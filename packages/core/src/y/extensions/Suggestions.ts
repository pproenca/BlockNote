import {
  configureYProsemirror,
  preflightYSyncTransaction,
  registerYSyncMutationPolicy,
  ySyncPluginKey,
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
import { findSuggestionRanges } from "./suggestions/analysis.js";
import {
  getNativeSuggestionRecords,
  getNativeSuggestionsBinding,
  observeNativeSuggestions,
  resolveNativeSuggestions,
  type NativeSuggestionRecord,
  type NativeSuggestionsBinding,
} from "./suggestions/native.js";
import {
  appendCapturedSuggestionClaims,
  assertCanTrackSuggestionEdit,
} from "./suggestions/ledger.js";

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

function publicSuggestion(
  suggestion: NativeSuggestionRecord,
): BlockNoteSuggestion {
  return Object.freeze({
    id: suggestion.id,
    authorId: suggestion.authorId,
    kind: suggestion.kind,
    preview: suggestion.preview,
    status: suggestion.status,
  });
}

function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const createSuggestionsExtension = ({
  editor,
}: ExtensionOptions<undefined>) => {
  const store = createBlockNoteStore<readonly BlockNoteSuggestion[]>([], {
    equals: equalSuggestions,
  });
  let binding: NativeSuggestionsBinding | undefined;
  let stopObserving: (() => void) | undefined;
  let stopMutationPolicy: (() => void) | undefined;
  let active = new Map<string, NativeSuggestionRecord>();
  let latestDoc: ProseMirrorNode | undefined;
  let refreshing = false;
  let refreshRequested = false;

  const refreshOnce = () => {
    if (!binding) {
      active = new Map();
      store.set([]);
      return;
    }
    const records = getNativeSuggestionRecords(binding);
    active = new Map(records);
    const suggestions = [...active.values()]
      .sort(
        (left, right) =>
          compareCodeUnits(left.order, right.order) ||
          compareCodeUnits(left.id, right.id),
      )
      .map(publicSuggestion);
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
    stopMutationPolicy?.();
    binding = next;
    stopObserving = observeNativeSuggestions(binding, () => refresh());
    const suggestionType = findTypeInOtherYdoc(
      binding.fragment,
      binding.suggestionDoc,
    );
    stopMutationPolicy = registerYSyncMutationPolicy(suggestionType, {
      beforeMutation: ({ rangeCountUpperBound }) => {
        if (binding?.renderer.suggestionMode) {
          assertCanTrackSuggestionEdit(binding, rangeCountUpperBound);
        }
      },
      afterMutation: (content) => {
        if (binding?.renderer.suggestionMode) {
          appendCapturedSuggestionClaims(binding, content);
        }
      },
    });
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
    await resolveNativeSuggestions(binding, [id], status);
    refresh();
  };

  const resolveAll = async (status: "accepted" | "rejected") => {
    ensureBinding();
    latestDoc = editor.prosemirrorState.doc;
    refresh(latestDoc);
    if (!binding) {
      return;
    }
    const ids = [...active.values()]
      .filter((record) => record.status === "pending")
      .map((record) => record.id);
    if (ids.length === 0) {
      return;
    }
    await resolveNativeSuggestions(binding, ids, status);
    refresh();
  };

  const extension = {
    key: "suggestions",
    store,
    runsBefore: ["ySync"],
    prosemirrorPlugins: [
      new Plugin({
        filterTransaction(transaction, state) {
          if (
            !transaction.docChanged ||
            transaction.getMeta("y-sync-transaction") ||
            transaction.getMeta("y-sync-append") ||
            transaction.getMeta(ySyncPluginKey)
          ) {
            return true;
          }
          const runtime = ensureBinding();
          const sync = ySyncPluginKey.getState(state);
          const suggestionType = runtime
            ? findTypeInOtherYdoc(runtime.fragment, runtime.suggestionDoc)
            : null;
          if (
            runtime?.renderer.suggestionMode &&
            suggestionType !== null &&
            sync?.ytype === suggestionType &&
            sync.renderer === runtime.renderer &&
            runtime.suggestionDoc._transaction === null &&
            runtime.suggestionDoc._transactionCleanups.length === 0
          ) {
            preflightYSyncTransaction(
              transaction,
              suggestionType,
              ySyncPluginKey.get(state),
              runtime.renderer,
            );
          }
          return true;
        },
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
      stopMutationPolicy?.();
    },
    select(id: string | null) {
      if (id === null) {
        return;
      }
      const suggestion = currentSuggestion(id);
      const sync = ySyncPluginKey.getState(editor.prosemirrorState);
      if (!binding || !sync) {
        return;
      }
      const suggestionType = findTypeInOtherYdoc(
        binding.fragment,
        binding.suggestionDoc,
      );
      const projection =
        sync.ytype === suggestionType && sync.renderer === binding.renderer
          ? { documentType: suggestionType, renderer: binding.renderer }
          : sync.ytype === binding.fragment
            ? { documentType: binding.fragment, renderer: null }
            : null;
      if (!projection) {
        return;
      }
      const ranges = suggestion
        ? findSuggestionRanges(
            editor.prosemirrorState.doc,
            binding,
            suggestion,
            projection,
          )
        : [];
      const selected =
        ranges.find((range) => range.to > range.from) ?? ranges[0];
      if (!selected) {
        return;
      }
      editor.transact((transaction) => {
        const from = Math.max(
          0,
          Math.min(selected.from, transaction.doc.content.size),
        );
        const to = Math.max(
          from,
          Math.min(selected.to, transaction.doc.content.size),
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
      const origin = ySyncPluginKey.get(editor.prosemirrorState);
      runtime.renderer.suggestionOrigins = origin ? [origin] : [];
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
      const origin = ySyncPluginKey.get(editor.prosemirrorState);
      runtime.renderer.suggestionOrigins = origin ? [origin] : [];
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
  ensureBinding();
  refresh();
  return extension;
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
