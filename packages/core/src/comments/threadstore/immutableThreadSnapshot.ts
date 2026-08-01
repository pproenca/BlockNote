import { BlockNoteError } from "../../platform/BlockNoteError.js";
import type {
  BlockNoteComment,
  BlockNoteCommentReaction,
  BlockNoteThread,
  BlockNoteThreadSnapshot,
  BlockNoteThreadStoreRevision,
} from "../types.js";
import {
  cloneOwnedSnapshotValue,
  immutableSnapshotDate,
  readonlyMapFacade,
} from "./immutableSnapshotValues.js";

export type NormalizedThreadSnapshot<TThreadMetadata, TCommentMetadata> = {
  readonly revision: BlockNoteThreadStoreRevision;
  readonly threads: Map<
    string,
    BlockNoteThread<TThreadMetadata, TCommentMetadata>
  >;
  readonly completeness: "partial" | "complete";
  readonly nextCursor?: string;
};

export function normalizeThreadSnapshot<TThreadMetadata, TCommentMetadata>(
  value: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
  revision: BlockNoteThreadStoreRevision,
  knownCompleteness?: "partial" | "complete",
): NormalizedThreadSnapshot<TThreadMetadata, TCommentMetadata> {
  const completeness =
    knownCompleteness ?? readThreadSnapshotCompleteness(value);
  let nextCursor: unknown;
  let sourceThreads: ReadonlyMap<
    string,
    BlockNoteThread<TThreadMetadata, TCommentMetadata>
  >;
  try {
    nextCursor = value.nextCursor;
    sourceThreads = value.threads;
  } catch (error) {
    throw invalidSnapshot("Thread snapshot is not readable.", error);
  }

  if (nextCursor !== undefined && typeof nextCursor !== "string") {
    throw invalidSnapshot("Thread snapshot cursor must be a string.");
  }

  try {
    const threads = new Map<
      string,
      BlockNoteThread<TThreadMetadata, TCommentMetadata>
    >();
    for (const [threadId, sourceThread] of sourceThreads) {
      const thread = cloneThread(sourceThread);
      if (threadId !== thread.id) {
        throw invalidSnapshot(
          `Thread map key "${threadId}" does not match its thread id.`,
        );
      }
      threads.set(threadId, thread);
    }

    return {
      revision,
      threads,
      completeness,
      ...(nextCursor === undefined ? {} : { nextCursor }),
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
  let completeness: unknown;
  try {
    completeness = value.completeness;
  } catch (error) {
    throw invalidSnapshot(
      "Thread snapshot completeness is not readable.",
      error,
    );
  }
  if (completeness !== "partial" && completeness !== "complete") {
    throw invalidSnapshot(
      'Thread snapshot completeness must be "partial" or "complete".',
    );
  }
  return completeness;
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
    threads: readonlyMapFacade(threads),
    completeness: value.completeness,
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
    revision: value.revision,
  });
}

export function cloneThread<TThreadMetadata, TCommentMetadata>(
  value: BlockNoteThread<TThreadMetadata, TCommentMetadata>,
): BlockNoteThread<TThreadMetadata, TCommentMetadata> {
  let type: unknown;
  let id: unknown;
  let createdAt: unknown;
  let updatedAt: unknown;
  let sourceComments: readonly BlockNoteComment<TCommentMetadata>[];
  let resolved: unknown;
  let metadata: TThreadMetadata;
  let resolvedUpdatedAt: unknown;
  let resolvedBy: unknown;
  let deletedAt: unknown;
  let detached: unknown;
  try {
    type = value.type;
    id = value.id;
    createdAt = value.createdAt;
    updatedAt = value.updatedAt;
    sourceComments = value.comments;
    resolved = value.resolved;
    metadata = value.metadata;
    resolvedUpdatedAt = value.resolvedUpdatedAt;
    resolvedBy = value.resolvedBy;
    deletedAt = value.deletedAt;
    detached = value.detached;
  } catch (error) {
    throw invalidSnapshot("Thread row is not readable.", error);
  }

  if (
    type !== "thread" ||
    typeof id !== "string" ||
    id.length === 0 ||
    !(createdAt instanceof Date) ||
    !(updatedAt instanceof Date) ||
    !Array.isArray(sourceComments) ||
    typeof resolved !== "boolean" ||
    (resolvedUpdatedAt !== undefined && !(resolvedUpdatedAt instanceof Date)) ||
    (resolvedBy !== undefined && typeof resolvedBy !== "string") ||
    (deletedAt !== undefined && !(deletedAt instanceof Date)) ||
    (detached !== undefined && typeof detached !== "boolean")
  ) {
    throw invalidSnapshot("Thread row has invalid fields.");
  }

  try {
    return Object.freeze({
      type: "thread" as const,
      id,
      createdAt: immutableSnapshotDate(createdAt),
      updatedAt: immutableSnapshotDate(updatedAt),
      comments: Object.freeze(
        sourceComments.map((comment) =>
          cloneComment<TCommentMetadata>(comment),
        ),
      ),
      resolved,
      metadata,
      ...(resolvedUpdatedAt === undefined
        ? {}
        : { resolvedUpdatedAt: immutableSnapshotDate(resolvedUpdatedAt) }),
      ...(resolvedBy === undefined ? {} : { resolvedBy }),
      ...(deletedAt === undefined
        ? {}
        : { deletedAt: immutableSnapshotDate(deletedAt) }),
      ...(detached === undefined ? {} : { detached }),
    });
  } catch (error) {
    if (error instanceof BlockNoteError) {
      throw error;
    }
    throw invalidSnapshot("Thread row fields are not readable.", error);
  }
}

