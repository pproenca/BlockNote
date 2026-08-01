import { BlockNoteError } from "../../platform/BlockNoteError.js";
import type {
  BlockNoteThreadStoreChange,
  BlockNoteThreadStoreCommitReceipt,
  BlockNoteThreadStoreRevision,
  CommentData,
  ThreadData,
} from "../types.js";
import { cloneThread } from "./immutableThreadSnapshot.js";
import type { ThreadStoreMutationReceipt } from "./threadStoreCallbacks.js";

const maximumRevisionTokenLength = 256;
let idempotencyPrefixSequence = 0;

export function createThreadStoreIdempotencyPrefix() {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) {
    return `blocknote-thread:${crypto.randomUUID()}`;
  }
  return `blocknote-thread:${Date.now()}:${++idempotencyPrefixSequence}`;
}

export function normalizeThreadStoreRevision(
  value: BlockNoteThreadStoreRevision,
): BlockNoteThreadStoreRevision {
  let sequence: unknown;
  let token: unknown;
  try {
    sequence = value?.sequence;
    token = value?.token;
  } catch (error) {
    throw invalidThreadStoreState(
      "Thread store revision is not readable.",
      error,
    );
  }

  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
    throw invalidThreadStoreState(
      "Thread store revision sequence must be a non-negative safe integer.",
    );
  }
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > maximumRevisionTokenLength
  ) {
    throw invalidThreadStoreState(
      `Thread store revision token must contain 1-${maximumRevisionTokenLength} characters.`,
    );
  }
  return Object.freeze({ sequence: sequence as number, token });
}

export function normalizeThreadStoreChange<TThreadMetadata, TCommentMetadata>(
  value: BlockNoteThreadStoreChange<TThreadMetadata, TCommentMetadata>,
): BlockNoteThreadStoreChange<TThreadMetadata, TCommentMetadata> {
  try {
    if (value?.type === "delete") {
      if (typeof value.threadId !== "string" || value.threadId.length === 0) {
        throw invalidThreadStoreState(
          "A deleted thread id must be a non-empty string.",
        );
      }
      return Object.freeze({ type: "delete", threadId: value.threadId });
    }
    if (value?.type === "upsert") {
      return Object.freeze({
        type: "upsert",
        thread: cloneThread(value.thread),
      });
    }
    throw invalidThreadStoreState(
      "A commit change must be an upsert or delete.",
    );
  } catch (error) {
    if (error instanceof BlockNoteError) {
      throw error;
    }
    throw invalidThreadStoreState(
      "Thread commit change is not readable.",
      error,
    );
  }
}

export function normalizeThreadStoreCommitReceipt<
  TThreadMetadata,
  TCommentMetadata,
>(
  value: BlockNoteThreadStoreCommitReceipt<TThreadMetadata, TCommentMetadata>,
  knownRevision?: BlockNoteThreadStoreRevision,
): BlockNoteThreadStoreCommitReceipt<TThreadMetadata, TCommentMetadata> {
  try {
    const revision =
      knownRevision ?? normalizeThreadStoreRevision(value.revision);
    const change = normalizeThreadStoreChange(value.change);
    return Object.freeze({ revision, change });
  } catch (error) {
    if (error instanceof BlockNoteError) {
      throw error;
    }
    throw invalidThreadStoreState(
      "Thread commit receipt is not readable.",
      error,
    );
  }
}

export function readThreadStoreRevision(value: {
  readonly revision: BlockNoteThreadStoreRevision;
}) {
  try {
    return normalizeThreadStoreRevision(value.revision);
  } catch (error) {
    if (error instanceof BlockNoteError) {
      throw error;
    }
    throw invalidThreadStoreState(
      "Thread store revision is not readable.",
      error,
    );
  }
}

export function compareThreadStoreRevision(
  current: BlockNoteThreadStoreRevision,
  incoming: BlockNoteThreadStoreRevision,
) {
  if (incoming.sequence === current.sequence) {
    if (incoming.token !== current.token) {
      throw threadStoreRevisionConflict(incoming.sequence);
    }
    return 0;
  }
  return current.sequence > incoming.sequence ? 1 : -1;
}

export function sameThreadStoreRevision(
  left: BlockNoteThreadStoreRevision,
  right: BlockNoteThreadStoreRevision,
) {
  return left.sequence === right.sequence && left.token === right.token;
}

export function assertCreateThreadReceipt<TThreadMetadata, TCommentMetadata>(
  receipt: ThreadStoreMutationReceipt<
    TThreadMetadata,
    TCommentMetadata,
    ThreadData<TThreadMetadata, TCommentMetadata>
  >,
) {
  const normalized = normalizeThreadStoreCommitReceipt(receipt);
  let resultId: unknown;
  try {
    resultId = receipt.result?.id;
  } catch (error) {
    throw invalidThreadStoreState(
      "createThread result is not readable.",
      error,
    );
  }
  if (
    normalized.change.type !== "upsert" ||
    typeof resultId !== "string" ||
    resultId !== normalized.change.thread.id
  ) {
    throw invalidThreadStoreState(
      "createThread result must identify its authoritative upsert.",
    );
  }
  return normalized;
}

export function assertAddCommentReceipt<TThreadMetadata, TCommentMetadata>(
  receipt: ThreadStoreMutationReceipt<
    TThreadMetadata,
    TCommentMetadata,
    CommentData<TCommentMetadata>
  >,
  threadId: string,
) {
  const normalized = normalizeThreadStoreCommitReceipt(receipt);
  let resultId: unknown;
  try {
    resultId = receipt.result?.id;
  } catch (error) {
    throw invalidThreadStoreState("addComment result is not readable.", error);
  }
  if (
    normalized.change.type !== "upsert" ||
    normalized.change.thread.id !== threadId ||
    typeof resultId !== "string" ||
    !normalized.change.thread.comments.some(
      (comment) => comment.id === resultId,
    )
  ) {
    throw invalidThreadStoreState(
      "addComment result must identify a comment in its authoritative upsert.",
    );
  }
  return { receipt: normalized, commentId: resultId };
}

export function assertThreadMutationReceipt<TThreadMetadata, TCommentMetadata>(
  receipt: BlockNoteThreadStoreCommitReceipt<TThreadMetadata, TCommentMetadata>,
  threadId: string,
  allowedChange: "upsert" | "upsert-or-delete",
) {
  const normalized = normalizeThreadStoreCommitReceipt(receipt);
  const matches =
    normalized.change.type === "upsert"
      ? normalized.change.thread.id === threadId
      : allowedChange === "upsert-or-delete" &&
        normalized.change.threadId === threadId;
  if (!matches) {
    throw invalidThreadStoreState(
      "Mutation receipt must change the operation's target thread.",
    );
  }
  return normalized;
}

export function threadStoreRevisionConflict(sequence: number) {
  return new BlockNoteError(
    "document-conflict",
    `Thread store revision ${sequence} has conflicting tokens.`,
    { retryable: false },
  );
}

export function invalidThreadStoreState(message: string, cause?: unknown) {
  return new BlockNoteError("invalid-document", message, { cause });
}
