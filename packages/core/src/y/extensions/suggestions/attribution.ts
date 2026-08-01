import * as Y from "@y/y";

import {
  compareCodeUnits,
  ledgerOrigin,
  SUGGESTION_ID_ATTR,
  type NativeSuggestionRecord,
  type NativeSuggestionsBinding,
} from "./model.js";

type PendingEmit = {
  changed: Y.IdSet;
  claimed: Y.IdSet;
  disposed: boolean;
  epoch: number;
  scheduled: boolean;
};

const pendingEmits = new WeakMap<NativeSuggestionsBinding, PendingEmit>();

function emitState(binding: NativeSuggestionsBinding) {
  let state = pendingEmits.get(binding);
  if (!state) {
    state = {
      changed: Y.createIdSet(),
      claimed: Y.createIdSet(),
      disposed: false,
      epoch: 0,
      scheduled: false,
    };
    pendingEmits.set(binding, state);
  }
  return state;
}

export function activateAttribution(binding: NativeSuggestionsBinding) {
  const state = emitState(binding);
  state.epoch += 1;
  state.disposed = false;
  state.scheduled = false;
  state.changed = Y.createIdSet();
  state.claimed = Y.createIdSet();
}

export function disposeAttribution(binding: NativeSuggestionsBinding) {
  const state = emitState(binding);
  state.epoch += 1;
  state.disposed = true;
  state.scheduled = false;
  state.changed = Y.createIdSet();
  state.claimed = Y.createIdSet();
}

function rebuildAttribution(
  source: Y.IdMap<any>,
  records: ReadonlyMap<string, NativeSuggestionRecord>,
  role: "insert" | "delete",
) {
  let rebuilt = Y.createIdMap();
  source.forEach((range, client) => {
    const attrs = range.attrs.flatMap((attribute) => {
      if (attribute.name === SUGGESTION_ID_ATTR) {
        return [];
      }
      return [attribute];
    });
    rebuilt.add(client, range.clock, range.len, attrs);
  });
  for (const record of [...records.values()].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  )) {
    if (record.status !== "pending") {
      continue;
    }
    const ids =
      role === "insert" ? record.contentIds.inserts : record.contentIds.deletes;
    if (ids.isEmpty()) {
      continue;
    }
    const covered = Y.intersectSets(rebuilt, ids);
    const coveredIds = Y.createIdSetFromIdMap(covered);
    rebuilt = Y.diffIdMap(rebuilt, ids);
    covered.forEach((range, client) => {
      const existingAuthors = range.attrs.filter(
        (attribute) => attribute.name === role,
      );
      const authors =
        record.authorId === null
          ? existingAuthors
              .map((attribute) => attribute.val)
              .filter((value): value is string => typeof value === "string")
          : [record.authorId];
      rebuilt.add(client, range.clock, range.len, [
        ...range.attrs.filter((attribute) => attribute.name !== role),
        ...authors.map((author) => Y.createContentAttribute(role, author)),
      ]);
    });
    Y.diffIdSet(ids, coveredIds).forEach((range, client) => {
      const attrs =
        record.authorId === null
          ? []
          : [Y.createContentAttribute(role, record.authorId)];
      rebuilt.add(client, range.clock, range.len, attrs);
    });
  }
  return rebuilt;
}

function legacyCoverage(idMap: Y.IdMap<any>) {
  const covered = Y.createIdSet();
  idMap.forEach((range, client) => {
    if (
      range.attrs.some((attribute) => attribute.name === SUGGESTION_ID_ATTR)
    ) {
      covered.add(client, range.clock, range.len);
    }
  });
  return covered;
}

function attributionSignature(inserts: Y.IdMap<any>, deletes: Y.IdMap<any>) {
  const entries: string[] = [];
  const append = (role: "insert" | "delete", idMap: Y.IdMap<any>) => {
    idMap.forEach((range, client) => {
      const overlay = range.attrs.flatMap((attribute) => {
        if (attribute.name === SUGGESTION_ID_ATTR) {
          return [["legacy-id", attribute.val]];
        }
        if (attribute.name !== role) {
          return [];
        }
        return typeof attribute.val === "string"
          ? [["user", attribute.val]]
          : [];
      });
      if (overlay.length > 0) {
        entries.push(
          JSON.stringify([
            role,
            client,
            range.clock,
            range.len,
            overlay
              .map((attribute) => JSON.stringify(attribute))
              .sort(compareCodeUnits),
          ]),
        );
      }
    });
  };
  append("insert", inserts);
  append("delete", deletes);
  return entries.sort(compareCodeUnits).join("|");
}

export function reconcileAttribution(
  binding: NativeSuggestionsBinding,
  records: ReadonlyMap<string, NativeSuggestionRecord>,
  emitChange = true,
) {
  const state = emitState(binding);
  const previousClaimed = state.claimed;
  const previousSignature = attributionSignature(
    binding.renderer.inserts,
    binding.renderer.deletes,
  );
  const legacy = Y.mergeIdSets([
    legacyCoverage(binding.renderer.inserts),
    legacyCoverage(binding.renderer.deletes),
  ]);
  const inserts = rebuildAttribution(
    binding.renderer.inserts,
    records,
    "insert",
  );
  const deletes = rebuildAttribution(
    binding.renderer.deletes,
    records,
    "delete",
  );
  binding.renderer.inserts = inserts;
  binding.renderer.deletes = deletes;
  state.claimed = Y.mergeIdSets(
    [...records.values()]
      .filter((record) => record.status === "pending")
      .flatMap((record) => [
        record.contentIds.inserts,
        record.contentIds.deletes,
      ]),
  );
  if (
    !emitChange ||
    previousSignature === attributionSignature(inserts, deletes)
  ) {
    return;
  }
  const changed = Y.mergeIdSets([previousClaimed, state.claimed, legacy]);
  if (!changed.isEmpty()) {
    state.changed = Y.mergeIdSets([state.changed, changed]);
    if (state.scheduled || state.disposed) {
      return;
    }
    state.scheduled = true;
    const epoch = state.epoch;
    queueMicrotask(() => {
      const current = pendingEmits.get(binding);
      if (!current || current.disposed || current.epoch !== epoch) {
        return;
      }
      current.scheduled = false;
      const accumulated = current.changed;
      current.changed = Y.createIdSet();
      if (!accumulated.isEmpty()) {
        binding.renderer.emit("change", [accumulated, ledgerOrigin, true]);
      }
    });
  }
}
