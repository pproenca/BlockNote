import {
  BlockNoteError,
  type AnyBlockNoteDocumentDefinition,
  type BlockNoteDocumentStore,
  type BlockNoteMutationAction,
  type BlockNoteRevision,
} from "@blocknote/core";

import type { BlockNoteAuthorizationProvider } from "../ports/authorization.js";
import type { BlockNoteProjectionSink } from "../ports/projection.js";
import type { BlockNoteReplicaCoordinator } from "../ports/replica.js";
import type { BlockNoteReviewExecutor } from "../review/execute-review.js";
import type { BlockNoteReviewCommand } from "../review/review-command.js";
import { createAwarenessRuntime } from "./awareness.js";
import {
  createDocumentRuntime,
  type RuntimeConnection,
} from "./document-runtime.js";

declare const blockNoteCollaborationOpaque: unique symbol;

export interface BlockNoteCollaboration<TKey> {
  readonly [blockNoteCollaborationOpaque]: TKey;
  stop(): Promise<void>;
}

export interface BlockNoteCollaborationOptions<TKey, Projection = unknown> {
  readonly document: AnyBlockNoteDocumentDefinition;
  readonly store: BlockNoteDocumentStore<TKey>;
  readonly authorization: BlockNoteAuthorizationProvider<TKey>;
  readonly projection?: BlockNoteProjectionSink<TKey, Projection>;
  readonly project?: (value: {
    readonly doc: unknown;
    readonly revision: BlockNoteRevision;
  }) => Projection;
  readonly replica?: BlockNoteReplicaCoordinator<TKey>;
  readonly replicaId?: string;
  readonly validate?: (value: {
    readonly doc: unknown;
    readonly update: Uint8Array;
    readonly action: BlockNoteMutationAction;
    readonly actorId: string;
  }) => Promise<void> | void;
  readonly executeReview?: BlockNoteReviewExecutor;
  readonly limits?: {
    readonly connections?: number;
    readonly queueItems?: number;
    readonly queueBytes?: number;
    readonly messageBytes?: number;
    readonly documentBytes?: number;
    readonly awarenessBytes?: number;
    readonly awarenessIdentities?: number;
    readonly compactAfterChanges?: number;
  };
}

export interface BlockNoteRuntimeConnection {
  readonly id: string;
  readonly documentName: string;
  readonly transportScope: object;
}

export interface BlockNoteCollaborationInternals {
  connect(input: {
    readonly id: string;
    readonly request: Request;
    readonly documentName: string;
    readonly send: (message: {
      readonly source: string;
      readonly update: Uint8Array;
      readonly revision: BlockNoteRevision;
    }) => void;
  }): Promise<BlockNoteRuntimeConnection>;
  message(
    connection: BlockNoteRuntimeConnection,
    message: {
      readonly update: Uint8Array;
    },
  ): Promise<BlockNoteRevision>;
  snapshot(connection: BlockNoteRuntimeConnection): Promise<{
    readonly update: Uint8Array;
    readonly revision: BlockNoteRevision;
  }>;
  review(
    connection: BlockNoteRuntimeConnection,
    command: BlockNoteReviewCommand,
  ): Promise<BlockNoteRevision>;
  awareness(
    connection: BlockNoteRuntimeConnection,
    identity: string,
    value: Uint8Array,
  ): void;
  disconnect(connection: BlockNoteRuntimeConnection): Promise<void>;
}

const internals = new WeakMap<object, BlockNoteCollaborationInternals>();

export function getBlockNoteCollaborationInternals(
  collaboration: BlockNoteCollaboration<unknown>,
) {
  const value = internals.get(collaboration);
  if (!value) {
    throw new BlockNoteError(
      "invalid-document",
      "Unknown BlockNote collaboration runtime.",
    );
  }
  return value;
}

