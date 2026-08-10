import * as Y from "@y/y";

export type NativeSuggestionStatus = "pending" | "accepted" | "rejected";

export type NativeSuggestionKind = "insertion" | "deletion" | "replacement";

export type NativeIdRange = {
  readonly client: number;
  readonly clock: number;
  readonly length: number;
};

export type NativeSuggestionHeader = {
  readonly version: 2;
  readonly id: string;
  readonly authorId: string | null;
  readonly creatorId: string;
};

export type NativeRangeClaim = NativeIdRange & {
  readonly version: 2;
  readonly suggestionId: string;
  readonly role: "insert" | "delete";
};

export type IndexedRangeClaim = NativeRangeClaim & {
  readonly key: string;
};

export type NativeDisposition = {
  readonly version: 2;
  readonly suggestionId: string;
  readonly decisionId: string;
  readonly status: Exclude<NativeSuggestionStatus, "pending">;
};

export type NativeExecution = {
  readonly version: 2;
  readonly suggestionId: string;
  readonly decisionId: string;
  readonly status: Exclude<NativeSuggestionStatus, "pending">;
  readonly fenceId: string;
};

export type NativeReceipt = {
  readonly version: 2;
  readonly suggestionId: string;
  readonly decisionId: string;
  readonly status: Exclude<NativeSuggestionStatus, "pending">;
  readonly kind: NativeSuggestionKind;
  readonly preview: string;
};

export type NativeSuggestionRecord = {
  readonly version: 2;
  readonly id: string;
  readonly authorId: string | null;
  readonly creatorId: string;
  readonly kind: NativeSuggestionKind;
  readonly preview: string;
  readonly status: NativeSuggestionStatus;
  readonly order: string;
  readonly insertRanges: readonly NativeIdRange[];
  readonly deleteRanges: readonly NativeIdRange[];
  readonly contentIds: Y.ContentIds;
  readonly decisionId: string | null;
  readonly decisionStatus: Exclude<NativeSuggestionStatus, "pending"> | null;
  readonly hasExecution: boolean;
  readonly hasReceipt: boolean;
  readonly rangeKeys: readonly string[];
};

export type NativeResolutionPhase =
  | "after-disposition"
  | "after-intent"
  | "after-content";

export type NativeSuggestionsBinding = {
  readonly fragment: Y.Type;
  readonly suggestionDoc: Y.Doc;
  readonly renderer: Y.DiffRenderer;
  readonly creatorId: string;
  readonly getActorId: () => string | null;
  readonly authorityKey: string;
  validateReviewAuthority?: NativeReviewAuthorityValidator;
  submitReview?: () => void | Promise<void>;
  onResolutionPhase?: (phase: NativeResolutionPhase) => void;
};

export type NativeReviewAuthorityRequest = {
  readonly key: string;
  readonly actorId: string | null;
  readonly revision: number;
  readonly reviews: readonly {
    readonly suggestionId: string;
    readonly decisionId: string;
    readonly action: Exclude<NativeSuggestionStatus, "pending">;
  }[];
};

export type NativeReviewAuthorityGrant = NativeReviewAuthorityRequest & {
  readonly leaseId: string;
  readonly fenceId: string;
  readonly nonce: string;
};

export type NativeReviewAuthorityValidator = (
  capability: unknown,
  request: NativeReviewAuthorityRequest,
) => NativeReviewAuthorityGrant | false;

export const NATIVE_SUGGESTION_LIMITS = Object.freeze({
  maxRecords: 2_048,
  maxRangesPerRecord: 4_096,
  maxTotalRanges: 16_384,
  maxLedgerEntries: 28_672,
  maxLedgerBytes: 2 * 1024 * 1024,
  maxAuthorIdLength: 512,
  maxActivePreviewLength: 16_384,
  maxTerminalPreviewLength: 512,
});

