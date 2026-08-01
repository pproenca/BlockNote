import { describe, expect, expectTypeOf, it, vi } from "vite-plus/test";

import type {
  BlockNoteThreadSnapshot,
  CommentData,
  ThreadData,
} from "../types.js";
import {
  createThreadStore,
  type ThreadStoreCallbacks,
} from "./createThreadStore.js";

type ThreadMetadata = {
  label: string;
  opaque?: unknown;
};

type CommentMetadata = {
  origin: "human" | "agent";
};

type Snapshot = BlockNoteThreadSnapshot<ThreadMetadata, CommentMetadata>;

type Behavior = {
  subscribe: ThreadStoreCallbacks<ThreadMetadata, CommentMetadata>["subscribe"];
  loadMore: ThreadStoreCallbacks<ThreadMetadata, CommentMetadata>["loadMore"];
  createThread: ThreadStoreCallbacks<
    ThreadMetadata,
    CommentMetadata
  >["createThread"];
  addComment: ThreadStoreCallbacks<
    ThreadMetadata,
    CommentMetadata
  >["addComment"];
  updateComment: ThreadStoreCallbacks<
    ThreadMetadata,
    CommentMetadata
  >["updateComment"];
  deleteComment: ThreadStoreCallbacks<
    ThreadMetadata,
    CommentMetadata
  >["deleteComment"];
  deleteThread: ThreadStoreCallbacks<
    ThreadMetadata,
    CommentMetadata
  >["deleteThread"];
  resolveThread: ThreadStoreCallbacks<
    ThreadMetadata,
    CommentMetadata
  >["resolveThread"];
  reopenThread: ThreadStoreCallbacks<
    ThreadMetadata,
    CommentMetadata
  >["reopenThread"];
  addReaction: ThreadStoreCallbacks<
    ThreadMetadata,
    CommentMetadata
  >["addReaction"];
  deleteReaction: ThreadStoreCallbacks<
    ThreadMetadata,
    CommentMetadata
  >["deleteReaction"];
};

function date(value: number) {
  return new Date(value);
}

function comment(id: string, revision: number): CommentData<CommentMetadata> {
  return {
    type: "comment",
    id,
    userId: "user-1",
    createdAt: date(revision),
    updatedAt: date(revision),
    reactions: [],
    metadata: { origin: "human" },
    body: [{ type: "paragraph", content: id }],
  };
}

function thread(
  id: string,
  revision: number,
  overrides: Partial<ThreadData<ThreadMetadata, CommentMetadata>> = {},
): ThreadData<ThreadMetadata, CommentMetadata> {
  return {
    type: "thread",
    id,
    createdAt: date(revision),
    updatedAt: date(revision),
    comments: [comment(`${id}-comment`, revision)],
    resolved: false,
    metadata: { label: id },
    ...overrides,
  };
}

