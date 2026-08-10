/** @vitest-environment node */
import {
  BlockNoteSchema,
  defineBlockNoteDocument,
  type BlockNoteAccess,
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

const access: BlockNoteAccess = {
  mode: "editing",
  edit: true,
  comment: true,
  suggest: true,
  review: true,
};

describe("collaboration deterministic stress", () => {
  it("serializes two writers and drains every accepted update", async () => {
    const document = defineBlockNoteDocument({
      id: "stress",
      version: "1",
      schema: BlockNoteSchema.create(),
    });
    const store = createInMemoryDocumentStore<string>();
    const authorization = createInMemoryAuthorizationProvider({
      resolve: async () => ({
        key: "doc",
        actor: { id: "actor" },
        access: async () => access,
      }),
    });
    const collaboration = createBlockNoteCollaboration({
      document,
      store,
      authorization,
      limits: {
        queueItems: 100,
        queueBytes: 1024 * 1024,
        compactAfterChanges: 0,
      },
    });
    const runtime = getBlockNoteCollaborationInternals(collaboration);
    const sent = vi.fn();
    const left = await runtime.connect({
      id: "left",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: sent,
    });
    const right = await runtime.connect({
      id: "right",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: sent,
    });
    const updates = Array.from({ length: 40 }, (_, index) => {
      const source = new Y.Doc();
      source.get("content").insert(0, String(index));
      const encoded = Y.encodeStateAsUpdate(source);
      source.destroy();
      return encoded;
    });
    await Promise.all(
      updates.map((value, index) =>
        runtime.message(index % 2 === 0 ? left : right, { update: value }),
      ),
    );
    await collaboration.stop();
    const stored = await store.load("doc");
    expect(stored?.changes).toHaveLength(40);
    expect(sent).toHaveBeenCalledTimes(80);
  });
});
