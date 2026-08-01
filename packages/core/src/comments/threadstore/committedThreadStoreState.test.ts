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
      }),
    ).toBe(true);
    expect(
      state.applyPage(snapshot([third], activeRevision, "complete"), {
        revision: activeRevision,
        cursor: "page-3",
      }),
    ).toBe(true);

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
      }).changed,
    ).toBe(false);
    expect(
      state.applyCommit({
        revision: revision(2, "accepted"),
        change: { type: "upsert", thread: equal },
      }).changed,
    ).toBe(false);
    expect(state.getSnapshot().threads.has("equal")).toBe(false);

    expect(
      state.applyCommit({
        revision: revision(3, "newer"),
        change: { type: "upsert", thread: newer },
      }).changed,
    ).toBe(true);
    expect(state.getSnapshot().threads.has("newer")).toBe(true);

    expect(() =>
      state.applyCommit({
        revision: revision(3, "conflict"),
        change: { type: "delete", threadId: newer.id },
      }),
    ).toThrow(expect.objectContaining({ code: "document-conflict" }));
    expect(state.getSnapshot().revision).toEqual(revision(3, "newer"));
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
    ).toThrow("immutable");
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

    expect(state.getSnapshot().threads.get("deleted")?.deletedAt).toEqual(
      date(5),
    );
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
      state.applySourceSnapshot(snapshot([second], revision(2), "complete")),
    ).toBe(true);
    expect([...state.getSnapshot().threads.keys()]).toEqual([second.id]);
  });
});