function snapshot(
  threads: ThreadData<ThreadMetadata, CommentMetadata>[],
  completeness: "partial" | "complete" = "partial",
  nextCursor?: string,
): Snapshot {
  return {
    threads: new Map(threads.map((item) => [item.id, item])),
    completeness,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(initialSnapshot: Snapshot) {
  let sourceSnapshot = initialSnapshot;
  const sourceListeners = new Set<() => void>();
  const unused = async () => {
    throw new Error("unused callback");
  };
  const behavior: Behavior = {
    subscribe(listener) {
      sourceListeners.add(listener);
      return () => sourceListeners.delete(listener);
    },
    loadMore: unused,
    createThread: unused,
    addComment: unused,
    updateComment: async () => {},
    deleteComment: async () => {},
    deleteThread: async () => {},
    resolveThread: async () => {},
    reopenThread: async () => {},
    addReaction: async () => {},
    deleteReaction: async () => {},
  };
  const store = createThreadStore<ThreadMetadata, CommentMetadata>({
    getSnapshot: () => sourceSnapshot,
    subscribe: (listener) => behavior.subscribe(listener),
    loadMore: (cursor) => behavior.loadMore(cursor),
    createThread: (options) => behavior.createThread(options),
    addComment: (options) => behavior.addComment(options),
    updateComment: (options) => behavior.updateComment(options),
    deleteComment: (options) => behavior.deleteComment(options),
    deleteThread: (options) => behavior.deleteThread(options),
    resolveThread: (options) => behavior.resolveThread(options),
    reopenThread: (options) => behavior.reopenThread(options),
    addReaction: (options) => behavior.addReaction(options),
    deleteReaction: (options) => behavior.deleteReaction(options),
  });

  return {
    behavior,
    store,
    emitSource() {
      for (const listener of [...sourceListeners]) {
        listener();
      }
    },
    setSource(next: Snapshot) {
      sourceSnapshot = next;
      for (const listener of [...sourceListeners]) {
        listener();
      }
    },
  };
}

describe("createThreadStore", () => {
  it("flows thread and comment metadata through callbacks without casts", async () => {
    const initial = snapshot([], "complete");
    const created = thread("created", 1);
    const store = createThreadStore<ThreadMetadata, CommentMetadata>({
      getSnapshot: () => initial,
      subscribe: () => () => {},
      loadMore: async () => initial,
      createThread: async (options) => {
        expectTypeOf(options.metadata).toEqualTypeOf<
          ThreadMetadata | undefined
        >();
        expectTypeOf(options.initialComment.metadata).toEqualTypeOf<
          CommentMetadata | undefined
        >();
        return created;
      },
      addComment: async (options) => {
        expectTypeOf(options.comment.metadata).toEqualTypeOf<
          CommentMetadata | undefined
        >();
        return comment("reply", 2);
      },
      updateComment: async (options) => {
        expectTypeOf(options.comment.metadata).toEqualTypeOf<
          CommentMetadata | undefined
        >();
      },
      deleteComment: async () => {},
      deleteThread: async () => {},
      resolveThread: async () => {},
      reopenThread: async () => {},
      addReaction: async () => {},
      deleteReaction: async () => {},
    });

    expectTypeOf(store.getThread("missing")).toEqualTypeOf<
      ThreadData<ThreadMetadata, CommentMetadata> | undefined
    >();
    expectTypeOf(store.getSnapshot().threads).toEqualTypeOf<
      ReadonlyMap<string, ThreadData<ThreadMetadata, CommentMetadata>>
    >();

    await expect(
      store.createThread({
        metadata: { label: "created" },
        initialComment: {
          body: [],
          metadata: { origin: "agent" },
        },
      }),
    ).resolves.toBe(created);
  });

  it("keeps a stable snapshot and ignores duplicate source emissions", () => {
    const firstThread = thread("first", 1);
    const harness = createHarness(snapshot([firstThread]));
    const firstSnapshot = harness.store.getSnapshot();
    const listener = vi.fn();
    const unsubscribe = harness.store.subscribe(listener);

    expect(harness.store.getSnapshot()).toBe(firstSnapshot);
    harness.setSource(snapshot([{ ...firstThread }]));

    expect(harness.store.getSnapshot()).toBe(firstSnapshot);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("preserves absent rows in partial snapshots until a complete snapshot", () => {
    const first = thread("first", 1);
    const second = thread("second", 2);
    const harness = createHarness(snapshot([first], "partial", "page-2"));
    const unsubscribe = harness.store.subscribe(() => {});

    harness.setSource(snapshot([second], "partial", "page-3"));
    expect([...harness.store.getSnapshot().threads.keys()]).toEqual([
      "first",
      "second",
    ]);
    expect(harness.store.getThread("not-loaded")).toBeUndefined();
    expect(harness.store.getSnapshot().completeness).toBe("partial");

    harness.setSource(snapshot([second], "complete"));
    expect([...harness.store.getSnapshot().threads.keys()]).toEqual(["second"]);
    expect(harness.store.getSnapshot().completeness).toBe("complete");
    unsubscribe();
  });

  it("composes partial pages and removes the cursor at completeness", async () => {
    const first = thread("first", 1);
    const second = thread("second", 2);
    const third = thread("third", 3);
    const harness = createHarness(snapshot([first], "partial", "page-2"));
    const pages = new Map<string | undefined, Snapshot>([
      ["page-2", snapshot([second], "partial", "page-3")],
      ["page-3", snapshot([third], "complete")],
    ]);
    harness.behavior.loadMore = async (cursor) => pages.get(cursor)!;

    await harness.store.loadMore();
    expect([...harness.store.getSnapshot().threads.keys()]).toEqual([
      "first",
      "second",
    ]);
    expect(harness.store.getSnapshot().nextCursor).toBe("page-3");

    await harness.store.loadMore();
    expect([...harness.store.getSnapshot().threads.keys()]).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(harness.store.getSnapshot()).toMatchObject({
      completeness: "complete",
    });
    expect(harness.store.getSnapshot()).not.toHaveProperty("nextCursor");
  });

  it("tracks loading separately from unknown and does not coalesce cursors", async () => {
    const harness = createHarness(snapshot([], "partial", "first-cursor"));
    const firstPage = deferred<Snapshot>();
    const secondPage = deferred<Snapshot>();
    const loadMore = vi.fn((cursor?: string) =>
      cursor === "first-cursor" ? firstPage.promise : secondPage.promise,
    );
    harness.behavior.loadMore = loadMore;
    const listener = vi.fn();
    const unsubscribe = harness.store.subscribe(listener);
    const before = harness.store.getSnapshot();

    const firstRequest = harness.store.loadMore("first-cursor");
    const duplicateRequest = harness.store.loadMore("first-cursor");
    const secondRequest = harness.store.loadMore("second-cursor");

    expect(duplicateRequest).toBe(firstRequest);
    expect(secondRequest).not.toBe(firstRequest);
    expect(loadMore).toHaveBeenCalledTimes(2);
    expect(harness.store.isLoading).toBe(true);
    expect(harness.store.getThread("unknown")).toBeUndefined();
    expect(harness.store.getSnapshot().completeness).toBe("partial");
    expect(harness.store.getSnapshot()).toBe(before);

    secondPage.resolve(
      snapshot([thread("second", 2)], "partial", "after-second"),
    );
    await Promise.resolve();
    expect(harness.store.isLoading).toBe(true);

    firstPage.resolve(snapshot([thread("first", 1)], "partial", "after-first"));
    await Promise.all([firstRequest, secondRequest]);
    expect(harness.store.isLoading).toBe(false);
    expect([...harness.store.getSnapshot().threads.keys()].sort()).toEqual([
      "first",
      "second",
    ]);
    expect(harness.store.getSnapshot().nextCursor).toBe("after-second");
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("keeps lifecycle states separate", () => {
    const deleted = thread("deleted", 1, { deletedAt: date(5) });
    const resolved = thread("resolved", 2, {
      resolved: true,
      resolvedUpdatedAt: date(6),
    });
    const detached = thread("detached", 3, { detached: true });
    const harness = createHarness(
      snapshot([deleted, resolved, detached], "partial"),
    );

    expect(harness.store.getThread("deleted")?.deletedAt).toEqual(date(5));
    expect(harness.store.getThread("resolved")).toMatchObject({
      resolved: true,
    });
    expect(harness.store.getThread("resolved")?.detached).toBeUndefined();
    expect(harness.store.getThread("detached")).toMatchObject({
      resolved: false,
      detached: true,
    });
    expect(harness.store.isLoading).toBe(false);
    expect(harness.store.getThread("unknown")).toBeUndefined();
  });

  it("does not resurrect deleted rows from stale or equal snapshots", () => {
    const live = thread("target", 1);
    const deleted = thread("target", 1, { deletedAt: date(5) });
    const harness = createHarness(snapshot([live]));
    const unsubscribe = harness.store.subscribe(() => {});

    harness.setSource(snapshot([deleted]));
    harness.setSource(snapshot([live]));
    expect(harness.store.getThread("target")?.deletedAt).toEqual(date(5));

    harness.setSource(snapshot([], "complete"));
    expect(harness.store.getThread("target")).toBeUndefined();

    harness.setSource(snapshot([live]));
    expect(harness.store.getThread("target")).toBeUndefined();
    unsubscribe();
  });

  it("resolves equal-timestamp conflicts independently of arrival order", () => {
    const left = thread("target", 1, { metadata: { label: "left" } });
    const right = thread("target", 1, { metadata: { label: "right" } });
    const leftFirst = createHarness(snapshot([left]));
    const rightFirst = createHarness(snapshot([right]));
    const unsubscribeLeft = leftFirst.store.subscribe(() => {});
    const unsubscribeRight = rightFirst.store.subscribe(() => {});

    leftFirst.setSource(snapshot([right]));
    rightFirst.setSource(snapshot([left]));

    expect(leftFirst.store.getThread("target")?.metadata).toEqual(
      rightFirst.store.getThread("target")?.metadata,
    );
    unsubscribeLeft();
    unsubscribeRight();
  });

  it("does not inspect opaque metadata unsafely during reconciliation", () => {
    const opaque = () =>
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("opaque metadata");
          },
        },
      );
    const first = thread("target", 1, {
      metadata: { label: "opaque", opaque: opaque() },
    });
    const second = thread("target", 1, {
      metadata: { label: "opaque", opaque: opaque() },
    });
    const harness = createHarness(snapshot([first]));
    const unsubscribe = harness.store.subscribe(() => {});

    expect(() => harness.setSource(snapshot([second]))).not.toThrow();
    expect(harness.store.getThread("target")?.id).toBe("target");
    unsubscribe();
  });

  it("does not commit subscription state emitted by a rejected mutation", async () => {
    const original = thread("target", 1);
    const optimistic = thread("target", 2, {
      metadata: { label: "optimistic" },
    });
    const harness = createHarness(snapshot([original]));
    const listener = vi.fn();
    const unsubscribe = harness.store.subscribe(listener);
    harness.behavior.updateComment = async () => {
      harness.setSource(snapshot([optimistic]));
      throw new Error("rejected");
    };

    await expect(
      harness.store.updateComment({
        threadId: "target",
        commentId: "target-comment",
        comment: { body: [] },
      }),
    ).rejects.toThrow("rejected");

    expect(harness.store.getThread("target")?.metadata.label).toBe("target");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("reconciles a mutation result with a newer concurrent source snapshot", async () => {
    const harness = createHarness(snapshot([]));
    const created = deferred<ThreadData<ThreadMetadata, CommentMetadata>>();
    const older = thread("target", 1, { metadata: { label: "older" } });
    const newer = thread("target", 2, { metadata: { label: "newer" } });
    harness.behavior.createThread = () => created.promise;
    const unsubscribe = harness.store.subscribe(() => {});

    const request = harness.store.createThread({
      metadata: { label: "older" },
      initialComment: { body: [], metadata: { origin: "human" } },
    });
    harness.setSource(snapshot([newer]));
    created.resolve(older);
    await request;

    expect(harness.store.getThread("target")?.metadata.label).toBe("newer");
    unsubscribe();
  });

  it("protects a successful mutation result from stale complete snapshots", async () => {
    const initial = snapshot([], "complete");
    const created = thread("created", 2);
    const harness = createHarness(initial);
    harness.behavior.createThread = async () => created;
    const unsubscribe = harness.store.subscribe(() => {});

    await harness.store.createThread({
      metadata: { label: "created" },
      initialComment: { body: [], metadata: { origin: "human" } },
    });
    harness.emitSource();
    expect(harness.store.getThread("created")).toBe(created);

    harness.setSource(snapshot([created], "complete"));
    harness.setSource(snapshot([], "complete"));
    expect(harness.store.getThread("created")).toBeUndefined();
    unsubscribe();
  });

  it("handles a synchronous source emission while subscribing", () => {
    const harness = createHarness(snapshot([]));
    const next = snapshot([thread("synchronous", 1)]);
    harness.behavior.subscribe = (listener) => {
      harness.setSource(next);
      listener();
      return () => {};
    };
    const listener = vi.fn();

    const unsubscribe = harness.store.subscribe(listener);

    expect(harness.store.getThread("synchronous")?.id).toBe("synchronous");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("removes a listener when source subscription throws", () => {
    const harness = createHarness(snapshot([]));
    const rejectedListener = vi.fn();
    harness.behavior.subscribe = () => {
      throw new Error("subscribe failed");
    };

    expect(() => harness.store.subscribe(rejectedListener)).toThrow(
      "subscribe failed",
    );

    const sourceListeners = new Set<() => void>();
    harness.behavior.subscribe = (listener) => {
      sourceListeners.add(listener);
      return () => sourceListeners.delete(listener);
    };
    const acceptedListener = vi.fn();
    const unsubscribe = harness.store.subscribe(acceptedListener);
    expect(sourceListeners.size).toBe(1);
    for (const listener of sourceListeners) {
      listener();
    }

    expect(rejectedListener).not.toHaveBeenCalled();
    expect(acceptedListener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
