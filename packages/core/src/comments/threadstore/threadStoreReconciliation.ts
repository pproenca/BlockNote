import deepEqual from "fast-deep-equal";

import type {
  BlockNoteThreadSnapshot,
  CommentData,
  ThreadData,
} from "../types.js";

type DeletionBarrier<T> = {
  value: T;
  compacted: boolean;
};

export class ThreadSnapshotReconciler<TThreadMetadata, TCommentMetadata> {
  private snapshot: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>;
  private readonly threadDeletionBarriers = new Map<
    string,
    DeletionBarrier<ThreadData<TThreadMetadata, TCommentMetadata>>
  >();
  private readonly commentDeletionBarriers = new Map<
    string,
    Map<string, DeletionBarrier<CommentData<TCommentMetadata>>>
  >();
  private readonly mutationBarriers = new Map<
    string,
    ThreadData<TThreadMetadata, TCommentMetadata>
  >();
  private partialSnapshotThreadIds = new Set<string>();

  constructor(
    initialSnapshot: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
  ) {
    this.snapshot = cloneSnapshot(initialSnapshot);
    this.recordDeletionBarriers(this.snapshot.threads);
    if (this.snapshot.completeness === "partial") {
      this.partialSnapshotThreadIds = new Set(this.snapshot.threads.keys());
    }
  }

  getSnapshot() {
    return this.snapshot;
  }

  applyMutationThread(thread: ThreadData<TThreadMetadata, TCommentMetadata>) {
    const nextThreads = new Map(this.snapshot.threads);
    const reconciled = this.reconcileThread(
      nextThreads.get(thread.id),
      thread,
      false,
    );

    if (reconciled) {
      nextThreads.set(thread.id, reconciled);
      if (reconciled.deletedAt) {
        this.mutationBarriers.delete(thread.id);
      } else {
        this.mutationBarriers.set(thread.id, reconciled);
      }
    }
    if (this.snapshot.completeness === "partial") {
      this.partialSnapshotThreadIds.add(thread.id);
    }

    return this.commit({
      ...this.snapshot,
      threads: nextThreads,
    });
  }

  applySnapshot(
    incomingValue: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
    origin: "source" | "page",
  ) {
    const incoming = cloneSnapshot(incomingValue);
    const incomingIds = new Set(incoming.threads.keys());
    const authoritativeSource =
      origin === "source" && incoming.completeness === "complete";

    if (incoming.completeness === "partial") {
      for (const id of incomingIds) {
        this.partialSnapshotThreadIds.add(id);
      }
    }

    const authoritativeIds = authoritativeSource
      ? incomingIds
      : incoming.completeness === "complete"
        ? new Set([...this.partialSnapshotThreadIds, ...incomingIds])
        : undefined;
    const nextThreads = authoritativeSource
      ? new Map<string, ThreadData<TThreadMetadata, TCommentMetadata>>()
      : new Map(this.snapshot.threads);

    for (const [id, incomingThread] of incoming.threads) {
      const mutationBarrier = this.mutationBarriers.get(id);
      if (
        incomingThread.deletedAt ||
        (mutationBarrier &&
          compareDeterministically(incomingThread, mutationBarrier) >= 0)
      ) {
        this.mutationBarriers.delete(id);
      }
      const reconciled = this.reconcileThread(
        this.snapshot.threads.get(id),
        incomingThread,
        incoming.completeness === "complete",
      );
      if (reconciled) {
        nextThreads.set(id, reconciled);
      } else {
        nextThreads.delete(id);
      }
    }

    if (authoritativeIds) {
      for (const [id, thread] of this.mutationBarriers) {
        authoritativeIds.add(id);
        if (!nextThreads.has(id)) {
          nextThreads.set(id, thread);
        }
      }
      for (const id of nextThreads.keys()) {
        if (!authoritativeIds.has(id)) {
          nextThreads.delete(id);
        }
      }
      this.compactDeletionBarriers(authoritativeIds, nextThreads);
      this.partialSnapshotThreadIds.clear();
    }

    return this.commit({
      threads: nextThreads,
      completeness: incoming.completeness,
      ...(incoming.nextCursor === undefined
        ? {}
        : { nextCursor: incoming.nextCursor }),
    });
  }

