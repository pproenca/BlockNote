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
} from "../runtime/createBlockNoteCollaboration.js";
import { classifyBlockNoteMutation } from "./classify-action.js";

const document = defineBlockNoteDocument({
  id: "review-test",
  version: "1",
  schema: BlockNoteSchema.create(),
});

function grant(
  values: Partial<Omit<BlockNoteAccess, "mode">>,
): BlockNoteAccess {
  return {
    mode: values.edit ? "editing" : values.suggest ? "suggesting" : "viewing",
    edit: false,
    comment: false,
    suggest: false,
    review: false,
    ...values,
  };
}

function mutation(root: string) {
  const doc = new Y.Doc();
  doc
    .get(root)
    .setAttr(
      "value",
      root === "__blocknote_suggestions_v2_headers"
        ? { id: "value", authorId: "spoofed" }
        : "changed",
    );
  const value = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return value;
}

function suggestionMutation() {
  const doc = new Y.Doc();
  doc.clientID = 101;
  doc.get("prosemirror").setAttr("proposal", "changed");
  doc.get("__blocknote_suggestions_v2_headers").setAttr("suggestion", {
    id: "suggestion",
    authorId: "spoofed",
  });
  doc.get("__blocknote_suggestions_v2_ranges").setAttr("range", {
    role: "insert",
    client: 101,
    clock: 0,
    length: 1,
    suggestionId: "suggestion",
  });
  const value = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return value;
}

function fabricatedDeleteClaim() {
  const before = new Y.Doc();
  before.clientID = 202;
  before.get("prosemirror").setAttr("existing", "unchanged");
  const after = new Y.Doc();
  Y.applyUpdate(after, Y.encodeStateAsUpdate(before));
  after.get("__blocknote_suggestions_v2_headers").setAttr("suggestion", {
    id: "suggestion",
    authorId: "spoofed",
  });
  after.get("__blocknote_suggestions_v2_ranges").setAttr("range", {
    role: "delete",
    client: 202,
    clock: 0,
    length: 1,
    suggestionId: "suggestion",
  });
  return { before, after };
}

function harness(initialAccess: BlockNoteAccess) {
  let current = initialAccess;
  const store = createInMemoryDocumentStore<string>();
  const executeReview = vi.fn(
    async ({ doc, actorId }: { doc: unknown; actorId: string }) => {
      (doc as Y.Doc).get("review-result").setAttr("actor", actorId);
    },
  );
  const collaboration = createBlockNoteCollaboration({
    document,
    store,
    authorization: createInMemoryAuthorizationProvider({
      resolve: async () => ({
        key: "doc",
        actor: { id: "server-actor" },
        access: async () => current,
      }),
    }),
    executeReview,
    limits: { compactAfterChanges: 0 },
  });
  return {
    collaboration,
    executeReview,
    store,
    setAccess(value: BlockNoteAccess) {
      current = value;
    },
  };
}

