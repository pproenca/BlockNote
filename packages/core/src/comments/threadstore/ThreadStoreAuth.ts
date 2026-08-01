import type { CommentData, ThreadData } from "../types.js";

export abstract class ThreadStoreAuth<
  TThreadMetadata = any,
  TCommentMetadata = any,
> {
  abstract canCreateThread(): boolean;
  abstract canAddComment(
    thread: ThreadData<TThreadMetadata, TCommentMetadata>,
  ): boolean;
  abstract canUpdateComment(comment: CommentData<TCommentMetadata>): boolean;
  abstract canDeleteComment(comment: CommentData<TCommentMetadata>): boolean;
  abstract canDeleteThread(
    thread: ThreadData<TThreadMetadata, TCommentMetadata>,
  ): boolean;
  abstract canResolveThread(
    thread: ThreadData<TThreadMetadata, TCommentMetadata>,
  ): boolean;
  abstract canUnresolveThread(
    thread: ThreadData<TThreadMetadata, TCommentMetadata>,
  ): boolean;
  abstract canAddReaction(
    comment: CommentData<TCommentMetadata>,
    emoji?: string,
  ): boolean;
  abstract canDeleteReaction(
    comment: CommentData<TCommentMetadata>,
    emoji?: string,
  ): boolean;
}
