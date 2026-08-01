import { uuidv4 } from "lib0/random";
import * as Y from "@y/y";

import type { BlockNoteEditor } from "../../../editor/BlockNoteEditor.js";

export type NativeSuggestionStatus = "pending" | "accepted" | "rejected";

export type NativeSuggestionKind = "insertion" | "deletion" | "replacement";

type NativeIdRange = {
  readonly client: number;
  readonly clock: number;
  readonly length: number;
};

export type NativeSuggestionRecord = {
  readonly version: 1;
  readonly id: string;
  readonly authorId: string | null;
  readonly kind: NativeSuggestionKind;
  readonly preview: string;
  readonly status: NativeSuggestionStatus;
  readonly insertRanges: readonly NativeIdRange[];
  readonly deleteRanges: readonly NativeIdRange[];
};

export type NativeSuggestionsBinding = {
  readonly fragment: Y.Type;
  readonly suggestionDoc: Y.Doc;
  readonly renderer: Y.DiffRenderer;
  readonly getActorId: () => string | null;
};

const LEDGER_KEY = "__blocknote_suggestions";
const SUGGESTION_ID_ATTR = "blocknoteSuggestionId";
const MAX_SUGGESTION_ID_LENGTH = 128;
const MAX_AUTHOR_ID_LENGTH = 512;
const MAX_PREVIEW_LENGTH = 16_384;
const MAX_ID_RANGES = 4_096;
const ledgerOrigin = Symbol("blocknote-suggestion-ledger");
const bindings = new WeakMap<
  BlockNoteEditor<any, any, any>,
  NativeSuggestionsBinding
>();

export function registerNativeSuggestionsBinding(
  editor: BlockNoteEditor<any, any, any>,
  binding: NativeSuggestionsBinding,
) {
  bindings.set(editor, binding);
}

export function getNativeSuggestionsBinding(
  editor: BlockNoteEditor<any, any, any>,
) {
  return bindings.get(editor);
}

function getLedger(doc: Y.Doc) {
  return doc.get(LEDGER_KEY);
}

function rangesFromIdSet(idSet: Y.IdSet) {
  const ranges: NativeIdRange[] = [];
  idSet.forEach((range, client) => {
    ranges.push({ client, clock: range.clock, length: range.len });
  });
  return ranges.sort(
    (left, right) =>
      left.client - right.client ||
      left.clock - right.clock ||
      left.length - right.length,
  );
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isNativeIdRange(value: unknown): value is NativeIdRange {
  if (!value || typeof value !== "object") {
    return false;
  }
  const range = value as Partial<NativeIdRange>;
  return (
    Number.isSafeInteger(range.client) &&
    range.client! >= 0 &&
    Number.isSafeInteger(range.clock) &&
    range.clock! >= 0 &&
    Number.isSafeInteger(range.length) &&
    range.length! > 0 &&
    range.clock! + range.length! <= Number.MAX_SAFE_INTEGER
  );
}

function isNativeIdRangeArray(value: unknown): value is NativeIdRange[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ID_RANGES &&
    value.every(isNativeIdRange)
  );
}

function idSetFromRanges(ranges: readonly NativeIdRange[]) {
  const idSet = Y.createIdSet();
  for (const range of ranges) {
    idSet.add(range.client, range.clock, range.length);
  }
  return idSet;
}

function contentIdsFor(record: NativeSuggestionRecord) {
  return Y.createContentIds(
    idSetFromRanges(record.insertRanges),
    idSetFromRanges(record.deleteRanges),
  );
}

function isNativeSuggestionRecord(
  key: string,
  value: unknown,
): value is NativeSuggestionRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<NativeSuggestionRecord>;
  return (
    record.version === 1 &&
    isBoundedString(record.id, MAX_SUGGESTION_ID_LENGTH) &&
    record.id.length > 0 &&
    record.id === key &&
    (record.authorId === null ||
      isBoundedString(record.authorId, MAX_AUTHOR_ID_LENGTH)) &&
    (record.kind === "insertion" ||
      record.kind === "deletion" ||
      record.kind === "replacement") &&
    isBoundedString(record.preview, MAX_PREVIEW_LENGTH) &&
    (record.status === "pending" ||
      record.status === "accepted" ||
      record.status === "rejected") &&
    isNativeIdRangeArray(record.insertRanges) &&
    isNativeIdRangeArray(record.deleteRanges)
  );
}

