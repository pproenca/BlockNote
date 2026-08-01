import { afterEach } from "vite-plus/test";
import * as Y from "@y/y";

import { BlockNoteEditor } from "../../../editor/BlockNoteEditor.js";
import { SuggestionsExtension } from "../Suggestions.js";
import { withCollaboration } from "../index.js";
import { findSuggestionRanges } from "./analysis.js";
import {
  getNativeSuggestionRecords,
  getNativeSuggestionsBinding,
  setNativeSuggestionsLocalExecutor,
} from "./native.js";
import { LEDGER_NAMES, rangeClaimId, rangesFromIdSet } from "./model.js";

export type Editor = BlockNoteEditor<any, any, any>;

const editors: Editor[] = [];
export const docs: Y.Doc[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy();
  }
  for (const doc of docs.splice(0)) {
    doc.destroy();
  }
});

export function createEditor(
  baseDoc: Y.Doc,
  options: {
    suggestionDoc?: Y.Doc;
    renderer?: Y.DiffRenderer;
    actorId?: string;
    mount?: boolean;
    executeReviews?: boolean;
  } = {},
) {
  const editor = BlockNoteEditor.create(
    withCollaboration({
      collaboration: {
        fragment: baseDoc.get("doc"),
        suggestionDoc: options.suggestionDoc,
        renderer: options.renderer,
        user: {
          id: options.actorId,
          name: options.actorId ?? "viewer",
          color: "#123456",
        },
      },
    }),
  );
  setNativeSuggestionsLocalExecutor(editor, options.executeReviews !== false);
  if (options.mount !== false) {
    editor.mount(document.createElement("div"));
  }
  editors.push(editor);
  return editor;
}

export function createFixture(
  initial: string,
  actorId: string | undefined = "alice",
) {
  const baseDoc = new Y.Doc();
  const suggestionDoc = new Y.Doc({ isSuggestionDoc: true });
  baseDoc.clientID = 1;
  suggestionDoc.clientID = 2;
  docs.push(baseDoc, suggestionDoc);
  const renderer = Y.createDiffRenderer(baseDoc, suggestionDoc, {
    attrs: new Y.Attributions(),
  });
  const editor = createEditor(baseDoc, {
    suggestionDoc,
    renderer,
    actorId,
  });
  setText(editor, initial);
  Y.applyUpdate(suggestionDoc, Y.encodeStateAsUpdate(baseDoc));
  return { baseDoc, suggestionDoc, renderer, editor };
}

export function cloneDoc(
  source: Y.Doc,
  options: ConstructorParameters<typeof Y.Doc>[0] = {},
) {
  const clone = new Y.Doc(options);
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
  docs.push(clone);
  return clone;
}

export function syncDocs(left: Y.Doc, right: Y.Doc) {
  Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
}

export function uuidFor(value: number) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

export function observerCount(doc: Y.Doc, event: string) {
  return (
    (
      doc as unknown as { _observers: Map<string, Set<unknown>> }
    )._observers.get(event)?.size ?? 0
  );
}

export function setText(editor: Editor, text: string) {
  editor.updateBlock(editor.document[0]!, { content: text });
}

export function positionAfter(editor: Editor, text: string) {
  let result: number | undefined;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    const index = node.isText ? (node.text ?? "").indexOf(text) : -1;
    if (index === -1) {
      return true;
    }
    result = pos + index + text.length;
    return false;
  });
  if (result === undefined) {
    throw new Error(`Text not found: ${text}`);
  }
  return result;
}

export function textEnd(editor: Editor) {
  let result: number | undefined;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.isText) {
      result = pos + node.nodeSize;
    }
    return true;
  });
  if (result === undefined) {
    throw new Error("Document has no text");
  }
  return result;
}

export function insertText(editor: Editor, pos: number, text: string) {
  editor.transact((transaction) => {
    transaction.insertText(text, pos);
  });
}

export function readBaseText(baseDoc: Y.Doc) {
  return createEditor(baseDoc).prosemirrorState.doc.textContent;
}

export function suggestions(editor: Editor) {
  return editor.getExtension(SuggestionsExtension)!;
}

export function pending(editor: Editor) {
  return suggestions(editor)
    .store.get()
    .filter((suggestion) => suggestion.status === "pending");
}

export function selectedText(editor: Editor) {
  const { from, to } = editor.prosemirrorState.selection;
  return editor.prosemirrorState.doc.textBetween(from, to, " ");
}

export function hasSuggestionMark(editor: Editor, id: string) {
  const binding = getNativeSuggestionsBinding(editor);
  const record = binding ? getNativeSuggestionRecords(binding).get(id) : null;
  return binding && record
    ? findSuggestionRanges(editor.prosemirrorState.doc, binding, record)
        .length > 0
    : false;
}

export function createInsertionLedgerUpdate(
  renderer: Y.DiffRenderer,
  id: string,
) {
  const updateDoc = new Y.Doc();
  docs.push(updateDoc);
  updateDoc.get(LEDGER_NAMES.headers).setAttr(id, {
    version: 2,
    id,
    authorId: "alice",
    creatorId: uuidFor(999_999),
  });
  const ranges = updateDoc.get(LEDGER_NAMES.ranges);
  for (const range of rangesFromIdSet(
    Y.createIdSetFromIdMap(renderer.inserts),
  )) {
    ranges.setAttr(rangeClaimId(id, "insert", range), {
      version: 2,
      suggestionId: id,
      role: "insert",
      ...range,
    });
  }
  return Y.encodeStateAsUpdate(updateDoc);
}
