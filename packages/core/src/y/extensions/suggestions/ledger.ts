import { uuidv4 } from "lib0/random";
import * as Y from "@y/y";

import { findTypeInOtherYdoc } from "../../utils.js";
import {
  activateAttribution,
  disposeAttribution,
  reconcileAttribution,
} from "./attribution.js";
import {
  actorIdFor,
  compareCodeUnits,
  decisionEntryId,
  getLedgerTypes,
  idSetFromRanges,
  isAcceptIntent,
  isDisposition,
  isHeader,
  isRangeClaim,
  isReceipt,
  kindFor,
  ledgerOrigin,
  NATIVE_SUGGESTION_LIMITS,
  orderFor,
  previewFromIds,
  rangeClaimId,
  rangeIsCovered,
  rangesFromIdSet,
  resolutionOrigin,
  utf8Length,
  type IndexedRangeClaim,
  type LedgerTypes,
  type NativeAcceptIntent,
  type NativeDisposition,
  type NativeRangeClaim,
  type NativeReceipt,
  type NativeSuggestionHeader,
  type NativeSuggestionRecord,
  type NativeSuggestionsBinding,
} from "./model.js";

type LedgerIndex = {
  dirty: boolean;
  records: ReadonlyMap<string, NativeSuggestionRecord>;
  revision: number;
};

const indexes = new WeakMap<NativeSuggestionsBinding, LedgerIndex>();

export function markLedgerDirty(binding: NativeSuggestionsBinding) {
  const index = indexes.get(binding);
  if (index) {
    index.dirty = true;
  } else {
    indexes.set(binding, { dirty: true, records: new Map(), revision: 0 });
  }
}

function ledgerEntryCount(ledger: LedgerTypes) {
  return Object.values(ledger).reduce(
    (total, type) => total + type.attrSize,
    0,
  );
}

function rangeIsInScope(doc: Y.Doc, scope: Y.Type, range: NativeRangeClaim) {
  const structs = doc.store.clients.get(range.client);
  if (!structs) {
    return false;
  }
  let covered = 0;
  for (const struct of structs) {
    const from = Math.max(struct.id.clock, range.clock);
    const to = Math.min(
      struct.id.clock + struct.length,
      range.clock + range.length,
    );
    if (to <= from) {
      continue;
    }
    if (!(struct instanceof Y.Item) || !Y.isParentOf(scope, struct)) {
      return false;
    }
    covered += to - from;
  }
  return covered === range.length;
}

function idsInScope(transaction: Y.Transaction, scope: Y.Type, ids: Y.IdSet) {
  const scoped = Y.createIdSet();
  Y.iterateStructsByIdSet(transaction, ids, (struct) => {
    if (struct instanceof Y.Item && Y.isParentOf(scope, struct)) {
      scoped.add(struct.id.client, struct.id.clock, struct.length);
    }
  });
  return scoped;
}

