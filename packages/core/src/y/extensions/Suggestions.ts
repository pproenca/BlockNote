import {
  acceptAllChanges,
  configureYProsemirror,
  rejectAllChanges,
} from "@y/prosemirror";
import { Plugin, TextSelection } from "prosemirror-state";
import type { Node as ProseMirrorNode } from "prosemirror-model";

import {
  createExtension,
  type Extension,
  type ExtensionOptions,
} from "../../editor/BlockNoteExtension.js";
import type {
  BlockNoteDocumentExtension,
  BlockNoteEmptyContext,
} from "../../document/BlockNoteDocumentExtension.js";
import {
  createBlockNoteStore,
  type BlockNoteStore,
} from "../../platform/BlockNoteStore.js";
import { findTypeInOtherYdoc } from "../utils.js";
import {
  analyzeSuggestions,
  type AnalyzedSuggestion,
} from "./suggestions/analysis.js";
import {
  acceptNativeSuggestion,
  getNativeSuggestionRecords,
  getNativeSuggestionsBinding,
  observeNativeSuggestions,
  rejectNativeSuggestion,
  resolveNativeSuggestions,
  updateNativeSuggestionProjections,
  type NativeSuggestionsBinding,
} from "./suggestions/native.js";

export type BlockNoteSuggestionKind = "insertion" | "deletion" | "replacement";

export type BlockNoteSuggestionStatus = "pending" | "accepted" | "rejected";

export interface BlockNoteSuggestion {
  readonly id: string;
  readonly authorId: string | null;
  readonly kind: BlockNoteSuggestionKind;
  readonly preview: string;
  readonly status: BlockNoteSuggestionStatus;
}

export interface BlockNoteSuggestionsExtension {
  readonly key: "suggestions";
  readonly store: BlockNoteStore<readonly BlockNoteSuggestion[]>;
  select(id: string | null): void;
  accept(id: string): Promise<void>;
  reject(id: string): Promise<void>;
  acceptAll(): Promise<void>;
  rejectAll(): Promise<void>;
  viewSuggestions(): boolean;
  enableSuggestions(): boolean;
  disableSuggestions(): boolean;
}

function equalSuggestions(
  previous: readonly BlockNoteSuggestion[],
  next: readonly BlockNoteSuggestion[],
) {
  return (
    previous.length === next.length &&
    previous.every((suggestion, index) => {
      const candidate = next[index];
      return (
        candidate !== undefined &&
        suggestion.id === candidate.id &&
        suggestion.authorId === candidate.authorId &&
        suggestion.kind === candidate.kind &&
        suggestion.preview === candidate.preview &&
        suggestion.status === candidate.status
      );
    })
  );
}

function publicSuggestion(suggestion: AnalyzedSuggestion): BlockNoteSuggestion {
  return Object.freeze({
    id: suggestion.id,
    authorId: suggestion.authorId,
    kind: suggestion.kind,
    preview: suggestion.preview,
    status: suggestion.status,
  });
}

