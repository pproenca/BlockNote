import { describe, expect, it } from "vite-plus/test";
import * as Y from "@y/y";

import { BlockNoteError } from "../../../platform/BlockNoteError.js";
import {
  getNativeSuggestionRecords,
  getNativeSuggestionsBinding,
} from "./native.js";
import { LEDGER_NAMES, NATIVE_SUGGESTION_LIMITS } from "./model.js";
import {
  cloneDoc,
  createEditor,
  createFixture,
  executeNativeReviewsForTest,
  insertText,
  mintNativeReviewPermitForTest,
  pending,
  readBaseText,
  revokeNativeReviewPermitForTest,
  setText,
  suggestions,
  syncDocs,
  textEnd,
} from "./test-fixture.js";

function seedRangeSlots(doc: Y.Doc, count: number) {
  const ranges = doc.get(LEDGER_NAMES.ranges);
  doc.transact(() => {
    for (let index = 0; index < count; index += 1) {
      ranges.setAttr(`hostile-range-${index}`, null);
    }
  });
  return ranges;
}

describe("native suggestion authority", () => {
  it("rejects forged, reused, and revoked capabilities before mutation", async () => {
    const { baseDoc, suggestionDoc, editor } = createFixture("a", "alice", {
      executeReviews: false,
    });
    suggestions(editor).enableSuggestions();
    insertText(editor, textEnd(editor), "X");
    const id = pending(editor)[0]!.id;
    await suggestions(editor).reject(id);
    expect(suggestionDoc.get(LEDGER_NAMES.receipts).attrSize).toBe(0);

    const beforeForgedBase = Y.encodeStateAsUpdate(baseDoc);
    const beforeForgedSuggestion = Y.encodeStateAsUpdate(suggestionDoc);
    expect(() =>
      executeNativeReviewsForTest(editor, { leaseId: "forged" }),
    ).toThrow(/authority capability/);
    expect(Y.encodeStateAsUpdate(baseDoc)).toEqual(beforeForgedBase);
    expect(Y.encodeStateAsUpdate(suggestionDoc)).toEqual(
      beforeForgedSuggestion,
    );

    const permit = mintNativeReviewPermitForTest();
    executeNativeReviewsForTest(editor, permit);
    const committedBase = Y.encodeStateAsUpdate(baseDoc);
    const committedSuggestion = Y.encodeStateAsUpdate(suggestionDoc);
    expect(() => executeNativeReviewsForTest(editor, permit)).toThrow(
      /authority capability/,
    );

    const revoked = mintNativeReviewPermitForTest();
    revokeNativeReviewPermitForTest(revoked);
    expect(() => executeNativeReviewsForTest(editor, revoked)).toThrow(
      /authority capability/,
    );
    expect(Y.encodeStateAsUpdate(baseDoc)).toEqual(committedBase);
    expect(Y.encodeStateAsUpdate(suggestionDoc)).toEqual(committedSuggestion);
  });

  it.each([
    ["deletion", "hello world", "hello"],
    ["replacement", "hello world", "hello universe"],
  ] as const)(
    "rejects a %s after encode to a fresh gc-enabled document",
    async (_kind, initial, proposed) => {
      const source = createFixture(initial);
      suggestions(source.editor).enableSuggestions();
      setText(source.editor, proposed);
      const id = pending(source.editor)[0]!.id;
      const authorityBase = cloneDoc(source.baseDoc);
      const authoritySuggestion = cloneDoc(source.suggestionDoc, {
        isSuggestionDoc: true,
      });
      expect(authoritySuggestion.gc).toBe(true);
      const authority = createEditor(authorityBase, {
        suggestionDoc: authoritySuggestion,
        renderer: Y.createDiffRenderer(authorityBase, authoritySuggestion, {
          attrs: new Y.Attributions(),
        }),
      });

      await suggestions(authority).reject(id);

      expect(readBaseText(authorityBase)).toBe(initial);
      expect(readBaseText(authoritySuggestion)).toBe(initial);
    },
  );

  it("keeps the first unresolved intent without retry updates", async () => {
    const { suggestionDoc, editor } = createFixture("a", "alice", {
      executeReviews: false,
    });
    suggestions(editor).enableSuggestions();
    insertText(editor, textEnd(editor), "X");
    const id = pending(editor)[0]!.id;

    await suggestions(editor).reject(id);
    const first = getNativeSuggestionRecords(
      getNativeSuggestionsBinding(editor)!,
    ).get(id)!;
    expect(suggestionDoc.get(LEDGER_NAMES.receipts).attrSize).toBe(0);
    const before = Y.encodeStateAsUpdate(suggestionDoc);
    const beforeVector = Y.encodeStateVector(suggestionDoc);
    let updates = 0;
    const countUpdate = () => {
      updates += 1;
    };
    suggestionDoc.on("update", countUpdate);

    await suggestions(editor).reject(id);
    await suggestions(editor).accept(id);
    await suggestions(editor).reject(id);
    suggestionDoc.off("update", countUpdate);

    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(suggestionDoc)).toEqual(before);
    expect(Y.encodeStateVector(suggestionDoc)).toEqual(beforeVector);
    expect(suggestionDoc.get(LEDGER_NAMES.dispositions).attrSize).toBe(1);
    expect(
      getNativeSuggestionRecords(getNativeSuggestionsBinding(editor)!).get(id),
    ).toMatchObject({
      decisionId: first.decisionId,
      status: "rejected",
    });
  });

  it("charges contiguous edits by structural range and rejects fragmented overflow", () => {
    const contiguous = createFixture("a");
    suggestions(contiguous.editor).enableSuggestions();
    const contiguousRanges = seedRangeSlots(
      contiguous.suggestionDoc,
      NATIVE_SUGGESTION_LIMITS.maxTotalRanges - 1,
    );
    insertText(
      contiguous.editor,
      textEnd(contiguous.editor),
      "X".repeat(NATIVE_SUGGESTION_LIMITS.maxTotalRanges + 1),
    );
    expect(pending(contiguous.editor)).toHaveLength(1);
    expect(contiguousRanges.attrSize).toBe(
      NATIVE_SUGGESTION_LIMITS.maxTotalRanges,
    );

    const fragmented = createFixture("a");
    const peerDoc = cloneDoc(fragmented.baseDoc);
    const peer = createEditor(peerDoc);
    insertText(peer, textEnd(peer), "b");
    syncDocs(fragmented.baseDoc, peerDoc);
    suggestions(fragmented.editor).enableSuggestions();
    const fragmentedRanges = seedRangeSlots(
      fragmented.suggestionDoc,
      NATIVE_SUGGESTION_LIMITS.maxTotalRanges - 1,
    );
    const beforeBase = Y.encodeStateAsUpdate(fragmented.baseDoc);
    const beforeSuggestion = Y.encodeStateAsUpdate(fragmented.suggestionDoc);

    let failure: unknown;
    try {
      const to = textEnd(fragmented.editor);
      fragmented.editor.transact((transaction) =>
        transaction.delete(to - 2, to),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(BlockNoteError);
    expect(failure).toMatchObject({ code: "document-too-large" });
    expect(Y.encodeStateAsUpdate(fragmented.baseDoc)).toEqual(beforeBase);
    expect(Y.encodeStateAsUpdate(fragmented.suggestionDoc)).toEqual(
      beforeSuggestion,
    );
    expect(fragmentedRanges.attrSize).toBe(
      NATIVE_SUGGESTION_LIMITS.maxTotalRanges - 1,
    );
  });

  it("preserves foreign retention ownership", async () => {
    const { suggestionDoc, editor } = createFixture("hello world");
    suggestions(editor).enableSuggestions();
    setText(editor, "hello");
    const id = pending(editor)[0]!.id;
    const record = getNativeSuggestionRecords(
      getNativeSuggestionsBinding(editor)!,
    ).get(id)!;
    const foreign = [...suggestionDoc.store.clients.values()]
      .flat()
      .filter(
        (struct): struct is Y.Item =>
          struct instanceof Y.Item &&
          record.deleteRanges.some(
            (range) =>
              range.client === struct.id.client &&
              struct.id.clock < range.clock + range.length &&
              range.clock < struct.id.clock + struct.length,
          ),
      );
    expect(foreign.length).toBeGreaterThan(0);
    for (const item of foreign) {
      item.keep = true;
    }

    await suggestions(editor).reject(id);

    expect(foreign.every((item) => item.keep)).toBe(true);
  });

  it("allows only one physical result for opposing replicas", async () => {
    const source = createFixture("a");
    suggestions(source.editor).enableSuggestions();
    insertText(source.editor, textEnd(source.editor), "X");
    const id = pending(source.editor)[0]!.id;
    const baseA = cloneDoc(source.baseDoc);
    const baseB = cloneDoc(source.baseDoc);
    const suggestionA = cloneDoc(source.suggestionDoc, {
      isSuggestionDoc: true,
    });
    const suggestionB = cloneDoc(source.suggestionDoc, {
      isSuggestionDoc: true,
    });
    const editorA = createEditor(baseA, {
      suggestionDoc: suggestionA,
      renderer: Y.createDiffRenderer(baseA, suggestionA),
      executeReviews: false,
    });
    const editorB = createEditor(baseB, {
      suggestionDoc: suggestionB,
      renderer: Y.createDiffRenderer(baseB, suggestionB),
      executeReviews: false,
    });

    await suggestions(editorA).accept(id);
    await suggestions(editorB).reject(id);
    expect(suggestionA.get(LEDGER_NAMES.receipts).attrSize).toBe(0);
    expect(suggestionB.get(LEDGER_NAMES.receipts).attrSize).toBe(0);
    syncDocs(suggestionA, suggestionB);

    const permit = mintNativeReviewPermitForTest();
    executeNativeReviewsForTest(editorA, permit);
    expect(() => executeNativeReviewsForTest(editorB, permit)).toThrow(
      /authority capability/,
    );
    syncDocs(baseA, baseB);
    syncDocs(suggestionA, suggestionB);

    expect(readBaseText(baseA)).toBe(readBaseText(baseB));
    expect(suggestionA.get(LEDGER_NAMES.receipts).attrSize).toBe(1);
    expect(suggestionB.get(LEDGER_NAMES.receipts).attrSize).toBe(1);
  });
});
