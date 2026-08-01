/**
 * The body of a comment. This actually is a BlockNote document (array of blocks)
 */
export type CommentBody = any;

/**
 * A reaction to a comment.
 */
export type CommentReactionData = {
  /**
   * The emoji that was reacted to the comment.
   */
  emoji: string;
  /**
   * The date the first user reacted to the comment with this emoji.
   */
  createdAt: Date;
  /**
   * The user ids of the users that have reacted to the comment with this emoji
   */
  userIds: string[];
};

/**
 * Information about a comment.
 */
export type CommentData<TCommentMetadata = any> = {
  type: "comment";
  /**
   * The unique identifier for the comment.
   */
  id: string;
  /**
   * The user id of the author of the comment.
   */
  userId: string;
  /**
   * The date when the comment was created.
   */
  createdAt: Date;
  /**
   * The date when the comment was last updated.
   */
  updatedAt: Date;

  /**
   * The reactions (emoji reactions) to the comment.
   */
  reactions: CommentReactionData[];

  /**
   * You can use this store any additional information about the comment.
   */
  metadata: TCommentMetadata;
} & (
  | {
      /**
       * The date when the comment was deleted. This applies only for "soft deletes",
       * otherwise the comment is removed entirely.
       */
      deletedAt: Date;
      /**
       * The body of the comment is undefined if the comment is deleted.
       */
      body: undefined;
    }
  | {
      /**
       * In case of a non-deleted comment, this is not set
       */
      deletedAt?: never;
      /**
       * The body of the comment.
       */
      body: CommentBody;
    }
);

/**
 * Information about a thread. A thread holds a list of comments.
 */
export type ThreadData<TThreadMetadata = any, TCommentMetadata = any> = {
  type: "thread";
  /**
   * The unique identifier for the thread.
   */
  id: string;
  /**
   * The date when the thread was created.
   */
  createdAt: Date;
  /**
   * The date when the thread was last updated.
   */
  updatedAt: Date;
  /**
   * The comments in the thread.
   */
  comments: CommentData<TCommentMetadata>[];
  /**
   * Whether the thread has been marked as resolved.
   */
  resolved: boolean;
  /**
   * The date when the thread was marked as resolved.
   */
  resolvedUpdatedAt?: Date;
  /**
   * The id of the user that marked the thread as resolved.
   */
  resolvedBy?: string;
  /**
   * You can use this store any additional information about the thread.
   */
  metadata: TThreadMetadata;
  /**
   * The date when the thread was deleted. (or undefined if it is not deleted)
   * This only applies for "soft deletes", otherwise the thread is removed entirely.
   */
  deletedAt?: Date;
  /**
   * Whether the thread's anchor can no longer be mapped to the document.
   */
  detached?: boolean;
};

/**
 * A comment with application-defined metadata.
 */
export type BlockNoteComment<TCommentMetadata = any> =
  CommentData<TCommentMetadata>;

/**
 * A thread with application-defined thread and comment metadata.
 */
export type BlockNoteThread<
  TThreadMetadata = any,
  TCommentMetadata = any,
> = ThreadData<TThreadMetadata, TCommentMetadata>;

/**
 * A stable view of the threads currently known to a thread store.
 *
 * Missing rows are only known to be absent when `completeness` is `complete`.
 */
export interface BlockNoteThreadSnapshot<
  TThreadMetadata = any,
  TCommentMetadata = any,
> {
  readonly threads: ReadonlyMap<
    string,
    BlockNoteThread<TThreadMetadata, TCommentMetadata>
  >;
  readonly completeness: "partial" | "complete";
  readonly nextCursor?: string;
}
