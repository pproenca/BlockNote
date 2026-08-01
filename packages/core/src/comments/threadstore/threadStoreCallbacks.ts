import type {
  BlockNoteThreadSnapshot,
  BlockNoteThreadStoreCommitReceipt,
  BlockNoteThreadStoreMutationReceipt,
  BlockNoteThreadStoreRevision,
  CommentBody,
  CommentData,
  ThreadData,
} from "../types.js";
import type { ThreadStoreAuth } from "./ThreadStoreAuth.js";

export type CreateThreadOptions<TThreadMetadata, TCommentMetadata> = {
  initialComment: {
    body: CommentBody;
    metadata?: TCommentMetadata;
  };
  metadata?: TThreadMetadata;
};

export type AddCommentOptions<TCommentMetadata> = {
  comment: {
    body: CommentBody;
    metadata?: TCommentMetadata;
  };
  threadId: string;
};

export type UpdateCommentOptions<TCommentMetadata> =
  AddCommentOptions<TCommentMetadata> & {
    commentId: string;
  };

export type CommentTarget = {
  threadId: string;
  commentId: string;
};

export type ReactionTarget = CommentTarget & {
  emoji: string;
};

export type ThreadStoreLoadRequest<TThreadMetadata, TCommentMetadata> = {
  readonly id: number;
  readonly cursor?: string;
  readonly revision: BlockNoteThreadStoreRevision;
  readonly promise: Promise<
    BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>
  >;
};

type Idempotent<TOptions> = TOptions & {
  /**
   * Stable across retries made inside this callback invocation. Calling the
   * public ThreadStore operation again starts a new operation with a new key.
   */
  readonly idempotencyKey: string;
};

type MutationReceipt<
  TThreadMetadata,
  TCommentMetadata,
  TResult = void,
> = BlockNoteThreadStoreMutationReceipt<
  TThreadMetadata,
  TCommentMetadata,
  TResult
>;

/**
 * Application callbacks used by createThreadStore.
 *
 * Revisions are authoritative and metadata is opaque. Applications must keep
 * each metadata value immutable for the lifetime of the revision that exposes
 * it. The store never enumerates, clones, freezes, compares, or serializes it.
 * A successful mutation callback must return its authoritative commit at a
 * revision strictly newer than the snapshot observed when invocation begins.
 * Source updates may overtake that receipt while the callback is pending.
 */
export type ThreadStoreCallbacks<
  TThreadMetadata = any,
  TCommentMetadata = any,
> = {
  readonly auth?: ThreadStoreAuth<TThreadMetadata, TCommentMetadata>;
  readonly getSnapshot: () => BlockNoteThreadSnapshot<
    TThreadMetadata,
    TCommentMetadata
  >;
  readonly subscribe: (
    listener: (
      commit: BlockNoteThreadStoreCommitReceipt<
        TThreadMetadata,
        TCommentMetadata
      >,
    ) => void,
  ) => () => void;
  readonly loadMore: (options: {
    readonly cursor?: string;
    readonly revision: BlockNoteThreadStoreRevision;
  }) => Promise<BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>>;
  readonly createThread: (
    options: Idempotent<CreateThreadOptions<TThreadMetadata, TCommentMetadata>>,
  ) => Promise<
    MutationReceipt<
      TThreadMetadata,
      TCommentMetadata,
      ThreadData<TThreadMetadata, TCommentMetadata>
    >
  >;
  readonly addComment: (
    options: Idempotent<AddCommentOptions<TCommentMetadata>>,
  ) => Promise<
    MutationReceipt<
      TThreadMetadata,
      TCommentMetadata,
      CommentData<TCommentMetadata>
    >
  >;
  readonly updateComment: (
    options: Idempotent<UpdateCommentOptions<TCommentMetadata>>,
  ) => Promise<MutationReceipt<TThreadMetadata, TCommentMetadata>>;
  readonly deleteComment: (
    options: Idempotent<CommentTarget>,
  ) => Promise<MutationReceipt<TThreadMetadata, TCommentMetadata>>;
  readonly deleteThread: (
    options: Idempotent<{ threadId: string }>,
  ) => Promise<MutationReceipt<TThreadMetadata, TCommentMetadata>>;
  readonly resolveThread: (
    options: Idempotent<{ threadId: string }>,
  ) => Promise<MutationReceipt<TThreadMetadata, TCommentMetadata>>;
  readonly reopenThread: (
    options: Idempotent<{ threadId: string }>,
  ) => Promise<MutationReceipt<TThreadMetadata, TCommentMetadata>>;
  readonly addReaction: (
    options: Idempotent<ReactionTarget>,
  ) => Promise<MutationReceipt<TThreadMetadata, TCommentMetadata>>;
  readonly deleteReaction: (
    options: Idempotent<ReactionTarget>,
  ) => Promise<MutationReceipt<TThreadMetadata, TCommentMetadata>>;
};

export type ThreadStoreMutationReceipt<
  TThreadMetadata,
  TCommentMetadata,
  TResult = void,
> = MutationReceipt<TThreadMetadata, TCommentMetadata, TResult>;
