import { uuidv4 } from "lib0/random";
import * as Y from "@y/y";

import { findTypeInOtherYdoc } from "../../utils.js";
import {
  assertLedgerCapacity,
  getIndexedRecords,
  markLedgerDirty,
} from "./ledger.js";
import {
  decisionEntryId,
  getLedgerTypes,
  ledgerOrigin,
  NATIVE_SUGGESTION_LIMITS,
  resolutionOrigin,
  utf8Length,
  type NativeDisposition,
  type NativeExecution,
  type NativeReceipt,
  type NativeSuggestionRecord,
  type NativeSuggestionsBinding,
  type NativeSuggestionStatus,
} from "./model.js";
import { retainResolutionContent } from "./retention.js";

type TerminalStatus = Exclude<NativeSuggestionStatus, "pending">;

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

function writeReviewIntents(
  binding: NativeSuggestionsBinding,
  records: readonly NativeSuggestionRecord[],
  status: TerminalStatus,
) {
  const actionable = records.filter(
    (record) => !record.hasReceipt && !record.hasExecution,
  );
  if (actionable.length === 0) {
    return false;
  }
  assertLedgerCapacity(binding, {
    entries: actionable.length,
    bytes: actionable.length * 128,
  });
  const dispositions = getLedgerTypes(binding.suggestionDoc).dispositions;
  binding.suggestionDoc.transact(() => {
    for (const record of actionable) {
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
  return true;
}

function writeExecutions(
  binding: NativeSuggestionsBinding,
  records: readonly NativeSuggestionRecord[],
  fenceId: string,
) {
  const actionable = records.filter(
    (record) =>
      !record.hasReceipt &&
      !record.hasExecution &&
      record.decisionId !== null &&
      record.decisionStatus !== null,
  );
  if (actionable.length === 0) {
    return;
  }
  assertLedgerCapacity(binding, {
    entries: actionable.length,
    bytes: actionable.length * 160,
  });
  const executions = getLedgerTypes(binding.suggestionDoc).intents;
  binding.suggestionDoc.transact(() => {
    for (const record of actionable) {
      const execution: NativeExecution = {
        version: 2,
        suggestionId: record.id,
        decisionId: record.decisionId!,
        status: record.decisionStatus!,
        fenceId,
      };
      executions.setAttr(
        decisionEntryId(record.id, record.decisionId!),
        execution,
      );
    }
  }, resolutionOrigin);
  markLedgerDirty(binding);
}

function writeReceipt(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  if (
    record.decisionId === null ||
    record.decisionStatus === null ||
    record.hasReceipt
  ) {
    return;
  }
  const ledger = getLedgerTypes(binding.suggestionDoc);
  const key = decisionEntryId(record.id, record.decisionId);
  if (ledger.receipts.hasAttr(key)) {
    return;
  }
  const preview = record.preview.slice(
    0,
    NATIVE_SUGGESTION_LIMITS.maxTerminalPreviewLength,
  );
  assertLedgerCapacity(binding, {
    ranges: -record.rangeKeys.length,
    entries: 1 - record.rangeKeys.length,
    bytes: 128 + utf8Length(preview) - record.rangeKeys.length * 128,
  });
  binding.suggestionDoc.transact(() => {
    const receipt: NativeReceipt = {
      version: 2,
      suggestionId: record.id,
      decisionId: record.decisionId!,
      status: record.decisionStatus!,
      kind: record.kind,
      preview,
    };
    ledger.receipts.setAttr(key, receipt);
    for (const rangeKey of record.rangeKeys) {
      ledger.ranges.deleteAttr(rangeKey);
    }
  }, resolutionOrigin);
  markLedgerDirty(binding);
}

function applyAcceptedContent(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  const baseDoc = binding.fragment.doc;
  if (!baseDoc) {
    return false;
  }
  const update = Y.intersectUpdateWithContentIds(
    Y.encodeStateAsUpdate(binding.suggestionDoc),
    record.contentIds,
  );
  Y.applyUpdate(baseDoc, update, binding.renderer);
  return true;
}

function applyRejectedContent(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  const baseDoc = binding.fragment.doc;
  if (!baseDoc) {
    return false;
  }
  const suggestionOrigins = binding.renderer.suggestionOrigins;
  const rendererObservers = binding.renderer as Y.DiffRenderer & {
    _observers: Map<string, Set<(...args: unknown[]) => void>>;
  };
  const changeObservers = rendererObservers._observers.get("change");
  rendererObservers._observers.set("change", new Set());
  let changed = Y.mergeIdSets([
    record.contentIds.inserts,
    record.contentIds.deletes,
  ]);
  binding.renderer.suggestionOrigins = [];
  try {
    binding.suggestionDoc.transact((transaction) => {
      oneShotUndoContentIds(binding, record.contentIds);
      retainResolutionContent(
        binding,
        transaction,
        record.id,
        transaction.insertSet,
      );
      changed = Y.mergeIdSets([
        changed,
        transaction.insertSet,
        transaction.deleteSet,
      ]);
      const update = Y.intersectUpdateWithContentIds(
        Y.encodeStateAsUpdate(binding.suggestionDoc),
        Y.createContentIds(transaction.insertSet, record.contentIds.deletes),
      );
      Y.applyUpdate(baseDoc, update, binding.renderer);
    }, resolutionOrigin);
  } finally {
    binding.renderer.suggestionOrigins = suggestionOrigins;
    if (changeObservers) {
      rendererObservers._observers.set("change", changeObservers);
    } else {
      rendererObservers._observers.delete("change");
    }
  }
  binding.renderer.emit("change", [changed, resolutionOrigin, true]);
  return true;
}

const activeFences = new WeakMap<NativeSuggestionsBinding, string>();

export function executeNativeSuggestionReviews(
  binding: NativeSuggestionsBinding,
  fenceId: string,
  ids?: readonly string[],
) {
  const activeFence = activeFences.get(binding);
  if (activeFence && activeFence !== fenceId) {
    throw new Error("Native suggestion review executor fence conflict");
  }
  activeFences.set(binding, fenceId);
  try {
    const requested = ids ? new Set(ids) : null;
    const candidates = [...getIndexedRecords(binding).values()]
      .filter(
        (record) =>
          (!requested || requested.has(record.id)) &&
          !record.hasReceipt &&
          record.decisionId !== null,
      )
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
    writeExecutions(binding, candidates, fenceId);
    if (candidates.length > 0) {
      binding.onResolutionPhase?.("after-intent");
    }

    const actionable = [...getIndexedRecords(binding).values()]
      .filter(
        (record) =>
          (!requested || requested.has(record.id)) &&
          record.hasExecution &&
          !record.hasReceipt &&
          record.decisionStatus !== null,
      )
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
    for (const record of actionable) {
      if (record.decisionStatus === "accepted") {
        if (!applyAcceptedContent(binding, record)) {
          continue;
        }
      } else if (!applyRejectedContent(binding, record)) {
        continue;
      }
      binding.onResolutionPhase?.("after-content");
      writeReceipt(binding, record);
    }
    getIndexedRecords(binding);
  } finally {
    activeFences.delete(binding);
  }
}

export async function resolveNativeSuggestions(
  binding: NativeSuggestionsBinding,
  ids: readonly string[],
  status: TerminalStatus,
) {
  const requested = new Set(ids);
  const records = [...getIndexedRecords(binding).values()].filter((record) =>
    requested.has(record.id),
  );
  const wrote = writeReviewIntents(binding, records, status);
  if (wrote) {
    binding.onResolutionPhase?.("after-disposition");
  }
  await binding.submitReview?.();
}

export function createLocalNativeSuggestionsExecutor(
  binding: NativeSuggestionsBinding,
) {
  const fenceId = uuidv4();
  return () => executeNativeSuggestionReviews(binding, fenceId);
}

export function acceptNativeSuggestion(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  return resolveNativeSuggestions(binding, [record.id], "accepted");
}

export function rejectNativeSuggestion(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  return resolveNativeSuggestions(binding, [record.id], "rejected");
}
