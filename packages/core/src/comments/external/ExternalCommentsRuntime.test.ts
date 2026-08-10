import { createBlockNoteAccess } from "../../access/BlockNoteAccess.js";
import type { ThreadStore } from "../threadstore/ThreadStore.js";
import type { BlockNoteThreadSnapshot, ThreadData } from "../types.js";
import { describe, expect, it, vi } from "vite-plus/test";

import type { BlockNoteCommentAnchor } from "./BlockNoteCommentAnchor.js";
import type { BlockNoteCommentAnchorCapture } from "./BlockNoteCommentAnchorCapture.js";
import { createExternalCommentsRuntime } from "./ExternalCommentsRuntime.js";

const commenting = Object.freeze({
  mode: "editing" as const,
  edit: true,
  comment: true,
  suggest: false,
  review: false,
});
const revoked = Object.freeze({ ...commenting, comment: false });
const capture = Object.freeze({
  kind: "blocknote-comment-anchor-capture",
  byteLength: 1,
}) as BlockNoteCommentAnchorCapture;
const anchor = Object.freeze({
  kind: "blocknote-comment-anchor",
  byteLength: 1,
}) as BlockNoteCommentAnchor;

function thread(overrides: Partial<ThreadData> = {}): ThreadData {
  return {
    type: "thread",
    id: "thread-1",
    createdAt: new Date(1),
    updatedAt: new Date(1),
    comments: [],
    resolved: false,
    metadata: undefined,
    anchor,
    ...overrides,
  };
}

function snapshot(
  rows: readonly ThreadData[],
  completeness: "partial" | "complete" = "complete",
): BlockNoteThreadSnapshot {
  return {
    threads: new Map(rows.map((row) => [row.id, row])),
    completeness,
    revision: { sequence: 1, token: "one" },
  };
}

function harness(initial = snapshot([])) {
  let current = initial;
  let listener: (() => void) | undefined;
  let execute = vi.fn(async (_options?: { signal?: AbortSignal }) => thread());
  const createThreadCommand = vi.fn(() => ({
    execute: (options?: { signal?: AbortSignal }) => execute(options),
  }));
  const store = {
    createThreadCommand,
    getSnapshot: () => current,
    subscribe(next: () => void) {
      listener = next;
      return vi.fn();
    },
  } as unknown as ThreadStore;
  const access = createBlockNoteAccess(commenting);
  let online = true;
  const verifier = {
    verifyAndMap: vi.fn(async () => ({
      status: "attached" as const,
      range: { from: 1, to: 2 },
    })),
  };
  const runtime = createExternalCommentsRuntime({
    threadStore: store,
    access,
    isOnline: () => online,
    capture: () => capture,
    verifier,
  });
  return {
    access,
    createThreadCommand,
    get execute() {
      return execute;
    },
    setExecute(next: typeof execute) {
      execute = next;
    },
    online(value: boolean) {
      online = value;
    },
    runtime,
    snapshot(next: BlockNoteThreadSnapshot) {
      current = next;
      listener?.();
    },
    verifier,
  };
}

describe("ExternalCommentsRuntime", () => {
  it("captures without a document mutation and dispatches an external target", async () => {
    const fixture = harness();
    expect(fixture.runtime.capture({ from: 1, to: 2 })).toBe(capture);
    const command = fixture.runtime.createThreadCommand({
      initialComment: { body: [] },
      capture,
    });

    await expect(command.execute()).resolves.toMatchObject({ id: "thread-1" });
    expect(fixture.createThreadCommand).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "external", capture } }),
    );
    expect(fixture.verifier.verifyAndMap).toHaveBeenCalledWith(
      anchor,
      undefined,
    );
  });

  it("blocks offline, aborted, and pre-dispatch revoked saves", async () => {
    const fixture = harness();
    const command = fixture.runtime.createThreadCommand({
      initialComment: { body: [] },
      capture,
    });
    fixture.online(false);
    await expect(command.execute()).rejects.toMatchObject({
      code: "offline-unavailable",
    });
    expect(fixture.execute).not.toHaveBeenCalled();

    fixture.online(true);
    fixture.access.set(revoked);
    await expect(command.execute()).rejects.toMatchObject({
      code: "access-denied",
    });
    expect(fixture.execute).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      command.execute({ signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("reuses a dispatched command after unknown outcome despite later revocation", async () => {
    const fixture = harness();
    fixture.setExecute(
      vi
        .fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValue(thread()),
    );
    const command = fixture.runtime.createThreadCommand({
      initialComment: { body: [] },
      capture,
    });
    await expect(command.execute()).rejects.toThrow("timeout");
    fixture.access.set(revoked);

    await expect(command.execute()).resolves.toMatchObject({ id: "thread-1" });
    expect(fixture.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects receipts without a sealed anchor", async () => {
    const fixture = harness();
    fixture.setExecute(vi.fn(async () => thread({ anchor: undefined })));
    const command = fixture.runtime.createThreadCommand({
      initialComment: { body: [] },
      capture,
    });

    await expect(command.execute()).rejects.toMatchObject({
      code: "invalid-anchor",
    });
  });

  it("publishes verified, detached, and partial unknown anchor states", async () => {
    const fixture = harness(snapshot([thread()]));
    await vi.waitFor(() =>
      expect(fixture.runtime.getState().anchors.get("thread-1")).toEqual({
        status: "attached",
        range: { from: 1, to: 2 },
      }),
    );
    fixture.snapshot(snapshot([thread({ anchor: undefined })], "partial"));
    await vi.waitFor(() =>
      expect(fixture.runtime.getState().anchors.get("thread-1")).toEqual({
        status: "unknown",
      }),
    );
    fixture.snapshot(snapshot([thread({ anchor: undefined })], "complete"));
    await vi.waitFor(() =>
      expect(fixture.runtime.getState().anchors.get("thread-1")).toEqual({
        status: "detached",
      }),
    );
  });
});
