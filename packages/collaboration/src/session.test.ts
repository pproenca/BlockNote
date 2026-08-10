/** @vitest-environment node */
import {
  BlockNoteSchema,
  CommentsExtension,
  blockNoteDocumentBinding,
  createBlockNoteAccess,
  defineBlockNoteDocument,
  type AnyBlockNoteDocumentDefinition,
  type BlockNoteEditorFor,
} from "@blocknote/core";
import type { ThreadStore } from "@blocknote/core/comments";
import { blockNoteCommentAnchorInternals } from "@blocknote/core/comments/internal";
import { blockNoteBootstrapInternals } from "@blocknote/core/persistence/internal";
import { getBlockNoteDocumentInternals } from "@blocknote/core/runtime";
import * as Y from "@y/y";
import { describe, expect, it, vi } from "vite-plus/test";

import { createBlockNoteSessionWithDependencies } from "./session.js";
import type { BlockNoteProviderSignals } from "./provider/hocuspocus-provider.js";
import type { BlockNoteSessionOptions } from "./session-types.js";

const editing = Object.freeze({
  mode: "editing" as const,
  edit: true,
  comment: true,
  suggest: false,
  review: false,
});
const viewing = Object.freeze({
  mode: "viewing" as const,
  edit: false,
  comment: false,
  suggest: false,
  review: false,
});
const viewingWithEditCapability = Object.freeze({
  ...editing,
  mode: "viewing" as const,
});
const document = defineBlockNoteDocument({
  id: "session-test",
  version: "1",
  schema: BlockNoteSchema.create(),
});

function bootstrap(
  definition: AnyBlockNoteDocumentDefinition = document,
  verificationBundle?: ReturnType<
    typeof blockNoteCommentAnchorInternals.createVerificationBundle
  >,
) {
  const doc = new Y.Doc();
  try {
    return blockNoteBootstrapInternals.create({
      binding: blockNoteDocumentBinding.fromBytes(new Uint8Array(32).fill(8)),
      documentId: definition.id,
      definitionVersion: definition.version,
      definitionFingerprint:
        getBlockNoteDocumentInternals(definition).formatFingerprint,
      verificationBundle,
      checkpoint: Y.encodeStateAsUpdate(doc),
    });
  } finally {
    doc.destroy();
  }
}

function harness(overrides: { readonly providerFailure?: Error } = {}) {
  const access = createBlockNoteAccess(editing);
  const editorDestroy = vi.fn();
  const providerDestroy = vi.fn();
  const connect = vi.fn();
  let signals!: BlockNoteProviderSignals;
  let editorInput:
    | BlockNoteSessionOptions<AnyBlockNoteDocumentDefinition>
    | undefined;
  const fakeEditor = {
    isEditable: true,
    onBeforeChange: vi.fn(() => vi.fn()),
    destroy: editorDestroy,
  } as unknown as BlockNoteEditorFor<typeof document>;
  const dependencies = {
    createDocument: () => new Y.Doc({ gc: false }),
    createEditor: (
      input: BlockNoteSessionOptions<AnyBlockNoteDocumentDefinition>,
    ) => {
      editorInput = input;
      return fakeEditor;
    },
    createProvider: (input: { signals: BlockNoteProviderSignals }) => {
      signals = input.signals;
      if (overrides.providerFailure) throw overrides.providerFailure;
      return {
        awareness: () => null,
        connect,
        destroy: providerDestroy,
      };
    },
  };
  return {
    access,
    connect,
    dependencies,
    editorDestroy,
    options: {
      document,
      bootstrap: bootstrap(),
      context: {},
      access,
      collaboration: {
        endpoint: "wss://example.test",
        documentName: "doc",
        user: { name: "User", color: "#000000" },
      },
    },
    providerDestroy,
    get editorInput() {
      return editorInput;
    },
    get signals() {
      return signals;
    },
  };
}