function cloneComment<TCommentMetadata>(
  value: BlockNoteComment<TCommentMetadata>,
): BlockNoteComment<TCommentMetadata> {
  let type: unknown;
  let id: unknown;
  let userId: unknown;
  let createdAt: unknown;
  let updatedAt: unknown;
  let sourceReactions: readonly BlockNoteCommentReaction[];
  let metadata: TCommentMetadata;
  let deletedAt: unknown;
  let body: unknown;
  try {
    type = value.type;
    id = value.id;
    userId = value.userId;
    createdAt = value.createdAt;
    updatedAt = value.updatedAt;
    sourceReactions = value.reactions;
    metadata = value.metadata;
    deletedAt = value.deletedAt;
    body = value.body;
  } catch (error) {
    throw invalidSnapshot("Comment row is not readable.", error);
  }

  if (
    type !== "comment" ||
    typeof id !== "string" ||
    id.length === 0 ||
    typeof userId !== "string" ||
    !(createdAt instanceof Date) ||
    !(updatedAt instanceof Date) ||
    !Array.isArray(sourceReactions) ||
    (deletedAt !== undefined && !(deletedAt instanceof Date)) ||
    (deletedAt !== undefined && body !== undefined)
  ) {
    throw invalidSnapshot("Comment row has invalid fields.");
  }

  try {
    const common = {
      type: "comment" as const,
      id,
      userId,
      createdAt: immutableSnapshotDate(createdAt),
      updatedAt: immutableSnapshotDate(updatedAt),
      reactions: Object.freeze(sourceReactions.map(cloneReaction)),
      metadata,
    };
    const comment =
      deletedAt === undefined
        ? { ...common, body: cloneOwnedSnapshotValue(body) }
        : {
            ...common,
            deletedAt: immutableSnapshotDate(deletedAt),
            body: undefined,
          };
    return Object.freeze(comment) as BlockNoteComment<TCommentMetadata>;
  } catch (error) {
    if (error instanceof BlockNoteError) {
      throw error;
    }
    throw invalidSnapshot("Comment row fields are not readable.", error);
  }
}

function cloneReaction(value: BlockNoteCommentReaction) {
  let emoji: unknown;
  let createdAt: unknown;
  let userIds: readonly string[];
  try {
    emoji = value.emoji;
    createdAt = value.createdAt;
    userIds = value.userIds;
  } catch (error) {
    throw invalidSnapshot("Comment reaction is not readable.", error);
  }
  if (
    typeof emoji !== "string" ||
    !(createdAt instanceof Date) ||
    !Array.isArray(userIds) ||
    userIds.some((userId) => typeof userId !== "string")
  ) {
    throw invalidSnapshot("Comment reaction has invalid fields.");
  }
  return Object.freeze({
    emoji,
    createdAt: immutableSnapshotDate(createdAt),
    userIds: Object.freeze([...userIds]),
  });
}

function invalidSnapshot(message: string, cause?: unknown) {
  return new BlockNoteError("invalid-document", message, { cause });
}