function scanLedger(binding: NativeSuggestionsBinding) {
  const ledger = getLedgerTypes(binding.suggestionDoc);
  if (ledgerEntryCount(ledger) > NATIVE_SUGGESTION_LIMITS.maxLedgerEntries) {
    return new Map<string, NativeSuggestionRecord>();
  }

  const headers = new Map<string, NativeSuggestionHeader>();
  const claims = new Map<string, IndexedRangeClaim[]>();
  const dispositions = new Map<string, NativeDisposition[]>();
  const intents = new Map<string, NativeAcceptIntent>();
  const receipts = new Map<string, NativeReceipt>();
  let bytes = 0;
  let rangeCount = 0;

  ledger.headers.forEachAttr((value: unknown, key) => {
    if (typeof key === "string" && isHeader(key, value)) {
      headers.set(key, value);
      bytes += 96 + utf8Length(value.authorId ?? "");
    }
  });
  ledger.ranges.forEachAttr((value: unknown, key) => {
    if (typeof key === "string" && isRangeClaim(key, value)) {
      const existing = claims.get(value.suggestionId) ?? [];
      existing.push({ ...value, key });
      claims.set(value.suggestionId, existing);
      rangeCount += 1;
      bytes += 128;
    }
  });
  ledger.dispositions.forEachAttr((value: unknown, key) => {
    if (typeof key === "string" && isDisposition(key, value)) {
      const existing = dispositions.get(value.suggestionId) ?? [];
      existing.push(value);
      dispositions.set(value.suggestionId, existing);
      bytes += 128;
    }
  });
  ledger.intents.forEachAttr((value: unknown, key) => {
    if (typeof key === "string" && isAcceptIntent(key, value)) {
      intents.set(key, value);
      bytes += 112;
    }
  });
  ledger.receipts.forEachAttr((value: unknown, key) => {
    if (typeof key === "string" && isReceipt(key, value)) {
      receipts.set(key, value);
      bytes += 128 + utf8Length(value.preview);
    }
  });

  if (
    headers.size > NATIVE_SUGGESTION_LIMITS.maxRecords ||
    rangeCount > NATIVE_SUGGESTION_LIMITS.maxTotalRanges ||
    bytes > NATIVE_SUGGESTION_LIMITS.maxLedgerBytes
  ) {
    return new Map<string, NativeSuggestionRecord>();
  }

  const diffInserts = Y.createIdSetFromIdMap(binding.renderer.inserts);
  const diffDeletes = Y.createIdSetFromIdMap(binding.renderer.deletes);
  const scope = findTypeInOtherYdoc(binding.fragment, binding.suggestionDoc);
  const candidates: NativeSuggestionRecord[] = [];
  for (const id of [...headers.keys()].sort(compareCodeUnits)) {
    const header = headers.get(id)!;
    const orderedDispositions = (dispositions.get(id) ?? []).sort(
      (left, right) => compareCodeUnits(left.decisionId, right.decisionId),
    );
    const disposition =
      orderedDispositions.find(
        (candidate) =>
          receipts.get(decisionEntryId(id, candidate.decisionId))?.status ===
          candidate.status,
      ) ?? orderedDispositions[0];
    const decisionId = disposition?.decisionId ?? null;
    const receiptKey = decisionId ? decisionEntryId(id, decisionId) : null;
    const receipt = receiptKey ? receipts.get(receiptKey) : undefined;
    const hasReceipt = receipt?.status === disposition?.status;
    const hasAcceptIntent =
      disposition?.status === "accepted" &&
      receiptKey !== null &&
      intents.get(receiptKey)?.status === "accepted";
    const recordClaims = claims.get(id) ?? [];
    if (recordClaims.length > NATIVE_SUGGESTION_LIMITS.maxRangesPerRecord) {
      continue;
    }

    if (hasReceipt && receipt) {
      candidates.push({
        version: 2,
        id,
        authorId: header.authorId,
        creatorId: header.creatorId,
        kind: receipt.kind,
        preview: receipt.preview,
        status: receipt.status,
        order: `~/${id}`,
        insertRanges: [],
        deleteRanges: [],
        contentIds: Y.createContentIds(),
        decisionId,
        hasAcceptIntent,
        hasReceipt: true,
        rangeKeys: recordClaims.map((claim) => claim.key),
      });
      continue;
    }

    const allowResolvedRanges = disposition !== undefined && !hasReceipt;
    const proposedInsertRanges = recordClaims
      .filter(
        (claim) =>
          claim.role === "insert" &&
          rangeIsInScope(binding.suggestionDoc, scope, claim) &&
          (allowResolvedRanges || rangeIsCovered(diffInserts, claim)),
      )
      .map(({ client, clock, length }) => ({ client, clock, length }));
    const proposedDeleteRanges = recordClaims
      .filter(
        (claim) =>
          claim.role === "delete" &&
          rangeIsInScope(binding.suggestionDoc, scope, claim) &&
          (allowResolvedRanges || rangeIsCovered(diffDeletes, claim)),
      )
      .map(({ client, clock, length }) => ({ client, clock, length }));
    const inserts = idSetFromRanges(proposedInsertRanges);
    const deletes = idSetFromRanges(proposedDeleteRanges);
    if (inserts.isEmpty() && deletes.isEmpty()) {
      continue;
    }
    const insertionPreview = previewFromIds(binding.suggestionDoc, inserts);
    const deletionPreview = previewFromIds(binding.fragment.doc, deletes);
    const insertRanges = rangesFromIdSet(inserts);
    const deleteRanges = rangesFromIdSet(deletes);
    candidates.push({
      version: 2,
      id,
      authorId: header.authorId,
      creatorId: header.creatorId,
      kind: kindFor(inserts, deletes),
      preview: insertionPreview || deletionPreview,
      status: disposition?.status ?? "pending",
      order: orderFor(id, insertRanges, deleteRanges),
      insertRanges,
      deleteRanges,
      contentIds: Y.createContentIds(inserts, deletes),
      decisionId,
      hasAcceptIntent,
      hasReceipt: false,
      rangeKeys: recordClaims.map((claim) => claim.key),
    });
  }

  const records = new Map<string, NativeSuggestionRecord>();
  const owned = Y.createIdSet();
  for (const candidate of candidates.sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  )) {
    const claimed = Y.mergeIdSets([
      candidate.contentIds.inserts,
      candidate.contentIds.deletes,
    ]);
    if (!Y.intersectSets(owned, claimed).isEmpty()) {
      continue;
    }
    Y.insertIntoIdSet(owned, claimed);
    records.set(candidate.id, candidate);
  }
  return records;
}

