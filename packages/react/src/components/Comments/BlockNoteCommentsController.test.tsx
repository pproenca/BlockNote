import {
  BlockNoteError,
  type BlockNoteAccess,
  type BlockNoteEditor,
  createBlockNoteStore,
} from "@blocknote/core";
import type { ThreadData } from "@blocknote/core/comments";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { createBlockNoteCommentsController } from "./BlockNoteCommentsController.js";
import {
  BlockNoteCommentsController,
  useBlockNoteCommentsState,
} from "./useBlockNoteCommentsState.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fullAccess: BlockNoteAccess = {
  mode: "editing",
  edit: true,
  comment: true,
  suggest: true,
  review: true,
};

function thread(id = "thread-1") {
  return { id } as ThreadData;
}

function fixture() {
  const commentState = createBlockNoteStore({
    pendingComment: false,
    selectedThreadId: undefined as string | undefined,
    threadPositions: new Map(),
  });
  const accessState = createBlockNoteStore<BlockNoteAccess>(fullAccess);
  const order: string[] = [];
  let execute = vi.fn(async () => thread());
  const createThreadCommand = vi.fn(() => ({
    execute: () => execute(),
  }));
  const mutation = vi.fn(async () => undefined);
  const comments = {
    store: {
      get state() {
        return commentState.state;
      },
      subscribe(listener: () => void) {
        const unsubscribe = commentState.subscribe(listener);
        return () => {
          order.push("comments");
          unsubscribe();
        };
      },
    },
    threadStore: {
      isLoading: false,
      subscribe() {
        return () => order.push("threads");
      },
      addComment: mutation,
      updateComment: mutation,
      deleteComment: mutation,
      deleteThread: mutation,
      resolveThread: mutation,
      reopenThread: mutation,
      addReaction: mutation,
      deleteReaction: mutation,
    },
    externalRuntime: {
      getState: () => ({
        anchors: new Map(),
        verification: { status: "idle" as const },
      }),
      subscribe: () => () => order.push("runtime"),
    },
    access: {
      get: () => accessState.state,
      subscribe(listener: () => void) {
        const unsubscribe = accessState.subscribe(listener);
        return () => {
          order.push("access");
          unsubscribe();
        };
      },
    },
    startPendingComment: vi.fn(),
    stopPendingComment: vi.fn(),
    selectThread: vi.fn(),
    createThreadCommand,
  };
  return {
    accessState,
    comments,
    createThreadCommand,
    order,
    setExecute(next: typeof execute) {
      execute = next;
    },
  };
}

