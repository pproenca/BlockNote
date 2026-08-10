/** @vitest-environment node */
import {
  blockNoteDocumentBinding,
  blockNotePersistence,
  type BlockNoteAccess,
} from "@blocknote/core";
import { blockNotePersistenceInternals } from "@blocknote/core/persistence/internal";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createInMemoryAuthorizationProvider,
  createInMemoryDocumentStore,
  createInMemoryProjectionSink,
  createSingleNodeReplicaCoordinator,
} from "./in-memory.js";

const editing: BlockNoteAccess = Object.freeze({
  mode: "editing",
  edit: true,
  comment: true,
  suggest: false,
  review: false,
});

const revision = (sequence: number) =>
  Object.freeze({ sequence, token: `revision-${sequence}` });

describe("collaboration server ports", () => {
  it("returns conflicts and copies persistence bytes on every boundary", async () => {
    const store = createInMemoryDocumentStore<string>();
    const checkpoint = blockNotePersistenceInternals.checkpointFromPayload(
      Uint8Array.of(1, 2),
    );
    const initial = await store.initialize({
      key: "doc",
      binding: blockNoteDocumentBinding.fromBytes(new Uint8Array(32).fill(4)),
      checkpoint,
      revision: revision(1),
    });
    expect(initial.status).toBe("committed");
    const conflict = await store.append({
      key: "doc",
      expected: revision(0),
      next: revision(2),
      change: blockNotePersistenceInternals.changeFromPayload(Uint8Array.of(3)),
    });
    expect(conflict).toEqual({ status: "conflict", actual: revision(1) });

    const loaded = await store.load("doc");
    const exposed = blockNotePersistence.checkpointToBytes(loaded!.checkpoint);
    exposed.fill(99);
    expect(
      blockNotePersistenceInternals.checkpointToPayload(
        (await store.load("doc"))!.checkpoint,
      ),
    ).toEqual(Uint8Array.of(1, 2));
  });

  it("makes authorization close and subscriptions idempotent", async () => {
    const close = vi.fn(async () => undefined);
    const provider = createInMemoryAuthorizationProvider({
      resolve: async () => ({
        key: "doc",
        actor: { id: "actor" },
        access: async () => editing,
        close,
      }),
    });
    const session = await provider.open({
      request: new Request("https://example.test"),
      documentName: "doc",
    });
    await session!.close();
    await session!.close();
    expect(close).toHaveBeenCalledTimes(1);

    const replica = createSingleNodeReplicaCoordinator<string>();
    const listener = vi.fn();
    const unsubscribe = replica.subscribe(listener);
    unsubscribe();
    unsubscribe();
    const lease = await replica.acquire({
      key: "doc",
      replicaId: "local",
      durationMs: 1_000,
    });
    await replica.publish(lease!);
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects stale fences and copies projection values", async () => {
    let time = 0;
    const replica = createSingleNodeReplicaCoordinator<string>({
      now: () => new Date(time),
    });
    const first = await replica.acquire({
      key: "doc",
      replicaId: "a",
      durationMs: 10,
    });
    time = 11;
    const second = await replica.acquire({
      key: "doc",
      replicaId: "b",
      durationMs: 10,
    });
    expect(second!.fence).toBeGreaterThan(first!.fence);
    expect(await replica.publish(first!)).toBe(false);
    expect(await replica.renew({ lease: first!, durationMs: 10 })).toBeNull();

    const projection = createInMemoryProjectionSink<
      string,
      { values: number[] }
    >();
    const value = { values: [1] };
    await projection.sink.commit({
      key: "doc",
      revision: revision(1),
      projection: value,
    });
    value.values.push(2);
    expect(projection.get("doc", revision(1))).toEqual({ values: [1] });
  });
});
