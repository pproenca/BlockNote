import type { BlockNoteEditor } from "../../editor/BlockNoteEditor.js";
import type {
  BlockNoteThreadSnapshot,
  BlockNoteThreadStoreRevision,
  BlockNoteCommentTarget,
  BlockNoteCreateThreadCommand,
  CommentBody,
  CommentData,
  ThreadData,
} from "../types.js";
import type { ThreadStoreAuth } from "./ThreadStoreAuth.js";
import { createPublicThreadSnapshot } from "./immutableThreadSnapshot.js";

type CreateThreadOptions<TThreadMetadata, TCommentMetadata> = {
  initialComment: {
    body: CommentBody;
    metadata?: TCommentMetadata;
  };
  metadata?: TThreadMetadata;
  target?: BlockNoteCommentTarget;
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

let legacyThreadStoreInstanceSequence = 0;

/**
 * Defines the interface to read and mutate threads and comments.
 */
export abstract class ThreadStore<
  TThreadMetadata = any,
  TCommentMetadata = any,
> {
  public readonly auth: ThreadStoreAuth<TThreadMetadata, TCommentMetadata>;
  private legacyObservationSequence = 0;
  private readonly legacyRevisionPrefix = `blocknote:legacy-thread-store:${++legacyThreadStoreInstanceSequence}`;

  constructor(auth: ThreadStoreAuth<TThreadMetadata, TCommentMetadata>) {
    this.auth = auth;
  }

  /**
   * Adds a thread's legacy mark to the document when supported by the store.
   */
  abstract addThreadToDocument?(options: {
    threadId: string;
    selection: {
      head: number;
      anchor: number;
    };
    editor: BlockNoteEditor<any, any, any>;
  }): Promise<void>;

  abstract createThread(
    options: CreateThreadOptions<TThreadMetadata, TCommentMetadata>,
  ): Promise<ThreadData<TThreadMetadata, TCommentMetadata>>;

  createThreadCommand(
    options: CreateThreadOptions<TThreadMetadata, TCommentMetadata>,
  ): BlockNoteCreateThreadCommand<
    ThreadData<TThreadMetadata, TCommentMetadata>
  > {
    let inFlight: Promise<
      ThreadData<TThreadMetadata, TCommentMetadata>
    > | null = null;
    let terminal: ThreadData<TThreadMetadata, TCommentMetadata> | undefined;
    return Object.freeze({
      execute: ({ signal }: { readonly signal?: AbortSignal } = {}) => {
        signal?.throwIfAborted();
        if (terminal) {
          return Promise.resolve(terminal);
        }
        if (!inFlight) {
          inFlight = this.createThread(options).then(
            (thread) => {
              terminal = thread;
              return thread;
            },
            (error) => {
              inFlight = null;
              throw error;
            },
          );
        }
        if (!signal) {
          return inFlight;
        }
        return new Promise<ThreadData<TThreadMetadata, TCommentMetadata>>(
          (resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            void inFlight!.then(
              (thread) => {
                signal.removeEventListener("abort", abort);
                resolve(thread);
              },
              (error) => {
                signal.removeEventListener("abort", abort);
                reject(error);
              },
            );
          },
        );
      },
    });
  }

  abstract addComment(
    options: AddCommentOptions<TCommentMetadata>,
  ): Promise<CommentData<TCommentMetadata>>;

  abstract updateComment(
    options: UpdateCommentOptions<TCommentMetadata>,
  ): Promise<void>;

  abstract deleteComment(options: CommentTarget): Promise<void>;

  abstract deleteThread(options: { threadId: string }): Promise<void>;

  abstract resolveThread(options: { threadId: string }): Promise<void>;

  abstract unresolveThread(options: { threadId: string }): Promise<void>;

  /**
   * Alias for `unresolveThread` using the public domain term.
   */
  reopenThread(options: { threadId: string }): Promise<void> {
    return this.unresolveThread(options);
  }

  abstract addReaction(options: ReactionTarget): Promise<void>;

  abstract deleteReaction(options: ReactionTarget): Promise<void>;

  /**
   * Returns a known thread, or `undefined` when a partial store has not loaded it.
   */
  abstract getThread(
    threadId: string,
  ): ThreadData<TThreadMetadata, TCommentMetadata> | undefined;

  abstract getThreads(): Map<
    string,
    ThreadData<TThreadMetadata, TCommentMetadata>
  >;

  /**
   * Legacy stores are complete, non-paginated stores by default.
   */
  getSnapshot(): BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata> {
    const threads = new Map(this.getThreads());
    const sequence = ++this.legacyObservationSequence;
    const revision: BlockNoteThreadStoreRevision = Object.freeze({
      sequence,
      token: `${this.legacyRevisionPrefix}:${sequence}`,
    });
    return createPublicThreadSnapshot<TThreadMetadata, TCommentMetadata>({
      threads,
      completeness: "complete",
      revision,
    });
  }

  /**
   * Whether this store is currently loading an additional snapshot page.
   */
  get isLoading() {
    return false;
  }

  /**
   * Complete legacy stores have no additional pages.
   */
  async loadMore(
    _cursor?: string,
  ): Promise<BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>> {
    return this.getSnapshot();
  }

  abstract subscribe(
    cb: (
      threads: Map<string, ThreadData<TThreadMetadata, TCommentMetadata>>,
    ) => void,
  ): () => void;
}
