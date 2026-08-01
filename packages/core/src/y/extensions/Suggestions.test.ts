/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Y from "@y/y";

import { BlockNoteEditor } from "../../editor/BlockNoteEditor.js";
import type { BlockNoteStore } from "../../platform/BlockNoteStore.js";
import {
  SuggestionsExtension,
  type BlockNoteSuggestion,
} from "./Suggestions.js";
import { withCollaboration } from "./index.js";

type Editor = BlockNoteEditor<any, any, any>;

const editors: Editor[] = [];
const docs: Y.Doc[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy();
  }
  for (const doc of docs.splice(0)) {
    doc.destroy();
  }
});

function createEditor(
  baseDoc: Y.Doc,
  options: {
    suggestionDoc?: Y.Doc;
    renderer?: Y.DiffRenderer;
    actorId?: string;
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
  editor.mount(document.createElement("div"));
  editors.push(editor);
  return editor;
}

function createFixture(initial: string) {
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
    actorId: "alice",
  });
  setText(editor, initial);
  Y.applyUpdate(suggestionDoc, Y.encodeStateAsUpdate(baseDoc));
  return { baseDoc, suggestionDoc, renderer, editor };
}

function setText(editor: Editor, text: string) {
  editor.updateBlock(editor.document[0]!, { content: text });
}

