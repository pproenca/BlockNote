/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vite-plus/test";
import * as Y from "@y/y";

import {
  getNativeSuggestionRecords,
  getNativeSuggestionsBinding,
  executeNativeSuggestionReviews,
  setNativeSuggestionsResolutionPhaseHook,
} from "./native.js";
import {
  decisionEntryId,
  getLedgerTypes,
  LEDGER_NAMES,
  NATIVE_SUGGESTION_LIMITS,
  rangeClaimId,
} from "./model.js";
import {
  cloneDoc,
  createEditor,
  createFixture,
  docs,
  insertText,
  pending,
  readBaseText,
  setText,
  suggestions,
  syncDocs,
  textEnd,
  uuidFor,
} from "./test-fixture.js";

describe("suggestion resolution", () => {
  it.each([
    ["deletion", "hello world", "hello"],
    ["replacement", "hello world", "hello universe"],
  ] as const)(
    "projects an authoritative %s rejection into a mounted suggestion view",
    async (_kind, initial, proposed) => {
      const { baseDoc, suggestionDoc, editor } = createFixture(initial);
      suggestions(editor).enableSuggestions();
      setText(editor, proposed);
      const id = pending(editor)[0]!.id;

      await suggestions(editor).reject(id);

      expect(readBaseText(baseDoc)).toBe(initial);
      expect(readBaseText(suggestionDoc)).toBe(initial);
      expect(editor.prosemirrorState.doc.textContent).toBe(initial);
    },
  );

  it.each([
    ["deletion", "hello world", "hello"],
    ["replacement", "hello world", "hello universe"],
  ] as const)(
    "rejects a %s after the deleted payload passes through gc",
    async (_kind, initial, proposed) => {
      const { baseDoc, suggestionDoc, editor } = createFixture(initial);
      expect(suggestionDoc.gc).toBe(true);
      suggestions(editor).enableSuggestions();
      setText(editor, proposed);
      const id = pending(editor)[0]!.id;
      const authorityBase = cloneDoc(baseDoc);
      const authoritySuggestion = cloneDoc(suggestionDoc, {
        gc: false,
        isSuggestionDoc: true,
      });
      const authorityRenderer = Y.createDiffRenderer(
        authorityBase,
        authoritySuggestion,
        {
          attrs: new Y.Attributions(),
        },
      );
      const authority = createEditor(authorityBase, {
        suggestionDoc: authoritySuggestion,
        renderer: authorityRenderer,
        mount: false,
      });

      await suggestions(authority).reject(id);

      expect(readBaseText(authorityBase)).toBe(initial);
      expect(readBaseText(authoritySuggestion)).toBe(initial);
      const scope = authoritySuggestion.get("doc");
      const keptContent = [...authoritySuggestion.store.clients.values()]
        .flat()
        .filter(
          (struct): struct is Y.Item =>
            struct instanceof Y.Item &&
            Y.isParentOf(scope, struct) &&
            struct.keep,
        );
      expect(keptContent).toEqual([]);
      expect(suggestions(authority).store.get()).toEqual([
        expect.objectContaining({ id, status: "rejected" }),
      ]);
    },
  );

  it("keeps opposing peer review commands intent-only before one authority executes", async () => {
    const seed = createFixture("a");
    suggestions(seed.editor).enableSuggestions();
    insertText(seed.editor, textEnd(seed.editor), "X");
    const id = pending(seed.editor)[0]!.id;
    const baseA = cloneDoc(seed.baseDoc);
    const suggestionA = cloneDoc(seed.suggestionDoc, {
      isSuggestionDoc: true,
    });
    const baseB = cloneDoc(seed.baseDoc);
    const suggestionB = cloneDoc(seed.suggestionDoc, {
      isSuggestionDoc: true,
    });
    const editorA = createEditor(baseA, {
      suggestionDoc: suggestionA,
      renderer: Y.createDiffRenderer(baseA, suggestionA, {
        attrs: new Y.Attributions(),
      }),
      executeReviews: false,
    });
    const editorB = createEditor(baseB, {
      suggestionDoc: suggestionB,
      renderer: Y.createDiffRenderer(baseB, suggestionB, {
        attrs: new Y.Attributions(),
      }),
      executeReviews: false,
    });

    await suggestions(editorA).accept(id);
    await suggestions(editorB).reject(id);

    expect(readBaseText(baseA)).toBe("a");
    expect(readBaseText(baseB)).toBe("a");
    expect(readBaseText(suggestionA)).toBe("aX");
    expect(readBaseText(suggestionB)).toBe("aX");
    expect(suggestionA.get(LEDGER_NAMES.receipts).attrSize).toBe(0);
    expect(suggestionB.get(LEDGER_NAMES.receipts).attrSize).toBe(0);

    syncDocs(suggestionA, suggestionB);
    expect(suggestionA.get(LEDGER_NAMES.receipts).attrSize).toBe(0);
    expect(suggestionB.get(LEDGER_NAMES.receipts).attrSize).toBe(0);

    executeNativeSuggestionReviews(
      getNativeSuggestionsBinding(editorA)!,
      uuidFor(10),
    );
    syncDocs(baseA, baseB);
    syncDocs(suggestionA, suggestionB);
    const terminal = suggestions(editorA).store.get()[0]!;
    const expected = terminal.status === "accepted" ? "aX" : "a";

    expect(terminal.status).not.toBe("pending");
    expect(suggestionA.get(LEDGER_NAMES.receipts).attrSize).toBe(1);
    expect(suggestionB.get(LEDGER_NAMES.receipts).attrSize).toBe(1);
    expect(readBaseText(baseA)).toBe(expected);
    expect(readBaseText(baseB)).toBe(expected);
    expect(readBaseText(suggestionA)).toBe(expected);
    expect(readBaseText(suggestionB)).toBe(expected);
  });

  it("never reopens a terminal receipt from stale v1 projection or late ranges", async () => {
    const { suggestionDoc, editor } = createFixture("a");
    suggestions(editor).enableSuggestions();
    insertText(editor, textEnd(editor), "X");
    const binding = getNativeSuggestionsBinding(editor)!;
    const active = getNativeSuggestionRecords(binding).values().next().value!;

    await suggestions(editor).accept(active.id);
    suggestionDoc.transact(() => {
      suggestionDoc.get("__blocknote_suggestions").setAttr(active.id, {
        version: 1,
        id: active.id,
        authorId: "alice",
        kind: "insertion",
        preview: "stale",
        status: "pending",
        insertRanges: active.insertRanges,
        deleteRanges: [],
      });
      const ranges = suggestionDoc.get(LEDGER_NAMES.ranges);
      for (const range of active.insertRanges) {
        ranges.setAttr(rangeClaimId(active.id, "insert", range), {
          version: 2,
          suggestionId: active.id,
          role: "insert",
          ...range,
        });
      }
    });

    expect(suggestions(editor).store.get()).toEqual([
      expect.objectContaining({ id: active.id, status: "accepted" }),
    ]);
    expect(suggestionDoc.get(LEDGER_NAMES.ranges).attrSize).toBe(0);
  });

  it.each(["accepted", "rejected"] as const)(
    "resumes an interrupted %s disposition without replaying the decision",
    async (status) => {
      const { baseDoc, editor } = createFixture("a");
      suggestions(editor).enableSuggestions();
      insertText(editor, textEnd(editor), "X");
      const id = pending(editor)[0]!.id;
      const binding = getNativeSuggestionsBinding(editor)!;
      const ledger = getLedgerTypes(binding.suggestionDoc);
      const headerCount = ledger.headers.attrSize;
      let interrupted = false;
      setNativeSuggestionsResolutionPhaseHook(editor, (phase) => {
        if (phase === "after-content" && !interrupted) {
          interrupted = true;
          throw new Error("phase interruption");
        }
      });

      const first =
        status === "accepted"
          ? suggestions(editor).accept(id)
          : suggestions(editor).reject(id);
      await expect(first).rejects.toThrow("phase interruption");
      setNativeSuggestionsResolutionPhaseHook(editor, undefined);
      if (status === "accepted") {
        await suggestions(editor).accept(id);
        expect(readBaseText(baseDoc)).toBe("aX");
      } else {
        await suggestions(editor).reject(id);
        expect(readBaseText(baseDoc)).toBe("a");
      }
      expect(suggestions(editor).store.get()).toEqual([
        expect.objectContaining({ id, status }),
      ]);
      if (status === "rejected") {
        expect(ledger.headers.attrSize).toBe(headerCount);
        expect(ledger.ranges.attrSize).toBe(0);
      }
    },
  );

  it("keeps a terminal receipt authoritative over a late unreceipted conflict", async () => {
    const { baseDoc, suggestionDoc, editor } = createFixture("a");
    suggestions(editor).enableSuggestions();
    insertText(editor, textEnd(editor), "X");
    const id = pending(editor)[0]!.id;

    await suggestions(editor).accept(id);
    const conflictDecisionId = uuidFor(1);
    suggestionDoc
      .get(LEDGER_NAMES.dispositions)
      .setAttr(decisionEntryId(id, conflictDecisionId), {
        version: 2,
        suggestionId: id,
        decisionId: conflictDecisionId,
        status: "rejected",
      });

    expect(suggestions(editor).store.get()).toEqual([
      expect.objectContaining({ id, status: "accepted" }),
    ]);
    let contentOperations = 0;
    setNativeSuggestionsResolutionPhaseHook(editor, (phase) => {
      if (phase === "after-content") {
        contentOperations += 1;
      }
    });
    await suggestions(editor).reject(id);

    expect(contentOperations).toBe(0);
    expect(readBaseText(baseDoc)).toBe("aX");
    expect(suggestions(editor).store.get()).toEqual([
      expect.objectContaining({ id, status: "accepted" }),
    ]);
  });

  it("resolves terminal conflicts identically under opposite integration order", () => {
    const seed = createFixture("a");
    suggestions(seed.editor).enableSuggestions();
    insertText(seed.editor, textEnd(seed.editor), "X");
    const active = pending(seed.editor)[0]!;
    const baseA = cloneDoc(seed.baseDoc);
    const suggestionA = cloneDoc(seed.suggestionDoc, {
      isSuggestionDoc: true,
    });
    const baseB = cloneDoc(seed.baseDoc);
    const suggestionB = cloneDoc(seed.suggestionDoc, {
      isSuggestionDoc: true,
    });
    const terminalUpdate = (
      decisionId: string,
      status: "accepted" | "rejected",
      clientID: number,
    ) => {
      const updateDoc = new Y.Doc();
      updateDoc.clientID = clientID;
      docs.push(updateDoc);
      const key = decisionEntryId(active.id, decisionId);
      updateDoc.get(LEDGER_NAMES.dispositions).setAttr(key, {
        version: 2,
        suggestionId: active.id,
        decisionId,
        status,
      });
      updateDoc.get(LEDGER_NAMES.receipts).setAttr(key, {
        version: 2,
        suggestionId: active.id,
        decisionId,
        status,
        kind: "insertion",
        preview: status,
      });
      return Y.encodeStateAsUpdate(updateDoc);
    };
    const lower = terminalUpdate(uuidFor(1), "accepted", 21);
    const higher = terminalUpdate(uuidFor(2), "rejected", 22);
    Y.applyUpdate(suggestionA, lower);
    Y.applyUpdate(suggestionA, higher);
    Y.applyUpdate(suggestionB, higher);
    Y.applyUpdate(suggestionB, lower);
    const editorA = createEditor(baseA, {
      suggestionDoc: suggestionA,
      renderer: Y.createDiffRenderer(baseA, suggestionA, {
        attrs: new Y.Attributions(),
      }),
    });
    const editorB = createEditor(baseB, {
      suggestionDoc: suggestionB,
      renderer: Y.createDiffRenderer(baseB, suggestionB, {
        attrs: new Y.Attributions(),
      }),
    });

    expect(suggestions(editorA).store.get()).toEqual([
      expect.objectContaining({
        id: active.id,
        preview: "accepted",
        status: "accepted",
      }),
    ]);
    expect(suggestions(editorB).store.get()).toEqual(
      suggestions(editorA).store.get(),
    );
  });

  it("compacts terminal ranges and truncates the durable preview", async () => {
    const { suggestionDoc, editor } = createFixture("a");
    suggestions(editor).enableSuggestions();
    insertText(editor, textEnd(editor), "X".repeat(1_024));
    const id = pending(editor)[0]!.id;
    expect(pending(editor)[0]!.preview.length).toBe(1_024);

    await suggestions(editor).accept(id);

    const terminal = suggestions(editor).store.get()[0]!;
    expect(terminal).toMatchObject({ id, status: "accepted" });
    expect(terminal.preview.length).toBe(
      NATIVE_SUGGESTION_LIMITS.maxTerminalPreviewLength,
    );
    expect(suggestionDoc.get(LEDGER_NAMES.ranges).attrSize).toBe(0);
    expect(suggestionDoc.get(LEDGER_NAMES.receipts).attrSize).toBe(1);
  });
});