export function getIndexedRecords(
  binding: NativeSuggestionsBinding,
  emitAttributionChange = false,
) {
  let index = indexes.get(binding);
  if (!index) {
    index = { dirty: true, records: new Map(), revision: 0 };
    indexes.set(binding, index);
  }
  if (index.dirty) {
    index.records = scanLedger(binding);
    index.revision += 1;
    index.dirty = false;
    reconcileAttribution(binding, index.records, emitAttributionChange);
  }
  return index.records;
}

function intersectsItem(idSet: Y.IdSet, item: Y.Item) {
  return idSet.intersects(item.id.client, item.id.clock, item.length);
}

function contentIdsTouch(
  transaction: Y.Transaction,
  left: Y.ContentIds,
  right: Y.ContentIds,
) {
  const leftIds = Y.mergeIdSets([left.inserts, left.deletes]);
  const rightIds = Y.mergeIdSets([right.inserts, right.deletes]);
  if (!Y.intersectSets(leftIds, rightIds).isEmpty()) {
    return true;
  }
  let touches = false;
  Y.iterateStructsByIdSet(transaction, leftIds, (struct) => {
    if (
      !touches &&
      struct instanceof Y.Item &&
      ((struct.left !== null && intersectsItem(rightIds, struct.left)) ||
        (struct.right !== null && intersectsItem(rightIds, struct.right)))
    ) {
      touches = true;
    }
  });
  return touches;
}

function appendClaims(
  binding: NativeSuggestionsBinding,
  transaction: Y.Transaction,
  inserts: Y.IdSet,
  deletes: Y.IdSet,
) {
  const authorId = actorIdFor(binding);
  const changes = Y.createContentIds(inserts, deletes);
  const continuation =
    authorId === null
      ? undefined
      : [...getIndexedRecords(binding).values()]
          .filter(
            (record) =>
              record.status === "pending" &&
              record.creatorId === binding.creatorId &&
              contentIdsTouch(transaction, changes, record.contentIds),
          )
          .sort((left, right) => compareCodeUnits(left.id, right.id))[0];
  const suggestionId = continuation?.id ?? uuidv4();
  const header: NativeSuggestionHeader | undefined = continuation
    ? undefined
    : {
        version: 2,
        id: suggestionId,
        authorId,
        creatorId: binding.creatorId,
      };
  const ranges = [
    ...rangesFromIdSet(inserts).map((range) => ({
      role: "insert" as const,
      range,
    })),
    ...rangesFromIdSet(deletes).map((range) => ({
      role: "delete" as const,
      range,
    })),
  ];
  if (
    (continuation?.rangeKeys.length ?? 0) + ranges.length >
    NATIVE_SUGGESTION_LIMITS.maxRangesPerRecord
  ) {
    return;
  }

  const ledger = getLedgerTypes(binding.suggestionDoc);
  binding.suggestionDoc.transact(() => {
    if (header) {
      ledger.headers.setAttr(header.id, header);
    }
    for (const { role, range } of ranges) {
      const key = rangeClaimId(suggestionId, role, range);
      const claim: NativeRangeClaim = {
        version: 2,
        suggestionId,
        role,
        ...range,
      };
      ledger.ranges.setAttr(key, claim);
    }
  }, ledgerOrigin);
  markLedgerDirty(binding);
  getIndexedRecords(binding, false);
}

