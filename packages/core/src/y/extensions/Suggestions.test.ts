/**
 * @vitest-environment jsdom
 */
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Y from "@y/y";
import { TextSelection } from "prosemirror-state";

import type { BlockNoteStore } from "../../platform/BlockNoteStore.js";
import {
  SuggestionsExtension,
  type BlockNoteSuggestion,
} from "./Suggestions.js";
import { findSuggestionRanges } from "./suggestions/analysis.js";
import {
  getNativeSuggestionRecords,
  getNativeSuggestionsBinding,
} from "./suggestions/native.js";
import {
  getLedgerTypes,
  previewFromIds,
  rangeClaimId,
} from "./suggestions/model.js";
import {
  cloneDoc,
  createEditor,
  createFixture,
  hasSuggestionMark,
  insertText,
  pending,
  positionAfter,
  readBaseText,
  selectedText,
  setText,
  suggestions,
  textEnd,
} from "./suggestions/test-fixture.js";

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

  it("selects only the requested non-adjacent suggestion", () => {
    const { editor } = createFixture("abcd");
    suggestions(editor).enableSuggestions();
    insertText(editor, positionAfter(editor, "a"), "X");
    insertText(editor, textEnd(editor), "Y");
    const target = pending(editor).find((suggestion) =>
      suggestion.preview.includes("Y"),
    )!;

    suggestions(editor).select(target.id);

    expect(selectedText(editor)).toBe("Y");
  });

  it("selects one exact span when a suggestion owns disjoint ranges", () => {
    const { suggestionDoc, editor } = createFixture("abcd");
    suggestions(editor).enableSuggestions();
    insertText(editor, positionAfter(editor, "a"), "X");
    const first = pending(editor)[0]!;
    insertText(editor, textEnd(editor), "Y");
    const second = pending(editor).find(({ id }) => id !== first.id)!;
    const ledger = getLedgerTypes(suggestionDoc);
    const moved: Array<{
      key: string;
      value: {
        version: 2;
        suggestionId: string;
        role: "insert" | "delete";
        client: number;
        clock: number;
        length: number;
      };
    }> = [];
    ledger.ranges.forEachAttr((value: unknown, key) => {
      const claim = value as (typeof moved)[number]["value"];
      if (typeof key === "string" && claim.suggestionId === second.id) {
        moved.push({ key, value: claim });
      }
    });
    suggestionDoc.transact(() => {
      ledger.headers.deleteAttr(second.id);
      for (const { key, value } of moved) {
        ledger.ranges.deleteAttr(key);
        const claim = { ...value, suggestionId: first.id };
        ledger.ranges.setAttr(rangeClaimId(first.id, claim.role, claim), claim);
      }
    });

    suggestions(editor).select(first.id);

    expect(pending(editor)).toHaveLength(1);
    expect(selectedText(editor)).toBe("X");
  });

  it("selects the full replacement range from semantic content ids", () => {
    const { editor } = createFixture("hello world");
    suggestions(editor).enableSuggestions();
    setText(editor, "hello universe");
    const target = pending(editor)[0]!;
    const binding = getNativeSuggestionsBinding(editor)!;
    const record = getNativeSuggestionRecords(binding).get(target.id)!;
    const ranges = findSuggestionRanges(
      editor.prosemirrorState.doc,
      binding,
      record,
    );

    suggestions(editor).select(target.id);

    expect(ranges.length).toBeGreaterThan(0);
    expect(editor.prosemirrorState.selection.from).toBe(ranges[0]!.from);
    expect(editor.prosemirrorState.selection.to).toBe(ranges[0]!.to);
  });

  it("selects an insertion anchor in the disabled base view", () => {
    const { editor } = createFixture("abcd");
    suggestions(editor).enableSuggestions();
    insertText(editor, positionAfter(editor, "a"), "X");
    const target = pending(editor)[0]!;
    suggestions(editor).disableSuggestions();
    const expected = positionAfter(editor, "a");
    const end = textEnd(editor);
    editor.transact((transaction) => {
      transaction.setSelection(TextSelection.create(transaction.doc, end));
    });

    suggestions(editor).select(target.id);

    expect(editor.prosemirrorState.selection.from).toBe(expected);
    expect(editor.prosemirrorState.selection.to).toBe(expected);
  });

  it("selects the replaced content in the disabled base view", () => {
    const { editor } = createFixture("hello world");
    suggestions(editor).enableSuggestions();
    setText(editor, "hello universe");
    const target = pending(editor)[0]!;
    suggestions(editor).disableSuggestions();

    suggestions(editor).select(target.id);

    expect(selectedText(editor)).toBe("wo");
  });

  it("publishes and observes ledger state before a view is mounted", () => {
    const seed = createFixture("abcd");
    suggestions(seed.editor).enableSuggestions();
    insertText(seed.editor, positionAfter(seed.editor, "a"), "X");
    const baseDoc = cloneDoc(seed.baseDoc);
    const suggestionDoc = cloneDoc(seed.suggestionDoc, {
      isSuggestionDoc: true,
    });
    const renderer = Y.createDiffRenderer(baseDoc, suggestionDoc, {
      attrs: new Y.Attributions(),
    });
    const headless = createEditor(baseDoc, {
      suggestionDoc,
      renderer,
      mount: false,
    });

    expect(pending(headless)).toHaveLength(1);

    insertText(seed.editor, textEnd(seed.editor), "Y");
    Y.applyUpdate(suggestionDoc, Y.encodeStateAsUpdate(seed.suggestionDoc));

    expect(pending(headless)).toHaveLength(2);
  });

  it("acceptAll applies only exact tracked ids and ignores an untracked diff", async () => {
    const { baseDoc, suggestionDoc, renderer, editor } = createFixture("a");
    suggestions(editor).enableSuggestions();
    insertText(editor, textEnd(editor), "T");
    const hostile = cloneDoc(suggestionDoc, { isSuggestionDoc: true });
    const hostileEditor = createEditor(hostile);
    setText(hostileEditor, "aTU");
    Y.applyUpdate(suggestionDoc, Y.encodeStateAsUpdate(hostile));

    expect(pending(editor)).toHaveLength(1);
    const binding = getNativeSuggestionsBinding(editor)!;
    const tracked = getNativeSuggestionRecords(binding).values().next().value!;
    const untracked = Y.diffIdSet(
      Y.createIdSetFromIdMap(renderer.inserts),
      tracked.contentIds.inserts,
    );
    expect(previewFromIds(suggestionDoc, tracked.contentIds.inserts)).toBe("T");
    expect(previewFromIds(suggestionDoc, untracked)).toContain("U");
    await suggestions(editor).acceptAll();

    expect(readBaseText(baseDoc)).toContain("T");
    expect(readBaseText(baseDoc)).not.toContain("U");
  });

  it("keeps semantic state and review commands in the disabled base view", async () => {
    const { baseDoc, editor } = createFixture("before");
    suggestions(editor).enableSuggestions();
    setText(editor, "before after");
    const proposed = pending(editor)[0]!;

    suggestions(editor).disableSuggestions();
    expect(editor.prosemirrorState.doc.textContent).toBe("before");
    expect(pending(editor)).toEqual([
      expect.objectContaining({ id: proposed.id, preview: "after" }),
    ]);

    await suggestions(editor).accept(proposed.id);
    expect(readBaseText(baseDoc)).toBe("before after");
    expect(suggestions(editor).store.get()).toEqual([
      expect.objectContaining({ id: proposed.id, status: "accepted" }),
    ]);
  });
});
