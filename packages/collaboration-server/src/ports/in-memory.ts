import {
  blockNoteDocumentBinding,
  blockNotePersistence,
  type BlockNoteAccess,
  type BlockNoteCommitResult,
  type BlockNoteDocumentStore,
  type BlockNoteRevision,
  type BlockNoteStoredDocument,
} from "@blocknote/core";

import type {
  BlockNoteActor,
  BlockNoteAuthorizationAction,
  BlockNoteAuthorizationProvider,
} from "./authorization.js";
import type { BlockNoteProjectionSink } from "./projection.js";
import type {
  BlockNoteReplicaCoordinator,
  BlockNoteReplicaLease,
} from "./replica.js";

function sameRevision(left: BlockNoteRevision, right: BlockNoteRevision) {
  return left.sequence === right.sequence && left.token === right.token;
}

function revision(value: BlockNoteRevision) {
  return Object.freeze({ ...value });
}

function copyStored(value: BlockNoteStoredDocument): BlockNoteStoredDocument {
  return Object.freeze({
    binding: blockNoteDocumentBinding.fromBytes(
      blockNoteDocumentBinding.toBytes(value.binding),
    ),
    checkpoint: blockNotePersistence.checkpointFromBytes(
      blockNotePersistence.checkpointToBytes(value.checkpoint),
    ),
    checkpointRevision: revision(value.checkpointRevision),
    changes: Object.freeze(
      value.changes.map((entry) =>
        Object.freeze({
          revision: revision(entry.revision),
          change: blockNotePersistence.changeFromBytes(
            blockNotePersistence.changeToBytes(entry.change),
          ),
        }),
      ),
    ),
  });
}

export function createInMemoryDocumentStore<
  TKey,
>(): BlockNoteDocumentStore<TKey> {
  const documents = new Map<TKey, BlockNoteStoredDocument>();
  const conflict = (actual: BlockNoteRevision): BlockNoteCommitResult =>
    Object.freeze({ status: "conflict", actual: revision(actual) });
  const committed = (value: BlockNoteRevision): BlockNoteCommitResult =>
    Object.freeze({ status: "committed", revision: revision(value) });
  const head = (value: BlockNoteStoredDocument) =>
    value.changes.at(-1)?.revision ?? value.checkpointRevision;
  return {
    async load(key) {
      const value = documents.get(key);
      return value ? copyStored(value) : null;
    },
    async initialize(input) {
      const existing = documents.get(input.key);
      if (existing) {
        return sameRevision(head(existing), input.revision)
          ? committed(input.revision)
          : conflict(head(existing));
      }
      documents.set(
        input.key,
        copyStored({
          binding: input.binding,
          checkpoint: input.checkpoint,
          checkpointRevision: input.revision,
          changes: [],
        }),
      );
      return committed(input.revision);
    },
    async append(input) {
      const existing = documents.get(input.key);
      if (!existing) {
        return conflict(Object.freeze({ sequence: 0, token: "absent" }));
      }
      const actual = head(existing);
      if (!sameRevision(actual, input.expected)) {
        if (sameRevision(actual, input.next)) {
          return committed(actual);
        }
        return conflict(actual);
      }
      const next = copyStored({
        ...existing,
        changes: [
          ...existing.changes,
          { revision: input.next, change: input.change },
        ],
      });
      documents.set(input.key, next);
      return committed(input.next);
    },
    async compact(input) {
      const existing = documents.get(input.key);
      if (!existing) {
        return conflict(Object.freeze({ sequence: 0, token: "absent" }));
      }
      const actual = head(existing);
      if (!sameRevision(actual, input.expected)) {
        if (sameRevision(actual, input.next)) {
          return committed(actual);
        }
        return conflict(actual);
      }
      documents.set(
        input.key,
        copyStored({
          binding: existing.binding,
          checkpoint: input.checkpoint,
          checkpointRevision: input.next,
          changes: [],
        }),
      );
      return committed(input.next);
    },
  };
}