describe("createBlockNoteSession", () => {
  it("publishes deterministic local/live and reconnect states", async () => {
    const fixture = harness();
    const observed: string[] = [];
    const session = await createBlockNoteSessionWithDependencies(
      fixture.options,
      fixture.dependencies,
      (starting) => {
        observed.push(starting.getState().phase);
        starting.subscribe((state) =>
          observed.push(`${state.readiness}:${state.connection}`),
        );
      },
    );

    expect(session.getState()).toMatchObject({
      phase: "ready",
      readiness: "local",
      connection: "connecting",
    });
    fixture.signals.status("online");
    fixture.signals.synced();
    expect(session.getState()).toMatchObject({
      readiness: "live",
      connection: "online",
    });
    fixture.signals.status("degraded");
    expect(session.getState().connection).toBe("degraded");
    fixture.signals.status("offline");
    expect(session.getState().connection).toBe("offline");
    expect(observed[0]).toBe("starting");
  });

  it("applies live access revocation without rebuilding the editor", async () => {
    const fixture = harness();
    const session = await createBlockNoteSessionWithDependencies(
      fixture.options,
      fixture.dependencies,
    );
    fixture.access.set(viewing);

    expect(session.getState().access).toStrictEqual(viewing);
    expect(session.editor.isEditable).toBe(false);
  });

  it("keeps viewing mode read only when edit capability is retained", async () => {
    const fixture = harness();
    const session = await createBlockNoteSessionWithDependencies(
      fixture.options,
      fixture.dependencies,
    );
    fixture.access.set(viewingWithEditCapability);

    expect(session.getState().access).toStrictEqual(viewingWithEditCapability);
    expect(session.editor.isEditable).toBe(false);
  });

  it("observes access changes during asynchronous recovery startup", async () => {
    const fixture = harness();
    let releaseRecovery!: () => void;
    let markRecoveryStarted!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => {
      markRecoveryStarted = resolve;
    });
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const sessionPromise = createBlockNoteSessionWithDependencies(
      fixture.options,
      {
        ...fixture.dependencies,
        async createRecoveryStore() {
          markRecoveryStarted();
          await recoveryGate;
          return null;
        },
      },
    );

    await recoveryStarted;
    fixture.access.set(viewing);
    releaseRecovery();
    const session = await sessionPromise;

    expect(session.getState().access).toStrictEqual(viewing);
    expect(session.editor.isEditable).toBe(false);
  });

  it("destroys every resource exactly once across 100 calls", async () => {
    const fixture = harness();
    const session = await createBlockNoteSessionWithDependencies(
      fixture.options,
      fixture.dependencies,
    );

    await Promise.all(Array.from({ length: 100 }, () => session.destroy()));
    expect(fixture.providerDestroy).toHaveBeenCalledTimes(1);
    expect(fixture.editorDestroy).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched bootstrap and cleans partial startup", async () => {
    const mismatch = harness();
    await expect(
      createBlockNoteSessionWithDependencies(
        {
          ...mismatch.options,
          bootstrap: bootstrap(
            defineBlockNoteDocument({
              id: "foreign",
              version: "1",
              schema: BlockNoteSchema.create(),
            }),
          ),
        },
        mismatch.dependencies,
      ),
    ).rejects.toMatchObject({ code: "incompatible-document" });

    const partial = harness({ providerFailure: new Error("provider") });
    await expect(
      createBlockNoteSessionWithDependencies(
        partial.options,
        partial.dependencies,
      ),
    ).rejects.toMatchObject({ code: "offline-unavailable" });
    expect(partial.editorDestroy).toHaveBeenCalledTimes(1);
  });

  it("preserves external comment stores while adding session services", async () => {
    const fixture = harness();
    const threadStore = {
      getSnapshot: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as ThreadStore;
    const resolveUsers = async () => [];
    const externalDocument = defineBlockNoteDocument({
      id: "session-external-comments",
      version: "1",
      schema: BlockNoteSchema.create(),
      extensions: [CommentsExtension({ target: "external" })],
    });
    const verificationBundle =
      blockNoteCommentAnchorInternals.createVerificationBundle({
        revision: 1,
        keys: [{ keyId: "active", publicKey: new Uint8Array(32).fill(3) }],
      });

    await createBlockNoteSessionWithDependencies(
      {
        ...fixture.options,
        document: externalDocument,
        bootstrap: bootstrap(externalDocument, verificationBundle),
        context: { commentsExternal: { threadStore, resolveUsers } },
      },
      fixture.dependencies,
    );

    const external = fixture.editorInput!.context.commentsExternal;
    expect(external.threadStore).toBe(threadStore);
    expect(external.resolveUsers).toBe(resolveUsers);
    expect(external.access).toBe(fixture.access);
    expect(external.isOnline()).toBe(false);
    fixture.signals.status("online");
    expect(external.isOnline()).toBe(true);
    expect(external.capture).toBeTypeOf("function");
    expect(external.verifier).toBeTypeOf("object");
  });
});