export const LEDGER_NAMES = Object.freeze({
  headers: "__blocknote_suggestions_v2_headers",
  ranges: "__blocknote_suggestions_v2_ranges",
  dispositions: "__blocknote_suggestions_v2_dispositions",
  intents: "__blocknote_suggestions_v3_executions",
  receipts: "__blocknote_suggestions_v2_receipts",
});

export const SUGGESTION_ID_ATTR = "blocknoteSuggestionId";
export const ledgerOrigin = Symbol("blocknote-suggestion-ledger-v2");
export const resolutionOrigin = Symbol("blocknote-suggestion-resolution-v2");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function getLedgerTypes(doc: Y.Doc) {
  return {
    headers: doc.get(LEDGER_NAMES.headers),
    ranges: doc.get(LEDGER_NAMES.ranges),
    dispositions: doc.get(LEDGER_NAMES.dispositions),
    intents: doc.get(LEDGER_NAMES.intents),
    receipts: doc.get(LEDGER_NAMES.receipts),
  } as const;
}

export type LedgerTypes = ReturnType<typeof getLedgerTypes>;

export function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
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

export function rangeClaimId(
  suggestionId: string,
  role: "insert" | "delete",
  range: NativeIdRange,
) {
  return `${suggestionId}/${role}/${range.client}/${range.clock}/${range.length}`;
}

export function decisionEntryId(suggestionId: string, decisionId: string) {
  return `${suggestionId}/${decisionId}`;
}

export function isHeader(
  key: string,
  value: unknown,
): value is NativeSuggestionHeader {
  if (!value || typeof value !== "object") {
    return false;
  }
  const header = value as Partial<NativeSuggestionHeader>;
  return (
    header.version === 2 &&
    isCanonicalUuid(header.id) &&
    header.id === key &&
    (header.authorId === null ||
      isBoundedString(
        header.authorId,
        NATIVE_SUGGESTION_LIMITS.maxAuthorIdLength,
      )) &&
    isCanonicalUuid(header.creatorId)
  );
}

export function isRangeClaim(
  key: string,
  value: unknown,
): value is NativeRangeClaim {
  if (!value || typeof value !== "object") {
    return false;
  }
  const claim = value as Partial<NativeRangeClaim>;
  const suggestionId = claim.suggestionId;
  const role = claim.role;
  return (
    claim.version === 2 &&
    isCanonicalUuid(suggestionId) &&
    (role === "insert" || role === "delete") &&
    isNativeIdRange(claim) &&
    rangeClaimId(suggestionId, role, claim) === key
  );
}

export function isDisposition(
  key: string,
  value: unknown,
): value is NativeDisposition {
  if (!value || typeof value !== "object") {
    return false;
  }
  const disposition = value as Partial<NativeDisposition>;
  return (
    disposition.version === 2 &&
    isCanonicalUuid(disposition.suggestionId) &&
    isCanonicalUuid(disposition.decisionId) &&
    (disposition.status === "accepted" || disposition.status === "rejected") &&
    decisionEntryId(disposition.suggestionId, disposition.decisionId) === key
  );
}

export function isExecution(
  key: string,
  value: unknown,
): value is NativeExecution {
  if (!value || typeof value !== "object") {
    return false;
  }
  const execution = value as Partial<NativeExecution>;
  return (
    execution.version === 2 &&
    isCanonicalUuid(execution.suggestionId) &&
    isCanonicalUuid(execution.decisionId) &&
    (execution.status === "accepted" || execution.status === "rejected") &&
    isCanonicalUuid(execution.fenceId) &&
    decisionEntryId(execution.suggestionId, execution.decisionId) === key
  );
}

export function isReceipt(key: string, value: unknown): value is NativeReceipt {
  if (!value || typeof value !== "object") {
    return false;
  }
  const receipt = value as Partial<NativeReceipt>;
  return (
    receipt.version === 2 &&
    isCanonicalUuid(receipt.suggestionId) &&
    isCanonicalUuid(receipt.decisionId) &&
    (receipt.status === "accepted" || receipt.status === "rejected") &&
    (receipt.kind === "insertion" ||
      receipt.kind === "deletion" ||
      receipt.kind === "replacement") &&
    isBoundedString(
      receipt.preview,
      NATIVE_SUGGESTION_LIMITS.maxTerminalPreviewLength,
    ) &&
    decisionEntryId(receipt.suggestionId, receipt.decisionId) === key
  );
}

