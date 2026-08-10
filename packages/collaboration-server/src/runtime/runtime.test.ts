/** @vitest-environment node */
import {
  BlockNoteSchema,
  defineBlockNoteDocument,
  type BlockNoteAccess,
  type BlockNoteAppendInput,
  type BlockNoteDocumentStore,
} from "@blocknote/core";
import * as Y from "@y/y";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createInMemoryAuthorizationProvider,
  createInMemoryDocumentStore,
} from "../ports/in-memory.js";
import {
  createBlockNoteCollaboration,
  getBlockNoteCollaborationInternals,
} from "./createBlockNoteCollaboration.js";
import { nextRevision } from "./persistence-loop.js";

const document = defineBlockNoteDocument({
  id: "runtime-test",
  version: "1",
  schema: BlockNoteSchema.create(),
});
const editing: BlockNoteAccess = Object.freeze({
  mode: "editing",
  edit: true,
  comment: true,
  suggest: true,
  review: true,
});

function update(text: string) {
  const doc = new Y.Doc();
  doc.get("content").insert(0, text);
  const value = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return value;
}

function authorization(access: () => BlockNoteAccess | null = () => editing) {
  const close = vi.fn(async () => undefined);
  return {
    close,
    provider: createInMemoryAuthorizationProvider({
      resolve: async () => ({
        key: "doc",
        actor: { id: "actor" },
        access: async () => access(),
        close,
      }),
    }),
  };
}

describe("createBlockNoteCollaboration", () => {
  it("broadcasts only after durable append and closes authorization once", async () => {
    const durable = createInMemoryDocumentStore<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const store: BlockNoteDocumentStore<string> = {
      ...durable,
      async append(input: BlockNoteAppendInput<string>) {
        await gate;
        return durable.append(input);
      },
    };
    const auth = authorization();
    const collaboration = createBlockNoteCollaboration({
      document,
      store,
      authorization: auth.provider,
      limits: { compactAfterChanges: 0 },
    });
    const runtime = getBlockNoteCollaborationInternals(collaboration);
    const sent = vi.fn();
    const connection = await runtime.connect({
      id: "one",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: sent,
    });
    const writing = runtime.message(connection, { update: update("a") });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).not.toHaveBeenCalled();
    release();
    await writing;
    expect(sent).toHaveBeenCalledTimes(1);
    expect((await durable.load("doc"))?.changes).toHaveLength(1);
    await runtime.disconnect(connection);
    await runtime.disconnect(connection);
    await collaboration.stop();
    expect(auth.close).toHaveBeenCalledTimes(1);
  });

  it("reauthorizes each mutation and retries projection by revision", async () => {
    let current: BlockNoteAccess | null = editing;
    const auth = authorization(() => current);
    const projection = vi.fn().mockRejectedValueOnce(new Error("outage"));
    const collaboration = createBlockNoteCollaboration({
      document,
      store: createInMemoryDocumentStore<string>(),
      authorization: auth.provider,
      projection: { commit: projection },
      project: ({ revision }) => ({ revision: revision.sequence }),
      limits: { compactAfterChanges: 0 },
    });
    const runtime = getBlockNoteCollaborationInternals(collaboration);
    const connection = await runtime.connect({
      id: "one",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: vi.fn(),
    });
    await runtime.message(connection, { update: update("a") });
    current = { ...editing, edit: false };
    await expect(
      runtime.message(connection, { update: update("b") }),
    ).rejects.toMatchObject({ code: "access-denied" });
    await collaboration.stop();
    expect(projection).toHaveBeenCalledTimes(2);
    expect(projection.mock.calls[0]![0]).toEqual(projection.mock.calls[1]![0]);
  });

  it("keeps retrying a committed projection while the sink is degraded", async () => {
    const auth = authorization();
    let projected!: () => void;
    const projectionSucceeded = new Promise<void>(
      (resolve) => (projected = resolve),
    );
    const projection = vi
      .fn()
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"))
      .mockRejectedValueOnce(new Error("three"))
      .mockImplementationOnce(async () => projected());
    const collaboration = createBlockNoteCollaboration({
      document,
      store: createInMemoryDocumentStore<string>(),
      authorization: auth.provider,
      projection: { commit: projection },
      project: ({ revision }) => ({ revision: revision.sequence }),
      limits: { compactAfterChanges: 0 },
    });
    const runtime = getBlockNoteCollaborationInternals(collaboration);
    const connection = await runtime.connect({
      id: "one",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: vi.fn(),
    });
    await runtime.message(connection, { update: update("a") });
    await projectionSucceeded;
    await collaboration.stop();
    expect(projection).toHaveBeenCalledTimes(4);
  });

  it("uses collision-resistant revision tokens", async () => {
    const current = Object.freeze({ sequence: 0, token: "initial" });
    const left = Uint8Array.of(0x80, 0xce, 0, 0, 0x80, 0x46, 0xa9, 0xbf);
    const right = Uint8Array.of(0x16, 0xcf, 1, 0, 0x36, 0x94, 0xdb, 0xed);
    expect((await nextRevision(current, left)).token).not.toBe(
      (await nextRevision(current, right)).token,
    );
  });

  it("rechecks duplicate connection admission after authorization", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const close = vi.fn(async () => undefined);
    const collaboration = createBlockNoteCollaboration({
      document,
      store: createInMemoryDocumentStore<string>(),
      authorization: createInMemoryAuthorizationProvider({
        resolve: async () => {
          await gate;
          return {
            key: "doc",
            actor: { id: "actor" },
            access: async () => editing,
            close,
          };
        },
      }),
    });
    const runtime = getBlockNoteCollaborationInternals(collaboration);
    const input = {
      id: "same",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: vi.fn(),
    };
    const attempts = [runtime.connect(input), runtime.connect(input)];
    release();
    const results = await Promise.allSettled(attempts);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await collaboration.stop();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("enforces message, queue, and awareness admission limits", async () => {
    const auth = authorization();
    const collaboration = createBlockNoteCollaboration({
      document,
      store: createInMemoryDocumentStore<string>(),
      authorization: auth.provider,
      limits: {
        messageBytes: 1,
        awarenessBytes: 1,
        awarenessIdentities: 1,
      },
    });
    const runtime = getBlockNoteCollaborationInternals(collaboration);
    const connection = await runtime.connect({
      id: "one",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: vi.fn(),
    });
    await expect(
      runtime.message(connection, { update: Uint8Array.of(1, 2) }),
    ).rejects.toMatchObject({ code: "document-too-large" });
    runtime.awareness(connection, "a", Uint8Array.of(1));
    expect(() => runtime.awareness(connection, "b", Uint8Array.of(1))).toThrow(
      /identity limit/,
    );
    expect(() =>
      runtime.awareness(connection, "a", Uint8Array.of(1, 2)),
    ).toThrow(/too large/);
    await collaboration.stop();
  });
});