function positionAfter(editor: Editor, text: string) {
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

function textEnd(editor: Editor) {
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

function insertText(editor: Editor, pos: number, text: string) {
  editor.transact((transaction) => {
    transaction.insertText(text, pos);
  });
}

function readBaseText(baseDoc: Y.Doc) {
  return createEditor(baseDoc).prosemirrorState.doc.textContent;
}

function suggestions(editor: Editor) {
  return editor.getExtension(SuggestionsExtension)!;
}

function pending(editor: Editor) {
  return suggestions(editor)
    .store.get()
    .filter((suggestion) => suggestion.status === "pending");
}

function hasSuggestionMark(editor: Editor, id: string) {
  let found = false;
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.marks.some((mark) => mark.attrs["blocknoteSuggestionId"] === id)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

describe("SuggestionsExtension", () => {
  it("publishes the native BlockNote store contract", () => {
    type PublicExtension = ReturnType<
      typeof SuggestionsExtension
    >["~types"]["extension"];
    type PublicStore = PublicExtension["store"];
    type HasTanStackState = "state" extends keyof PublicStore ? true : false;

    expectTypeOf<Parameters<typeof SuggestionsExtension>>().toEqualTypeOf<[]>();
    expectTypeOf<PublicStore>().toEqualTypeOf<
      BlockNoteStore<readonly BlockNoteSuggestion[]>
    >();
    expectTypeOf<HasTanStackState>().toEqualTypeOf<false>();
  });

  it.each([
    ["insertion", "hello", "hello world"],
    ["deletion", "hello world", "hello"],
    ["replacement", "hello world", "hello universe"],
  ] as const)(
    "preserves the base view for a suggested %s until acceptance",
    async (kind, initial, proposed) => {
      const { baseDoc, editor } = createFixture(initial);
      suggestions(editor).enableSuggestions();

      setText(editor, proposed);

      expect(readBaseText(baseDoc)).toBe(initial);
      expect(pending(editor)).toHaveLength(1);
      expect(pending(editor)[0]).toMatchObject({
        authorId: "alice",
        kind,
        status: "pending",
      });

      const id = pending(editor)[0]!.id;
      await suggestions(editor).accept(id);

      expect(readBaseText(baseDoc)).toBe(proposed);
      expect(suggestions(editor).store.get()).toEqual([
        expect.objectContaining({ status: "accepted" }),
      ]);
      expect(hasSuggestionMark(editor, id)).toBe(false);
    },
  );

  it("rejects exactly once and retains the terminal public record", async () => {
    const { baseDoc, editor } = createFixture("before");
    suggestions(editor).enableSuggestions();
    setText(editor, "before after");
    const id = pending(editor)[0]!.id;

    await suggestions(editor).reject(id);
    await suggestions(editor).reject(id);
    await suggestions(editor).accept(id);

    expect(readBaseText(baseDoc)).toBe("before");
    expect(suggestions(editor).store.get()).toEqual([
      expect.objectContaining({ id, preview: "after", status: "rejected" }),
    ]);
    expect(hasSuggestionMark(editor, id)).toBe(false);
  });

  it("does not record ordinary edits before suggestion mode is enabled", () => {
    const { editor } = createFixture("before");

    setText(editor, "ordinary edit");

    expect(suggestions(editor).store.get()).toEqual([]);
  });

  it("coalesces adjacent same-actor keystrokes into one persisted suggestion", async () => {
    const { baseDoc, editor } = createFixture("ab");
    suggestions(editor).enableSuggestions();

    insertText(editor, textEnd(editor), "X");
    const id = pending(editor)[0]!.id;
    insertText(editor, textEnd(editor), "Y");
    insertText(editor, textEnd(editor), "Z");

    expect(readBaseText(baseDoc)).toBe("ab");
    expect(pending(editor)).toEqual([
      expect.objectContaining({
        id,
        authorId: "alice",
        kind: "insertion",
        preview: "XYZ",
      }),
    ]);

    await suggestions(editor).accept(id);

    expect(readBaseText(baseDoc)).toBe("abXYZ");
    expect(suggestions(editor).store.get()).toEqual([
      expect.objectContaining({ id, status: "accepted" }),
    ]);
  });

  it("does not coalesce consecutive edits at different document locations", () => {
    const { editor } = createFixture("left right");
    suggestions(editor).enableSuggestions();

    insertText(editor, positionAfter(editor, "left"), "X");
    const firstId = pending(editor)[0]!.id;
    insertText(editor, textEnd(editor), "Y");

    expect(pending(editor)).toHaveLength(2);
    expect(pending(editor).map((suggestion) => suggestion.id)).toContain(
      firstId,
    );
    expect(pending(editor).map((suggestion) => suggestion.preview)).toEqual(
      expect.arrayContaining(["X", "Y"]),
    );
  });

  it("ignores malformed collaborative ledger records", () => {
    const { suggestionDoc, editor } = createFixture("safe");
    const ledger = suggestionDoc.get("__blocknote_suggestions");

    suggestionDoc.transact(() => {
      ledger.setAttr("wrong-key", {
        version: 1,
        id: "different-id",
        authorId: "mallory",
        kind: "insertion",
        preview: "unsafe",
        status: "pending",
        insertRanges: [{ client: 1, clock: 1, length: 1 }],
        deleteRanges: [],
      });
      ledger.setAttr("invalid-range", {
        version: 1,
        id: "invalid-range",
        authorId: "mallory",
        kind: "deletion",
        preview: "unsafe",
        status: "pending",
        insertRanges: [],
        deleteRanges: [{ client: -1, clock: 1, length: 0 }],
      });
      ledger.setAttr("oversized", {
        version: 1,
        id: "oversized",
        authorId: "mallory",
        kind: "insertion",
        preview: "x".repeat(20_000),
        status: "pending",
        insertRanges: Array.from({ length: 5_000 }, (_, clock) => ({
          client: 1,
          clock,
          length: 1,
        })),
        deleteRanges: [],
      });
    });

    expect(suggestions(editor).store.get()).toEqual([]);
  });

  it("round-trips the persisted id, author and pending state", () => {
    const fixture = createFixture("hello world");
    suggestions(fixture.editor).enableSuggestions();
    setText(fixture.editor, "hello universe");
    const before = pending(fixture.editor)[0]!;

    const baseDoc = new Y.Doc();
    const suggestionDoc = new Y.Doc({ isSuggestionDoc: true });
    docs.push(baseDoc, suggestionDoc);
    Y.applyUpdate(baseDoc, Y.encodeStateAsUpdate(fixture.baseDoc));
    Y.applyUpdate(suggestionDoc, Y.encodeStateAsUpdate(fixture.suggestionDoc));
    const renderer = Y.createDiffRenderer(baseDoc, suggestionDoc, {
      attrs: new Y.Attributions(),
    });
    const reloaded = createEditor(baseDoc, {
      suggestionDoc,
      renderer,
      actorId: "mallory",
    });
    suggestions(reloaded).viewSuggestions();

    expect(pending(reloaded)).toEqual([before]);
  });

  it("keeps identity stable when an ordinary concurrent edit remaps it", () => {
    const { baseDoc, editor } = createFixture("hello world");
    suggestions(editor).enableSuggestions();
    setText(editor, "hello universe");
    const id = pending(editor)[0]!.id;
    const ordinaryEditor = createEditor(baseDoc);

    setText(ordinaryEditor, "prefix hello world");

    expect(pending(editor)).toHaveLength(1);
    expect(pending(editor)[0]!.id).toBe(id);
    expect(readBaseText(baseDoc)).toBe("prefix hello world");
  });

  it("resolves one non-adjacent suggestion without resolving another", async () => {
    const { baseDoc, editor } = createFixture("abcd");
    suggestions(editor).enableSuggestions();
    insertText(editor, positionAfter(editor, "a"), "X");
    insertText(editor, textEnd(editor), "Y");
    const proposed = pending(editor);

    expect(proposed).toHaveLength(2);
    const first = proposed.find((suggestion) =>
      suggestion.preview.includes("X"),
    );
    const second = proposed.find((suggestion) => suggestion.id !== first?.id);
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    await suggestions(editor).accept(first!.id);

    expect(readBaseText(baseDoc)).toBe("aXbcd");
    expect(suggestions(editor).store.get()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first!.id, status: "accepted" }),
        expect.objectContaining({ id: second!.id, status: "pending" }),
      ]),
    );
    expect(pending(editor).map((suggestion) => suggestion.id)).toEqual([
      second!.id,
    ]);
    expect(hasSuggestionMark(editor, first!.id)).toBe(false);
    expect(hasSuggestionMark(editor, second!.id)).toBe(true);
  });
});
