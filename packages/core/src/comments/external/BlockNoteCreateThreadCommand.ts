import type { BlockNoteCreateThreadCommand, ThreadData } from "../types.js";

export function createBlockNoteCreateThreadCommand<
  TThreadMetadata,
  TCommentMetadata,
>(
  execute: (
    signal: AbortSignal,
  ) => Promise<ThreadData<TThreadMetadata, TCommentMetadata>>,
): BlockNoteCreateThreadCommand<ThreadData<TThreadMetadata, TCommentMetadata>> {
  const controller = new AbortController();
  let inFlight: Promise<ThreadData<TThreadMetadata, TCommentMetadata>> | null =
    null;
  let terminal: ThreadData<TThreadMetadata, TCommentMetadata> | undefined;

  return Object.freeze({
    execute({ signal }: { readonly signal?: AbortSignal } = {}) {
      signal?.throwIfAborted();
      if (terminal) {
        return Promise.resolve(terminal);
      }
      if (!inFlight) {
        inFlight = execute(controller.signal).then(
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
