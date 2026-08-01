import { BlockNoteError } from "../../platform/BlockNoteError.js";
import type {
  BlockNoteThread,
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
  let type: unknown;
  try {
    type = value?.type;
  } catch (error) {
    throw invalidThreadStoreState(
      "Thread commit change is not readable.",
      error,
    );
  }

  if (type === "delete") {
    let threadId: unknown;
    try {
      threadId = (
        value as BlockNoteThreadStoreChange<
          TThreadMetadata,
          TCommentMetadata
        > & {
          readonly type: "delete";
        }
      ).threadId;
    } catch (error) {
      throw invalidThreadStoreState(
        "Deleted thread id is not readable.",
        error,
      );
    }
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw invalidThreadStoreState(
        "A deleted thread id must be a non-empty string.",
      );
    }
    return Object.freeze({ type: "delete", threadId });
  }

  if (type === "upsert") {
    let sourceThread: BlockNoteThread<TThreadMetadata, TCommentMetadata>;
    try {
      sourceThread = (
        value as BlockNoteThreadStoreChange<
          TThreadMetadata,
          TCommentMetadata
        > & {
          readonly type: "upsert";
        }
      ).thread;
    } catch (error) {
      throw invalidThreadStoreState("Upsert thread is not readable.", error);
    }
    return Object.freeze({
      type: "upsert",
      thread: cloneThread(sourceThread),
    });
  }

  throw invalidThreadStoreState("A commit change must be an upsert or delete.");
}

export function normalizeThreadStoreCommitReceipt<
  TThreadMetadata,
  TCommentMetadata,
>(
  value: BlockNoteThreadStoreCommitReceipt<TThreadMetadata, TCommentMetadata>,
  knownRevision?: BlockNoteThreadStoreRevision,
): BlockNoteThreadStoreCommitReceipt<TThreadMetadata, TCommentMetadata> {
  let revision = knownRevision;
  if (revision === undefined) {
    let sourceRevision: BlockNoteThreadStoreRevision;
    try {
      sourceRevision = value.revision;
    } catch (error) {
      throw invalidThreadStoreState(
        "Thread commit revision is not readable.",
        error,
      );
    }
    revision = normalizeThreadStoreRevision(sourceRevision);
  }

  let sourceChange: BlockNoteThreadStoreChange<
    TThreadMetadata,
    TCommentMetadata
  >;
  try {
    sourceChange = value.change;
  } catch (error) {
    throw invalidThreadStoreState(
      "Thread commit change is not readable.",
      error,
    );
  }
  return Object.freeze({
    revision,
    change: normalizeThreadStoreChange(sourceChange),
  });
}

export function readThreadStoreRevision(value: {
  readonly revision: BlockNoteThreadStoreRevision;
}) {
  let sourceRevision: BlockNoteThreadStoreRevision;
  try {
    sourceRevision = value.revision;
  } catch (error) {
    throw invalidThreadStoreState(
      "Thread store revision is not readable.",
      error,
    );
  }
  return normalizeThreadStoreRevision(sourceRevision);
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

export function assertThreadStoreCommitIsFresh(
  revision: BlockNoteThreadStoreRevision,
  startRevision: BlockNoteThreadStoreRevision,
) {
  if (revision.sequence <= startRevision.sequence) {
    throw invalidThreadStoreState(
      "Mutation receipt revision must be strictly newer than its start revision.",
    );
  }
}

export function assertCreateThreadReceipt<TThreadMetadata, TCommentMetadata>(
  receipt: ThreadStoreMutationReceipt<
    TThreadMetadata,
    TCommentMetadata,
    ThreadData<TThreadMetadata, TCommentMetadata>
  >,
) {
  const normalized = normalizeThreadStoreCommitReceipt(receipt);
  const result = readMutationResult(receipt, "createThread");
  let resultId: unknown;
  try {
    resultId = result?.id;
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
  return { receipt: normalized, result };
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
  const result = readMutationResult(receipt, "addComment");
  let resultId: unknown;
  try {
    resultId = result?.id;
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
  return { receipt: normalized, result };
}

export function assertThreadMutationReceipt<TThreadMetadata, TCommentMetadata>(
  receipt: BlockNoteThreadStoreCommitReceipt<TThreadMetadata, TCommentMetadata>,
  threadId: string,
  allowedChange: "upsert" | "upsert-or-delete",
) {
  const normalized = normalizeThreadStoreCommitReceipt(receipt);
  const result = readMutationResult(receipt, "Thread mutation");
  if (result !== undefined) {
    throw invalidThreadStoreState("Thread mutation result must be undefined.");
  }
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

function readMutationResult<TResult>(
  receipt: { readonly result: TResult },
  operation: string,
): TResult;
function readMutationResult(receipt: object, operation: string): unknown;
function readMutationResult(receipt: object, operation: string) {
  try {
    return (receipt as { readonly result?: unknown }).result;
  } catch (error) {
    throw invalidThreadStoreState(
      `${operation} result is not readable.`,
      error,
    );
  }
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
