/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vite-plus/test";
import * as Y from "@y/y";

import { reconcileAttribution } from "./attribution.js";
import {
  getNativeSuggestionRecords,
  getNativeSuggestionsBinding,
} from "./native.js";
import {
  cloneDoc,
  createEditor,
  createFixture,
  createInsertionLedgerUpdate,
  docs,
  insertText,
  pending,
  setText,
  suggestions,
  textEnd,
  uuidFor,
} from "./test-fixture.js";

type AttributionRange = Parameters<
  Parameters<Y.IdMap<unknown>["forEach"]>[0]
>[0];
type AttributionValue = AttributionRange["attrs"][number];

function createAttributedTableFixture() {
  const baseDoc = new Y.Doc();
  const suggestionDoc = new Y.Doc({ isSuggestionDoc: true });
  baseDoc.clientID = 1;
  suggestionDoc.clientID = 2;
  docs.push(baseDoc, suggestionDoc);
  const attributions = new Y.Attributions();
  suggestionDoc.on("beforeObserverCalls", (transaction: Y.Transaction) => {
    if (!transaction.local) {
      return;
    }
    Y.insertIntoIdMap(
      attributions.inserts,
      Y.createIdMapFromIdSet(transaction.insertSet, [
        Y.createContentAttribute("insert", "alice"),
      ]),
    );
  });
  const renderer = Y.createDiffRenderer(baseDoc, suggestionDoc, {
    attrs: attributions,
  });
  const editor = createEditor(baseDoc, { suggestionDoc, renderer });
  editor.replaceBlocks(editor.document, [
    {
      id: "table",
      type: "table",
      content: {
        type: "tableContent",
        rows: [{ cells: ["A1", "B1"] }, { cells: ["A2", "B2"] }],
      },
    },
  ]);
  Y.applyUpdate(suggestionDoc, Y.encodeStateAsUpdate(baseDoc));
  return { renderer, editor };
}

function createConcurrentAttributedTableFixture() {
  const baseDoc = new Y.Doc();
  const suggestionDocA = new Y.Doc({ isSuggestionDoc: true });
  const suggestionDocB = new Y.Doc({ isSuggestionDoc: true });
  const suggestionDocMerged = new Y.Doc({ isSuggestionDoc: true });
  baseDoc.clientID = 1;
  suggestionDocA.clientID = 2;
  suggestionDocB.clientID = 3;
  suggestionDocMerged.clientID = 4;
  docs.push(baseDoc, suggestionDocA, suggestionDocB, suggestionDocMerged);
  const createRenderer = (
    suggestionDoc: Y.Doc,
    resolveActor: (transaction: Y.Transaction) => string | null,
  ) => {
    const attributions = new Y.Attributions();
    suggestionDoc.on("beforeObserverCalls", (transaction: Y.Transaction) => {
      const actor = resolveActor(transaction);
      if (actor === null) {
        return;
      }
      if (!transaction.insertSet.isEmpty()) {
        Y.insertIntoIdMap(
          attributions.inserts,
          Y.createIdMapFromIdSet(transaction.insertSet, [
            Y.createContentAttribute("insert", actor),
          ]),
        );
      }
      if (!transaction.deleteSet.isEmpty()) {
        Y.insertIntoIdMap(
          attributions.deletes,
          Y.createIdMapFromIdSet(transaction.deleteSet, [
            Y.createContentAttribute("delete", actor),
          ]),
        );
      }
    });
    return Y.createDiffRenderer(baseDoc, suggestionDoc, {
      attrs: attributions,
    });
  };
  const rendererA = createRenderer(suggestionDocA, (transaction) =>
    transaction.local ? "A" : null,
  );
  const rendererB = createRenderer(suggestionDocB, (transaction) =>
    transaction.local ? "B" : null,
  );
  const rendererMerged = createRenderer(suggestionDocMerged, (transaction) =>
    transaction.origin === "A" || transaction.origin === "B"
      ? transaction.origin
      : null,
  );
  const editorA = createEditor(baseDoc, {
    suggestionDoc: suggestionDocA,
    renderer: rendererA,
  });
  const editorB = createEditor(baseDoc, {
    suggestionDoc: suggestionDocB,
    renderer: rendererB,
  });
  const editorMerged = createEditor(baseDoc, {
    suggestionDoc: suggestionDocMerged,
    renderer: rendererMerged,
  });
  editorA.replaceBlocks(editorA.document, [
    {
      id: "table",
      type: "table",
      content: {
        type: "tableContent",
        rows: [{ cells: ["A1", "B1"] }, { cells: ["A2", "B2"] }],
      },
    },
  ]);
  for (const suggestionDoc of [
    suggestionDocA,
    suggestionDocB,
    suggestionDocMerged,
  ]) {
    Y.applyUpdate(suggestionDoc, Y.encodeStateAsUpdate(baseDoc));
  }
  return {
    editorA,
    editorB,
    editorMerged,
    rendererMerged,
    suggestionDocA,
    suggestionDocB,
    suggestionDocMerged,
  };
}

