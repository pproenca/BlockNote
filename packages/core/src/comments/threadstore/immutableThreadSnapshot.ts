import { BlockNoteError } from "../../platform/BlockNoteError.js";
import type {
  BlockNoteComment,
  BlockNoteCommentReaction,
  BlockNoteThread,
  BlockNoteThreadSnapshot,
  BlockNoteThreadStoreRevision,
} from "../types.js";

export type NormalizedThreadSnapshot<TThreadMetadata, TCommentMetadata> = {
  readonly revision: BlockNoteThreadStoreRevision;
  readonly threads: Map<
    string,
    BlockNoteThread<TThreadMetadata, TCommentMetadata>
  >;
  readonly completeness: "partial" | "complete";
  readonly nextCursor?: string;
};

const dateMutationMethods = [
  "setDate",
  "setFullYear",
  "setHours",
  "setMilliseconds",
  "setMinutes",
  "setMonth",
  "setSeconds",
  "setTime",
  "setUTCDate",
  "setUTCFullYear",
  "setUTCHours",
  "setUTCMilliseconds",
  "setUTCMinutes",
  "setUTCMonth",
  "setUTCSeconds",
  "setYear",
] as const;

export function normalizeThreadSnapshot<TThreadMetadata, TCommentMetadata>(
  value: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
  revision: BlockNoteThreadStoreRevision,
): NormalizedThreadSnapshot<TThreadMetadata, TCommentMetadata> {
  try {
    const completeness = readThreadSnapshotCompleteness(value);
    if (
      value.nextCursor !== undefined &&
      typeof value.nextCursor !== "string"
    ) {
      throw invalidSnapshot("Thread snapshot cursor must be a string.");
    }

    const threads = new Map<
      string,
      BlockNoteThread<TThreadMetadata, TCommentMetadata>
    >();
    for (const [threadId, thread] of value.threads) {
      if (threadId !== thread.id) {
        throw invalidSnapshot(
          `Thread map key "${threadId}" does not match thread id "${thread.id}".`,
        );
      }
      threads.set(threadId, cloneThread(thread));
    }

    return {
      revision,
      threads,
      completeness,
      ...(value.nextCursor === undefined
        ? {}
        : { nextCursor: value.nextCursor }),
    };
  } catch (error) {
    if (error instanceof BlockNoteError) {
      throw error;
    }
    throw invalidSnapshot("Thread snapshot rows are not readable.", error);
  }
}

export function readThreadSnapshotCompleteness(value: {
  readonly completeness: "partial" | "complete";
}) {
  try {
    const completeness = value.completeness;
    if (completeness !== "partial" && completeness !== "complete") {
      throw invalidSnapshot(
        'Thread snapshot completeness must be "partial" or "complete".',
      );
    }
    return completeness;
  } catch (error) {
    if (error instanceof BlockNoteError) {
      throw error;
    }
    throw invalidSnapshot(
      "Thread snapshot completeness is not readable.",
      error,
    );
  }
}

export function createPublicThreadSnapshot<TThreadMetadata, TCommentMetadata>(
  value: NormalizedThreadSnapshot<TThreadMetadata, TCommentMetadata>,
): BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata> {
  const threads = new Map<
    string,
    BlockNoteThread<TThreadMetadata, TCommentMetadata>
  >();
  for (const [threadId, thread] of value.threads) {
    threads.set(threadId, cloneThread(thread));
  }

  return Object.freeze({
    threads: readonlyMap(threads),
    completeness: value.completeness,
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
    revision: value.revision,
  });
}

