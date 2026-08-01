import { uuidv4 } from "lib0/random";
import * as Y from "@y/y";

import { findTypeInOtherYdoc } from "../../utils.js";
import { getIndexedRecords, markLedgerDirty } from "./ledger.js";
import {
  decisionEntryId,
  getLedgerTypes,
  ledgerOrigin,
  NATIVE_SUGGESTION_LIMITS,
  resolutionOrigin,
  type NativeAcceptIntent,
  type NativeDisposition,
  type NativeReceipt,
  type NativeSuggestionRecord,
  type NativeSuggestionsBinding,
  type NativeSuggestionStatus,
} from "./model.js";

function mergeContentIds(records: readonly NativeSuggestionRecord[]) {
  return Y.createContentIds(
    Y.mergeIdSets(records.map((record) => record.contentIds.inserts)),
    Y.mergeIdSets(records.map((record) => record.contentIds.deletes)),
  );
}

function oneShotUndoContentIds(
  binding: NativeSuggestionsBinding,
  contentIds: Y.ContentIds,
) {
  const scope = findTypeInOtherYdoc(binding.fragment, binding.suggestionDoc);
  const undoManager = new Y.UndoManager(scope, { trackedOrigins: new Set() });
  try {
    const stackItem: Y.UndoManager["undoStack"][number] = {
      inserts: Y.diffIdSet(contentIds.inserts, contentIds.deletes),
      deletes: Y.diffIdSet(contentIds.deletes, contentIds.inserts),
      meta: new Map(),
    };
    undoManager.undoStack.push(stackItem);
    undoManager.undo();
  } finally {
    undoManager.destroy();
  }
}

function writeDispositions(
  binding: NativeSuggestionsBinding,
  records: readonly NativeSuggestionRecord[],
  status: Exclude<NativeSuggestionStatus, "pending">,
) {
  const dispositions = getLedgerTypes(binding.suggestionDoc).dispositions;
  binding.suggestionDoc.transact(() => {
    for (const record of records) {
      if (record.status !== "pending") {
        continue;
      }
      const decisionId = uuidv4();
      const disposition: NativeDisposition = {
        version: 2,
        suggestionId: record.id,
        decisionId,
        status,
      };
      dispositions.setAttr(decisionEntryId(record.id, decisionId), disposition);
    }
  }, ledgerOrigin);
  markLedgerDirty(binding);
}

function writeAcceptIntents(
  binding: NativeSuggestionsBinding,
  records: readonly NativeSuggestionRecord[],
) {
  const intents = getLedgerTypes(binding.suggestionDoc).intents;
  binding.suggestionDoc.transact(() => {
    for (const record of records) {
      if (record.status !== "accepted" || record.decisionId === null) {
        continue;
      }
      const key = decisionEntryId(record.id, record.decisionId);
      if (!intents.hasAttr(key)) {
        const intent: NativeAcceptIntent = {
          version: 2,
          suggestionId: record.id,
          decisionId: record.decisionId,
          status: "accepted",
        };
        intents.setAttr(key, intent);
      }
    }
  }, ledgerOrigin);
  markLedgerDirty(binding);
}

function writeReceipts(
  binding: NativeSuggestionsBinding,
  records: readonly NativeSuggestionRecord[],
) {
  const ledger = getLedgerTypes(binding.suggestionDoc);
  binding.suggestionDoc.transact(() => {
    for (const record of records) {
      if (record.status === "pending" || record.decisionId === null) {
        continue;
      }
      const key = decisionEntryId(record.id, record.decisionId);
      if (!ledger.receipts.hasAttr(key)) {
        const receipt: NativeReceipt = {
          version: 2,
          suggestionId: record.id,
          decisionId: record.decisionId,
          status: record.status,
          kind: record.kind,
          preview: record.preview.slice(
            0,
            NATIVE_SUGGESTION_LIMITS.maxTerminalPreviewLength,
          ),
        };
        ledger.receipts.setAttr(key, receipt);
      }
      for (const rangeKey of record.rangeKeys) {
        ledger.ranges.deleteAttr(rangeKey);
      }
    }
  }, ledgerOrigin);
  markLedgerDirty(binding);
}

export function resolveNativeSuggestions(
  binding: NativeSuggestionsBinding,
  ids: readonly string[],
  status: Exclude<NativeSuggestionStatus, "pending">,
) {
  const requestedIds = new Set(ids);
  const before = [...getIndexedRecords(binding).values()].filter(
    (record) => requestedIds.has(record.id) && !record.hasReceipt,
  );
  if (before.length === 0) {
    return;
  }
  writeDispositions(binding, before, status);
  binding.onResolutionPhase?.("after-disposition");

  let actionable = [...getIndexedRecords(binding).values()].filter(
    (record) =>
      requestedIds.has(record.id) &&
      record.status === status &&
      !record.hasReceipt,
  );
  if (actionable.length === 0) {
    return;
  }

  if (status === "accepted") {
    writeAcceptIntents(binding, actionable);
    binding.onResolutionPhase?.("after-intent");
    actionable = [...getIndexedRecords(binding).values()].filter(
      (record) =>
        requestedIds.has(record.id) &&
        record.status === "accepted" &&
        record.hasAcceptIntent &&
        !record.hasReceipt,
    );
    const baseDoc = binding.fragment.doc;
    if (!baseDoc || actionable.length === 0) {
      return;
    }
    const update = Y.intersectUpdateWithContentIds(
      Y.encodeStateAsUpdate(binding.suggestionDoc),
      mergeContentIds(actionable),
    );
    Y.applyUpdate(baseDoc, update, resolutionOrigin);
    binding.onResolutionPhase?.("after-content");
    writeReceipts(binding, actionable);
  } else {
    const contentIds = mergeContentIds(actionable);
    binding.suggestionDoc.transact(() => {
      oneShotUndoContentIds(binding, contentIds);
      binding.onResolutionPhase?.("after-content");
      writeReceipts(binding, actionable);
    }, resolutionOrigin);
  }
  getIndexedRecords(binding);
}

export function acceptNativeSuggestion(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  resolveNativeSuggestions(binding, [record.id], "accepted");
}

export function rejectNativeSuggestion(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  resolveNativeSuggestions(binding, [record.id], "rejected");
}
