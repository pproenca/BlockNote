import {
  BlockNoteEditor,
  BlockNoteError,
  blockNoteDocumentBinding,
  type BlockNoteAccess,
  type BlockNoteCommentAnchor,
  type BlockNoteCommentAnchorMappingResult,
  type AnyBlockNoteDocumentDefinition,
  type BlockNoteEditorFor,
} from "@blocknote/core";
import { blockNoteBootstrapInternals } from "@blocknote/core/persistence/internal";
import { getBlockNoteDocumentInternals } from "@blocknote/core/runtime";
import {
  createYCommentAnchorMapping,
  withCollaboration,
} from "@blocknote/core/y";
import * as Y from "@y/y";

import { blockNoteCacheKey } from "./cache/cache-key.js";
import { createIndexedDbRecoveryStore } from "./cache/indexeddb-cache.js";
import { createRecoveryController } from "./cache/recovery-controller.js";
import type { BlockNoteRecoveryStore } from "./cache/recovery-store.js";
import { createBlockNoteCommentAnchorVerifier } from "./comments/comment-anchor-verifier.js";
import { createBlockNoteEvents } from "./events.js";
import { createHocuspocusProviderAdapter } from "./provider/hocuspocus-provider.js";
import type {
  BlockNoteSession,
  BlockNoteSessionEvents,
  BlockNoteSessionOptions,
  BlockNoteSessionState,
} from "./session-types.js";

type SessionInternals = Readonly<{
  verifier: Readonly<{
    verifyAndMap(
      anchor: BlockNoteCommentAnchor,
      signal?: AbortSignal,
    ): Promise<BlockNoteCommentAnchorMappingResult>;
    getStatus(): Readonly<{ status: "idle" | "verifying" | "error" }>;
  }> | null;
}>;

const internals = new WeakMap<object, SessionInternals>();

function canMutate(access: BlockNoteAccess) {
  return (
    (access.mode === "editing" && access.edit) ||
    (access.mode === "suggesting" && access.suggest)
  );
}

export function getBlockNoteSessionInternals(session: object) {
  const value = internals.get(session);
  if (!value) throw new Error("Unknown BlockNote collaboration session.");
  return value;
}

interface SessionDependencies {
  readonly createDocument: () => unknown;
  readonly createEditor: (
    input: BlockNoteSessionOptions<AnyBlockNoteDocumentDefinition>,
    doc: unknown,
  ) => unknown;
  readonly createProvider: (input: {
    readonly document: unknown;
    readonly options: BlockNoteSessionOptions<AnyBlockNoteDocumentDefinition>;
    readonly signals: {
      readonly status: (
        status: "connecting" | "online" | "offline" | "degraded",
      ) => void;
      readonly synced: () => void;
      readonly durability: (
        state: "saved" | "pending" | "offline" | "error",
      ) => void;
      readonly fatal: (error: unknown) => void;
    };
  }) => Readonly<{
    connect(): void;
    awareness(): unknown;
    destroy(): void;
  }>;
  readonly createRecoveryStore?: (
    options: BlockNoteSessionOptions<AnyBlockNoteDocumentDefinition>,
  ) => Promise<BlockNoteRecoveryStore | null>;
}

const defaultDependencies: SessionDependencies = {
  createDocument: () => new Y.Doc({ gc: false }),
  createEditor(input, doc) {
    const document = doc as Y.Doc;
    const configured = withCollaboration({
      schema: input.document.schema,
      context: input.context,
      extensions: input.document.extensions.filter(
        (extension) => extension.name !== "collaboration",
      ),
      collaboration: {
        fragment: document.get("prosemirror"),
        user: input.collaboration.user,
      },
    });
    const editor = BlockNoteEditor.create(configured) as BlockNoteEditorFor<
      typeof input.document
    >;
    Object.defineProperty(editor, "documentDefinition", {
      configurable: true,
      value: input.document,
    });
    return editor;
  },
  createProvider({ document, options, signals }) {
    return createHocuspocusProviderAdapter({
      document,
      endpoint: options.collaboration.endpoint,
      documentName: options.collaboration.documentName,
      credentials: options.collaboration.credentials,
      signals,
    });
  },
  async createRecoveryStore(options) {
    if (typeof indexedDB === "undefined") {
      return null;
    }
    return createIndexedDbRecoveryStore(options.offline?.databaseName);
  },
};

function sameState(left: BlockNoteSessionState, right: BlockNoteSessionState) {
  return (
    left.phase === right.phase &&
    left.readiness === right.readiness &&
    left.connection === right.connection &&
    left.durability === right.durability &&
    left.access === right.access &&
    left.error === right.error
  );
}

