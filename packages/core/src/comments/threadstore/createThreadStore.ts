import type {
  BlockNoteThreadSnapshot,
  CommentBody,
  CommentData,
  ThreadData,
} from "../types.js";
import { ThreadStore } from "./ThreadStore.js";
import { ThreadStoreAuth } from "./ThreadStoreAuth.js";
import {
  latestDate,
  ThreadSnapshotReconciler,
} from "./threadStoreReconciliation.js";

type CreateThreadOptions<TThreadMetadata, TCommentMetadata> = {
  initialComment: {
    body: CommentBody;
    metadata?: TCommentMetadata;
  };
  metadata?: TThreadMetadata;
};

type AddCommentOptions<TCommentMetadata> = {
  comment: {
    body: CommentBody;
    metadata?: TCommentMetadata;
  };
  threadId: string;
};

type UpdateCommentOptions<TCommentMetadata> =
  AddCommentOptions<TCommentMetadata> & {
    commentId: string;
  };

type CommentTarget = {
  threadId: string;
  commentId: string;
};

type ReactionTarget = CommentTarget & {
  emoji: string;
};

/**
 * Application callbacks used by {@link createThreadStore}.
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
  readonly subscribe: (listener: () => void) => () => void;
  readonly loadMore: (
    cursor?: string,
  ) => Promise<BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>>;
  readonly createThread: (
    options: CreateThreadOptions<TThreadMetadata, TCommentMetadata>,
  ) => Promise<ThreadData<TThreadMetadata, TCommentMetadata>>;
  readonly addComment: (
    options: AddCommentOptions<TCommentMetadata>,
  ) => Promise<CommentData<TCommentMetadata>>;
  readonly updateComment: (
    options: UpdateCommentOptions<TCommentMetadata>,
  ) => Promise<void>;
  readonly deleteComment: (options: CommentTarget) => Promise<void>;
  readonly deleteThread: (options: { threadId: string }) => Promise<void>;
  readonly resolveThread: (options: { threadId: string }) => Promise<void>;
  readonly reopenThread: (options: { threadId: string }) => Promise<void>;
  readonly addReaction: (options: ReactionTarget) => Promise<void>;
  readonly deleteReaction: (options: ReactionTarget) => Promise<void>;
};

class CallbackThreadStoreAuth<
  TThreadMetadata,
  TCommentMetadata,
> extends ThreadStoreAuth<TThreadMetadata, TCommentMetadata> {
  canCreateThread() {
    return true;
  }

  canAddComment() {
    return true;
  }

  canUpdateComment() {
    return true;
  }

  canDeleteComment() {
    return true;
  }

  canDeleteThread() {
    return true;
  }

  canResolveThread() {
    return true;
  }

  canUnresolveThread() {
    return true;
  }

  canAddReaction() {
    return true;
  }

  canDeleteReaction() {
    return true;
  }
}

class CallbackThreadStore<
  TThreadMetadata,
  TCommentMetadata,
> extends ThreadStore<TThreadMetadata, TCommentMetadata> {
  public addThreadToDocument = undefined;

  private readonly reconciler: ThreadSnapshotReconciler<
    TThreadMetadata,
    TCommentMetadata
  >;
  private readonly listeners = new Set<
    (
      threads: Map<string, ThreadData<TThreadMetadata, TCommentMetadata>>,
    ) => void
  >();
  private readonly loadingRequests = new Map<
    string | undefined,
    Promise<BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>>
  >();
  private unsubscribeFromSource: (() => void) | undefined;
  private operationActive = false;
  private operationQueue: Promise<void> = Promise.resolve();
  private pageApplicationQueue: Promise<void> = Promise.resolve();
  private applyingSourceSnapshot = false;
  private sourceSnapshotChangedReentrantly = false;

  constructor(
    private readonly callbacks: ThreadStoreCallbacks<
      TThreadMetadata,
      TCommentMetadata
    >,
  ) {
    super(
      callbacks.auth ??
        new CallbackThreadStoreAuth<TThreadMetadata, TCommentMetadata>(),
    );
    this.reconciler = new ThreadSnapshotReconciler(callbacks.getSnapshot());
  }

  createThread(
    options: CreateThreadOptions<TThreadMetadata, TCommentMetadata>,
  ) {
    return this.runOperation(async () => {
      const thread = await this.callbacks.createThread(options);
      let changed = this.applySourceSnapshot();
      changed = this.reconciler.applyMutationThread(thread) || changed;
      this.notify(changed);
      return thread;
    });
  }

  addComment(options: AddCommentOptions<TCommentMetadata>) {
    return this.runOperation(async () => {
      const comment = await this.callbacks.addComment(options);
      let changed = this.applySourceSnapshot();
      const thread = this.reconciler
        .getSnapshot()
        .threads.get(options.threadId);

      if (thread && !thread.deletedAt) {
        changed =
          this.reconciler.applyMutationThread({
            ...thread,
            comments: [...thread.comments, comment],
            updatedAt: latestDate(thread.updatedAt, comment.updatedAt),
          }) || changed;
      }

      this.notify(changed);
      return comment;
    });
  }

  updateComment(options: UpdateCommentOptions<TCommentMetadata>) {
    return this.runMutation(() => this.callbacks.updateComment(options));
  }

  deleteComment(options: CommentTarget) {
    return this.runMutation(() => this.callbacks.deleteComment(options));
  }

  deleteThread(options: { threadId: string }) {
    return this.runMutation(() => this.callbacks.deleteThread(options));
  }

  resolveThread(options: { threadId: string }) {
    return this.runMutation(() => this.callbacks.resolveThread(options));
  }

  unresolveThread(options: { threadId: string }) {
    return this.runMutation(() => this.callbacks.reopenThread(options));
  }

  addReaction(options: ReactionTarget) {
    return this.runMutation(() => this.callbacks.addReaction(options));
  }

  deleteReaction(options: ReactionTarget) {
    return this.runMutation(() => this.callbacks.deleteReaction(options));
  }

  getThread(threadId: string) {
    return this.reconciler.getSnapshot().threads.get(threadId);
  }

  getThreads() {
    return new Map(this.reconciler.getSnapshot().threads);
  }

  override getSnapshot() {
    return this.reconciler.getSnapshot();
  }

  override get isLoading() {
    return this.loadingRequests.size > 0;
  }

  override loadMore(cursor = this.getSnapshot().nextCursor) {
    const existing = this.loadingRequests.get(cursor);
    if (existing) {
      return existing;
    }

    if (
      cursor === undefined &&
      this.getSnapshot().completeness === "complete"
    ) {
      return Promise.resolve(this.getSnapshot());
    }

    const wasLoading = this.isLoading;
    const response = this.callbacks.loadMore(cursor).then(
      (page) => ({ page }) as const,
      (error: unknown) => ({ error }) as const,
    );
    const request = this.pageApplicationQueue.then(async () => {
      const result = await response;
      if ("error" in result) {
        throw result.error;
      }
      return this.runOperation(async () => {
        const changed = this.reconciler.applySnapshot(result.page, "page");
        this.notify(changed);
        return this.getSnapshot();
      });
    });
    this.pageApplicationQueue = request.then(
      () => undefined,
      () => undefined,
    );
    this.loadingRequests.set(cursor, request);
    if (!wasLoading) {
      this.notify(true);
    }
    const clear = () => {
      if (this.loadingRequests.get(cursor) === request) {
        this.loadingRequests.delete(cursor);
        if (!this.isLoading) {
          this.notify(true);
        }
      }
    };
    void request.then(clear, clear);
    return request;
  }

  subscribe(
    cb: (
      threads: Map<string, ThreadData<TThreadMetadata, TCommentMetadata>>,
    ) => void,
  ) {
    this.listeners.add(cb);

    if (this.listeners.size === 1) {
      try {
        this.unsubscribeFromSource = this.callbacks.subscribe(() => {
          if (!this.operationActive) {
            this.notify(this.applySourceSnapshot());
          }
        });
        this.notify(this.applySourceSnapshot());
      } catch (error) {
        this.listeners.delete(cb);
        this.unsubscribeFromSource?.();
        this.unsubscribeFromSource = undefined;
        throw error;
      }
    }

    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) {
        this.unsubscribeFromSource?.();
        this.unsubscribeFromSource = undefined;
      }
    };
  }

  private runMutation(mutation: () => Promise<void>) {
    return this.runOperation(async () => {
      await mutation();
      this.notify(this.applySourceSnapshot());
    });
  }

  private runOperation<T>(operation: () => Promise<T>) {
    const run = this.operationQueue.then(async () => {
      this.operationActive = true;
      try {
        return await operation();
      } finally {
        this.operationActive = false;
      }
    });

    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private applySourceSnapshot() {
    if (this.applyingSourceSnapshot) {
      this.sourceSnapshotChangedReentrantly = true;
      return false;
    }

    this.applyingSourceSnapshot = true;
    let changed = false;
    try {
      for (let pass = 0; pass < 2; pass++) {
        this.sourceSnapshotChangedReentrantly = false;
        changed =
          this.reconciler.applySnapshot(
            this.callbacks.getSnapshot(),
            "source",
          ) || changed;
        if (!this.sourceSnapshotChangedReentrantly) {
          break;
        }
      }
    } finally {
      this.applyingSourceSnapshot = false;
      this.sourceSnapshotChangedReentrantly = false;
    }
    return changed;
  }

  private notify(changed: boolean) {
    if (!changed) {
      return;
    }
    for (const listener of this.listeners) {
      listener(this.getThreads());
    }
  }
}

/**
 * Creates a generic ThreadStore backed by an application's secure store.
 */
export function createThreadStore<
  TThreadMetadata = any,
  TCommentMetadata = any,
>(
  callbacks: ThreadStoreCallbacks<TThreadMetadata, TCommentMetadata>,
): ThreadStore<TThreadMetadata, TCommentMetadata> {
  return new CallbackThreadStore(callbacks);
}