  private reconcileThread(
    current: ThreadData<TThreadMetadata, TCommentMetadata> | undefined,
    incoming: ThreadData<TThreadMetadata, TCommentMetadata>,
    authoritativeComments: boolean,
  ) {
    const deletionBarrier = this.threadDeletionBarriers.get(incoming.id);

    if (incoming.deletedAt) {
      const deleted = deletionBarrier
        ? chooseDeterministically(deletionBarrier.value, incoming)
        : incoming;
      this.threadDeletionBarriers.set(incoming.id, {
        value: deleted,
        compacted: false,
      });
      return deleted;
    }

    if (deletionBarrier) {
      return deletionBarrier.compacted ? undefined : deletionBarrier.value;
    }

    if (!current) {
      this.recordCommentDeletionBarriers(incoming);
      return incoming;
    }

    if (current.deletedAt) {
      this.threadDeletionBarriers.set(current.id, {
        value: current,
        compacted: false,
      });
      return current;
    }

    const preferred = chooseDeterministically(current, incoming);
    const resolution = chooseResolution(current, incoming);
    const comments = mergeComments(
      incoming.id,
      current.comments,
      incoming.comments,
      authoritativeComments && preferred === incoming,
      this.commentDeletionBarriers,
    );

    return {
      ...preferred,
      comments,
      resolved: resolution.resolved,
      ...(resolution.resolvedUpdatedAt
        ? { resolvedUpdatedAt: resolution.resolvedUpdatedAt }
        : {}),
      ...(resolution.resolvedBy ? { resolvedBy: resolution.resolvedBy } : {}),
    };
  }

  private recordDeletionBarriers(
    threads: ReadonlyMap<string, ThreadData<TThreadMetadata, TCommentMetadata>>,
  ) {
    for (const thread of threads.values()) {
      if (thread.deletedAt) {
        this.threadDeletionBarriers.set(thread.id, {
          value: thread,
          compacted: false,
        });
      }
      this.recordCommentDeletionBarriers(thread);
    }
  }

  private recordCommentDeletionBarriers(
    thread: ThreadData<TThreadMetadata, TCommentMetadata>,
  ) {
    for (const comment of thread.comments) {
      if (!comment.deletedAt) {
        continue;
      }
      const barriers = this.commentDeletionBarriers.get(thread.id) ?? new Map();
      barriers.set(comment.id, {
        value: comment,
        compacted: false,
      });
      this.commentDeletionBarriers.set(thread.id, barriers);
    }
  }

  private compactDeletionBarriers(
    authoritativeThreadIds: Set<string>,
    threads: ReadonlyMap<string, ThreadData<TThreadMetadata, TCommentMetadata>>,
  ) {
    for (const [id, barrier] of this.threadDeletionBarriers) {
      if (!authoritativeThreadIds.has(id)) {
        barrier.compacted = true;
      }
    }

    for (const [threadId, barriers] of this.commentDeletionBarriers) {
      const thread = threads.get(threadId);
      const commentIds = new Set(thread?.comments.map((comment) => comment.id));
      for (const [commentId, barrier] of barriers) {
        if (
          !authoritativeThreadIds.has(threadId) ||
          !commentIds.has(commentId)
        ) {
          barrier.compacted = true;
        }
      }
    }
  }

  private commit(
    next: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
  ) {
    const normalized = cloneSnapshot(next);
    if (snapshotsEqual(this.snapshot, normalized)) {
      return false;
    }

    this.snapshot = normalized;
    return true;
  }
}

function cloneSnapshot<TThreadMetadata, TCommentMetadata>(
  snapshot: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
): BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata> {
  return {
    threads: new Map(snapshot.threads),
    completeness: snapshot.completeness,
    ...(snapshot.nextCursor === undefined
      ? {}
      : { nextCursor: snapshot.nextCursor }),
  };
}

function snapshotsEqual<TThreadMetadata, TCommentMetadata>(
  left: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
  right: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
) {
  if (
    left.completeness !== right.completeness ||
    left.nextCursor !== right.nextCursor ||
    left.threads.size !== right.threads.size
  ) {
    return false;
  }

  for (const [id, thread] of left.threads) {
    if (!safeDeepEqual(thread, right.threads.get(id))) {
      return false;
    }
  }
  return true;
}