export function rangesFromIdSet(idSet: Y.IdSet) {
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

export function idSetFromRanges(ranges: readonly NativeIdRange[]) {
  const idSet = Y.createIdSet();
  for (const range of ranges) {
    idSet.add(range.client, range.clock, range.length);
  }
  return idSet;
}

export function rangeIsCovered(idSet: Y.IdSet, range: NativeIdRange) {
  return idSet
    .slice(range.client, range.clock, range.length)
    .every((slice) => slice.exists);
}

export function kindFor(
  inserts: Y.IdSet,
  deletes: Y.IdSet,
): NativeSuggestionKind {
  return !inserts.isEmpty() && !deletes.isEmpty()
    ? "replacement"
    : inserts.isEmpty()
      ? "deletion"
      : "insertion";
}

export function actorIdFor(binding: NativeSuggestionsBinding) {
  let actorId: unknown = null;
  try {
    actorId = binding.getActorId();
  } catch {
    return null;
  }
  return actorId === null ||
    isBoundedString(actorId, NATIVE_SUGGESTION_LIMITS.maxAuthorIdLength)
    ? actorId
    : null;
}

export function utf8Length(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function normalizedPreview(value: string, maxLength: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function previewFromIds(doc: Y.Doc | null, ids: Y.IdSet) {
  if (!doc || ids.isEmpty()) {
    return "";
  }
  const parts: Array<{ client: number; clock: number; value: string }> = [];
  ids.forEach((range, client) => {
    const structs = doc.store.clients.get(client);
    if (!structs) {
      return;
    }
    let left = 0;
    let right = structs.length - 1;
    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      const struct = structs[middle]!;
      if (struct.id.clock + struct.length <= range.clock) {
        left = middle + 1;
      } else {
        right = middle - 1;
      }
    }
    for (let index = left; index < structs.length; index += 1) {
      const struct = structs[index]!;
      if (struct.id.clock >= range.clock + range.len) {
        break;
      }
      if (!(struct instanceof Y.Item)) {
        continue;
      }
      const offset = Math.max(0, range.clock - struct.id.clock);
      const length =
        Math.min(struct.id.clock + struct.length, range.clock + range.len) -
        (struct.id.clock + offset);
      if (struct.content instanceof Y.ContentString) {
        parts.push({
          client: struct.id.client,
          clock: struct.id.clock + offset,
          value: struct.content.str.slice(offset, offset + length),
        });
      } else if (struct.content instanceof Y.ContentAny) {
        const value = struct.content.arr
          .slice(offset, offset + length)
          .filter((part): part is string => typeof part === "string")
          .join("");
        if (value) {
          parts.push({
            client: struct.id.client,
            clock: struct.id.clock + offset,
            value,
          });
        }
      }
    }
  });
  parts.sort(
    (left, right) =>
      left.client - right.client ||
      left.clock - right.clock ||
      compareCodeUnits(left.value, right.value),
  );
  return normalizedPreview(
    parts.map((part) => part.value).join(""),
    NATIVE_SUGGESTION_LIMITS.maxActivePreviewLength,
  );
}

export function orderFor(
  id: string,
  insertRanges: readonly NativeIdRange[],
  deleteRanges: readonly NativeIdRange[],
) {
  const first = [...insertRanges, ...deleteRanges].sort(
    (left, right) =>
      left.client - right.client ||
      left.clock - right.clock ||
      left.length - right.length,
  )[0];
  return first
    ? `${String(first.client).padStart(16, "0")}/${String(first.clock).padStart(16, "0")}/${id}`
    : `~/${id}`;
}