export function getNativeSuggestionRecords(binding: NativeSuggestionsBinding) {
  const records = new Map<string, NativeSuggestionRecord>();
  getLedger(binding.suggestionDoc).forEachAttr((value: unknown, key) => {
    if (typeof key === "string" && isNativeSuggestionRecord(key, value)) {
      records.set(value.id, value);
    }
  });
  return records;
}

function attributionFor(
  kind: "insert" | "delete",
  record: NativeSuggestionRecord,
) {
  const attrs = [Y.createContentAttribute(SUGGESTION_ID_ATTR, record.id)];
  if (record.authorId !== null) {
    attrs.push(Y.createContentAttribute(kind, record.authorId));
  }
  return attrs;
}

function applyRecordAttribution(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  if (record.status !== "pending") {
    return;
  }
  const inserts = idSetFromRanges(record.insertRanges);
  const deletes = idSetFromRanges(record.deleteRanges);
  if (!inserts.isEmpty()) {
    Y.insertIntoIdMap(
      binding.renderer.inserts,
      Y.createIdMapFromIdSet(inserts, attributionFor("insert", record)),
    );
  }
  if (!deletes.isEmpty()) {
    Y.insertIntoIdMap(
      binding.renderer.deletes,
      Y.createIdMapFromIdSet(deletes, attributionFor("delete", record)),
    );
  }
}

function writeRecord(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  binding.suggestionDoc.transact(() => {
    getLedger(binding.suggestionDoc).setAttr(record.id, record);
  }, ledgerOrigin);
}

function kindFor(inserts: Y.IdSet, deletes: Y.IdSet): NativeSuggestionKind {
  return !inserts.isEmpty() && !deletes.isEmpty()
    ? "replacement"
    : inserts.isEmpty()
      ? "deletion"
      : "insertion";
}