export function createInMemoryAuthorizationProvider<TKey>(input: {
  readonly resolve: (value: {
    readonly request: Request;
    readonly documentName: string;
  }) => Promise<{
    readonly key: TKey;
    readonly actor: BlockNoteActor;
    readonly access: (
      action: BlockNoteAuthorizationAction,
    ) => Promise<BlockNoteAccess | null>;
    readonly close?: () => Promise<void>;
  } | null>;
}): BlockNoteAuthorizationProvider<TKey> {
  return {
    async open(value) {
      const resolved = await input.resolve(value);
      if (!resolved) {
        return null;
      }
      let closed = false;
      return Object.freeze({
        documentKey: resolved.key,
        actor: Object.freeze({
          ...resolved.actor,
          ...(resolved.actor.attributes
            ? { attributes: Object.freeze({ ...resolved.actor.attributes }) }
            : {}),
        }),
        getAccess: resolved.access,
        async close() {
          if (closed) {
            return;
          }
          closed = true;
          await resolved.close?.();
        },
      });
    },
  };
}

export function createInMemoryProjectionSink<TKey, Projection>() {
  const commits = new Map<string, Projection>();
  const key = (value: TKey, revision: BlockNoteRevision) =>
    `${String(value)}:${revision.sequence}:${revision.token}`;
  const sink: BlockNoteProjectionSink<TKey, Projection> = {
    async commit(input) {
      commits.set(
        key(input.key, input.revision),
        structuredClone(input.projection),
      );
    },
  };
  return Object.freeze({
    sink,
    get(keyValue: TKey, revisionValue: BlockNoteRevision) {
      const value = commits.get(key(keyValue, revisionValue));
      return value === undefined ? undefined : structuredClone(value);
    },
  });
}

export function createSingleNodeReplicaCoordinator<TKey>(
  input: {
    readonly now?: () => Date;
  } = {},
): BlockNoteReplicaCoordinator<TKey> {
  const now = input.now ?? (() => new Date());
  const leases = new Map<
    TKey,
    BlockNoteReplicaLease<TKey> & { replicaId: string }
  >();
  const listeners = new Set<
    (value: { readonly key: TKey; readonly fence: number }) => void
  >();
  let sequence = 0;
  const valid = (lease: BlockNoteReplicaLease<TKey>) => {
    const current = leases.get(lease.key);
    return (
      !!current &&
      current.token === lease.token &&
      current.fence === lease.fence
    );
  };
  return {
    async locate(key) {
      const lease = leases.get(key);
      return lease && lease.expiresAt.getTime() > now().getTime()
        ? lease.replicaId
        : null;
    },
    async acquire({ key, replicaId, durationMs }) {
      const current = leases.get(key);
      if (current && current.expiresAt.getTime() > now().getTime()) {
        return current.replicaId === replicaId ? current : null;
      }
      const lease = Object.freeze({
        key,
        replicaId,
        token: `local-${++sequence}`,
        fence: (current?.fence ?? 0) + 1,
        expiresAt: new Date(now().getTime() + durationMs),
      });
      leases.set(key, lease);
      return lease;
    },
    async renew({ lease, durationMs }) {
      if (!valid(lease)) {
        return null;
      }
      const current = leases.get(lease.key)!;
      const renewed = Object.freeze({
        ...current,
        expiresAt: new Date(now().getTime() + durationMs),
      });
      leases.set(lease.key, renewed);
      return renewed;
    },
    async release(lease) {
      if (valid(lease)) {
        leases.delete(lease.key);
      }
    },
    async publish(lease) {
      if (!valid(lease)) {
        return false;
      }
      const value = Object.freeze({ key: lease.key, fence: lease.fence });
      for (const listener of [...listeners]) {
        listener(value);
      }
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      let active = true;
      return () => {
        if (active) {
          active = false;
          listeners.delete(listener);
        }
      };
    },
  };
}