export function createBlockNoteCollaboration<TKey, Projection = unknown>(
  options: BlockNoteCollaborationOptions<TKey, Projection>,
): BlockNoteCollaboration<TKey> {
  const limits = Object.freeze({
    connections: options.limits?.connections ?? 1_000,
    queueItems: options.limits?.queueItems ?? 1_000,
    queueBytes: options.limits?.queueBytes ?? 16 * 1024 * 1024,
    messageBytes: options.limits?.messageBytes ?? 1024 * 1024,
    documentBytes:
      options.limits?.documentBytes ??
      options.document.limits?.documentBytes ??
      16 * 1024 * 1024,
    awarenessBytes: options.limits?.awarenessBytes ?? 64 * 1024,
    awarenessIdentities: options.limits?.awarenessIdentities ?? 64,
    compactAfterChanges: options.limits?.compactAfterChanges ?? 100,
  });
  const documents = new Map<
    TKey,
    ReturnType<typeof createDocumentRuntime<TKey, Projection>>
  >();
  const connections = new Map<
    string,
    {
      readonly public: BlockNoteRuntimeConnection;
      readonly runtime: ReturnType<
        typeof createDocumentRuntime<TKey, Projection>
      >;
      readonly connection: RuntimeConnection<TKey>;
    }
  >();
  const awareness = createAwarenessRuntime({
    maxBytes: limits.awarenessBytes,
    maxIdentities: limits.awarenessIdentities,
  });
  let stopping = false;
  let stopPromise: Promise<void> | null = null;

  const closeConnection = (id: string) => {
    const entry = connections.get(id);
    if (!entry) {
      return Promise.resolve();
    }
    if (entry.connection.closePromise) {
      return entry.connection.closePromise;
    }
    entry.connection.closed = true;
    entry.connection.closePromise = Promise.resolve().then(async () => {
      connections.delete(id);
      entry.runtime.remove(id);
      awareness.removeConnection(id);
      await entry.connection.authorization.close();
    });
    return entry.connection.closePromise;
  };

  const adapter: BlockNoteCollaborationInternals = Object.freeze({
    async connect(
      input: Parameters<BlockNoteCollaborationInternals["connect"]>[0],
    ) {
      if (stopping || connections.size >= limits.connections) {
        throw new BlockNoteError(
          "offline-unavailable",
          "BlockNote collaboration is unavailable.",
          { retryable: true },
        );
      }
      if (connections.has(input.id)) {
        throw new BlockNoteError(
          "invalid-document",
          "BlockNote collaboration connection id is already active.",
        );
      }
      const authorization = await options.authorization.open({
        request: input.request,
        documentName: input.documentName,
      });
      if (!authorization) {
        throw new BlockNoteError(
          "access-denied",
          "BlockNote collaboration connection was denied.",
        );
      }
      let accepted = false;
      try {
        if (!(await authorization.getAccess("connect"))) {
          throw new BlockNoteError(
            "access-denied",
            "BlockNote collaboration connection was denied.",
          );
        }
        if (stopping || connections.size >= limits.connections) {
          throw new BlockNoteError(
            "offline-unavailable",
            "BlockNote collaboration is unavailable.",
            { retryable: true },
          );
        }
        if (connections.has(input.id)) {
          throw new BlockNoteError(
            "invalid-document",
            "BlockNote collaboration connection id is already active.",
          );
        }
        let runtime = documents.get(authorization.documentKey);
        if (!runtime) {
          runtime = createDocumentRuntime({
            key: authorization.documentKey,
            document: options.document,
            store: options.store,
            projection: options.projection,
            project: options.project,
            replica: options.replica,
            replicaId: options.replicaId ?? "local",
            limits: {
              queueItems: limits.queueItems,
              queueBytes: limits.queueBytes,
              documentBytes: limits.documentBytes,
              compactAfterChanges: limits.compactAfterChanges,
            },
            validate: options.validate,
          });
          documents.set(authorization.documentKey, runtime);
        }
        const connection: RuntimeConnection<TKey> = {
          id: input.id,
          authorization,
          send: input.send,
          closed: false,
          closePromise: null,
        };
        const publicConnection = Object.freeze({
          id: input.id,
          documentName: input.documentName,
          transportScope: runtime,
        });
        runtime.add(connection);
        connections.set(input.id, {
          public: publicConnection,
          runtime,
          connection,
        });
        accepted = true;
        return publicConnection;
      } finally {
        if (!accepted) {
          await authorization.close();
        }
      }
    },
    async message(
      connection: BlockNoteRuntimeConnection,
      message: Parameters<BlockNoteCollaborationInternals["message"]>[1],
    ) {
      const entry = connections.get(connection.id);
      if (!entry || entry.public !== connection) {
        throw new BlockNoteError(
          "access-denied",
          "BlockNote collaboration connection is closed.",
        );
      }
      if (message.update.byteLength > limits.messageBytes) {
        throw new BlockNoteError(
          "document-too-large",
          "BlockNote collaboration message is too large.",
        );
      }
      return entry.runtime.handle(entry.connection, {
        update: Uint8Array.from(message.update),
      });
    },
    async snapshot(connection: BlockNoteRuntimeConnection) {
      const entry = connections.get(connection.id);
      if (!entry || entry.public !== connection) {
        throw new BlockNoteError(
          "access-denied",
          "BlockNote collaboration connection is closed.",
        );
      }
      const snapshot = await entry.runtime.snapshot();
      return Object.freeze({
        update: Uint8Array.from(snapshot.update),
        revision: snapshot.revision,
      });
    },
    async review(
      connection: BlockNoteRuntimeConnection,
      command: BlockNoteReviewCommand,
    ) {
      const entry = connections.get(connection.id);
      if (!entry || entry.public !== connection) {
        throw new BlockNoteError(
          "access-denied",
          "BlockNote collaboration connection is closed.",
        );
      }
      if (!options.executeReview) {
        throw new BlockNoteError(
          "incompatible-document",
          "BlockNote native review execution is not configured.",
        );
      }
      return entry.runtime.review(
        entry.connection,
        command,
        options.executeReview,
      );
    },
    awareness(
      connection: BlockNoteRuntimeConnection,
      identity: string,
      value: Uint8Array,
    ) {
      if (!connections.has(connection.id)) {
        throw new BlockNoteError(
          "access-denied",
          "BlockNote collaboration connection is closed.",
        );
      }
      awareness.update(connection.id, identity, value);
    },
    disconnect(connection: BlockNoteRuntimeConnection) {
      return closeConnection(connection.id);
    },
  });

  const collaboration = Object.freeze({
    stop() {
      if (stopPromise) {
        return stopPromise;
      }
      stopping = true;
      stopPromise = Promise.resolve().then(async () => {
        await Promise.all([...connections.keys()].map(closeConnection));
        await Promise.all(
          [...documents.values()].map((runtime) => runtime.stop()),
        );
        documents.clear();
        awareness.clear();
      });
      return stopPromise;
    },
  }) as BlockNoteCollaboration<TKey>;
  internals.set(collaboration, adapter);
  return collaboration;
}
