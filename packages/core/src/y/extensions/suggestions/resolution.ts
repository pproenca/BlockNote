import { uuidv4 } from "lib0/random";
import * as Y from "@y/y";

import {
  assertLedgerCapacity,
  getNativeSuggestionRevision,
  getIndexedRecords,
  markLedgerDirty,
} from "./ledger.js";
import { consumeNativeReviewAuthority } from "./authority.js";
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
  type NativeReviewAuthorityRequest,
} from "./model.js";

type TerminalStatus = Exclude<NativeSuggestionStatus, "pending">;

function writeReviewIntents(
  binding: NativeSuggestionsBinding,
  records: readonly NativeSuggestionRecord[],
  status: TerminalStatus,
) {
  const actionable = records.filter(
    (record) =>
      !record.hasReceipt && !record.hasExecution && record.decisionId === null,
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
  if (!binding.fragment.doc) return false;
  binding.renderer.resolveContentIds(
    record.contentIds,
    "accept",
    resolutionOrigin,
  );
  return true;
}

function applyRejectedContent(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  if (!binding.fragment.doc) return false;
  const renderer = binding.renderer as Y.DiffRenderer & {
    _observers: Map<string, Set<(...args: unknown[]) => void>>;
  };
  const observers = renderer._observers.get("change");
  renderer._observers.set("change", new Set());
  try {
    binding.renderer.resolveContentIds(
      record.contentIds,
      "reject",
      resolutionOrigin,
    );
  } finally {
    if (observers) renderer._observers.set("change", observers);
    else renderer._observers.delete("change");
  }
  return true;
}

const activeFences = new WeakMap<NativeSuggestionsBinding, string>();

export function executeNativeSuggestionReviews(
  binding: NativeSuggestionsBinding,
  capability: unknown,
  ids?: readonly string[],
) {
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
  const request: NativeReviewAuthorityRequest = Object.freeze({
    key: binding.authorityKey,
    actorId: binding.getActorId(),
    revision: getNativeSuggestionRevision(binding),
    reviews: Object.freeze(
      candidates.map((record) =>
        Object.freeze({
          suggestionId: record.id,
          decisionId: record.decisionId!,
          action: record.decisionStatus!,
        }),
      ),
    ),
  });
  const grant = consumeNativeReviewAuthority(binding, capability, request);
  const activeFence = activeFences.get(binding);
  if (activeFence && activeFence !== grant.fenceId) {
    throw new Error("Native suggestion review executor fence conflict");
  }
  activeFences.set(binding, grant.fenceId);
  try {
    writeExecutions(binding, candidates, grant.fenceId);
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
  _binding: NativeSuggestionsBinding,
) {
  return () => {
    throw new Error(
      "Native suggestion review authority capability is required",
    );
  };
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