function actorIdFor(binding: NativeSuggestionsBinding) {
  let actorId: unknown = null;
  try {
    actorId = binding.getActorId();
  } catch {
    return null;
  }
  return actorId === null || isBoundedString(actorId, MAX_AUTHOR_ID_LENGTH)
    ? actorId
    : null;
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

function extendRecord(
  record: NativeSuggestionRecord,
  inserts: Y.IdSet,
  deletes: Y.IdSet,
) {
  const mergedInserts = Y.mergeIdSets([
    idSetFromRanges(record.insertRanges),
    inserts,
  ]);
  const mergedDeletes = Y.mergeIdSets([
    idSetFromRanges(record.deleteRanges),
    deletes,
  ]);
  const insertRanges = rangesFromIdSet(mergedInserts);
  const deleteRanges = rangesFromIdSet(mergedDeletes);
  if (
    insertRanges.length > MAX_ID_RANGES ||
    deleteRanges.length > MAX_ID_RANGES
  ) {
    return undefined;
  }
  return {
    ...record,
    kind: kindFor(mergedInserts, mergedDeletes),
    insertRanges,
    deleteRanges,
  } satisfies NativeSuggestionRecord;
}

function createOrExtendRecord(
  binding: NativeSuggestionsBinding,
  transaction: Y.Transaction,
  inserts: Y.IdSet,
  deletes: Y.IdSet,
): NativeSuggestionRecord | undefined {
  const authorId = actorIdFor(binding);
  const changes = Y.createContentIds(inserts, deletes);
  const continuation = [...getNativeSuggestionRecords(binding).values()]
    .filter(
      (record) =>
        record.status === "pending" &&
        record.authorId === authorId &&
        contentIdsTouch(transaction, changes, contentIdsFor(record)),
    )
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (continuation) {
    const extended = extendRecord(continuation, inserts, deletes);
    if (extended) {
      return extended;
    }
  }

  const insertRanges = rangesFromIdSet(inserts);
  const deleteRanges = rangesFromIdSet(deletes);
  if (
    insertRanges.length > MAX_ID_RANGES ||
    deleteRanges.length > MAX_ID_RANGES
  ) {
    return undefined;
  }
  return {
    version: 1,
    id: uuidv4(),
    authorId,
    kind: kindFor(inserts, deletes),
    preview: "",
    status: "pending",
    insertRanges,
    deleteRanges,
  };
}

export function observeNativeSuggestions(
  binding: NativeSuggestionsBinding,
  onChange: () => void,
) {
  const ledger = getLedger(binding.suggestionDoc);

  for (const record of getNativeSuggestionRecords(binding).values()) {
    applyRecordAttribution(binding, record);
  }

  const onBeforeObserverCalls = (transaction: Y.Transaction) => {
    if (transaction.origin === ledgerOrigin) {
      return;
    }
    if (!transaction.local) {
      for (const record of getNativeSuggestionRecords(binding).values()) {
        applyRecordAttribution(binding, record);
      }
      return;
    }
    if (!binding.renderer.suggestionMode) {
      return;
    }
    const inserts = Y.intersectSets(
      transaction.insertSet,
      binding.renderer.inserts,
    );
    const deletes = Y.intersectSets(
      transaction.deleteSet,
      binding.renderer.deletes,
    );
    if (inserts.isEmpty() && deletes.isEmpty()) {
      return;
    }
    const record = createOrExtendRecord(binding, transaction, inserts, deletes);
    if (!record) {
      return;
    }
    applyRecordAttribution(binding, record);
    writeRecord(binding, record);
  };

  const onLedgerChange = () => {
    for (const record of getNativeSuggestionRecords(binding).values()) {
      applyRecordAttribution(binding, record);
    }
    onChange();
  };

  binding.suggestionDoc.on("beforeObserverCalls", onBeforeObserverCalls);
  ledger.observe(onLedgerChange);

  return () => {
    binding.suggestionDoc.off("beforeObserverCalls", onBeforeObserverCalls);
    ledger.unobserve(onLedgerChange);
  };
}

export function updateNativeSuggestionProjections(
  binding: NativeSuggestionsBinding,
  projections: ReadonlyMap<
    string,
    Pick<NativeSuggestionRecord, "kind" | "preview">
  >,
) {
  const records = getNativeSuggestionRecords(binding);
  const updates: NativeSuggestionRecord[] = [];
  for (const [id, projection] of projections) {
    const record = records.get(id);
    const preview = projection.preview.slice(0, MAX_PREVIEW_LENGTH);
    if (
      record?.status === "pending" &&
      (record.kind !== projection.kind || record.preview !== preview)
    ) {
      updates.push({ ...record, kind: projection.kind, preview });
    }
  }
  if (updates.length === 0) {
    return;
  }
  binding.suggestionDoc.transact(() => {
    const ledger = getLedger(binding.suggestionDoc);
    for (const record of updates) {
      ledger.setAttr(record.id, record);
    }
  }, ledgerOrigin);
}

export function resolveNativeSuggestions(
  binding: NativeSuggestionsBinding,
  ids: readonly string[],
  status: Exclude<NativeSuggestionStatus, "pending">,
) {
  const records = getNativeSuggestionRecords(binding);
  binding.suggestionDoc.transact(() => {
    const ledger = getLedger(binding.suggestionDoc);
    for (const id of ids) {
      const record = records.get(id);
      if (record?.status === "pending") {
        ledger.setAttr(id, { ...record, status });
      }
    }
  }, ledgerOrigin);
}

export function acceptNativeSuggestion(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  const baseDoc = binding.fragment.doc;
  if (!baseDoc || record.status !== "pending") {
    return;
  }
  const update = Y.intersectUpdateWithContentIds(
    Y.encodeStateAsUpdate(binding.suggestionDoc),
    contentIdsFor(record),
  );
  Y.applyUpdate(baseDoc, update, ledgerOrigin);
}

export function rejectNativeSuggestion(
  binding: NativeSuggestionsBinding,
  record: NativeSuggestionRecord,
) {
  if (record.status !== "pending") {
    return;
  }
  Y.undoContentIds(binding.suggestionDoc, contentIdsFor(record));
}

export { SUGGESTION_ID_ATTR };
