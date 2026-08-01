import type {
  BlockNoteThreadSnapshot,
  CommentData,
  ThreadData,
} from "../types.js";
import { ThreadStore } from "./ThreadStore.js";
import { CallbackThreadStoreAuth } from "./CallbackThreadStoreAuth.js";
import { CommittedThreadStoreState } from "./committedThreadStoreState.js";
import {
  assertAddCommentReceipt,
  assertCreateThreadReceipt,
  assertThreadMutationReceipt,
  createThreadStoreIdempotencyPrefix,
  invalidThreadStoreState,
  sameThreadStoreRevision,
} from "./threadStoreCommit.js";
import type {
  AddCommentOptions,
  CommentTarget,
  CreateThreadOptions,
  ReactionTarget,
  ThreadStoreCallbacks,
  ThreadStoreLoadRequest,
  ThreadStoreMutationReceipt,
  UpdateCommentOptions,
} from "./threadStoreCallbacks.js";

export type { ThreadStoreCallbacks } from "./threadStoreCallbacks.js";

class CallbackThreadStore<
  TThreadMetadata,
  TCommentMetadata,
> extends ThreadStore<TThreadMetadata, TCommentMetadata> {
  public addThreadToDocument = undefined;

  private readonly state: CommittedThreadStoreState<
    TThreadMetadata,
    TCommentMetadata
  >;
  private readonly listeners = new Set<
    (
      threads: Map<string, ThreadData<TThreadMetadata, TCommentMetadata>>,
    ) => void
  >();
  private readonly loadingRequests = new Map<
    number,
    ThreadStoreLoadRequest<TThreadMetadata, TCommentMetadata>
  >();
  private unsubscribeFromSource: (() => void) | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private nextLoadRequestId = 0;
  private nextIdempotencySequence = 0;
  private readonly idempotencyPrefix = createThreadStoreIdempotencyPrefix();

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
    this.state = new CommittedThreadStoreState(callbacks.getSnapshot());
  }

  createThread(
    options: CreateThreadOptions<TThreadMetadata, TCommentMetadata>,
  ) {
    return this.runMutation(async (idempotencyKey) => {
      const receipt = await this.callbacks.createThread({
        ...options,
        idempotencyKey,
      });
      const normalizedReceipt = assertCreateThreadReceipt(receipt);
      const applied = this.state.applyCommit(normalizedReceipt);
      this.notify(applied.changed);
      const change = applied.change ?? normalizedReceipt.change;
      if (change.type !== "upsert") {
        throw invalidThreadStoreState("createThread must commit an upsert.");
      }
      return change.thread as ThreadData<TThreadMetadata, TCommentMetadata>;
    });
  }

  addComment(options: AddCommentOptions<TCommentMetadata>) {
    return this.runMutation(async (idempotencyKey) => {
      const receipt = await this.callbacks.addComment({
        ...options,
        idempotencyKey,
      });
      const normalized = assertAddCommentReceipt(receipt, options.threadId);
      const applied = this.state.applyCommit(normalized.receipt);
      this.notify(applied.changed);
      const change = applied.change ?? normalized.receipt.change;
      if (change.type !== "upsert") {
        throw invalidThreadStoreState("addComment must commit an upsert.");
      }
      const comment = change.thread.comments.find(
        (candidate) => candidate.id === normalized.commentId,
      );
      if (!comment) {
        throw invalidThreadStoreState(
          "addComment result is absent from its authoritative thread.",
        );
      }
      return comment as CommentData<TCommentMetadata>;
    });
  }

  updateComment(options: UpdateCommentOptions<TCommentMetadata>) {
    return this.runThreadMutation(
      options.threadId,
      "upsert",
      (idempotencyKey) =>
        this.callbacks.updateComment({ ...options, idempotencyKey }),
    );
  }

  deleteComment(options: CommentTarget) {
    return this.runThreadMutation(
      options.threadId,
      "upsert",
      (idempotencyKey) =>
        this.callbacks.deleteComment({ ...options, idempotencyKey }),
    );
  }

  deleteThread(options: { threadId: string }) {
    return this.runThreadMutation(
      options.threadId,
      "upsert-or-delete",
      (idempotencyKey) =>
        this.callbacks.deleteThread({ ...options, idempotencyKey }),
    );
  }

  resolveThread(options: { threadId: string }) {
    return this.runThreadMutation(
      options.threadId,
      "upsert",
      (idempotencyKey) =>
        this.callbacks.resolveThread({ ...options, idempotencyKey }),
    );
  }

  unresolveThread(options: { threadId: string }) {
    return this.runThreadMutation(
      options.threadId,
      "upsert",
      (idempotencyKey) =>
        this.callbacks.reopenThread({ ...options, idempotencyKey }),
    );
  }

  addReaction(options: ReactionTarget) {
    return this.runThreadMutation(
      options.threadId,
      "upsert",
      (idempotencyKey) =>
        this.callbacks.addReaction({ ...options, idempotencyKey }),
    );
  }

  deleteReaction(options: ReactionTarget) {
    return this.runThreadMutation(
      options.threadId,
      "upsert",
      (idempotencyKey) =>
        this.callbacks.deleteReaction({ ...options, idempotencyKey }),
    );
  }

  getThread(threadId: string) {
    return this.state.getSnapshot().threads.get(threadId) as
      | ThreadData<TThreadMetadata, TCommentMetadata>
      | undefined;
  }

  getThreads() {
    return new Map(this.state.getSnapshot().threads) as Map<
      string,
      ThreadData<TThreadMetadata, TCommentMetadata>
    >;
  }

  override getSnapshot() {
    return this.state.getSnapshot();
  }

  override get isLoading() {
    return this.loadingRequests.size > 0;
  }

  override loadMore(cursor = this.getSnapshot().nextCursor) {
    const snapshot = this.getSnapshot();
    if (
      snapshot.completeness === "complete" ||
      cursor !== snapshot.nextCursor
    ) {
      return Promise.resolve(snapshot);
    }

    const duplicate = [...this.loadingRequests.values()].find(
      (request) =>
        request.cursor === cursor &&
        sameThreadStoreRevision(request.revision, snapshot.revision),
    );
    if (duplicate) {
      return duplicate.promise;
    }

    const id = ++this.nextLoadRequestId;
    const revision = snapshot.revision;
    const wasLoading = this.isLoading;
    const requestOptions = Object.freeze({
      ...(cursor === undefined ? {} : { cursor }),
      revision,
    });
    let response: Promise<
      BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>
    >;
    try {
      response = Promise.resolve(this.callbacks.loadMore(requestOptions));
    } catch (error) {
      response = Promise.reject(error);
    }
    const promise = response
      .then((page) => {
        const changed = this.state.applyPage(page, { cursor, revision });
        this.notify(changed);
        return this.getSnapshot();
      })
      .finally(() => {
        this.loadingRequests.delete(id);
        if (!this.isLoading) {
          this.notify(true);
        }
      });

    this.loadingRequests.set(id, { id, cursor, revision, promise });
    if (!wasLoading) {
      this.notify(true);
    }
    return promise;
  }

  subscribe(
    listener: (
      threads: Map<string, ThreadData<TThreadMetadata, TCommentMetadata>>,
    ) => void,
  ) {
    this.listeners.add(listener);

    if (this.listeners.size === 1) {
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = this.callbacks.subscribe((commit) => {
          const applied = this.state.applyCommit(commit);
          this.notify(applied.changed);
        });
        this.unsubscribeFromSource = unsubscribe;
        this.notify(
          this.state.applySourceSnapshot(this.callbacks.getSnapshot()),
        );
      } catch (error) {
        this.listeners.delete(listener);
        unsubscribe?.();
        this.unsubscribeFromSource = undefined;
        throw error;
      }
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unsubscribeFromSource?.();
        this.unsubscribeFromSource = undefined;
      }
    };
  }

  private runThreadMutation(
    threadId: string,
    allowedChange: "upsert" | "upsert-or-delete",
    callback: (
      idempotencyKey: string,
    ) => Promise<ThreadStoreMutationReceipt<TThreadMetadata, TCommentMetadata>>,
  ) {
    return this.runMutation(async (idempotencyKey) => {
      const receipt = await callback(idempotencyKey);
      const normalizedReceipt = assertThreadMutationReceipt(
        receipt,
        threadId,
        allowedChange,
      );
      const applied = this.state.applyCommit(normalizedReceipt);
      this.notify(applied.changed);
    });
  }

  private runMutation<TResult>(
    operation: (idempotencyKey: string) => Promise<TResult>,
  ) {
    const idempotencyKey = `${this.idempotencyPrefix}:${++this.nextIdempotencySequence}`;
    const run = this.mutationQueue.then(() => operation(idempotencyKey));
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private notify(changed: boolean) {
    if (!changed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(this.getThreads());
      } catch {
        // A consumer listener cannot alter a committed adapter operation.
      }
    }
  }
}

/** Creates a generic ThreadStore backed by an application's secure store. */
export function createThreadStore<
  TThreadMetadata = any,
  TCommentMetadata = any,
>(
  callbacks: ThreadStoreCallbacks<TThreadMetadata, TCommentMetadata>,
): ThreadStore<TThreadMetadata, TCommentMetadata> {
  return new CallbackThreadStore(callbacks);
}
