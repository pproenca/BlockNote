/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vite-plus/test";
import * as Y from "@y/y";

import {
  getNativeSuggestionRecords,
  getNativeSuggestionsBinding,
} from "./native.js";
import {
  isRangeClaim,
  LEDGER_NAMES,
  NATIVE_SUGGESTION_LIMITS,
  rangeClaimId,
  rangesFromIdSet,
} from "./model.js";
import {
  cloneDoc,
  createEditor,
  createFixture,
  docs,
  insertText,
  observerCount,
  pending,
  positionAfter,
  readBaseText,
  setText,
  suggestions,
  syncDocs,
  textEnd,
  uuidFor,
} from "./test-fixture.js";

describe("suggestion ledger", () => {
  it("round-trips deterministic composite range claim keys", () => {
    const suggestionId = uuidFor(1);
    const range = { client: 7, clock: 11, length: 13 };
    const key = rangeClaimId(suggestionId, "insert", range);
    const claim = {
      version: 2 as const,
      suggestionId,
      role: "insert" as const,
      ...range,
    };

    expect(key).toBe(`${suggestionId}/insert/7/11/13`);
    expect(isRangeClaim(key, claim)).toBe(true);
    expect(isRangeClaim(suggestionId, claim)).toBe(false);
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

  it("unions concurrent range entries for the same suggestion", () => {
    const seed = createFixture("ab");
    suggestions(seed.editor).enableSuggestions();
    insertText(seed.editor, textEnd(seed.editor), "X");
    const id = pending(seed.editor)[0]!.id;
    const seedBinding = getNativeSuggestionsBinding(seed.editor)!;

    const baseA = cloneDoc(seed.baseDoc);
    const suggestionA = cloneDoc(seed.suggestionDoc, { isSuggestionDoc: true });
    const baseB = cloneDoc(seed.baseDoc);
    const suggestionB = cloneDoc(seed.suggestionDoc, { isSuggestionDoc: true });
    const rendererA = Y.createDiffRenderer(baseA, suggestionA, {
      attrs: new Y.Attributions(),
    });
    const rendererB = Y.createDiffRenderer(baseB, suggestionB, {
      attrs: new Y.Attributions(),
    });
    const editorA = createEditor(baseA, {
      suggestionDoc: suggestionA,
      renderer: rendererA,
      actorId: "alice",
    });
    const editorB = createEditor(baseB, {
      suggestionDoc: suggestionB,
      renderer: rendererB,
      actorId: "alice",
    });
    const bindingA = getNativeSuggestionsBinding(editorA)!;
    const bindingB = getNativeSuggestionsBinding(editorB)!;
    Object.assign(bindingA, { creatorId: seedBinding.creatorId });
    Object.assign(bindingB, { creatorId: seedBinding.creatorId });
    suggestions(editorA).enableSuggestions();
    suggestions(editorB).enableSuggestions();

    insertText(editorA, textEnd(editorA), "A");
    insertText(editorB, textEnd(editorB), "B");
    const beforeA = getNativeSuggestionRecords(bindingA).get(id)!;
    syncDocs(suggestionA, suggestionB);

    const afterA = getNativeSuggestionRecords(bindingA).get(id)!;
    const afterB = getNativeSuggestionRecords(bindingB).get(id)!;
    expect(afterA.insertRanges.length).toBeGreaterThan(
      beforeA.insertRanges.length,
    );
    expect(afterA.insertRanges).toEqual(afterB.insertRanges);
    expect(pending(editorA).map((item) => item.id)).toEqual([id]);
    expect(pending(editorB).map((item) => item.id)).toEqual([id]);
  });

  it("chooses overlap ownership identically under opposite ledger integration order", () => {
    const seed = createFixture("a");
    suggestions(seed.editor).enableSuggestions();
    const hostile = cloneDoc(seed.suggestionDoc, { isSuggestionDoc: true });
    const hostileEditor = createEditor(hostile);
    setText(hostileEditor, "aX");
    Y.applyUpdate(seed.suggestionDoc, Y.encodeStateAsUpdate(hostile));

    const baseA = cloneDoc(seed.baseDoc);
    const suggestionA = cloneDoc(seed.suggestionDoc, { isSuggestionDoc: true });
    const baseB = cloneDoc(seed.baseDoc);
    const suggestionB = cloneDoc(seed.suggestionDoc, { isSuggestionDoc: true });
    const rendererA = Y.createDiffRenderer(baseA, suggestionA, {
      attrs: new Y.Attributions(),
    });
    const rendererB = Y.createDiffRenderer(baseB, suggestionB, {
      attrs: new Y.Attributions(),
    });
    const ranges = rangesFromIdSet(Y.createIdSetFromIdMap(rendererA.inserts));
    const lowerId = uuidFor(1);
    const higherId = uuidFor(2);
    const updateFor = (id: string, clientID: number) => {
      const updateDoc = new Y.Doc();
      updateDoc.clientID = clientID;
      docs.push(updateDoc);
      updateDoc.get(LEDGER_NAMES.headers).setAttr(id, {
        version: 2,
        id,
        authorId: "alice",
        creatorId: uuidFor(clientID),
      });
      const claims = updateDoc.get(LEDGER_NAMES.ranges);
      for (const range of ranges) {
        claims.setAttr(rangeClaimId(id, "insert", range), {
          version: 2,
          suggestionId: id,
          role: "insert",
          ...range,
        });
      }
      return Y.encodeStateAsUpdate(updateDoc);
    };
    const lowerUpdate = updateFor(lowerId, 11);
    const higherUpdate = updateFor(higherId, 12);
    Y.applyUpdate(suggestionA, lowerUpdate);
    Y.applyUpdate(suggestionA, higherUpdate);
    Y.applyUpdate(suggestionB, higherUpdate);
    Y.applyUpdate(suggestionB, lowerUpdate);
    const editorA = createEditor(baseA, {
      suggestionDoc: suggestionA,
      renderer: rendererA,
      actorId: "alice",
    });
    const editorB = createEditor(baseB, {
      suggestionDoc: suggestionB,
      renderer: rendererB,
      actorId: "alice",
    });

    expect(pending(editorA).map((item) => item.id)).toEqual([lowerId]);
    expect(pending(editorB).map((item) => item.id)).toEqual([lowerId]);
    for (const renderer of [rendererA, rendererB]) {
      let sawAuthor = false;
      renderer.inserts.forEach((range) => {
        const authors = range.attrs.filter(
          (attribute) => attribute.name === "insert",
        );
        sawAuthor ||= authors.some((attribute) => attribute.val === "alice");
        expect(
          authors.every((attribute) => typeof attribute.val === "string"),
        ).toBe(true);
        expect(
          range.attrs.some(
            (attribute) => attribute.name === "blocknoteSuggestionId",
          ),
        ).toBe(false);
      });
      expect(sawAuthor).toBe(true);
    }
  });

  it("never coalesces edits from anonymous peers", () => {
    const seed = createFixture("left right");
    const baseA = cloneDoc(seed.baseDoc);
    const suggestionA = cloneDoc(seed.suggestionDoc, { isSuggestionDoc: true });
    const baseB = cloneDoc(seed.baseDoc);
    const suggestionB = cloneDoc(seed.suggestionDoc, { isSuggestionDoc: true });
    const rendererA = Y.createDiffRenderer(baseA, suggestionA, {
      attrs: new Y.Attributions(),
    });
    const rendererB = Y.createDiffRenderer(baseB, suggestionB, {
      attrs: new Y.Attributions(),
    });
    const editorA = createEditor(baseA, {
      suggestionDoc: suggestionA,
      renderer: rendererA,
    });
    const editorB = createEditor(baseB, {
      suggestionDoc: suggestionB,
      renderer: rendererB,
    });
    suggestions(editorA).enableSuggestions();
    suggestions(editorB).enableSuggestions();

    insertText(editorA, positionAfter(editorA, "left"), "A");
    insertText(editorB, textEnd(editorB), "B");
    syncDocs(suggestionA, suggestionB);

    expect(pending(editorA)).toHaveLength(2);
    expect(pending(editorB)).toHaveLength(2);
    expect(pending(editorA).every((item) => item.authorId === null)).toBe(true);
    expect(
      pending(editorA)
        .map((item) => item.id)
        .sort(),
    ).toEqual(
      pending(editorB)
        .map((item) => item.id)
        .sort(),
    );
  });

  it("quarantines the whole indexed ledger when aggregate record budget is exceeded", () => {
    const { suggestionDoc, editor } = createFixture("a");
    suggestions(editor).enableSuggestions();
    insertText(editor, textEnd(editor), "X");
    expect(pending(editor)).toHaveLength(1);

    const headers = suggestionDoc.get(LEDGER_NAMES.headers);
    suggestionDoc.transact(() => {
      for (
        let index = 1;
        index <= NATIVE_SUGGESTION_LIMITS.maxRecords;
        index += 1
      ) {
        const id = uuidFor(index);
        headers.setAttr(id, {
          version: 2,
          id,
          authorId: "hostile",
          creatorId: uuidFor(999_999),
        });
      }
    });

    expect(suggestions(editor).store.get()).toEqual([]);
  });

  it("does not leak afterTransaction observers across repeated rejection", async () => {
    const { suggestionDoc, editor } = createFixture("a");
    suggestions(editor).enableSuggestions();
    const baseline = observerCount(suggestionDoc, "afterTransaction");

    for (let index = 0; index < 12; index += 1) {
      insertText(editor, textEnd(editor), "X");
      await suggestions(editor).reject(pending(editor)[0]!.id);
      expect(observerCount(suggestionDoc, "afterTransaction")).toBe(baseline);
    }

    editor.destroy();
    expect(observerCount(suggestionDoc, "afterTransaction")).toBe(baseline - 1);
  });
});