function runtimeError(error: unknown) {
  return error instanceof BlockNoteError
    ? error
    : new BlockNoteError(
        "offline-unavailable",
        "BlockNote collaboration session failed.",
        { cause: error, retryable: true },
      );
}

export async function createBlockNoteSessionWithDependencies<
  const Document extends AnyBlockNoteDocumentDefinition,
>(
  options: BlockNoteSessionOptions<Document>,
  dependencies: SessionDependencies,
  observe?: (session: BlockNoteSession<Document>) => void,
): Promise<BlockNoteSession<Document>> {
  const events = createBlockNoteEvents<BlockNoteSessionEvents>();
  const listeners = new Set<(state: BlockNoteSessionState) => void>();
  let state: BlockNoteSessionState = Object.freeze({
    phase: "starting",
    readiness: "none",
    connection: "connecting",
    durability: "saved",
    access: options.access.get(),
  });
  let doc: Y.Doc | null = null;
  let editor: BlockNoteEditorFor<Document> | null = null;
  let provider: ReturnType<SessionDependencies["createProvider"]> | null = null;
  let verifier: ReturnType<typeof createBlockNoteCommentAnchorVerifier> | null =
    null;
  let recovery: ReturnType<typeof createRecoveryController> | null = null;
  let stopAccess: (() => void) | null = null;
  let stopBeforeChange: (() => void) | null = null;
  let destroyed = false;
  let destroyPromise: Promise<void> | null = null;

  const publish = (patch: Partial<BlockNoteSessionState>) => {
    if (destroyed) return;
    const next = Object.freeze({ ...state, ...patch });
    if (sameState(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener(state);
  };

  const destroy = () => {
    if (destroyPromise) return destroyPromise;
    destroyPromise = Promise.resolve().then(async () => {
      if (destroyed) return;
      destroyed = true;
      const failures: unknown[] = [];
      const cleanup = async (action: (() => void | Promise<void>) | null) => {
        try {
          await action?.();
        } catch (error) {
          failures.push(error);
        }
      };
      await cleanup(() => provider?.destroy());
      await cleanup(() => recovery?.destroy());
      await cleanup(() => verifier?.destroy());
      await cleanup(stopBeforeChange);
      await cleanup(stopAccess);
      await cleanup(() => editor?.destroy());
      await cleanup(() => doc?.destroy());
      listeners.clear();
      events.clear();
      if (failures.length > 0) {
        throw new BlockNoteError(
          "extension-cleanup-failed",
          "BlockNote collaboration session cleanup failed.",
          { cause: new AggregateError(failures) },
        );
      }
    });
    return destroyPromise;
  };

  const placeholder = {} as BlockNoteSession<Document>;
  Object.defineProperties(placeholder, {
    document: { enumerable: true, value: options.document },
    editor: { enumerable: true, get: () => editor },
  });
  Object.assign(placeholder, {
    getState: () => state,
    subscribe(listener: (value: BlockNoteSessionState) => void) {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    on: events.on,
    async applyRecovery() {
      if (!recovery) {
        throw new BlockNoteError(
          "offline-unavailable",
          "BlockNote recovery is not available for this session.",
          { retryable: true },
        );
      }
      const applied = await recovery.applyRecovery();
      events.emit("recoveryApplied", applied);
    },
    async discardRecovery() {
      await recovery?.discardRecovery();
    },
    destroy,
  });
  const session = placeholder;
  observe?.(session);

  try {
    const bootstrap = blockNoteBootstrapInternals.inspect(options.bootstrap);
    const definition = getBlockNoteDocumentInternals(options.document);
    if (
      bootstrap.documentId !== options.document.id ||
      bootstrap.definitionVersion !== options.document.version ||
      bootstrap.definitionFingerprint !== definition.formatFingerprint
    ) {
      throw new BlockNoteError(
        "incompatible-document",
        "BlockNote collaboration bootstrap is incompatible.",
      );
    }
    doc = dependencies.createDocument() as Y.Doc;
    Y.applyUpdate(doc, bootstrap.checkpoint);
    const recoveryStore = await dependencies.createRecoveryStore?.(
      options as BlockNoteSessionOptions<AnyBlockNoteDocumentDefinition>,
    );
    if (recoveryStore) {
      recovery = createRecoveryController({
        key: blockNoteCacheKey({
          accountId:
            options.offline?.accountId ??
            [...blockNoteDocumentBinding.toBytes(bootstrap.binding)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join(""),
          documentId: bootstrap.documentId,
          definitionVersion: bootstrap.definitionVersion,
          definitionFingerprint: bootstrap.definitionFingerprint,
          binding: bootstrap.binding,
        }),
        generation: 1,
        store: recoveryStore,
        document: {
          apply: (bytes) => Y.applyUpdate(doc!, bytes, recovery),
          snapshot: () => Y.encodeStateAsUpdate(doc!),
          subscribe(listener) {
            const update = (_bytes: Uint8Array, origin: unknown) => {
              if (origin !== recovery) {
                listener();
              }
            };
            doc!.on("update", update);
            return () => doc?.off("update", update);
          },
        },
        durability: (durability) => publish({ durability }),
        recoveryAvailable: (value) => events.emit("recoveryAvailable", value),
      });
      await recovery.start();
    }
    const mapping = createYCommentAnchorMapping({
      doc,
      type: doc.get("prosemirror"),
    });
    if (bootstrap.verificationBundle) {
      verifier = createBlockNoteCommentAnchorVerifier({
        documentBinding: bootstrap.binding,
        definitionFingerprint: bootstrap.definitionFingerprint,
        verificationBundle: bootstrap.verificationBundle,
        refresh: options.refreshCommentAnchorVerification,
        mapAnchor: mapping.mapAnchor,
      });
    }
    const externalComments = options.document.extensions.some(
      (extension) =>
        extension.name === "comments" &&
        !!extension.options &&
        typeof extension.options === "object" &&
        "target" in extension.options &&
        extension.options.target === "external",
    );
    const configuredExternal =
      "commentsExternal" in options.context
        ? options.context.commentsExternal
        : undefined;
    if (externalComments && !configuredExternal) {
      throw new BlockNoteError(
        "incompatible-document",
        "External comments require a thread store and user resolver.",
      );
    }
    if (externalComments && !verifier) {
      throw new BlockNoteError(
        "incompatible-document",
        "External comments require an authenticated verification bundle.",
      );
    }
    const runtimeOptions = {
      ...options,
      context: {
        ...options.context,
        ...(externalComments && configuredExternal && verifier
          ? {
              commentsExternal: {
                ...configuredExternal,
                access: options.access,
                isOnline: () => state.connection === "online",
                capture: mapping.capture,
                verifier,
              },
            }
          : {}),
      },
    } as unknown as BlockNoteSessionOptions<AnyBlockNoteDocumentDefinition>;
    stopAccess = options.access.subscribe((access) => {
      if (editor) editor.isEditable = canMutate(access);
      publish({ access });
    });
    publish({ access: options.access.get() });
    editor = dependencies.createEditor(
      runtimeOptions,
      doc,
    ) as unknown as BlockNoteEditorFor<Document>;
    editor.isEditable = canMutate(state.access);
    stopBeforeChange = editor.onBeforeChange(({ tr }) => {
      if (
        !tr.docChanged ||
        tr.getMeta("y-sync-transaction") ||
        tr.getMeta("y-sync-append")
      ) {
        return true;
      }
      const access = options.access.get();
      if (canMutate(access)) return true;
      events.emit("accessRejected", { action: "edit", access });
      return false;
    });
    const signals = {
      status(connection: "connecting" | "online" | "offline" | "degraded") {
        publish({ connection });
      },
      synced() {
        publish({ phase: "ready", readiness: "live", connection: "online" });
      },
      durability(durability: "saved" | "pending" | "offline" | "error") {
        publish({ durability });
      },
      fatal(error: unknown) {
        const failure = runtimeError(error);
        publish({ phase: "failed", connection: "offline", error: failure });
        events.emit("fatalError", failure);
      },
    };
    provider = dependencies.createProvider({
      document: doc,
      options:
        options as BlockNoteSessionOptions<AnyBlockNoteDocumentDefinition>,
      signals,
    });
    publish({ phase: "ready", readiness: "local" });
    provider.connect();
    internals.set(session, Object.freeze({ verifier }));
    return Object.freeze(session);
  } catch (error) {
    const failure = runtimeError(error);
    publish({ phase: "failed", error: failure, connection: "offline" });
    events.emit("fatalError", failure);
    await destroy().catch((cleanup) => {
      if (failure.cause === undefined) failure.cause = cleanup;
    });
    throw failure;
  }
}

export function createBlockNoteSession<
  const Document extends AnyBlockNoteDocumentDefinition,
>(options: BlockNoteSessionOptions<Document>) {
  return createBlockNoteSessionWithDependencies(options, defaultDependencies);
}