export function cloneThread<TThreadMetadata, TCommentMetadata>(
  value: BlockNoteThread<TThreadMetadata, TCommentMetadata>,
): BlockNoteThread<TThreadMetadata, TCommentMetadata> {
  const thread = {
    type: "thread" as const,
    id: value.id,
    createdAt: immutableDate(value.createdAt),
    updatedAt: immutableDate(value.updatedAt),
    comments: Object.freeze(value.comments.map(cloneComment)),
    resolved: value.resolved,
    metadata: value.metadata,
    ...(value.resolvedUpdatedAt === undefined
      ? {}
      : { resolvedUpdatedAt: immutableDate(value.resolvedUpdatedAt) }),
    ...(value.resolvedBy === undefined ? {} : { resolvedBy: value.resolvedBy }),
    ...(value.deletedAt === undefined
      ? {}
      : { deletedAt: immutableDate(value.deletedAt) }),
    ...(value.detached === undefined ? {} : { detached: value.detached }),
  };
  return Object.freeze(thread);
}

function cloneComment<TCommentMetadata>(
  value: BlockNoteComment<TCommentMetadata>,
): BlockNoteComment<TCommentMetadata> {
  const common = {
    type: "comment" as const,
    id: value.id,
    userId: value.userId,
    createdAt: immutableDate(value.createdAt),
    updatedAt: immutableDate(value.updatedAt),
    reactions: Object.freeze(value.reactions.map(cloneReaction)),
    metadata: value.metadata,
  };
  const comment = value.deletedAt
    ? {
        ...common,
        deletedAt: immutableDate(value.deletedAt),
        body: undefined,
      }
    : { ...common, body: cloneOwnedValue(value.body) };
  return Object.freeze(comment) as BlockNoteComment<TCommentMetadata>;
}

function cloneReaction(
  value: BlockNoteCommentReaction,
): BlockNoteCommentReaction {
  return Object.freeze({
    emoji: value.emoji,
    createdAt: immutableDate(value.createdAt),
    userIds: Object.freeze([...value.userIds]),
  });
}

function immutableDate(value: Date) {
  const date = new Date(value.getTime());
  const rejectMutation = () => {
    throw new TypeError("Thread store snapshots are immutable.");
  };
  for (const method of dateMutationMethods) {
    Object.defineProperty(date, method, {
      configurable: false,
      enumerable: false,
      value: rejectMutation,
      writable: false,
    });
  }
  return Object.freeze(date);
}

function cloneOwnedValue(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (value instanceof Date) {
    return immutableDate(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    seen.set(value, next);
    next.push(...value.map((item) => cloneOwnedValue(item, seen)));
    return Object.freeze(next);
  }
  if (value instanceof Map) {
    const next = new Map<unknown, unknown>();
    seen.set(value, next);
    for (const [key, item] of value) {
      next.set(cloneOwnedValue(key, seen), cloneOwnedValue(item, seen));
    }
    return readonlyMap(next);
  }
  if (value instanceof Set) {
    const next = new Set<unknown>();
    seen.set(value, next);
    for (const item of value) {
      next.add(cloneOwnedValue(item, seen));
    }
    return readonlySet(next);
  }

  const next: Record<PropertyKey, unknown> = {};
  seen.set(value, next);
  for (const key of Reflect.ownKeys(value)) {
    next[key] = cloneOwnedValue(
      (value as Record<PropertyKey, unknown>)[key],
      seen,
    );
  }
  return Object.freeze(next);
}

function readonlyMap<TKey, TValue>(
  map: Map<TKey, TValue>,
): ReadonlyMap<TKey, TValue> {
  return new Proxy(map, {
    get(target, property) {
      if (property === "set" || property === "delete" || property === "clear") {
        return rejectSnapshotMutation;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set: rejectSnapshotMutation,
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
  });
}

function readonlySet<TValue>(set: Set<TValue>): ReadonlySet<TValue> {
  return new Proxy(set, {
    get(target, property) {
      if (property === "add" || property === "delete" || property === "clear") {
        return rejectSnapshotMutation;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set: rejectSnapshotMutation,
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
  });
}

function rejectSnapshotMutation(): never {
  throw new TypeError("Thread store snapshots are immutable.");
}

function invalidSnapshot(message: string, cause?: unknown) {
  return new BlockNoteError("invalid-document", message, { cause });
}