function compactTerminalRanges(
  binding: NativeSuggestionsBinding,
  records: ReadonlyMap<string, NativeSuggestionRecord>,
) {
  const keys = [...records.values()]
    .filter((record) => record.hasReceipt && record.rangeKeys.length > 0)
    .flatMap((record) => record.rangeKeys);
  if (keys.length === 0) {
    return;
  }
  const ranges = getLedgerTypes(binding.suggestionDoc).ranges;
  binding.suggestionDoc.transact(() => {
    for (const key of keys) {
      ranges.deleteAttr(key);
    }
  }, ledgerOrigin);
  markLedgerDirty(binding);
}

export function observeNativeSuggestions(
  binding: NativeSuggestionsBinding,
  onChange: () => void,
) {
  activateAttribution(binding);
  let refreshing = false;
  const onSuggestionTransaction = (transaction: Y.Transaction) => {
    markLedgerDirty(binding);
    if (refreshing) {
      return;
    }
    refreshing = true;
    try {
      const ledger = getLedgerTypes(binding.suggestionDoc);
      const ledgerChanged = Object.values(ledger).some((type) =>
        transaction.changedParentTypes.has(type),
      );
      const shouldEmitAttribution =
        ledgerChanged &&
        transaction.origin !== ledgerOrigin &&
        transaction.origin !== resolutionOrigin;
      const records = getIndexedRecords(binding, shouldEmitAttribution);
      compactTerminalRanges(binding, records);
      onChange();
    } finally {
      refreshing = false;
    }
  };
  const onBaseTransaction = () => {
    markLedgerDirty(binding);
    onChange();
  };
  const onBeforeObserverCalls = (transaction: Y.Transaction) => {
    if (
      transaction.origin === ledgerOrigin ||
      transaction.origin === resolutionOrigin
    ) {
      return;
    }
    const scope = findTypeInOtherYdoc(binding.fragment, binding.suggestionDoc);
    if (!transaction.local) {
      markLedgerDirty(binding);
      getIndexedRecords(binding, true);
      return;
    }
    if (!binding.renderer.suggestionMode) {
      return;
    }
    const inserts = idsInScope(
      transaction,
      scope,
      Y.intersectSets(transaction.insertSet, binding.renderer.inserts),
    );
    const deletes = idsInScope(
      transaction,
      scope,
      Y.intersectSets(transaction.deleteSet, binding.renderer.deletes),
    );
    if (!inserts.isEmpty() || !deletes.isEmpty()) {
      appendClaims(binding, transaction, inserts, deletes);
    }
  };

  binding.suggestionDoc.on("beforeObserverCalls", onBeforeObserverCalls);
  binding.suggestionDoc.on("afterTransaction", onSuggestionTransaction);
  binding.fragment.doc?.on("afterTransaction", onBaseTransaction);
  markLedgerDirty(binding);
  getIndexedRecords(binding, false);

  return () => {
    binding.suggestionDoc.off("beforeObserverCalls", onBeforeObserverCalls);
    binding.suggestionDoc.off("afterTransaction", onSuggestionTransaction);
    binding.fragment.doc?.off("afterTransaction", onBaseTransaction);
    disposeAttribution(binding);
    indexes.delete(binding);
  };
}