describe("suggestion attribution", () => {
  it("cancels a queued attribution refresh when the extension is destroyed", async () => {
    const { suggestionDoc, renderer, editor } = createFixture("a");
    suggestions(editor).enableSuggestions();
    const hostile = cloneDoc(suggestionDoc, { isSuggestionDoc: true });
    const hostileEditor = createEditor(hostile);
    setText(hostileEditor, "aX");
    Y.applyUpdate(suggestionDoc, Y.encodeStateAsUpdate(hostile));
    let changes = 0;
    const onChange = () => {
      changes += 1;
    };
    renderer.on("change", onChange);

    Y.applyUpdate(
      suggestionDoc,
      createInsertionLedgerUpdate(renderer, uuidFor(31)),
    );
    editor.destroy();
    await Promise.resolve();

    renderer.off("change", onChange);
    expect(changes).toBe(0);
  });

  it("emits the first empty-to-attributed overlay refresh", async () => {
    const { suggestionDoc, renderer, editor } = createFixture("a");
    suggestions(editor).enableSuggestions();
    const hostile = cloneDoc(suggestionDoc, { isSuggestionDoc: true });
    const hostileEditor = createEditor(hostile);
    setText(hostileEditor, "aX");
    Y.applyUpdate(suggestionDoc, Y.encodeStateAsUpdate(hostile));
    let sawAuthor = false;
    const onChange = () => {
      renderer.inserts.forEach((range: AttributionRange) => {
        sawAuthor ||= range.attrs.some(
          (attribute: AttributionValue) =>
            attribute.name === "insert" && attribute.val === "alice",
        );
      });
    };
    renderer.on("change", onChange);

    Y.applyUpdate(
      suggestionDoc,
      createInsertionLedgerUpdate(renderer, uuidFor(32)),
    );
    await Promise.resolve();

    renderer.off("change", onChange);
    expect(sawAuthor).toBe(true);
  });

  it("keeps author attribution idempotent and emits author replacement", async () => {
    const { renderer, editor } = createFixture("a");
    suggestions(editor).enableSuggestions();
    insertText(editor, textEnd(editor), "X");
    const binding = getNativeSuggestionsBinding(editor)!;
    const record = getNativeSuggestionRecords(binding).values().next().value!;
    renderer.replaceAttributions({
      inserts: Y.createIdMapFromIdSet(record.contentIds.inserts, [
        Y.createContentAttribute("insert", "alice"),
      ]),
      deletes: renderer.deletes,
    });

    reconcileAttribution(binding, new Map([[record.id, record]]), false);
    const recordAttributions = () =>
      Y.intersectMaps<Y.IdMap<unknown>, Y.IdSet>(
        renderer.inserts,
        record.contentIds.inserts,
      );
    const first = Y.encodeIdMap(recordAttributions());
    reconcileAttribution(binding, new Map([[record.id, record]]), false);

    recordAttributions().forEach((range: AttributionRange) => {
      const roles = range.attrs.filter(
        (attribute: AttributionValue) => attribute.name === "insert",
      );
      expect(roles).toHaveLength(1);
      expect(roles[0]!.val).toBe("alice");
      expect(
        range.attrs.some(
          (attribute: AttributionValue) =>
            attribute.name === "blocknoteSuggestionId",
        ),
      ).toBe(false);
    });
    expect(Y.encodeIdMap(recordAttributions())).toEqual(first);

    let changes = 0;
    const onChange = () => {
      changes += 1;
    };
    renderer.on("change", onChange);
    reconcileAttribution(
      binding,
      new Map([[record.id, { ...record, authorId: "bob" }]]),
      true,
    );
    await Promise.resolve();
    reconcileAttribution(
      binding,
      new Map([[record.id, { ...record, authorId: "bob" }]]),
      true,
    );
    await Promise.resolve();
    renderer.off("change", onChange);

    expect(changes).toBe(1);
    recordAttributions().forEach((range: AttributionRange) => {
      expect(
        range.attrs.filter(
          (attribute: AttributionValue) => attribute.name === "insert",
        ),
      ).toEqual([Y.createContentAttribute("insert", "bob")]);
    });
  });

  it("removes malformed anonymous role attribution", () => {
    const { renderer, editor } = createFixture("a");
    suggestions(editor).enableSuggestions();
    insertText(editor, textEnd(editor), "X");
    const binding = getNativeSuggestionsBinding(editor)!;
    const record = getNativeSuggestionRecords(binding).values().next().value!;
    renderer.replaceAttributions({
      inserts: Y.createIdMapFromIdSet(record.contentIds.inserts, [
        Y.createContentAttribute("insert", { malformed: true }),
      ]),
      deletes: renderer.deletes,
    });

    reconcileAttribution(
      binding,
      new Map([[record.id, { ...record, authorId: null }]]),
      false,
    );

    Y.intersectMaps<Y.IdMap<unknown>, Y.IdSet>(
      renderer.inserts,
      record.contentIds.inserts,
    ).forEach((range: AttributionRange) => {
      expect(
        range.attrs.filter(
          (attribute: AttributionValue) => attribute.name === "insert",
        ),
      ).toEqual([]);
    });
  });

  it("replaces source attribution instead of stacking duplicate role marks", () => {
    const { editor } = createAttributedTableFixture();
    suggestions(editor).enableSuggestions();

    editor.updateBlock("table", {
      type: "table",
      content: {
        type: "tableContent",
        rows: [
          { cells: ["A1", "B1"] },
          { cells: ["A2", "B2"] },
          { cells: ["A3", "B3"] },
        ],
      },
    });

    expect(pending(editor)).toHaveLength(1);
    editor.prosemirrorState.doc.descendants((node) => {
      const marks = node.marks.filter(
        (mark) => mark.type.name === "y-attributed-insert",
      );
      expect(marks).toHaveLength(marks.length === 0 ? 0 : 1);
      return true;
    });
  });

  it("does not stack source and ledger attribution after a concurrent merge", async () => {
    const {
      editorA,
      editorB,
      editorMerged,
      rendererMerged,
      suggestionDocA,
      suggestionDocB,
      suggestionDocMerged,
    } = createConcurrentAttributedTableFixture();
    suggestions(editorA).enableSuggestions();
    suggestions(editorB).enableSuggestions();
    suggestions(editorMerged).enableSuggestions();

    editorA.updateBlock("table", {
      type: "table",
      content: {
        type: "tableContent",
        rows: [
          { cells: ["A1", "B1"] },
          { cells: ["A2", "B2"] },
          { cells: ["A3", "B3"] },
        ],
      },
    });
    editorB.updateBlock("table", {
      type: "table",
      content: {
        type: "tableContent",
        rows: [{ cells: ["A1", "B1", "C1"] }, { cells: ["A2", "B2", "C2"] }],
      },
    });
    Y.applyUpdate(
      suggestionDocMerged,
      Y.encodeStateAsUpdate(suggestionDocA),
      "A",
    );
    Y.applyUpdate(
      suggestionDocMerged,
      Y.encodeStateAsUpdate(suggestionDocB),
      "B",
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(pending(editorMerged).length).toBeGreaterThanOrEqual(2);
    let maxRendererRoles = 0;
    rendererMerged.inserts.forEach((range: AttributionRange) => {
      maxRendererRoles = Math.max(
        maxRendererRoles,
        range.attrs.filter(
          (attribute: AttributionValue) => attribute.name === "insert",
        ).length,
      );
    });
    expect(maxRendererRoles).toBe(1);
    editorMerged.prosemirrorState.doc.descendants((node) => {
      const marks = node.marks.filter(
        (mark) => mark.type.name === "y-attributed-insert",
      );
      expect(marks.length).toBeLessThanOrEqual(1);
      return true;
    });
  });

  it("does not stack deleted source and ledger attribution after a concurrent merge", async () => {
    const {
      editorA,
      editorB,
      editorMerged,
      rendererMerged,
      suggestionDocA,
      suggestionDocB,
      suggestionDocMerged,
    } = createConcurrentAttributedTableFixture();
    suggestions(editorA).enableSuggestions();
    suggestions(editorB).enableSuggestions();
    suggestions(editorMerged).enableSuggestions();

    editorA.updateBlock("table", {
      type: "table",
      content: {
        type: "tableContent",
        rows: [{ cells: ["A1"] }, { cells: ["A2"] }],
      },
    });
    editorB.updateBlock("table", {
      type: "table",
      content: {
        type: "tableContent",
        rows: [
          { cells: ["A1", "B1"] },
          { cells: ["A2", "B2"] },
          { cells: ["A3", "B3"] },
        ],
      },
    });
    Y.applyUpdate(
      suggestionDocMerged,
      Y.encodeStateAsUpdate(suggestionDocA),
      "A",
    );
    await Promise.resolve();
    await Promise.resolve();
    let duplicateDeleteMarksAfterA = 0;
    editorMerged.prosemirrorState.doc.descendants((node) => {
      if (
        node.marks.filter((mark) => mark.type.name === "y-attributed-delete")
          .length > 1
      ) {
        duplicateDeleteMarksAfterA += 1;
      }
      return true;
    });
    expect(duplicateDeleteMarksAfterA).toBe(0);
    Y.applyUpdate(
      suggestionDocMerged,
      Y.encodeStateAsUpdate(suggestionDocB),
      "B",
    );
    await Promise.resolve();
    await Promise.resolve();
    let maxRendererRoles = 0;
    rendererMerged.deletes.forEach((range: AttributionRange) => {
      maxRendererRoles = Math.max(
        maxRendererRoles,
        range.attrs.filter(
          (attribute: AttributionValue) => attribute.name === "delete",
        ).length,
      );
    });
    expect(maxRendererRoles).toBe(1);
    const duplicateMarks: unknown[] = [];
    editorMerged.prosemirrorState.doc.descendants((node) => {
      const marks = node.marks.filter(
        (mark) => mark.type.name === "y-attributed-delete",
      );
      if (marks.length > 1) {
        duplicateMarks.push(marks.map((mark) => mark.attrs));
      }
      return true;
    });
    expect(duplicateMarks).toEqual([]);
  });
});
