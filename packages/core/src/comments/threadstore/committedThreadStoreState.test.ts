import { describe, expect, it } from "vite-plus/test";

import type {
  BlockNoteThread,
  BlockNoteThreadSnapshot,
  BlockNoteThreadStoreRevision,
  CommentData,
  ThreadData,
} from "../types.js";
import { CommittedThreadStoreState } from "./committedThreadStoreState.js";

type ThreadMetadata = {
  label: string;
  opaque?: unknown;
};

type CommentMetadata = {
  origin: "human" | "agent";
};

type Snapshot = BlockNoteThreadSnapshot<ThreadMetadata, CommentMetadata>;

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
    reactions: [{ emoji: "👍", createdAt: date(version), userIds: ["user-1"] }],
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

describe("CommittedThreadStoreState", () => {
  it("composes only pages bound to the active revision", () => {
    const first = thread("first", 1);
    const second = thread("second", 1);
    const third = thread("third", 1);
    const activeRevision = revision(1);
    const state = new CommittedThreadStoreState(
      snapshot([first], activeRevision, "partial", "page-2"),
    );

    expect(
      state.applyPage(snapshot([second], activeRevision, "partial", "page-3"), {
        revision: activeRevision,
        cursor: "page-2",
      }).status,
    ).toBe("applied");
    expect(
      state.applyPage(snapshot([third], activeRevision, "complete"), {
        revision: activeRevision,
        cursor: "page-3",
      }).status,
    ).toBe("applied");

    expect([...state.getSnapshot().threads.keys()]).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(state.getSnapshot()).toMatchObject({ completeness: "complete" });
  });

  it("discards lower/equal commits, accepts newer, and rejects token conflicts", () => {
    const original = thread("target", 2);
    const equal = thread("equal", 2);
    const newer = thread("newer", 3);
    const state = new CommittedThreadStoreState(
      snapshot([original], revision(2, "accepted"), "complete"),
    );

    expect(
      state.applyCommit({
        revision: revision(1),
        change: { type: "upsert", thread: thread("lower", 1) },
      }).status,
    ).toBe("stale");
    expect(
      state.applyCommit({
        revision: revision(2, "accepted"),
        change: { type: "upsert", thread: equal },
      }).status,
    ).toBe("duplicate");
    expect(state.getSnapshot().threads.has("equal")).toBe(false);

    expect(
      state.applyCommit({
        revision: revision(3, "newer"),
        change: { type: "upsert", thread: newer },
      }).status,
    ).toBe("applied");
    expect(state.getSnapshot().threads.has("newer")).toBe(true);

    expect(() =>
      state.applyCommit({
        revision: revision(3, "conflict"),
        change: { type: "delete", threadId: newer.id },
      }),
    ).toThrow(expect.objectContaining({ code: "document-conflict" }));
    expect(state.getSnapshot().revision).toEqual(revision(3, "newer"));
  });

  it("starts an unknown generation when a commit sequence is missed", () => {
    const deletedAtMissedRevision = thread("deleted", 1);
    const retainedWithoutProof = thread("unproven", 1);
    const unrelated = thread("unrelated", 3);
    const state = new CommittedThreadStoreState(
      snapshot(
        [deletedAtMissedRevision, retainedWithoutProof],
        revision(1),
        "complete",
      ),
    );

    expect(state.applyCommit(upsert(revision(3), unrelated)).status).toBe(
      "applied",
    );
    expect([...state.getSnapshot().threads.keys()]).toEqual([unrelated.id]);
    expect(state.getSnapshot().completeness).toBe("partial");
  });

  it("replaces prior rows with a newer partial source generation", () => {
    const stale = thread("stale", 1);
    const current = thread("current", 3);
    const state = new CommittedThreadStoreState(
      snapshot([stale], revision(1), "complete"),
    );

    state.applySourceSnapshot(snapshot([current], revision(3), "partial"));

    expect([...state.getSnapshot().threads.keys()]).toEqual([current.id]);
    expect(state.getSnapshot()).toMatchObject({
      completeness: "partial",
      revision: revision(3),
    });
  });

  it("retains proven rows across a contiguous single-change commit", () => {
    const first = thread("first", 1);
    const second = thread("second", 2);
    const state = new CommittedThreadStoreState(
      snapshot([first], revision(1), "complete"),
    );

    state.applyCommit(upsert(revision(2), second));

    expect([...state.getSnapshot().threads.keys()]).toEqual([
      first.id,
      second.id,
    ]);
    expect(state.getSnapshot().completeness).toBe("complete");
  });

  it("rejects pages that cannot prove progress", () => {
    const activeRevision = revision(1);
    const requests = [
      snapshot([], activeRevision, "partial"),
      snapshot([], activeRevision, "partial", "page-2"),
      snapshot([], activeRevision, "complete", "page-3"),
    ];

    for (const page of requests) {
      const state = new CommittedThreadStoreState(
        snapshot([], activeRevision, "partial", "page-2"),
      );
      expect(() =>
        state.applyPage(page, {
          revision: activeRevision,
          cursor: "page-2",
        }),
      ).toThrow(expect.objectContaining({ code: "invalid-document" }));
      expect(state.getSnapshot()).toMatchObject({
        completeness: "partial",
        nextCursor: "page-2",
      });
    }
  });

  it("rejects cursor cycles without blocking a progressing page", () => {
    const activeRevision = revision(1);
    const state = new CommittedThreadStoreState(
      snapshot([], activeRevision, "partial", "A"),
    );

    expect(
      state.applyPage(snapshot([], activeRevision, "partial", "B"), {
        revision: activeRevision,
        cursor: "A",
      }).status,
    ).toBe("applied");
    const beforeCycle = state.getSnapshot();
    expect(() =>
      state.applyPage(snapshot([], activeRevision, "partial", "A"), {
        revision: activeRevision,
        cursor: "B",
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-document" }));
    expect(state.getSnapshot()).toBe(beforeCycle);

    expect(
      state.applyPage(snapshot([], activeRevision, "partial", "C"), {
        revision: activeRevision,
        cursor: "B",
      }).status,
    ).toBe("applied");
    expect(
      state.applyPage(snapshot([], activeRevision, "complete"), {
        revision: activeRevision,
        cursor: "C",
      }).status,
    ).toBe("applied");
  });

  it("resets cursor history for a newer source generation", () => {
    const firstRevision = revision(1);
    const secondRevision = revision(2);
    const state = new CommittedThreadStoreState(
      snapshot([], firstRevision, "partial", "A"),
    );
    state.applyPage(snapshot([], firstRevision, "partial", "B"), {
      revision: firstRevision,
      cursor: "A",
    });

    state.applySourceSnapshot(snapshot([], secondRevision, "partial", "A"));

    expect(
      state.applyPage(snapshot([], secondRevision, "partial", "B"), {
        revision: secondRevision,
        cursor: "A",
      }).status,
    ).toBe("applied");
  });

  it("captures snapshot and row properties once before normalization", () => {
    const source = thread("captured", 1);
    const fieldReads = new Map<PropertyKey, number>();
    const changingThread = new Proxy(source, {
      get(target, property, receiver) {
        const count = (fieldReads.get(property) ?? 0) + 1;
        fieldReads.set(property, count);
        if (property === "id" && count > 1) {
          return "changed";
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const snapshotReads = {
      completeness: 0,
      nextCursor: 0,
      revision: 0,
      threads: 0,
    };
    const changingSnapshot = {
      get completeness() {
        snapshotReads.completeness += 1;
        return "complete" as const;
      },
      get nextCursor() {
        snapshotReads.nextCursor += 1;
        return undefined;
      },
      get revision() {
        snapshotReads.revision += 1;
        return revision(1);
      },
      get threads() {
        snapshotReads.threads += 1;
        return new Map([[source.id, changingThread]]);
      },
    };

    const state = new CommittedThreadStoreState(changingSnapshot);

    expect(state.getSnapshot().threads.has(source.id)).toBe(true);
    expect(snapshotReads).toEqual({
      completeness: 1,
      nextCursor: 1,
      revision: 1,
      threads: 1,
    });
    for (const field of [
      "type",
      "id",
      "createdAt",
      "updatedAt",
      "comments",
      "resolved",
      "metadata",
      "resolvedUpdatedAt",
      "resolvedBy",
      "deletedAt",
      "detached",
    ]) {
      expect(fieldReads.get(field)).toBe(1);
    }
  });

  it("captures commit and change properties once", () => {
    const state = new CommittedThreadStoreState(
      snapshot([], revision(0), "complete"),
    );
    const target = thread("target", 1);
    const reads = { revision: 0, change: 0, type: 0, thread: 0 };
    const change = {
      get type() {
        reads.type += 1;
        return "upsert" as const;
      },
      get thread() {
        reads.thread += 1;
        return target;
      },
    };
    const receipt = {
      get revision() {
        reads.revision += 1;
        return revision(1);
      },
      get change() {
        reads.change += 1;
        return change;
      },
    };

    state.applyCommit(receipt);

    expect(reads).toEqual({ revision: 1, change: 1, type: 1, thread: 1 });
  });

  it("captures each reaction user id index once before publication", () => {
    const state = new CommittedThreadStoreState(
      snapshot([], revision(0), "complete"),
    );
    const changingUserIds = ["placeholder"];
    let indexReads = 0;
    Object.defineProperty(changingUserIds, 0, {
      configurable: true,
      get() {
        indexReads += 1;
        return indexReads === 1 ? "captured" : 42;
      },
    });
    const target = thread("target", 1);
    target.comments[0]!.reactions[0]!.userIds = changingUserIds;

    expect(state.applyCommit(upsert(revision(1), target)).status).toBe(
      "applied",
    );

    expect(indexReads).toBe(1);
    expect(
      state.getSnapshot().threads.get(target.id)?.comments[0]?.reactions[0]
        ?.userIds,
    ).toEqual(["captured"]);
  });

  it("keeps revision retryable after an invalid captured reaction user id", () => {
    const state = new CommittedThreadStoreState(
      snapshot([], revision(0), "complete"),
    );
    const changingUserIds = ["placeholder"];
    let indexReads = 0;
    Object.defineProperty(changingUserIds, 0, {
      configurable: true,
      get() {
        indexReads += 1;
        return indexReads === 1 ? 42 : "changed";
      },
    });
    const invalid = thread("target", 1);
    invalid.comments[0]!.reactions[0]!.userIds = changingUserIds;

    expect(() => state.applyCommit(upsert(revision(1), invalid))).toThrow(
      expect.objectContaining({ code: "invalid-document" }),
    );
    expect(indexReads).toBe(1);
    expect(state.getSnapshot().revision).toEqual(revision(0));
    expect(state.getSnapshot().threads.size).toBe(0);

    const corrected = thread("target", 1);
    expect(state.applyCommit(upsert(revision(1), corrected)).status).toBe(
      "applied",
    );
    expect(state.getSnapshot().revision).toEqual(revision(1));
    expect(state.getSnapshot().threads.has(corrected.id)).toBe(true);
  });

  it("validates revision shape and bounds tokens", () => {
    const invalidSequence = {
      ...snapshot([], revision(0), "complete"),
      revision: { sequence: Number.NaN, token: "invalid" },
    };
    expect(() => new CommittedThreadStoreState(invalidSequence)).toThrow(
      expect.objectContaining({ code: "invalid-document" }),
    );

    const invalidToken = {
      ...snapshot([], revision(0), "complete"),
      revision: revision(0, "x".repeat(257)),
    };
    expect(() => new CommittedThreadStoreState(invalidToken)).toThrow(
      expect.objectContaining({ code: "invalid-document" }),
    );
  });

  it("never enumerates or serializes opaque Proxy and Map metadata", () => {
    const throwingMetadata = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("metadata inspected");
        },
      },
    );
    const mapMetadata = new Map([["key", "value"]]);
    const first = thread("first", 1, {
      metadata: throwingMetadata as ThreadMetadata,
    });
    const second = thread("second", 2, {
      metadata: mapMetadata as unknown as ThreadMetadata,
    });

    expect(() => {
      const state = new CommittedThreadStoreState(
        snapshot([first], revision(1), "complete"),
      );
      state.applyCommit({
        revision: revision(2),
        change: { type: "upsert", thread: second },
      });
      expect(state.getSnapshot().threads.get(second.id)?.metadata).toBe(
        mapMetadata,
      );
    }).not.toThrow();
  });

  it("wraps unreadable accepted upserts in a stable BlockNoteError", () => {
    const state = new CommittedThreadStoreState(
      snapshot([], revision(0), "complete"),
    );
    const unreadable = new Proxy(thread("target", 1), {
      get(target, property, receiver) {
        if (property === "comments") {
          throw new Error("unreadable");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      state.applyCommit({
        revision: revision(1),
        change: { type: "upsert", thread: unreadable },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-document" }));
    expect(state.getSnapshot().revision).toEqual(revision(0));
  });

  it("owns and freezes snapshot containers while preserving metadata identity", () => {
    const source = thread("target", 1);
    const metadata = source.metadata;
    const sourceSnapshot = snapshot([source], revision(1), "complete");
    const state = new CommittedThreadStoreState(sourceSnapshot);
    const current = state.getSnapshot();
    const known = current.threads.get(source.id)!;

    source.comments.push(comment("external", 2));
    source.comments[0]!.reactions[0]!.userIds.push("external");
    (source.comments[0]!.body as Array<{ content: string }>)[0]!.content =
      "external";
    (
      sourceSnapshot as unknown as {
        threads: ReadonlyMap<
          string,
          BlockNoteThread<ThreadMetadata, CommentMetadata>
        >;
      }
    ).threads = new Map();

    expect(known.comments).toHaveLength(1);
    expect(known.comments[0]!.reactions[0]!.userIds).toEqual(["user-1"]);
    expect(
      (known.comments[0]!.body as Array<{ content: string }>)[0]!.content,
    ).toBe(`${source.id}-comment`);
    expect(known.metadata).toBe(metadata);
    expect(() =>
      (
        current.threads as Map<
          string,
          BlockNoteThread<ThreadMetadata, CommentMetadata>
        >
      ).clear(),
    ).toThrow();
    expect(() =>
      (known.comments as CommentData<CommentMetadata>[]).push(
        comment("mutated", 3),
      ),
    ).toThrow();
    expect(() => known.createdAt.setTime(999)).toThrow("immutable");
    expect(state.getSnapshot().threads.get(source.id)?.comments).toHaveLength(
      1,
    );
  });

  it("keeps lifecycle states distinct", () => {
    const deleted = thread("deleted", 1, { deletedAt: date(5) });
    const resolved = thread("resolved", 2, {
      resolved: true,
      resolvedUpdatedAt: date(6),
    });
    const detached = thread("detached", 3, { detached: true });
    const state = new CommittedThreadStoreState(
      snapshot([deleted, resolved, detached], revision(3)),
    );

    expect(
      state.getSnapshot().threads.get("deleted")?.deletedAt?.getTime(),
    ).toBe(5);
    expect(state.getSnapshot().threads.get("resolved")).toMatchObject({
      resolved: true,
    });
    expect(
      state.getSnapshot().threads.get("resolved")?.detached,
    ).toBeUndefined();
    expect(state.getSnapshot().threads.get("detached")).toMatchObject({
      resolved: false,
      detached: true,
    });
    expect(state.getSnapshot().threads.get("unknown")).toBeUndefined();
  });

  it("bounds hard-deletion receipts to the current revision", () => {
    const first = thread("first", 0);
    const second = thread("second", 0);
    const third = thread("third", 0);
    const state = new CommittedThreadStoreState(
      snapshot([first, second, third], revision(0), "complete"),
    );

    state.applyCommit({
      revision: revision(1),
      change: { type: "delete", threadId: first.id },
    });
    expect(state.getDeletionReceiptCountForTesting()).toBe(1);
    state.applyCommit({
      revision: revision(2),
      change: { type: "delete", threadId: second.id },
    });
    expect(state.getDeletionReceiptCountForTesting()).toBe(1);
    state.applyCommit({
      revision: revision(3),
      change: { type: "delete", threadId: third.id },
    });
    expect(state.getDeletionReceiptCountForTesting()).toBe(1);
    state.applyCommit({
      revision: revision(4),
      change: { type: "upsert", thread: thread("new", 4) },
    });
    expect(state.getDeletionReceiptCountForTesting()).toBe(0);
  });

  it("uses a newer complete source snapshot for hard-delete cleanup", () => {
    const first = thread("first", 1);
    const second = thread("second", 1);
    const state = new CommittedThreadStoreState(
      snapshot([first, second], revision(1), "partial", "next"),
    );

    expect(
      state.applySourceSnapshot(snapshot([second], revision(2), "complete"))
        .status,
    ).toBe("applied");
    expect([...state.getSnapshot().threads.keys()]).toEqual([second.id]);
  });
});

function upsert(
  storeRevision: BlockNoteThreadStoreRevision,
  value: ThreadData<ThreadMetadata, CommentMetadata>,
) {
  return {
    revision: storeRevision,
    change: { type: "upsert" as const, thread: value },
  };
}
