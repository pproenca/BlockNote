/** @vitest-environment node */
import {
  blockNoteDocumentBinding,
  type BlockNoteDocumentBinding,
} from "@blocknote/core";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Y from "@y/y";

import { blockNoteCacheKey } from "./cache-key.js";
import { nextCacheRecord } from "./cache-manifest.js";
import { createRecoveryController } from "./recovery-controller.js";
import { createMemoryRecoveryStore } from "./recovery-store.js";

function binding(fill: number): BlockNoteDocumentBinding {
  return blockNoteDocumentBinding.fromBytes(new Uint8Array(32).fill(fill));
}

function identity(
  accountId: string,
  documentId: string,
  definitionVersion: string,
) {
  return {
    accountId,
    documentId,
    definitionVersion,
    definitionFingerprint: "fingerprint",
    binding: binding(1),
  };
}

function documentHarness(initial = Uint8Array.of(1)) {
  let bytes = Uint8Array.from(initial);
  const listeners = new Set<() => void>();
  return {
    adapter: {
      apply(next: Uint8Array) {
        bytes = Uint8Array.from(next);
      },
      snapshot: () => Uint8Array.from(bytes),
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    change(next: Uint8Array) {
      bytes = Uint8Array.from(next);
      for (const listener of listeners) {
        listener();
      }
    },
    get bytes() {
      return bytes;
    },
  };
}

describe("offline recovery", () => {
  it("scopes cache keys across account, document, version, and binding", () => {
    const base = blockNoteCacheKey(identity("a", "doc", "1"));
    expect(base).not.toBe(blockNoteCacheKey(identity("b", "doc", "1")));
    expect(base).not.toBe(blockNoteCacheKey(identity("a", "other", "1")));
    expect(base).not.toBe(blockNoteCacheKey(identity("a", "doc", "2")));
    expect(base).not.toBe(
      blockNoteCacheKey({ ...identity("a", "doc", "1"), binding: binding(2) }),
    );
  });

  it("hydrates active local state, persists copied bytes, and closes once", async () => {
    const store = createMemoryRecoveryStore();
    const key = "cache";
    await store.compareAndSetActive(
      nextCacheRecord({
        key,
        generation: 1,
        bytes: Uint8Array.of(2),
        now: 1,
      }),
      null,
    );
    const document = documentHarness();
    const durability: string[] = [];
    const controller = createRecoveryController({
      key,
      generation: 1,
      store,
      document: document.adapter,
      durability: (value) => durability.push(value),
      recoveryAvailable: vi.fn(),
    });
    await controller.start();
    expect(document.bytes).toEqual(Uint8Array.of(2));
    const changed = Uint8Array.of(3, 4);
    document.change(changed);
    changed[0] = 99;
    await controller.destroy();
    expect((await store.loadActive(key))?.bytes).toEqual(Uint8Array.of(3, 4));
    expect(durability).toEqual(["pending", "saved"]);
    await controller.destroy();
  });

  it("does not let an earlier cache write clear a newer snapshot", async () => {
    const base = createMemoryRecoveryStore();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let writes = 0;
    const store = {
      ...base,
      async compareAndSetActive(
        ...args: Parameters<typeof base.compareAndSetActive>
      ) {
        writes += 1;
        if (writes === 1) {
          started();
          await gate;
        }
        return base.compareAndSetActive(...args);
      },
    };
    const document = documentHarness();
    const controller = createRecoveryController({
      key: "cache",
      generation: 1,
      store,
      document: document.adapter,
      durability: vi.fn(),
      recoveryAvailable: vi.fn(),
    });
    await controller.start();
    document.change(Uint8Array.of(2));
    await pending;
    document.change(Uint8Array.of(3));
    release();
    await controller.destroy();
    expect((await base.loadActive("cache"))?.bytes).toEqual(Uint8Array.of(3));
  });

  it("applies one current-generation recovery and discards idempotently", async () => {
    const store = createMemoryRecoveryStore();
    const record = {
      ...nextCacheRecord({
        key: "cache",
        generation: 1,
        bytes: Uint8Array.of(7),
        now: 10,
      }),
      reason: "pending" as const,
    };
    await store.archive(record);
    const document = documentHarness();
    const available = vi.fn();
    const controller = createRecoveryController({
      key: "cache",
      generation: 1,
      store,
      document: document.adapter,
      durability: vi.fn(),
      recoveryAvailable: available,
    });
    await controller.start();
    expect(available).toHaveBeenCalledWith({
      createdAt: new Date(10),
      byteLength: 1,
    });
    const applied = await controller.applyRecovery();
    expect(applied.createdAt).not.toBe(record.updatedAt);
    expect(document.bytes).toEqual(Uint8Array.of(7));
    expect(await controller.discardRecovery()).toBeNull();
    await expect(controller.applyRecovery()).rejects.toMatchObject({
      code: "offline-unavailable",
    });
  });

  it("archives pending state before close when durable cache writes fail", async () => {
    const base = createMemoryRecoveryStore();
    const store = {
      ...base,
      compareAndSetActive: vi.fn(async () => {
        throw new Error("quota");
      }),
    };
    const document = documentHarness();
    const controller = createRecoveryController({
      key: "cache",
      generation: 1,
      store,
      document: document.adapter,
      durability: vi.fn(),
      recoveryAvailable: vi.fn(),
    });
    await controller.start();
    document.change(Uint8Array.of(8, 9));
    await controller.destroy();
    expect((await base.loadRecovery("cache"))?.bytes).toEqual(
      Uint8Array.of(8, 9),
    );
  });

  it("merges cache and live state so a stale bootstrap cannot replace live", () => {
    const bootstrap = new Y.Doc();
    bootstrap.get("content").insert(0, "abc");
    const cached = new Y.Doc();
    Y.applyUpdate(cached, Y.encodeStateAsUpdate(bootstrap));
    cached.get("content").insert(3, "d");
    const live = new Y.Doc();
    Y.applyUpdate(live, Y.encodeStateAsUpdate(cached));
    live.get("content").insert(4, "e");

    const session = new Y.Doc();
    Y.applyUpdate(session, Y.encodeStateAsUpdate(bootstrap));
    Y.applyUpdate(session, Y.encodeStateAsUpdate(cached));
    Y.applyUpdate(session, Y.encodeStateAsUpdate(live));
    expect(session.get("content").toString()).toBe("abcde");

    bootstrap.destroy();
    cached.destroy();
    live.destroy();
    session.destroy();
  });

  it("allows only one apply/discard recovery winner", async () => {
    const store = createMemoryRecoveryStore();
    await store.archive({
      ...nextCacheRecord({
        key: "cache",
        generation: 1,
        bytes: Uint8Array.of(5),
        now: 1,
      }),
      reason: "pending",
    });
    const leftDocument = documentHarness();
    const rightDocument = documentHarness();
    const left = createRecoveryController({
      key: "cache",
      generation: 1,
      store,
      document: leftDocument.adapter,
      durability: vi.fn(),
      recoveryAvailable: vi.fn(),
    });
    const right = createRecoveryController({
      key: "cache",
      generation: 1,
      store,
      document: rightDocument.adapter,
      durability: vi.fn(),
      recoveryAvailable: vi.fn(),
    });
    await Promise.all([left.start(), right.start()]);
    const results = await Promise.allSettled([
      left.applyRecovery(),
      right.discardRecovery(),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    const values = results.map((result) =>
      result.status === "fulfilled" ? result.value : undefined,
    );
    expect(values.filter(Boolean)).toHaveLength(1);
  });
});
