/** @vitest-environment node */
import {
  BlockNoteSchema,
  defineBlockNoteDocument,
  type BlockNoteAccess,
} from "@blocknote/core";
import {
  createBlockNoteCollaboration,
  createInMemoryAuthorizationProvider,
  createInMemoryDocumentStore,
} from "@blocknote/collaboration-server";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Y from "@y/y";

import { serveBlockNoteCollaboration } from "./serveBlockNoteCollaboration.js";

const access: BlockNoteAccess = {
  mode: "editing",
  edit: true,
  comment: true,
  suggest: true,
  review: true,
};

function collaboration(store = createInMemoryDocumentStore<string>()) {
  return createBlockNoteCollaboration({
    document: defineBlockNoteDocument({
      id: "node-server-test",
      version: "1",
      schema: BlockNoteSchema.create(),
    }),
    store,
    authorization: createInMemoryAuthorizationProvider({
      resolve: async () => ({
        key: "doc",
        actor: { id: "actor" },
        access: async () => access,
      }),
    }),
  });
}

function tenantCollaboration(
  store: ReturnType<typeof createInMemoryDocumentStore<string>>,
) {
  return createBlockNoteCollaboration({
    document: defineBlockNoteDocument({
      id: "node-server-tenant-test",
      version: "1",
      schema: BlockNoteSchema.create(),
    }),
    store,
    authorization: createInMemoryAuthorizationProvider({
      resolve: async ({ request }) => ({
        key: new URL(request.url).searchParams.get("tenant") ?? "missing",
        actor: { id: "actor" },
        access: async () => access,
      }),
    }),
  });
}

async function client(endpoint: string, document: Y.Doc) {
  let synced!: () => void;
  const ready = new Promise<void>((resolve) => (synced = resolve));
  const websocket = new HocuspocusProviderWebsocket({
    url: endpoint,
    autoConnect: false,
  });
  const provider = new HocuspocusProvider({
    name: "doc",
    document: document as never,
    websocketProvider: websocket,
    onSynced({ state }) {
      if (state) {
        synced();
      }
    },
  });
  provider.attach();
  void websocket.connect();
  await ready;
  return () => {
    provider.destroy();
    websocket.destroy();
  };
}

describe("serveBlockNoteCollaboration", () => {
  it("starts on an ephemeral port, removes signals, and stops idempotently", async () => {
    const before = process.listenerCount("SIGUSR2");
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const server = await serveBlockNoteCollaboration({
      collaboration: collaboration(),
      host: "127.0.0.1",
      port: 0,
      logger,
      signals: ["SIGUSR2", "SIGUSR2"],
    });
    expect(server.address.port).toBeGreaterThan(0);
    expect(process.listenerCount("SIGUSR2")).toBe(before + 1);
    const response = await fetch(
      `http://${server.address.host}:${server.address.port}`,
    );
    expect(response.status).toBeLessThan(500);
    const first = server.stop();
    expect(server.stop()).toBe(first);
    await first;
    expect(process.listenerCount("SIGUSR2")).toBe(before);
    await expect(
      fetch(`http://${server.address.host}:${server.address.port}`),
    ).rejects.toThrow();
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it("can restart cleanly on a new ephemeral port", async () => {
    const first = await serveBlockNoteCollaboration({
      collaboration: collaboration(),
      host: "127.0.0.1",
      port: 0,
    });
    await first.stop();
    const second = await serveBlockNoteCollaboration({
      collaboration: collaboration(),
      host: "127.0.0.1",
      port: 0,
    });
    expect(second.address.port).toBeGreaterThan(0);
    await second.stop();
  });

  it("syncs two clients from durable authority and restores after restart", async () => {
    const store = createInMemoryDocumentStore<string>();
    const firstServer = await serveBlockNoteCollaboration({
      collaboration: collaboration(store),
      host: "127.0.0.1",
      port: 0,
    });
    const endpoint = `ws://${firstServer.address.host}:${firstServer.address.port}`;
    const left = new Y.Doc();
    const stopLeft = await client(endpoint, left);
    left.get("content").insert(0, "authoritative");
    await vi.waitFor(async () => {
      expect((await store.load("doc"))?.changes).toHaveLength(1);
    });
    const right = new Y.Doc();
    const stopRight = await client(endpoint, right);
    await vi.waitFor(() => {
      expect(right.get("content").toString()).toBe("authoritative");
    });
    stopRight();
    stopLeft();
    await firstServer.stop();

    const restarted = await serveBlockNoteCollaboration({
      collaboration: collaboration(store),
      host: "127.0.0.1",
      port: 0,
    });
    const restored = new Y.Doc();
    const stopRestored = await client(
      `ws://${restarted.address.host}:${restarted.address.port}`,
      restored,
    );
    expect(restored.get("content").toString()).toBe("authoritative");
    stopRestored();
    await restarted.stop();
    left.destroy();
    right.destroy();
    restored.destroy();
  });

  it("rejects one transport name resolving to a different tenant key", async () => {
    const store = createInMemoryDocumentStore<string>();
    const server = await serveBlockNoteCollaboration({
      collaboration: tenantCollaboration(store),
      host: "127.0.0.1",
      port: 0,
    });
    const endpoint = `ws://${server.address.host}:${server.address.port}`;
    const first = new Y.Doc();
    const stopFirst = await client(`${endpoint}?tenant=first`, first);
    first.get("content").insert(0, "private");
    await vi.waitFor(async () => {
      expect((await store.load("first"))?.changes).toHaveLength(1);
    });

    let rejected!: () => void;
    const rejection = new Promise<void>((resolve) => (rejected = resolve));
    const second = new Y.Doc();
    const websocket = new HocuspocusProviderWebsocket({
      url: `${endpoint}?tenant=second`,
      autoConnect: false,
    });
    const provider = new HocuspocusProvider({
      name: "doc",
      document: second as never,
      websocketProvider: websocket,
      onAuthenticationFailed: rejected,
    });
    provider.attach();
    void websocket.connect();
    await rejection;
    expect(second.get("content").toString()).toBe("");
    expect(await store.load("second")).toBeNull();

    provider.destroy();
    websocket.destroy();
    stopFirst();
    await server.stop();
    first.destroy();
    second.destroy();
  });
});
