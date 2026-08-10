import { describe, expect, expectTypeOf, it, vi } from "vite-plus/test";

import type {
  BlockNoteComment,
  BlockNoteThread,
  BlockNoteThreadSnapshot,
  BlockNoteThreadStoreCommitReceipt,
  BlockNoteThreadStoreMutationReceipt,
  BlockNoteThreadStoreRevision,
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
type Callbacks = ThreadStoreCallbacks<ThreadMetadata, CommentMetadata>;
type Mutable<T> = { -readonly [TKey in keyof T]: T[TKey] };
type Behavior = Mutable<
  Pick<
    Callbacks,
    | "subscribe"
    | "loadMore"
    | "createThread"
    | "addComment"
    | "updateComment"
    | "deleteComment"
    | "deleteThread"
    | "resolveThread"
    | "reopenThread"
    | "addReaction"
    | "deleteReaction"
  >
>;

function assertReadonlySnapshotTypes(
  value: BlockNoteThread<ThreadMetadata, CommentMetadata>,
) {
  // @ts-expect-error snapshot comment arrays are readonly
  value.comments.push(value.comments[0]!);
  // @ts-expect-error snapshot reaction arrays are readonly
  value.comments[0]!.reactions.push(value.comments[0]!.reactions[0]!);
}

void assertReadonlySnapshotTypes;

function revision(sequence: number, token = `revision-${sequence}`) {
  return { sequence, token };
}

function date(value: number) {
  return new Date(value);
}

function comment(id: string, version: number): CommentData<CommentMetadata> {
  return {
    type: "comment",
    id,
    userId: "user-1",
    createdAt: date(version),
    updatedAt: date(version),
    reactions: [],
    metadata: { origin: "human" },
    body: [{ type: "paragraph", content: id }],
  };
}

function thread(
  id: string,
  version: number,
  overrides: Partial<ThreadData<ThreadMetadata, CommentMetadata>> = {},
): ThreadData<ThreadMetadata, CommentMetadata> {
  return {
    type: "thread",
    id,
    createdAt: date(version),
    updatedAt: date(version),
    comments: [comment(`${id}-comment`, version)],
    resolved: false,
    metadata: { label: id },
    ...overrides,
  };
}

function snapshot(
  threads: ThreadData<ThreadMetadata, CommentMetadata>[],
  storeRevision: BlockNoteThreadStoreRevision,
  completeness: "partial" | "complete" = "partial",
  nextCursor?: string,
): Snapshot {
  return {
    threads: new Map(threads.map((item) => [item.id, item])),
    completeness,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    revision: storeRevision,
  };
}

function upsertCommit(
  storeRevision: BlockNoteThreadStoreRevision,
  value: ThreadData<ThreadMetadata, CommentMetadata>,
): BlockNoteThreadStoreCommitReceipt<ThreadMetadata, CommentMetadata> {
  return { revision: storeRevision, change: { type: "upsert", thread: value } };
}

function deleteCommit(
  storeRevision: BlockNoteThreadStoreRevision,
  threadId: string,
): BlockNoteThreadStoreCommitReceipt<ThreadMetadata, CommentMetadata> {
  return { revision: storeRevision, change: { type: "delete", threadId } };
}

function mutationReceipt<TResult>(
  commit: BlockNoteThreadStoreCommitReceipt<ThreadMetadata, CommentMetadata>,
  result: TResult,
): BlockNoteThreadStoreMutationReceipt<
  ThreadMetadata,
  CommentMetadata,
  TResult
> {
  return { ...commit, result } as BlockNoteThreadStoreMutationReceipt<
    ThreadMetadata,
    CommentMetadata,
    TResult
  >;
}

function voidReceipt(
  commit: BlockNoteThreadStoreCommitReceipt<ThreadMetadata, CommentMetadata>,
): BlockNoteThreadStoreMutationReceipt<ThreadMetadata, CommentMetadata, void> {
  return commit;
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
  const sourceListeners = new Set<
    (
      commit: BlockNoteThreadStoreCommitReceipt<
        ThreadMetadata,
        CommentMetadata
      >,
    ) => void
  >();
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
    updateComment: unused,
    deleteComment: unused,
    deleteThread: unused,
    resolveThread: unused,
    reopenThread: unused,
    addReaction: unused,
    deleteReaction: unused,
  };
  const store = createThreadStore<ThreadMetadata, CommentMetadata>({
    getSnapshot: () => sourceSnapshot,
    subscribe: (listener) => behavior.subscribe(listener),
    loadMore: (options) => behavior.loadMore(options),
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
    emit(
      commit: BlockNoteThreadStoreCommitReceipt<
        ThreadMetadata,
        CommentMetadata
      >,
    ) {
      for (const listener of [...sourceListeners]) {
        listener(commit);
      }
    },
    setSource(next: Snapshot) {
      sourceSnapshot = next;
    },
  };
}

describe("createThreadStore", () => {
  it("infers metadata, revisions, idempotency, and readonly snapshots", async () => {
    const created = thread("created", 1);
    const reply = comment("reply", 2);
    const withReply = { ...created, comments: [...created.comments, reply] };
    const initial = snapshot([], revision(0), "complete");
    const store = createThreadStore<ThreadMetadata, CommentMetadata>({
      getSnapshot: () => initial,
      subscribe: () => () => {},
      loadMore: async (options) => {
        expectTypeOf(
          options.revision,
        ).toEqualTypeOf<BlockNoteThreadStoreRevision>();
        return initial;
      },
      createThread: async (options) => {
        expectTypeOf(options.idempotencyKey).toEqualTypeOf<string>();
        expectTypeOf(options.metadata).toEqualTypeOf<
          ThreadMetadata | undefined
        >();
        expectTypeOf(options.initialComment.metadata).toEqualTypeOf<
          CommentMetadata | undefined
        >();
        return mutationReceipt(upsertCommit(revision(1), created), created);
      },
      addComment: async (options) => {
        expectTypeOf(options.comment.metadata).toEqualTypeOf<
          CommentMetadata | undefined
        >();
        return mutationReceipt(upsertCommit(revision(2), withReply), reply);
      },
      updateComment: async () =>
        voidReceipt(upsertCommit(revision(3), created)),
      deleteComment: async () =>
        voidReceipt(upsertCommit(revision(3), created)),
      deleteThread: async () =>
        voidReceipt(deleteCommit(revision(3), created.id)),
      resolveThread: async () =>
        voidReceipt(upsertCommit(revision(3), created)),
      reopenThread: async () => voidReceipt(upsertCommit(revision(3), created)),
      addReaction: async () => voidReceipt(upsertCommit(revision(3), created)),
      deleteReaction: async () =>
        voidReceipt(upsertCommit(revision(3), created)),
    });

    expectTypeOf(store.getThread("missing")).toEqualTypeOf<
      ThreadData<ThreadMetadata, CommentMetadata> | undefined
    >();
    expectTypeOf(store.getSnapshot().threads).toEqualTypeOf<
      ReadonlyMap<string, BlockNoteThread<ThreadMetadata, CommentMetadata>>
    >();
    expectTypeOf(
      store.getSnapshot().threads.get("missing")?.comments,
    ).toEqualTypeOf<readonly BlockNoteComment<CommentMetadata>[] | undefined>();

    await expect(
      store.createThread({
        metadata: { label: "created" },
        initialComment: {
          body: [],
          metadata: { origin: "agent" },
        },
      }),
    ).resolves.toMatchObject({ id: "created" });
  });

  it("commits a successful operation despite a throwing subscriber", async () => {
    const harness = createHarness(snapshot([], revision(0), "complete"));
    const created = thread("created", 1);
    const keys: string[] = [];
    harness.behavior.createThread = async (options) => {
      keys.push(options.idempotencyKey);
      return mutationReceipt(upsertCommit(revision(1), created), created);
    };
    const unsubscribe = harness.store.subscribe(() => {
      throw new Error("consumer failed");
    });

    await expect(
      harness.store.createThread({ initialComment: { body: [] } }),
    ).resolves.toMatchObject({ id: "created" });

    expect(harness.store.getThread("created")?.id).toBe("created");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^blocknote-thread:/);
    unsubscribe();
  });

  it("keeps one idempotency key across concurrent, aborted, and unknown-outcome retries", async () => {
    const harness = createHarness(snapshot([], revision(0), "complete"));
    const created = thread("created", 1);
    const firstReceipt =
      deferred<Awaited<ReturnType<Callbacks["createThread"]>>>();
    const keys: string[] = [];
    harness.behavior.createThread = (options) => {
      keys.push(options.idempotencyKey);
      return firstReceipt.promise;
    };
    const command = harness.store.createThreadCommand({
      initialComment: { body: [] },
    });
    const first = command.execute();
    const concurrent = command.execute();
    expect(concurrent).toBe(first);
    firstReceipt.reject(new Error("unknown outcome"));
    await expect(first).rejects.toThrow("unknown outcome");

    harness.behavior.createThread = async (options) => {
      keys.push(options.idempotencyKey);
      return mutationReceipt(upsertCommit(revision(1), created), created);
    };
    await expect(command.execute()).resolves.toMatchObject({ id: "created" });
    await expect(command.execute()).resolves.toMatchObject({ id: "created" });
    expect(new Set(keys).size).toBe(1);

    const secondCreated = thread("second", 2);
    harness.behavior.createThread = async (options) => {
      keys.push(options.idempotencyKey);
      return mutationReceipt(
        upsertCommit(revision(2), secondCreated),
        secondCreated,
      );
    };
    await harness.store
      .createThreadCommand({ initialComment: { body: [] } })
      .execute();
    expect(new Set(keys).size).toBe(2);
  });

  it("aborts only the caller wait while retaining the authoritative operation", async () => {
    const harness = createHarness(snapshot([], revision(0), "complete"));
    const created = thread("created", 1);
    const receipt = deferred<Awaited<ReturnType<Callbacks["createThread"]>>>();
    harness.behavior.createThread = () => receipt.promise;
    const command = harness.store.createThreadCommand({
      initialComment: { body: [] },
    });
    const controller = new AbortController();
    const waiting = command.execute({ signal: controller.signal });
    controller.abort(new Error("caller stopped"));
    await expect(waiting).rejects.toThrow("caller stopped");

    receipt.resolve(
      mutationReceipt(upsertCommit(revision(1), created), created),
    );
    await expect(command.execute()).resolves.toMatchObject({ id: "created" });
  });

  it("cleans up a rejected load despite a throwing subscriber", async () => {
    const harness = createHarness(snapshot([], revision(1), "partial", "next"));
    harness.behavior.loadMore = async () => {
      throw new Error("load failed");
    };
    const unsubscribe = harness.store.subscribe(() => {
      throw new Error("consumer failed");
    });

    await expect(harness.store.loadMore()).rejects.toThrow("load failed");
    expect(harness.store.isLoading).toBe(false);
    unsubscribe();
  });

  it("normalizes a synchronous loadMore adapter result", async () => {
    const next = thread("next", 1);
    const harness = createHarness(snapshot([], revision(1), "partial", "next"));
    harness.behavior.loadMore = (() =>
      snapshot(
        [next],
        revision(1),
        "complete",
      )) as unknown as Callbacks["loadMore"];

    await expect(harness.store.loadMore()).resolves.toMatchObject({
      completeness: "complete",
    });
    expect(harness.store.getThread(next.id)?.id).toBe(next.id);
    expect(harness.store.isLoading).toBe(false);
  });

  it("creates then hard-deletes a thread from authoritative receipts", async () => {
    const harness = createHarness(snapshot([], revision(0), "complete"));
    const created = thread("created", 1);
    harness.behavior.createThread = async () =>
      mutationReceipt(upsertCommit(revision(1), created), created);
    harness.behavior.deleteThread = async () =>
      voidReceipt(deleteCommit(revision(2), created.id));

    await harness.store.createThread({ initialComment: { body: [] } });
    await harness.store.deleteThread({ threadId: created.id });

    expect(harness.store.getThread(created.id)).toBeUndefined();
    expect(harness.store.getSnapshot().revision).toEqual(revision(2));
  });

  it("returns exact legacy results without exposing committed state", async () => {
    const harness = createHarness(snapshot([], revision(0), "complete"));
    const created = thread("created", 1);
    const reply = comment("reply", 2);
    const withReply = thread("created", 2, {
      comments: [comment("created-comment", 1), reply],
    });
    harness.behavior.createThread = async () =>
      mutationReceipt(upsertCommit(revision(1), created), created);
    harness.behavior.addComment = async () =>
      mutationReceipt(upsertCommit(revision(2), withReply), reply);

    const createResult = await harness.store.createThread({
      initialComment: { body: [] },
    });
    expect(createResult).toBe(created);
    created.comments.push(comment("external", 3));
    created.createdAt.setTime(999);
    (created.comments[0]!.body as Array<{ content: string }>)[0]!.content =
      "external";

    const committedAfterCreate = harness.store.getThread(created.id)!;
    expect(committedAfterCreate.comments).toHaveLength(1);
    expect(committedAfterCreate.createdAt.getTime()).toBe(1);
    expect(
      (committedAfterCreate.comments[0]!.body as Array<{ content: string }>)[0]
        ?.content,
    ).toBe("created-comment");

    const addResult = await harness.store.addComment({
      threadId: created.id,
      comment: { body: [] },
    });
    expect(addResult).toBe(reply);
    (reply.body as Array<{ content: string }>)[0]!.content = "external";
    reply.reactions.push({
      emoji: "🔥",
      createdAt: date(3),
      userIds: ["external"],
    });

    const committedReply = harness.store
      .getThread(created.id)!
      .comments.find((value) => value.id === reply.id)!;
    expect(
      (committedReply.body as Array<{ content: string }>)[0]?.content,
    ).toBe("reply");
    expect(committedReply.reactions).toHaveLength(0);
  });

  it("does not resurrect a remote hard delete from a stale page", async () => {
    const target = thread("target", 1);
    const harness = createHarness(
      snapshot([target], revision(1), "partial", "page-2"),
    );
    const page = deferred<Snapshot>();
    harness.behavior.loadMore = () => page.promise;
    const unsubscribe = harness.store.subscribe(() => {});

    const request = harness.store.loadMore();
    harness.emit(deleteCommit(revision(2), target.id));
    page.resolve(snapshot([target], revision(1), "complete"));
    await request;

    expect(harness.store.getThread(target.id)).toBeUndefined();
    expect(harness.store.getSnapshot().revision).toEqual(revision(2));
    unsubscribe();
  });

  it("binds cursors to their revision and restarts a newer generation", async () => {
    const first = thread("first", 1);
    const unrelated = thread("unrelated", 2);
    const second = thread("second", 2);
    const harness = createHarness(
      snapshot([first], revision(1), "partial", "old-cursor"),
    );
    const oldPage = deferred<Snapshot>();
    const newPage = deferred<Snapshot>();
    const loadMore = vi.fn((options: Parameters<Callbacks["loadMore"]>[0]) =>
      options.revision.sequence === 1 ? oldPage.promise : newPage.promise,
    );
    harness.behavior.loadMore = loadMore;
    const unsubscribe = harness.store.subscribe(() => {});

    const oldRequest = harness.store.loadMore();
    harness.emit(upsertCommit(revision(2), unrelated));
    await harness.store.loadMore("old-cursor");
    const newRequest = harness.store.loadMore();

    expect(loadMore).toHaveBeenCalledTimes(2);
    expect(loadMore.mock.calls[0]![0]).toEqual({
      cursor: "old-cursor",
      revision: revision(1),
    });
    expect(loadMore.mock.calls[1]![0]).toEqual({ revision: revision(2) });

    newPage.resolve(snapshot([second], revision(2), "complete"));
    await newRequest;
    oldPage.resolve(snapshot([thread("stale", 1)], revision(1), "complete"));
    await oldRequest;

    expect(harness.store.getThread("stale")).toBeUndefined();
    expect([...harness.store.getSnapshot().threads.keys()].sort()).toEqual([
      "first",
      "second",
      "unrelated",
    ]);
    unsubscribe();
  });

  it("keeps an unrelated source commit during a rejected mutation", async () => {
    const original = thread("original", 1);
    const unrelated = thread("unrelated", 2);
    const harness = createHarness(
      snapshot([original], revision(1), "complete"),
    );
    const mutationStarted = deferred<void>();
    const release = deferred<void>();
    harness.behavior.updateComment = async () => {
      mutationStarted.resolve();
      await release.promise;
      throw new Error("rejected");
    };
    const unsubscribe = harness.store.subscribe(() => {});

    const request = harness.store.updateComment({
      threadId: original.id,
      commentId: original.comments[0]!.id,
      comment: { body: [] },
    });
    await mutationStarted.promise;
    harness.emit(upsertCommit(revision(2), unrelated));
    release.resolve();

    await expect(request).rejects.toThrow("rejected");
    expect(harness.store.getThread(unrelated.id)?.id).toBe(unrelated.id);
    expect(harness.store.getSnapshot().revision).toEqual(revision(2));
    unsubscribe();
  });

  it("rejects unrelated mutation receipts before changing state", async () => {
    const target = thread("target", 1);
    const unrelated = thread("unrelated", 2);
    const harness = createHarness(snapshot([target], revision(1), "complete"));
    const keys: string[] = [];
    harness.behavior.updateComment = async (options) => {
      keys.push(options.idempotencyKey);
      return voidReceipt(upsertCommit(revision(2), unrelated));
    };

    await expect(
      harness.store.updateComment({
        threadId: target.id,
        commentId: target.comments[0]!.id,
        comment: { body: [] },
      }),
    ).rejects.toMatchObject({ code: "invalid-document" });

    expect(harness.store.getThread(unrelated.id)).toBeUndefined();
    expect(harness.store.getSnapshot().revision).toEqual(revision(1));
    expect(keys).toHaveLength(1);
  });

  it("rejects inconsistent create and add results", async () => {
    const target = thread("target", 1);
    const other = thread("other", 1);
    const harness = createHarness(snapshot([], revision(0), "complete"));
    harness.behavior.createThread = async () =>
      mutationReceipt(upsertCommit(revision(1), target), other);

    await expect(
      harness.store.createThread({ initialComment: { body: [] } }),
    ).rejects.toMatchObject({ code: "invalid-document" });
    expect(harness.store.getSnapshot().revision).toEqual(revision(0));

    harness.behavior.addComment = async () =>
      mutationReceipt(upsertCommit(revision(1), target), comment("absent", 1));
    await expect(
      harness.store.addComment({
        threadId: target.id,
        comment: { body: [] },
      }),
    ).rejects.toMatchObject({ code: "invalid-document" });
  });

  it("rejects mutation receipts not newer than actual operation start", async () => {
    const target = thread("target", 2);

    const createCase = createHarness(
      snapshot([target], revision(2), "complete"),
    );
    createCase.behavior.createThread = async () =>
      mutationReceipt(upsertCommit(revision(2), target), target);
    await expect(
      createCase.store.createThread({ initialComment: { body: [] } }),
    ).rejects.toMatchObject({ code: "invalid-document" });

    const reply = comment("reply", 3);
    const withReply = thread(target.id, 3, {
      comments: [...target.comments, reply],
    });
    const addCase = createHarness(snapshot([target], revision(2), "complete"));
    addCase.behavior.addComment = async () =>
      mutationReceipt(upsertCommit(revision(1), withReply), reply);
    await expect(
      addCase.store.addComment({
        threadId: target.id,
        comment: { body: [] },
      }),
    ).rejects.toMatchObject({ code: "invalid-document" });

    const voidCase = createHarness(snapshot([target], revision(2), "complete"));
    voidCase.behavior.updateComment = async () =>
      voidReceipt(upsertCommit(revision(2), target));
    await expect(
      voidCase.store.updateComment({
        threadId: target.id,
        commentId: target.comments[0]!.id,
        comment: { body: [] },
      }),
    ).rejects.toMatchObject({ code: "invalid-document" });

    for (const store of [createCase.store, addCase.store, voidCase.store]) {
      expect(store.getSnapshot().revision).toEqual(revision(2));
    }
  });

  it("accepts a fresh receipt overtaken by a newer source revision", async () => {
    const initial = thread("initial", 1);
    const created = thread("created", 2);
    const newer = thread("newer", 3);
    const harness = createHarness(snapshot([initial], revision(1), "complete"));
    const started = deferred<void>();
    const response =
      deferred<
        BlockNoteThreadStoreMutationReceipt<
          ThreadMetadata,
          CommentMetadata,
          ThreadData<ThreadMetadata, CommentMetadata>
        >
      >();
    harness.behavior.createThread = async () => {
      started.resolve();
      return response.promise;
    };
    const unsubscribe = harness.store.subscribe(() => {});

    const request = harness.store.createThread({
      initialComment: { body: [] },
    });
    await started.promise;
    harness.emit(upsertCommit(revision(3), newer));
    response.resolve(
      mutationReceipt(upsertCommit(revision(2), created), created),
    );

    await expect(request).resolves.toBe(created);
    expect(harness.store.getSnapshot().revision).toEqual(revision(3));
    expect([...harness.store.getSnapshot().threads.keys()]).toEqual([newer.id]);
    unsubscribe();
  });

  it("captures queued mutation freshness when each callback starts", async () => {
    const target = thread("target", 1);
    const updated = thread("target", 2);
    const harness = createHarness(snapshot([target], revision(1), "complete"));
    const started = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    harness.behavior.updateComment = async () => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      return voidReceipt(upsertCommit(revision(2), updated));
    };
    const options = {
      threadId: target.id,
      commentId: target.comments[0]!.id,
      comment: { body: [] },
    };

    const first = harness.store.updateComment(options);
    const second = harness.store.updateComment(options);
    await started.promise;
    expect(calls).toBe(1);
    release.resolve();

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toMatchObject({ code: "invalid-document" });
    expect(calls).toBe(2);
    expect(harness.store.getSnapshot().revision).toEqual(revision(2));
  });

  it("captures changing receipt and result getters exactly once", async () => {
    const target = thread("target", 1);
    const harness = createHarness(snapshot([], revision(0), "complete"));
    const reads = { revision: 0, change: 0, result: 0, id: 0 };
    const changingResult = new Proxy(target, {
      get(value, property, receiver) {
        if (property === "id") {
          reads.id += 1;
          return reads.id === 1 ? target.id : "changed";
        }
        return Reflect.get(value, property, receiver);
      },
    });
    const receipt = {
      get revision() {
        reads.revision += 1;
        return revision(1);
      },
      get change() {
        reads.change += 1;
        return { type: "upsert" as const, thread: target };
      },
      get result() {
        reads.result += 1;
        return changingResult;
      },
    };
    harness.behavior.createThread = async () => receipt;

    const result = await harness.store.createThread({
      initialComment: { body: [] },
    });

    expect(result).toBe(changingResult);
    expect(reads).toEqual({ revision: 1, change: 1, result: 1, id: 1 });
    expect(harness.store.getThread(target.id)?.id).toBe(target.id);
  });

  it("normalizes hostile mutation receipts before inspecting them", async () => {
    const target = thread("target", 1);
    const harness = createHarness(snapshot([], revision(0), "complete"));
    const createReceipt = mutationReceipt(
      upsertCommit(revision(1), target),
      target,
    );
    harness.behavior.createThread = async () =>
      new Proxy(createReceipt, {
        get(value, property, receiver) {
          if (property === "change") {
            throw new Error("hostile change getter");
          }
          return Reflect.get(value, property, receiver);
        },
      });

    await expect(
      harness.store.createThread({ initialComment: { body: [] } }),
    ).rejects.toMatchObject({ code: "invalid-document" });

    const addReceipt = mutationReceipt(
      upsertCommit(revision(1), target),
      target.comments[0]!,
    );
    harness.behavior.addComment = async () =>
      new Proxy(addReceipt, {
        get(value, property, receiver) {
          if (property === "result") {
            throw new Error("hostile result getter");
          }
          return Reflect.get(value, property, receiver);
        },
      });
    await expect(
      harness.store.addComment({ threadId: target.id, comment: { body: [] } }),
    ).rejects.toMatchObject({ code: "invalid-document" });

    const updateReceipt = voidReceipt(upsertCommit(revision(1), target));
    harness.behavior.updateComment = async () =>
      new Proxy(updateReceipt, {
        get(value, property, receiver) {
          if (property === "change") {
            throw new Error("hostile target getter");
          }
          return Reflect.get(value, property, receiver);
        },
      });
    await expect(
      harness.store.updateComment({
        threadId: target.id,
        commentId: target.comments[0]!.id,
        comment: { body: [] },
      }),
    ).rejects.toMatchObject({ code: "invalid-document" });

    expect(harness.store.getSnapshot().revision).toEqual(revision(0));
    expect(harness.store.getSnapshot().threads.size).toBe(0);
  });

  it("does not swallow source revision conflicts", () => {
    const target = thread("target", 1);
    const harness = createHarness(
      snapshot([target], revision(1, "accepted"), "complete"),
    );
    const unsubscribe = harness.store.subscribe(() => {
      throw new Error("consumer failure");
    });

    expect(() =>
      harness.emit(upsertCommit(revision(1, "conflict"), target)),
    ).toThrow(expect.objectContaining({ code: "document-conflict" }));
    expect(harness.store.getSnapshot().revision).toEqual(
      revision(1, "accepted"),
    );
    unsubscribe();
  });

  it("removes a facade listener when adapter subscription throws", () => {
    const harness = createHarness(snapshot([], revision(0), "complete"));
    const rejectedListener = vi.fn();
    harness.behavior.subscribe = () => {
      throw new Error("subscribe failed");
    };

    expect(() => harness.store.subscribe(rejectedListener)).toThrow(
      "subscribe failed",
    );

    harness.behavior.subscribe = () => () => {};
    const acceptedListener = vi.fn();
    const unsubscribe = harness.store.subscribe(acceptedListener);
    expect(rejectedListener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("rejects a complete source snapshot with a cursor at subscription ingress", () => {
    const harness = createHarness(
      snapshot([], revision(0), "partial", "initial"),
    );
    harness.setSource(snapshot([], revision(1), "complete", "unexpected"));

    expect(() => harness.store.subscribe(vi.fn())).toThrow(
      expect.objectContaining({ code: "invalid-document" }),
    );
    expect(harness.store.getSnapshot()).toMatchObject({
      completeness: "partial",
      nextCursor: "initial",
      revision: revision(0),
    });

    harness.setSource(snapshot([], revision(1), "complete"));
    const unsubscribe = harness.store.subscribe(vi.fn());
    expect(harness.store.getSnapshot()).toMatchObject({
      completeness: "complete",
      revision: revision(1),
    });
    expect(harness.store.getSnapshot().nextCursor).toBeUndefined();
    unsubscribe();
  });
});
