import type { BlockNoteAccessStore } from "../../access/BlockNoteAccess.js";
import { BlockNoteError } from "../../platform/BlockNoteError.js";
import type { BlockNoteCommentAnchorMappingResult } from "../../runtime/BlockNoteCommentAnchorRuntime.js";
import type { ThreadStore } from "../threadstore/ThreadStore.js";
import type {
  BlockNoteCreateThreadCommand,
  BlockNoteThreadSnapshot,
  CommentBody,
  ThreadData,
} from "../types.js";
import type { BlockNoteCommentAnchor } from "./BlockNoteCommentAnchor.js";
import type { BlockNoteCommentAnchorCapture } from "./BlockNoteCommentAnchorCapture.js";

export type BlockNoteCommentAnchorVerificationState =
  | { readonly status: "idle" }
  | { readonly status: "verifying" }
  | { readonly status: "error"; readonly error: BlockNoteError };

export type BlockNoteExternalCommentAnchorState =
  | {
      readonly status: "attached";
      readonly range: { readonly from: number; readonly to: number };
    }
  | { readonly status: "detached" }
  | { readonly status: "unknown" };

export interface ExternalCommentsRuntimeState {
  readonly anchors: ReadonlyMap<string, BlockNoteExternalCommentAnchorState>;
  readonly verification: BlockNoteCommentAnchorVerificationState;
}

export interface ExternalCommentsVerifier {
  verifyAndMap(
    anchor: BlockNoteCommentAnchor,
    signal?: AbortSignal,
  ): Promise<BlockNoteCommentAnchorMappingResult>;
}

export function createExternalCommentsRuntime<
  TThreadMetadata = any,
  TCommentMetadata = any,
>(input: {
  readonly threadStore: ThreadStore<TThreadMetadata, TCommentMetadata>;
  readonly access: BlockNoteAccessStore;
  readonly isOnline: () => boolean;
  readonly capture: (range: {
    readonly from: number;
    readonly to: number;
  }) => BlockNoteCommentAnchorCapture;
  readonly verifier: ExternalCommentsVerifier;
}) {
  let state: ExternalCommentsRuntimeState = Object.freeze({
    anchors: new Map(),
    verification: Object.freeze({ status: "idle" }),
  });
  let generation = 0;
  let destroyed = false;
  let destroyPromise: Promise<void> | null = null;
  const listeners = new Set<(state: ExternalCommentsRuntimeState) => void>();

  const publish = (next: ExternalCommentsRuntimeState) => {
    if (destroyed) {
      return;
    }
    state = Object.freeze(next);
    for (const listener of [...listeners]) {
      listener(state);
    }
  };

  const verifySnapshot = async (
    snapshot: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
  ) => {
    const current = ++generation;
    publish({ ...state, verification: Object.freeze({ status: "verifying" }) });
    const anchors = new Map<string, BlockNoteExternalCommentAnchorState>();
    try {
      await Promise.all(
        [...snapshot.threads].map(async ([threadId, thread]) => {
          if (!thread.anchor) {
            anchors.set(
              threadId,
              snapshot.completeness === "complete"
                ? { status: "detached" }
                : { status: "unknown" },
            );
            return;
          }
          anchors.set(
            threadId,
            await input.verifier.verifyAndMap(thread.anchor),
          );
        }),
      );
      if (current !== generation || destroyed) {
        return;
      }
      publish({
        anchors,
        verification: Object.freeze({ status: "idle" }),
      });
    } catch (error) {
      if (current !== generation || destroyed) {
        return;
      }
      const failure =
        error instanceof BlockNoteError
          ? error
          : new BlockNoteError(
              "invalid-anchor",
              "BlockNote external comment anchor verification failed.",
              { cause: error },
            );
      publish({
        anchors: new Map(),
        verification: Object.freeze({ status: "error", error: failure }),
      });
    }
  };

  const stop = input.threadStore.subscribe(() => {
    void verifySnapshot(input.threadStore.getSnapshot());
  });
  void verifySnapshot(input.threadStore.getSnapshot());

  return Object.freeze({
    capture: input.capture,
    createThreadCommand(options: {
      readonly initialComment: {
        readonly body: CommentBody;
        readonly metadata?: TCommentMetadata;
      };
      readonly metadata?: TThreadMetadata;
      readonly capture: BlockNoteCommentAnchorCapture;
    }): BlockNoteCreateThreadCommand<
      ThreadData<TThreadMetadata, TCommentMetadata>
    > {
      const command = input.threadStore.createThreadCommand({
        initialComment: options.initialComment,
        metadata: options.metadata,
        target: { kind: "external", capture: options.capture },
      });
      let dispatched = false;
      return Object.freeze({
        async execute({ signal }: { readonly signal?: AbortSignal } = {}) {
          signal?.throwIfAborted();
          if (!dispatched) {
            if (!input.isOnline()) {
              throw new BlockNoteError(
                "offline-unavailable",
                "External comments require an online authoritative server.",
                { retryable: true },
              );
            }
            if (!input.access.get().comment) {
              throw new BlockNoteError(
                "access-denied",
                "Comment access is required.",
              );
            }
            dispatched = true;
          }
          const thread = await command.execute({ signal });
          if (!thread.anchor) {
            throw new BlockNoteError(
              "invalid-anchor",
              "Authoritative external comment receipt has no sealed anchor.",
            );
          }
          await input.verifier.verifyAndMap(thread.anchor, signal);
          return thread;
        },
      });
    },
    destroy() {
      if (destroyPromise) {
        return destroyPromise;
      }
      destroyPromise = Promise.resolve().then(() => {
        if (destroyed) {
          return;
        }
        destroyed = true;
        generation += 1;
        try {
          stop();
        } catch (error) {
          throw new BlockNoteError(
            "extension-cleanup-failed",
            "External comments cleanup failed.",
            { cause: error },
          );
        } finally {
          listeners.clear();
        }
      });
      return destroyPromise;
    },
    getState: () => state,
    subscribe(listener: (value: ExternalCommentsRuntimeState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
