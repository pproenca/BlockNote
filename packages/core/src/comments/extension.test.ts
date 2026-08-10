/** @vitest-environment jsdom */
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { createBlockNoteAccess } from "../access/BlockNoteAccess.js";
import { BlockNoteSchema } from "../blocks/BlockNoteSchema.js";
import {
  defineBlockNoteDocument,
  type BlockNoteRuntimeContext,
} from "../document/BlockNoteDocument.js";
import type { BlockNoteEditor } from "../editor/BlockNoteEditor.js";
import type { UserStoreOrResolver } from "../user/index.js";
import { blockNoteCommentAnchorInternals } from "./internal.js";
import { CommentsExtension } from "./extension.js";
import type { ThreadStore } from "./threadstore/ThreadStore.js";

const editing = Object.freeze({
  mode: "editing" as const,
  edit: true,
  comment: true,
  suggest: false,
  review: false,
});

function threadStore(token: string) {
  return {
    getSnapshot: () => ({
      threads: new Map(),
      completeness: "complete" as const,
      revision: { sequence: 1, token },
    }),
    subscribe: () => () => undefined,
  } as unknown as ThreadStore;
}

const resolveUsers: UserStoreOrResolver = async () => [];
const editor = {} as BlockNoteEditor;

function instantiate<
  Configured extends {
    readonly "~types": { readonly extension: unknown };
  },
>(configured: Configured, context: object) {
  return (
    configured as unknown as (input: {
      readonly editor: BlockNoteEditor;
      readonly context: object;
    }) => Configured["~types"]["extension"]
  )({ editor, context });
}

function resolvedContext(store: ThreadStore) {
  return {
    commentsExternal: {
      threadStore: store,
      resolveUsers,
      access: createBlockNoteAccess(editing),
      isOnline: () => true,
      capture: () =>
        blockNoteCommentAnchorInternals.createCapture({
          from: Uint8Array.of(0, 1, 2, 0),
          to: Uint8Array.of(0, 1, 6, 1),
        }),
      verifier: {
        verifyAndMap: async () => ({ status: "detached" as const }),
      },
    },
  };
}

describe("CommentsExtension", () => {
  it("binds external stores from each runtime context", () => {
    const definition = defineBlockNoteDocument({
      id: "external-comments-context",
      version: "1",
      schema: BlockNoteSchema.create(),
      extensions: [CommentsExtension({ target: "external" })],
    });
    type Context = BlockNoteRuntimeContext<typeof definition>;

    expectTypeOf<Context>().toEqualTypeOf<{
      readonly commentsExternal: {
        readonly threadStore: ThreadStore;
        readonly resolveUsers: UserStoreOrResolver;
      };
    }>();

    const configured = definition.extensions[0]!;
    const left = instantiate(configured, resolvedContext(threadStore("left")));
    const right = instantiate(
      configured,
      resolvedContext(threadStore("right")),
    );

    expect(left.threadStore.getSnapshot().revision.token).toBe("left");
    expect(right.threadStore.getSnapshot().revision.token).toBe("right");
    expect(left.userStore).not.toBe(right.userStore);
  });

  it("keeps document-target stores in extension options", () => {
    const store = threadStore("document");
    const extension = instantiate(
      CommentsExtension({ threadStore: store, resolveUsers }),
      {},
    );

    expect(extension.threadStore).toBe(store);
    expect(extension.externalRuntime).toBeNull();
  });

  it("rejects external context that was not enriched by a session", () => {
    const store = threadStore("uncomposed");
    const configured = CommentsExtension({ target: "external" });

    expect(() =>
      instantiate(configured, {
        commentsExternal: { threadStore: store, resolveUsers },
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible-document" }));
  });
});