function mergeComments<TCommentMetadata>(
  threadId: string,
  current: CommentData<TCommentMetadata>[],
  incoming: CommentData<TCommentMetadata>[],
  authoritative: boolean,
  allBarriers: Map<
    string,
    Map<string, DeletionBarrier<CommentData<TCommentMetadata>>>
  >,
) {
  const barriers = allBarriers.get(threadId) ?? new Map();
  const currentById = new Map(current.map((comment) => [comment.id, comment]));
  const incomingIds = new Set(incoming.map((comment) => comment.id));
  const next = new Map<string, CommentData<TCommentMetadata>>();

  if (!authoritative) {
    for (const comment of current) {
      next.set(comment.id, comment);
    }
  }

  for (const comment of incoming) {
    const barrier = barriers.get(comment.id);
    if (comment.deletedAt) {
      const deleted = barrier
        ? chooseDeterministically(barrier.value, comment)
        : comment;
      barriers.set(comment.id, { value: deleted, compacted: false });
      next.set(comment.id, deleted);
      continue;
    }

    if (barrier) {
      if (!barrier.compacted) {
        next.set(comment.id, barrier.value);
      }
      continue;
    }

    const existing = currentById.get(comment.id);
    next.set(
      comment.id,
      existing ? chooseDeterministically(existing, comment) : comment,
    );
  }

  if (authoritative) {
    for (const [commentId, barrier] of barriers) {
      if (!incomingIds.has(commentId)) {
        barrier.compacted = true;
        next.delete(commentId);
      }
    }
  } else {
    for (const [commentId, barrier] of barriers) {
      if (!barrier.compacted && !next.has(commentId)) {
        next.set(commentId, barrier.value);
      }
    }
  }

  if (barriers.size > 0) {
    allBarriers.set(threadId, barriers);
  }

  return [...next.values()].sort((left, right) => {
    const created = left.createdAt.getTime() - right.createdAt.getTime();
    return created || left.id.localeCompare(right.id);
  });
}

function chooseResolution<TThreadMetadata, TCommentMetadata>(
  current: ThreadData<TThreadMetadata, TCommentMetadata>,
  incoming: ThreadData<TThreadMetadata, TCommentMetadata>,
) {
  const currentTime = dateValue(current.resolvedUpdatedAt);
  const incomingTime = dateValue(incoming.resolvedUpdatedAt);

  if (currentTime !== incomingTime) {
    return currentTime > incomingTime ? current : incoming;
  }
  return deterministicKey(current) >= deterministicKey(incoming)
    ? current
    : incoming;
}

function chooseDeterministically<T extends CommentData | ThreadData>(
  current: T,
  incoming: T,
) {
  return compareDeterministically(current, incoming) >= 0 ? current : incoming;
}

function compareDeterministically(
  left: CommentData | ThreadData,
  right: CommentData | ThreadData,
) {
  if (safeDeepEqual(left, right)) {
    return 0;
  }

  const leftRevision = recordRevision(left);
  const rightRevision = recordRevision(right);
  if (leftRevision !== rightRevision) {
    return leftRevision > rightRevision ? 1 : -1;
  }

  const leftKey = deterministicKey(left);
  const rightKey = deterministicKey(right);
  return leftKey === rightKey ? 0 : leftKey > rightKey ? 1 : -1;
}

function recordRevision(record: CommentData | ThreadData): number {
  if (record.type === "comment") {
    return Math.max(
      dateValue(record.createdAt),
      dateValue(record.updatedAt),
      dateValue(record.deletedAt),
      ...record.reactions.map((reaction) => dateValue(reaction.createdAt)),
    );
  }

  return Math.max(
    dateValue(record.createdAt),
    dateValue(record.updatedAt),
    dateValue(record.deletedAt),
    dateValue(record.resolvedUpdatedAt),
    ...record.comments.map(recordRevision),
  );
}

function dateValue(value: Date | undefined) {
  return value?.getTime() ?? Number.NEGATIVE_INFINITY;
}

export function latestDate(left: Date, right: Date) {
  return left.getTime() >= right.getTime() ? left : right;
}

function deterministicKey(record: CommentData | ThreadData) {
  const known =
    record.type === "comment"
      ? [
          record.type,
          record.id,
          record.userId,
          dateValue(record.createdAt),
          dateValue(record.updatedAt),
          dateValue(record.deletedAt),
        ]
      : [
          record.type,
          record.id,
          dateValue(record.createdAt),
          dateValue(record.updatedAt),
          dateValue(record.deletedAt),
          record.resolved,
          dateValue(record.resolvedUpdatedAt),
          record.resolvedBy ?? "",
          record.detached ?? false,
        ];

  try {
    return `${known.join(":")}:${stableSerialize(record)}`;
  } catch {
    return known.join(":");
  }
}

function safeDeepEqual(left: unknown, right: unknown) {
  if (left === right) {
    return true;
  }
  try {
    return deepEqual(left, right);
  } catch {
    return false;
  }
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value instanceof Date) {
    return `date:${value.getTime()}`;
  }
  if (value === null || typeof value !== "object") {
    return `${typeof value}:${String(value)}`;
  }
  if (seen.has(value)) {
    return "circular";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
  }
  if (value instanceof Map) {
    return `map:{${[...value.entries()]
      .map(
        ([key, item]) =>
          `${stableSerialize(key, seen)}:${stableSerialize(item, seen)}`,
      )
      .sort()
      .join(",")}}`;
  }
  if (value instanceof Set) {
    return `set:[${[...value]
      .map((item) => stableSerialize(item, seen))
      .sort()
      .join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${key}:${stableSerialize(object[key], seen)}`)
    .join(",")}}`;
}