describe("BlockNoteCommentsController", () => {
  it("deduplicates concurrent saves and retains the command across retry", async () => {
    const test = fixture();
    let release!: (value: ThreadData) => void;
    test.setExecute(
      vi.fn(() => new Promise<ThreadData>((resolve) => (release = resolve))),
    );
    const controller = createBlockNoteCommentsController(
      test.comments as never,
    );
    controller.openComposer();
    const first = controller.save({ initialComment: { body: [] } });
    const duplicate = controller.save({ initialComment: { body: [] } });
    expect(duplicate).toBe(first);
    release(thread());
    await first;
    expect(test.createThreadCommand).toHaveBeenCalledTimes(1);
    expect(controller.getState().composer).toBe("closed");

    const denied = new BlockNoteError("access-denied", "denied");
    test.setExecute(
      vi.fn().mockRejectedValueOnce(denied).mockResolvedValueOnce(thread()),
    );
    controller.openComposer();
    await expect(
      controller.save({ initialComment: { body: [] } }),
    ).rejects.toBe(denied);
    expect(controller.getState().composer).toBe("open");
    await controller.save({ initialComment: { body: [] } });
    expect(test.createThreadCommand).toHaveBeenCalledTimes(2);
  });

  it("does not let a closed in-flight save clobber a reopened composer", async () => {
    const test = fixture();
    let resolveFirst!: (value: ThreadData) => void;
    let resolveSecond!: (value: ThreadData) => void;
    test.setExecute(
      vi
        .fn()
        .mockImplementationOnce(
          () => new Promise<ThreadData>((resolve) => (resolveFirst = resolve)),
        )
        .mockImplementationOnce(
          () => new Promise<ThreadData>((resolve) => (resolveSecond = resolve)),
        ),
    );
    const controller = createBlockNoteCommentsController(
      test.comments as never,
    );
    controller.openComposer();
    const first = controller.save({ initialComment: { body: [] } });
    controller.closeComposer();
    controller.openComposer();
    const second = controller.save({ initialComment: { body: [] } });
    expect(second).not.toBe(first);
    resolveFirst(thread("first"));
    await first;
    expect(controller.getState().composer).toBe("submitting");
    resolveSecond(thread("second"));
    await second;
    expect(controller.getState().composer).toBe("closed");
    expect(test.createThreadCommand).toHaveBeenCalledTimes(1);
  });

  it("retains the command when stale success precedes current failure", async () => {
    const test = fixture();
    let resolveFirst!: (value: ThreadData) => void;
    let rejectSecond!: (cause: unknown) => void;
    let resolveRetry!: (value: ThreadData) => void;
    test.setExecute(
      vi
        .fn()
        .mockImplementationOnce(
          () => new Promise<ThreadData>((resolve) => (resolveFirst = resolve)),
        )
        .mockImplementationOnce(
          () =>
            new Promise<ThreadData>(
              (_resolve, reject) => (rejectSecond = reject),
            ),
        )
        .mockImplementationOnce(
          () => new Promise<ThreadData>((resolve) => (resolveRetry = resolve)),
        ),
    );
    const controller = createBlockNoteCommentsController(
      test.comments as never,
    );
    controller.openComposer();
    const stale = controller.save({ initialComment: { body: [] } });
    controller.closeComposer();
    controller.openComposer();
    const current = controller.save({ initialComment: { body: [] } });
    resolveFirst(thread("first"));
    await stale;
    rejectSecond(new Error("unknown outcome"));
    await expect(current).rejects.toThrow("unknown outcome");
    const retry = controller.save({ initialComment: { body: [] } });
    resolveRetry(thread("first"));
    await retry;
    expect(test.createThreadCommand).toHaveBeenCalledTimes(1);
    expect(controller.getState().composer).toBe("closed");
  });

  it("denies every mutation after live access revocation", async () => {
    const test = fixture();
    const controller = createBlockNoteCommentsController(
      test.comments as never,
    );
    test.accessState.set({ ...fullAccess, comment: false });
    const mutations = [
      () => controller.addComment({} as never),
      () => controller.updateComment({} as never),
      () => controller.deleteComment({} as never),
      () => controller.deleteThread({} as never),
      () => controller.resolveThread({} as never),
      () => controller.reopenThread({} as never),
      () => controller.addReaction({} as never),
      () => controller.deleteReaction({} as never),
    ];
    for (const mutate of mutations) {
      await expect(mutate()).rejects.toMatchObject({ code: "access-denied" });
    }
    expect(test.comments.threadStore.addComment).not.toHaveBeenCalled();
  });

  it("cleans subscriptions in reverse order exactly once", async () => {
    const test = fixture();
    const controller = createBlockNoteCommentsController(
      test.comments as never,
    );
    const first = controller.destroy();
    expect(controller.destroy()).toBe(first);
    await first;
    expect(test.order).toEqual(["access", "runtime", "threads", "comments"]);
  });

  it("does not publish commands or leak subscriptions in Strict Mode", async () => {
    const test = fixture();
    const editor = {
      getExtension: () => test.comments,
    } as unknown as BlockNoteEditor<any, any, any>;
    const container = document.createElement("div");
    const root = createRoot(container);
    let renders = 0;
    const Consumer = () => {
      useBlockNoteCommentsState((state) => state.composer);
      renders += 1;
      return null;
    };
    await act(async () => {
      root.render(
        <StrictMode>
          <BlockNoteCommentsController editor={editor}>
            <Consumer />
          </BlockNoteCommentsController>
        </StrictMode>,
      );
    });
    expect(test.createThreadCommand).not.toHaveBeenCalled();
    expect(renders).toBeGreaterThan(0);
    await act(async () => root.unmount());
    await Promise.resolve();
    expect(test.order).toEqual(["access", "runtime", "threads", "comments"]);
  });
});