const createSuggestionsExtension = ({
  editor,
}: ExtensionOptions<undefined>) => {
  const store = createBlockNoteStore<readonly BlockNoteSuggestion[]>([], {
    equals: equalSuggestions,
  });
  let binding: NativeSuggestionsBinding | undefined;
  let stopObserving: (() => void) | undefined;
  let active = new Map<string, AnalyzedSuggestion>();
  let latestDoc: ProseMirrorNode | undefined;
  let refreshing = false;
  let refreshRequested = false;

  const refreshOnce = (doc = latestDoc) => {
    if (!binding || !doc) {
      active = new Map();
      store.set([]);
      return;
    }
    const records = getNativeSuggestionRecords(binding);
    active = analyzeSuggestions(doc, records);
    const projections = new Map<
      string,
      Pick<AnalyzedSuggestion, "kind" | "preview">
    >();
    for (const suggestion of active.values()) {
      projections.set(suggestion.id, {
        kind: suggestion.kind,
        preview: suggestion.preview,
      });
    }
    updateNativeSuggestionProjections(binding, projections);
    const pending = [...active.values()]
      .sort(
        (left, right) =>
          left.order - right.order || left.id.localeCompare(right.id),
      )
      .map(publicSuggestion);
    const terminal = [...records.values()]
      .filter((record) => record.status !== "pending")
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(
        (record): BlockNoteSuggestion =>
          Object.freeze({
            id: record.id,
            authorId: record.authorId,
            kind: record.kind,
            preview: record.preview,
            status: record.status,
          }),
      );
    const suggestions = [...pending, ...terminal];
    store.set(Object.freeze(suggestions));
  };

  const refresh = (doc?: ProseMirrorNode) => {
    if (doc) {
      latestDoc = doc;
    }
    if (refreshing) {
      refreshRequested = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshRequested = false;
        refreshOnce();
      } while (refreshRequested);
    } finally {
      refreshing = false;
    }
  };

  const ensureBinding = () => {
    const next = getNativeSuggestionsBinding(editor);
    if (!next || next === binding) {
      return next;
    }
    stopObserving?.();
    binding = next;
    stopObserving = observeNativeSuggestions(binding, () => refresh());
    return binding;
  };

  const currentSuggestion = (id: string) => {
    ensureBinding();
    latestDoc = editor.prosemirrorState.doc;
    refresh(latestDoc);
    return active.get(id);
  };

  const resolve = async (id: string, status: "accepted" | "rejected") => {
    const suggestion = currentSuggestion(id);
    if (!binding || !suggestion) {
      return;
    }
    const record = getNativeSuggestionRecords(binding).get(id);
    if (!record || record.status !== "pending") {
      return;
    }
    if (status === "accepted") {
      acceptNativeSuggestion(binding, record);
    } else {
      rejectNativeSuggestion(binding, record);
    }
    resolveNativeSuggestions(binding, [id], status);
    refresh();
  };

  const resolveAll = async (status: "accepted" | "rejected") => {
    ensureBinding();
    latestDoc = editor.prosemirrorState.doc;
    refresh(latestDoc);
    if (!binding || active.size === 0) {
      return;
    }
    const ids = [...active.keys()];
    editor.exec(
      status === "accepted" ? acceptAllChanges() : rejectAllChanges(),
    );
    resolveNativeSuggestions(binding, ids, status);
    refresh();
  };

  return {
    key: "suggestions",
    store,
    runsBefore: ["ySync"],
    prosemirrorPlugins: [
      new Plugin({
        view(view) {
          latestDoc = view.state.doc;
          ensureBinding();
          refresh(latestDoc);
          return {
            update(nextView) {
              latestDoc = nextView.state.doc;
              ensureBinding();
              refresh(latestDoc);
            },
          };
        },
      }),
    ],
    destroy() {
      stopObserving?.();
    },
    select(id: string | null) {
      if (id === null) {
        return;
      }
      const suggestion = currentSuggestion(id);
      const first = suggestion?.ranges[0];
      const last = suggestion?.ranges.at(-1);
      if (!first || !last) {
        return;
      }
      editor.transact((transaction) => {
        const from = Math.max(
          0,
          Math.min(first.from, transaction.doc.content.size),
        );
        const to = Math.max(
          from,
          Math.min(last.to, transaction.doc.content.size),
        );
        transaction.setSelection(
          TextSelection.create(transaction.doc, from, to),
        );
      });
    },
    accept(id: string) {
      return resolve(id, "accepted");
    },
    reject(id: string) {
      return resolve(id, "rejected");
    },
    acceptAll() {
      return resolveAll("accepted");
    },
    rejectAll() {
      return resolveAll("rejected");
    },
    viewSuggestions() {
      const runtime = ensureBinding();
      if (!runtime) {
        return false;
      }
      runtime.renderer.suggestionMode = false;
      return editor.exec(
        configureYProsemirror({
          ytype: findTypeInOtherYdoc(runtime.fragment, runtime.suggestionDoc),
          renderer: runtime.renderer,
        }),
      );
    },
    enableSuggestions() {
      const runtime = ensureBinding();
      if (!runtime) {
        return false;
      }
      runtime.renderer.suggestionMode = true;
      return editor.exec(
        configureYProsemirror({
          ytype: findTypeInOtherYdoc(runtime.fragment, runtime.suggestionDoc),
          renderer: runtime.renderer,
        }),
      );
    },
    disableSuggestions() {
      const runtime = ensureBinding();
      if (!runtime) {
        return false;
      }
      return editor.exec(
        configureYProsemirror({ ytype: runtime.fragment, renderer: null }),
      );
    },
  } as const;
};

const SuggestionsExtensionImplementation = createExtension(
  createSuggestionsExtension as unknown as (
    options: ExtensionOptions<undefined>,
  ) => Extension<readonly BlockNoteSuggestion[], "suggestions">,
  { name: "suggestions", version: "1" },
);

export const SuggestionsExtension =
  SuggestionsExtensionImplementation as unknown as () => BlockNoteDocumentExtension<
    "suggestions",
    "1",
    readonly [],
    undefined,
    BlockNoteEmptyContext,
    BlockNoteSuggestionsExtension
  >;