describe("native review authorization", () => {
  it("classifies native ledger semantics and rejects mixed authority", () => {
    const before = new Y.Doc();
    const edit = new Y.Doc();
    edit.get("prosemirror").setAttr("x", 1);
    const suggest = new Y.Doc();
    Y.applyUpdate(suggest, suggestionMutation());
    const review = new Y.Doc();
    review.get("__blocknote_suggestions_v2_receipts").setAttr("x", 1);
    const mixed = new Y.Doc();
    mixed
      .get("__blocknote_suggestions_v2_headers")
      .setAttr("x", { id: "x", authorId: "spoofed" });
    mixed.get("__blocknote_suggestions_v2_receipts").setAttr("x", 1);
    const disguisedEdit = new Y.Doc();
    disguisedEdit
      .get("__blocknote_suggestions_v2_headers")
      .setAttr("x", { id: "x", authorId: "spoofed" });
    disguisedEdit.get("prosemirror").setAttr("x", 1);
    expect(classifyBlockNoteMutation(before, edit)).toBe("edit");
    expect(classifyBlockNoteMutation(before, suggest)).toBe("suggest");
    expect(classifyBlockNoteMutation(before, review)).toBe("review");
    expect(() => classifyBlockNoteMutation(before, mixed)).toThrow(/mixes/);
    expect(() => classifyBlockNoteMutation(before, disguisedEdit)).toThrow(
      /mixes/,
    );
    for (const doc of [before, edit, suggest, review, mixed, disguisedEdit]) {
      doc.destroy();
    }
  });

  it.each([
    [grant({}), "edit", false],
    [grant({ comment: true }), "edit", false],
    [grant({ suggest: true }), "edit", false],
    [grant({ suggest: true }), "suggest", true],
  ] as const)(
    "maps current access for %s / %s",
    async (access, action, allowed) => {
      const test = harness(access);
      const runtime = getBlockNoteCollaborationInternals(test.collaboration);
      const connection = await runtime.connect({
        id: "connection",
        request: new Request("https://example.test"),
        documentName: "doc",
        send: vi.fn(),
      });
      const update =
        action === "suggest" ? suggestionMutation() : mutation("prosemirror");
      const result = runtime.message(connection, { update });
      if (allowed) {
        await expect(result).resolves.toMatchObject({ sequence: 1 });
      } else {
        await expect(result).rejects.toMatchObject({ code: "access-denied" });
      }
      await test.collaboration.stop();
    },
  );

  it("binds suggestion authors inside the mandatory server path", async () => {
    const test = harness(grant({ suggest: true }));
    const runtime = getBlockNoteCollaborationInternals(test.collaboration);
    const connection = await runtime.connect({
      id: "connection",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: vi.fn(),
    });
    await runtime.message(connection, { update: suggestionMutation() });
    const snapshot = await runtime.snapshot(connection);
    const authoritative = new Y.Doc();
    Y.applyUpdate(authoritative, snapshot.update);
    expect(
      authoritative
        .get("__blocknote_suggestions_v2_headers")
        .getAttr("suggestion"),
    ).toMatchObject({ authorId: "server-actor" });
    authoritative.destroy();
    await test.collaboration.stop();
  });

  it("rejects claims over unchanged historical content", () => {
    const { before, after } = fabricatedDeleteClaim();
    expect(() => classifyBlockNoteMutation(before, after)).toThrow(/mixes/);
    before.destroy();
    after.destroy();
  });

  it("binds reviewer identity and makes duplicate commands idempotent", async () => {
    const test = harness(grant({ review: true }));
    const runtime = getBlockNoteCollaborationInternals(test.collaboration);
    const connection = await runtime.connect({
      id: "connection",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: vi.fn(),
    });
    const command = {
      id: "decision-1",
      action: "accept" as const,
      suggestionIds: ["suggestion-1"],
    };
    const [first, duplicate] = await Promise.all([
      runtime.review(connection, command),
      runtime.review(connection, command),
    ]);
    expect(duplicate).toEqual(first);
    expect(test.executeReview).toHaveBeenCalledTimes(1);
    expect(test.executeReview.mock.calls[0]![0]).toMatchObject({
      actorId: "server-actor",
    });
    await expect(
      runtime.review(connection, { ...command, action: "reject" }),
    ).rejects.toMatchObject({ code: "invalid-document" });
    expect((await test.store.load("doc"))?.changes).toHaveLength(1);
    await test.collaboration.stop();
  });

  it("persists review command receipts across runtime restart", async () => {
    const store = createInMemoryDocumentStore<string>();
    const executeReview = vi.fn(async ({ doc }: { doc: unknown }) => {
      (doc as Y.Doc).get("review-result").setAttr("done", true);
    });
    const create = () =>
      createBlockNoteCollaboration({
        document,
        store,
        authorization: createInMemoryAuthorizationProvider({
          resolve: async () => ({
            key: "doc",
            actor: { id: "server-actor" },
            access: async () => grant({ review: true }),
          }),
        }),
        executeReview,
        limits: { compactAfterChanges: 0 },
      });
    const command = {
      id: "decision-restart",
      action: "accept" as const,
      suggestionIds: ["suggestion-1"],
    };
    const first = create();
    const firstRuntime = getBlockNoteCollaborationInternals(first);
    const firstConnection = await firstRuntime.connect({
      id: "first",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: vi.fn(),
    });
    await firstRuntime.review(firstConnection, command);
    await first.stop();

    const second = create();
    const secondRuntime = getBlockNoteCollaborationInternals(second);
    const secondConnection = await secondRuntime.connect({
      id: "second",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: vi.fn(),
    });
    await expect(
      secondRuntime.review(secondConnection, command),
    ).resolves.toMatchObject({
      sequence: 1,
    });
    await expect(
      secondRuntime.review(secondConnection, { ...command, action: "reject" }),
    ).rejects.toMatchObject({ code: "invalid-document" });
    expect(executeReview).toHaveBeenCalledTimes(1);
    expect((await store.load("doc"))?.changes).toHaveLength(1);
    await second.stop();
  });

  it("lets revocation win before review append", async () => {
    const test = harness(grant({ review: true }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    test.executeReview.mockImplementationOnce(async ({ doc, actorId }) => {
      await gate;
      (doc as Y.Doc).get("review-result").setAttr("actor", actorId);
    });
    const runtime = getBlockNoteCollaborationInternals(test.collaboration);
    const connection = await runtime.connect({
      id: "connection",
      request: new Request("https://example.test"),
      documentName: "doc",
      send: vi.fn(),
    });
    const reviewing = runtime.review(connection, {
      id: "decision-1",
      action: "accept",
      suggestionIds: ["suggestion-1"],
    });
    await Promise.resolve();
    test.setAccess(grant({}));
    release();
    await expect(reviewing).rejects.toMatchObject({ code: "access-denied" });
    expect((await test.store.load("doc"))?.changes).toHaveLength(0);
    await test.collaboration.stop();
  });
});
