import { BlockNoteError } from "@blocknote/core";

export function createDocumentQueue(options: {
  readonly maxItems: number;
  readonly maxBytes: number;
}) {
  let tail = Promise.resolve();
  let items = 0;
  let bytes = 0;
  let stopped = false;
  const run = <Result>(byteLength: number, task: () => Promise<Result>) => {
    if (
      stopped ||
      items >= options.maxItems ||
      byteLength > options.maxBytes - bytes
    ) {
      return Promise.reject(
        new BlockNoteError(
          "offline-unavailable",
          "BlockNote collaboration queue is overloaded.",
          { retryable: true },
        ),
      );
    }
    items += 1;
    bytes += byteLength;
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      items -= 1;
      bytes -= byteLength;
    });
  };
  return Object.freeze({
    run,
    get size() {
      return items;
    },
    async stop() {
      stopped = true;
      await tail;
    },
  });
}
