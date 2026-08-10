import { BlockNoteError } from "@blocknote/core";
import * as Y from "@y/y";

const HEADERS = "__blocknote_suggestions_v2_headers";
const RANGES = "__blocknote_suggestions_v2_ranges";
const suggestionRoots = new Set([HEADERS, RANGES]);

type Claim = {
  readonly role?: unknown;
  readonly client?: unknown;
  readonly clock?: unknown;
  readonly length?: unknown;
  readonly suggestionId?: unknown;
};

function invalid(): never {
  throw new BlockNoteError(
    "invalid-document",
    "BlockNote mutation mixes ordinary edits with suggestion authority.",
  );
}

function itemForId(doc: Y.Doc, client: number, clock: number) {
  const structs = doc.store.clients.get(client);
  if (!structs) {
    return null;
  }
  let left = 0;
  let right = structs.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const struct = structs[middle]!;
    if (clock < struct.id.clock) {
      right = middle - 1;
    } else if (clock >= struct.id.clock + struct.length) {
      left = middle + 1;
    } else {
      return struct instanceof Y.Item ? struct : null;
    }
  }
  return null;
}

function rootName(doc: Y.Doc, item: Y.Item) {
  let parent = item.parent;
  while (typeof parent !== "string") {
    const parentItem = (parent as Y.Type & { _item?: Y.Item | null })._item;
    if (!parentItem) {
      for (const [name, type] of doc.share) {
        if (type === parent) {
          return name;
        }
      }
      return null;
    }
    parent = parentItem.parent;
  }
  return parent;
}

function assertOnlyLedger(doc: Y.Doc, ids: Y.IdSet) {
  ids.forEach((range, client) => {
    const end = range.clock + range.len;
    let clock = range.clock;
    while (clock < end) {
      const item = itemForId(doc, client, clock);
      if (!item || !suggestionRoots.has(rootName(doc, item) ?? "")) {
        invalid();
      }
      clock = Math.min(end, item.id.clock + item.length);
    }
  });
}

function assertNoLedger(doc: Y.Doc, ids: Y.IdSet) {
  ids.forEach((range, client) => {
    const end = range.clock + range.len;
    let clock = range.clock;
    while (clock < end) {
      const item = itemForId(doc, client, clock);
      if (!item || suggestionRoots.has(rootName(doc, item) ?? "")) {
        invalid();
      }
      clock = Math.min(end, item.id.clock + item.length);
    }
  });
}

function overlaps(left: Y.IdSet, right: Y.IdSet) {
  let found = false;
  left.forEach((range, client) => {
    if (right.intersects(client, range.clock, range.len)) {
      found = true;
    }
  });
  return found;
}

function unchanged(previous: unknown, current: unknown) {
  return JSON.stringify(previous) === JSON.stringify(current);
}

export function validateBlockNoteSuggestionMutation(
  before: Y.Doc,
  after: Y.Doc,
  actorId?: string,
) {
  const previousHeaders = before.share.get(HEADERS);
  const headers = after.share.get(HEADERS);
  const previousRanges = before.share.get(RANGES);
  const ranges = after.share.get(RANGES);
  if (!headers) {
    invalid();
  }
  const newHeaders = new Set<string>();
  const claimsByHeader = new Map<string, number>();
  const insertClaims = Y.createIdSet();
  const deleteClaims = Y.createIdSet();

  previousHeaders?.forEachAttr((value: unknown, key: string | number) => {
    if (typeof key !== "string" || !unchanged(value, headers.getAttr(key))) {
      invalid();
    }
  });
  headers.forEachAttr((value: unknown, key: string | number) => {
    if (typeof key !== "string" || !value || typeof value !== "object") {
      invalid();
    }
    if (previousHeaders?.getAttr(key) === undefined) {
      newHeaders.add(key);
      if (actorId) {
        headers.setAttr(key, {
          ...(value as Record<string, unknown>),
          authorId: actorId,
        });
      }
    }
  });
  previousRanges?.forEachAttr((value: unknown, key: string | number) => {
    if (
      typeof key !== "string" ||
      !ranges ||
      !unchanged(value, ranges.getAttr(key))
    ) {
      invalid();
    }
  });
  ranges?.forEachAttr((value: unknown, key: string | number) => {
    if (
      typeof key !== "string" ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      invalid();
    }
    if (previousRanges?.getAttr(key) !== undefined) {
      return;
    }
    const claim = value as Claim;
    if (
      (claim.role !== "insert" && claim.role !== "delete") ||
      !Number.isSafeInteger(claim.client) ||
      (claim.client as number) < 0 ||
      !Number.isSafeInteger(claim.clock) ||
      (claim.clock as number) < 0 ||
      !Number.isSafeInteger(claim.length) ||
      (claim.length as number) <= 0 ||
      typeof claim.suggestionId !== "string" ||
      !newHeaders.has(claim.suggestionId)
    ) {
      invalid();
    }
    const target = claim.role === "insert" ? insertClaims : deleteClaims;
    target.add(
      claim.client as number,
      claim.clock as number,
      claim.length as number,
    );
    claimsByHeader.set(
      claim.suggestionId,
      (claimsByHeader.get(claim.suggestionId) ?? 0) + 1,
    );
  });
  for (const header of newHeaders) {
    if (!claimsByHeader.has(header)) {
      invalid();
    }
  }
  if (overlaps(insertClaims, deleteClaims)) {
    invalid();
  }

  const renderer = Y.createDiffRenderer(before, after);
  try {
    const actualInserts = Y.createIdSetFromIdMap(renderer.inserts);
    const actualDeletes = Y.createIdSetFromIdMap(renderer.deletes);
    if (
      !Y.diffIdSet(insertClaims, actualInserts).isEmpty() ||
      !Y.diffIdSet(deleteClaims, actualDeletes).isEmpty()
    ) {
      invalid();
    }
    assertNoLedger(after, insertClaims);
    assertNoLedger(after, deleteClaims);
    const unclaimedInserts = Y.diffIdSet(actualInserts, insertClaims);
    const unclaimedDeletes = Y.diffIdSet(actualDeletes, deleteClaims);
    assertOnlyLedger(after, unclaimedInserts);
    assertOnlyLedger(after, unclaimedDeletes);
  } finally {
    renderer.destroy();
  }
}
