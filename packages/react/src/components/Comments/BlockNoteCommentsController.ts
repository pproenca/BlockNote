import {
  BlockNoteError,
  isBlockNoteError,
  type BlockNoteAccess,
} from "@blocknote/core";
import type {
  BlockNoteCreateThreadCommand,
  CommentsExtension,
  BlockNoteCommentAnchorVerificationState,
  CommentBody,
  ThreadData,
} from "@blocknote/core/comments";

type CommentsFacade = ReturnType<
  typeof CommentsExtension
>["~types"]["extension"];

export interface BlockNoteCommentsState {
  readonly composer: "closed" | "open" | "submitting" | "reconciling";
  readonly selectedThreadId?: string;
  readonly anchor: "none" | "attached" | "detached" | "unknown";
  readonly verification: BlockNoteCommentAnchorVerificationState;
  readonly loading: boolean;
  readonly access: BlockNoteAccess;
  readonly error?: BlockNoteError;
}

const legacyAccess = Object.freeze({
  mode: "editing" as const,
  edit: true,
  comment: true,
  suggest: true,
  review: true,
});

function blockNoteError(value: unknown): BlockNoteError | undefined {
  return isBlockNoteError(value) ? value : undefined;
}

export function createBlockNoteCommentsController(comments: CommentsFacade) {
  let composer: BlockNoteCommentsState["composer"] = "closed";
  let error: BlockNoteError | undefined;
  let command: BlockNoteCreateThreadCommand<ThreadData> | null = null;
  let active: Promise<ThreadData> | null = null;
  let composerGeneration = 0;
  let destroyed = false;
  let destroyPromise: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const snapshot = (): BlockNoteCommentsState => {
    const selectedThreadId = comments.store.state.selectedThreadId;
    const external = comments.externalRuntime?.getState();
    const selectedAnchor = selectedThreadId
      ? external?.anchors.get(selectedThreadId)
      : undefined;
    return Object.freeze({
      composer,
      ...(selectedThreadId === undefined ? {} : { selectedThreadId }),
      anchor: selectedAnchor?.status ?? "none",
      verification:
        external?.verification ?? Object.freeze({ status: "idle" as const }),
      loading: comments.threadStore.isLoading,
      access: comments.access?.get() ?? legacyAccess,
      ...(error === undefined ? {} : { error }),
    });
  };
  let state = snapshot();

  const notify = () => {
    if (destroyed) {
      return;
    }
    state = snapshot();
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const cleanups = [
    comments.store.subscribe(notify),
    comments.threadStore.subscribe(notify),
    comments.externalRuntime?.subscribe(notify),
    comments.access?.subscribe(notify),
  ].filter((cleanup): cleanup is () => void => typeof cleanup === "function");

  const requireCommentAccess = () => {
    if (!(comments.access?.get() ?? legacyAccess).comment) {
      throw new BlockNoteError("access-denied", "Comment access is required.");
    }
  };

  const runMutation = async <Result>(operation: () => Promise<Result>) => {
    requireCommentAccess();
    return operation();
  };

  return Object.freeze({
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openComposer() {
      composerGeneration += 1;
      comments.startPendingComment();
      composer = "open";
      error = undefined;
      notify();
    },
    closeComposer() {
      composerGeneration += 1;
      comments.stopPendingComment();
      composer = "closed";
      const hadActiveWaiter = active !== null;
      active = null;
      if (!hadActiveWaiter) {
        command = null;
      }
      error = undefined;
      notify();
    },
    save(options: {
      readonly initialComment: {
        readonly body: CommentBody;
        readonly metadata?: any;
      };
      readonly metadata?: any;
    }) {
      if (active) {
        return active;
      }
      command ??= comments.createThreadCommand(options);
      const currentCommand = command;
      const generation = composerGeneration;
      composer = composer === "reconciling" ? "reconciling" : "submitting";
      error = undefined;
      notify();
      const operation = currentCommand
        .execute()
        .then(
          (thread) => {
            if (generation === composerGeneration) {
              if (command === currentCommand) {
                command = null;
              }
              composer = "closed";
              comments.stopPendingComment();
              error = undefined;
            }
            return thread;
          },
          (cause: unknown) => {
            if (generation === composerGeneration) {
              const stable = blockNoteError(cause);
              error = stable;
              composer =
                stable?.code === "offline-unavailable" ||
                stable?.code === "access-denied" ||
                stable?.code === "invalid-anchor"
                  ? "open"
                  : "reconciling";
            }
            throw cause;
          },
        )
        .finally(() => {
          if (active === operation) {
            active = null;
            notify();
          }
        });
      active = operation;
      return operation;
    },
    selectThread(threadId?: string) {
      comments.selectThread(threadId);
    },
    addComment: (
      options: Parameters<CommentsFacade["threadStore"]["addComment"]>[0],
    ) => runMutation(() => comments.threadStore.addComment(options)),
    updateComment: (
      options: Parameters<CommentsFacade["threadStore"]["updateComment"]>[0],
    ) => runMutation(() => comments.threadStore.updateComment(options)),
    deleteComment: (
      options: Parameters<CommentsFacade["threadStore"]["deleteComment"]>[0],
    ) => runMutation(() => comments.threadStore.deleteComment(options)),
    deleteThread: (
      options: Parameters<CommentsFacade["threadStore"]["deleteThread"]>[0],
    ) => runMutation(() => comments.threadStore.deleteThread(options)),
    resolveThread: (
      options: Parameters<CommentsFacade["threadStore"]["resolveThread"]>[0],
    ) => runMutation(() => comments.threadStore.resolveThread(options)),
    reopenThread: (
      options: Parameters<CommentsFacade["threadStore"]["reopenThread"]>[0],
    ) => runMutation(() => comments.threadStore.reopenThread(options)),
    addReaction: (
      options: Parameters<CommentsFacade["threadStore"]["addReaction"]>[0],
    ) => runMutation(() => comments.threadStore.addReaction(options)),
    deleteReaction: (
      options: Parameters<CommentsFacade["threadStore"]["deleteReaction"]>[0],
    ) => runMutation(() => comments.threadStore.deleteReaction(options)),
    destroy() {
      if (destroyPromise) {
        return destroyPromise;
      }
      destroyPromise = Promise.resolve().then(() => {
        destroyed = true;
        const failures: unknown[] = [];
        for (const cleanup of cleanups.reverse()) {
          try {
            cleanup();
          } catch (cause) {
            failures.push(cause);
          }
        }
        listeners.clear();
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "BlockNote comments cleanup failed.",
          );
        }
      });
      return destroyPromise;
    },
  });
}

export type BlockNoteCommentsControllerInstance = ReturnType<
  typeof createBlockNoteCommentsController
>;
