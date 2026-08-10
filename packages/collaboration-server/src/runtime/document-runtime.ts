import {
  BlockNoteError,
  blockNoteDocumentBinding,
  type AnyBlockNoteDocumentDefinition,
  type BlockNoteMutationAction,
  type BlockNoteDocumentStore,
  type BlockNoteRevision,
} from "@blocknote/core";
import * as Y from "@y/y";

import type { BlockNoteAuthorizationSession } from "../ports/authorization.js";
import type { BlockNoteProjectionSink } from "../ports/projection.js";
import type {
  BlockNoteReplicaCoordinator,
  BlockNoteReplicaLease,
} from "../ports/replica.js";
import { classifyBlockNoteMutation } from "../review/classify-action.js";
import type { BlockNoteReviewExecutor } from "../review/execute-review.js";
import { validateBlockNoteSuggestionMutation } from "../review/validate-suggestion.js";
import {
  validateBlockNoteReviewCommand,
  type BlockNoteReviewCommand,
} from "../review/review-command.js";
import { compactRuntimeDocument } from "./compaction.js";
import { createDocumentQueue } from "./document-queue.js";
import {
  appendDurably,
  createCheckpoint,
  reconstructRuntimeDocument,
} from "./persistence-loop.js";

const REVIEW_COMMANDS = "__blocknote_review_commands_v1";

export interface RuntimeConnection<TKey> {
  readonly id: string;
  readonly authorization: BlockNoteAuthorizationSession<TKey>;
  readonly send: (message: {
    readonly source: string;
    readonly update: Uint8Array;
    readonly revision: BlockNoteRevision;
  }) => void;
  closed: boolean;
  closePromise: Promise<void> | null;
}

function randomBinding() {
  const bytes = new Uint8Array(32);
  if (!globalThis.crypto?.getRandomValues) {
    throw new BlockNoteError(
      "incompatible-document",
      "Secure collaboration binding generation is unavailable.",
    );
  }
  globalThis.crypto.getRandomValues(bytes);
  return blockNoteDocumentBinding.fromBytes(bytes);
}

export function createDocumentRuntime<TKey, Projection>(input: {
  readonly key: TKey;
  readonly document: AnyBlockNoteDocumentDefinition;
  readonly store: BlockNoteDocumentStore<TKey>;
  readonly projection?: BlockNoteProjectionSink<TKey, Projection>;
  readonly project?: (value: {
    readonly doc: unknown;
    readonly revision: BlockNoteRevision;
  }) => Projection;
  readonly replica?: BlockNoteReplicaCoordinator<TKey>;
  readonly replicaId: string;
  readonly limits: {
    readonly queueItems: number;
    readonly queueBytes: number;
    readonly documentBytes: number;
    readonly compactAfterChanges: number;
  };
  readonly validate?: (value: {
    readonly doc: unknown;
    readonly update: Uint8Array;
    readonly action: BlockNoteMutationAction;
    readonly actorId: string;
  }) => Promise<void> | void;
}) {
  const queue = createDocumentQueue({
    maxItems: input.limits.queueItems,
    maxBytes: input.limits.queueBytes,
  });
  const connections = new Map<string, RuntimeConnection<TKey>>();
  let doc: Y.Doc | null = null;
  let revision: BlockNoteRevision | null = null;
  let lease: BlockNoteReplicaLease<TKey> | null = null;
  let changesSinceCompaction = 0;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let projectionTail = Promise.resolve();
  let projectionFailure: unknown;

  const load = async () => {
    const stored = await input.store.load(input.key);
    if (!stored) {
      const initial = Object.freeze({ sequence: 0, token: "initial" });
      const empty = new Y.Doc({ gc: false });
      const initialized = await input.store.initialize({
        key: input.key,
        binding: randomBinding(),
        checkpoint: createCheckpoint(input.document, initial, empty),
        revision: initial,
      });
      empty.destroy();
      if (initialized.status === "conflict") {
        return load();
      }
      doc = new Y.Doc({ gc: false });
      revision = initial;
      return;
    }
    const loaded = reconstructRuntimeDocument(input.document, stored);
    doc?.destroy();
    doc = loaded.doc;
    revision = loaded.revision;
  };

  const ensureLoaded = async () => {
    if (!doc || !revision) {
      await load();
    }
  };

  const ensureLease = async () => {
    if (!input.replica) {
      return;
    }
    if (lease) {
      const renewed = await input.replica.renew({
        lease,
        durationMs: 30_000,
      });
      if (renewed) {
        lease = renewed;
        return;
      }
    }
    lease = await input.replica.acquire({
      key: input.key,
      replicaId: input.replicaId,
      durationMs: 30_000,
    });
    if (!lease) {
      throw new BlockNoteError(
        "offline-unavailable",
        "BlockNote collaboration replica lease is unavailable.",
        { retryable: true },
      );
    }
  };

  const project = () => {
    if (!input.projection || !input.project || !doc || !revision) {
      return;
    }
    const commit = Object.freeze({
      key: input.key,
      revision,
      projection: input.project({ doc, revision }),
    });
    projectionTail = projectionTail.then(async () => {
      let attempt = 0;
      while (!stopped) {
        try {
          await input.projection!.commit(commit);
          projectionFailure = undefined;
          return;
        } catch (error) {
          projectionFailure = error;
          attempt += 1;
          if (attempt >= 3) {
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(1_000, attempt * 25)),
            );
          }
        }
      }
      throw projectionFailure;
    });
    void projectionTail.catch(() => undefined);
  };

  const append = async (update: Uint8Array) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await ensureLoaded();
      await ensureLease();
      const expected = revision!;
      const appended = await appendDurably({
        key: input.key,
        document: input.document,
        store: input.store,
        expected,
        update,
      });
      if (appended.result.status === "committed") {
        Y.applyUpdate(doc!, update);
        revision = appended.result.revision;
        if (lease && input.replica && !(await input.replica.publish(lease))) {
          await load();
          throw new BlockNoteError(
            "offline-unavailable",
            "BlockNote collaboration replica lease was lost.",
            { retryable: true },
          );
        }
        return revision;
      }
      await load();
    }
    throw new BlockNoteError(
      "offline-unavailable",
      "BlockNote collaboration could not reconcile a durable conflict.",
      { retryable: true },
    );
  };

  return Object.freeze({
    add(connection: RuntimeConnection<TKey>) {
      if (stopped) {
        throw new BlockNoteError(
          "offline-unavailable",
          "BlockNote collaboration runtime is stopping.",
          { retryable: true },
        );
      }
      connections.set(connection.id, connection);
    },
    remove(connectionId: string) {
      connections.delete(connectionId);
    },
    snapshot() {
      return queue.run(0, async () => {
        await ensureLoaded();
        project();
        return Object.freeze({
          update: Y.encodeStateAsUpdate(doc!),
          revision: revision!,
        });
      });
    },
    handle(
      connection: RuntimeConnection<TKey>,
      message: {
        readonly update: Uint8Array;
      },
    ) {
      if (message.update.byteLength > input.limits.documentBytes) {
        return Promise.reject(
          new BlockNoteError(
            "document-too-large",
            "BlockNote collaboration update is too large.",
          ),
        );
      }
      const update = Uint8Array.from(message.update);
      return queue.run(update.byteLength, async () => {
        if (connection.closed) {
          throw new BlockNoteError(
            "access-denied",
            "BlockNote collaboration connection is closed.",
          );
        }
        await ensureLoaded();
        const candidate = new Y.Doc({ gc: false });
        let action: BlockNoteMutationAction;
        let authoritativeUpdate: Uint8Array;
        try {
          Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc!));
          Y.applyUpdate(candidate, update);
          authoritativeUpdate = Y.encodeStateAsUpdate(
            candidate,
            Y.encodeStateVector(doc!),
          );
          if (authoritativeUpdate.byteLength <= 2) {
            return revision!;
          }
          action = classifyBlockNoteMutation(doc!, candidate);
          if (action === "review") {
            throw new BlockNoteError(
              "access-denied",
              "Native review requires an authoritative BlockNote review command.",
            );
          }
          if (action === "suggest") {
            validateBlockNoteSuggestionMutation(
              doc!,
              candidate,
              connection.authorization.actor.id,
            );
          }
          const access = await connection.authorization.getAccess(action);
          if (connection.closed || !access?.[action]) {
            throw new BlockNoteError(
              "access-denied",
              "BlockNote collaboration mutation is not authorized.",
            );
          }
          await input.validate?.({
            doc: candidate,
            update,
            action,
            actorId: connection.authorization.actor.id,
          });
          if (
            Y.encodeStateAsUpdate(candidate).byteLength >
            input.limits.documentBytes
          ) {
            throw new BlockNoteError(
              "document-too-large",
              "BlockNote collaboration document is too large.",
            );
          }
          const currentAccess =
            await connection.authorization.getAccess(action);
          if (connection.closed || !currentAccess?.[action]) {
            throw new BlockNoteError(
              "access-denied",
              "BlockNote collaboration mutation authorization changed.",
            );
          }
          authoritativeUpdate = Y.encodeStateAsUpdate(
            candidate,
            Y.encodeStateVector(doc!),
          );
        } finally {
          candidate.destroy();
        }
        const committed = await append(authoritativeUpdate!);
        for (const target of [...connections.values()]) {
          if (!target.closed) {
            target.send({
              source: connection.id,
              update: Uint8Array.from(authoritativeUpdate!),
              revision: committed,
            });
          }
        }
        changesSinceCompaction += 1;
        project();
        if (
          input.limits.compactAfterChanges > 0 &&
          changesSinceCompaction >= input.limits.compactAfterChanges
        ) {
          const compacted = await compactRuntimeDocument({
            key: input.key,
            document: input.document,
            store: input.store,
            doc: doc!,
            expected: revision!,
          });
          if (compacted.status === "committed") {
            revision = compacted.revision;
            changesSinceCompaction = 0;
          } else {
            await load();
          }
        }
        return committed;
      });
    },
    review(
      connection: RuntimeConnection<TKey>,
      rawCommand: BlockNoteReviewCommand,
      execute: BlockNoteReviewExecutor,
    ) {
      return queue.run(0, async () => {
        const command = validateBlockNoteReviewCommand(rawCommand);
        const fingerprint = JSON.stringify(command);
        await ensureLoaded();
        const receipt = doc!.get(REVIEW_COMMANDS).getAttr(command.id) as
          | { readonly fingerprint?: unknown }
          | undefined;
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) {
            throw new BlockNoteError(
              "invalid-document",
              "BlockNote review command id was reused with different intent.",
            );
          }
          return revision!;
        }
        const access = await connection.authorization.getAccess("review");
        if (connection.closed || !access?.review) {
          throw new BlockNoteError(
            "access-denied",
            "BlockNote review is not authorized.",
          );
        }
        await ensureLoaded();
        await ensureLease();
        const candidate = new Y.Doc({ gc: false });
        try {
          Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc!));
          await execute({
            doc: candidate,
            command,
            actorId: connection.authorization.actor.id,
            revision: revision!,
            fence: Object.freeze({
              token: lease?.token ?? `single-${revision!.token}`,
              sequence: lease?.fence ?? revision!.sequence,
            }),
          });
          candidate
            .get(REVIEW_COMMANDS)
            .setAttr(command.id, Object.freeze({ version: 1, fingerprint }));
          const currentAccess =
            await connection.authorization.getAccess("review");
          if (connection.closed || !currentAccess?.review) {
            throw new BlockNoteError(
              "access-denied",
              "BlockNote review authorization changed.",
            );
          }
          const update = Y.encodeStateAsUpdate(
            candidate,
            Y.encodeStateVector(doc!),
          );
          const committed = await append(update);
          for (const target of [...connections.values()]) {
            if (!target.closed) {
              target.send({
                source: connection.id,
                update: Uint8Array.from(update),
                revision: committed,
              });
            }
          }
          project();
          return committed;
        } finally {
          candidate.destroy();
        }
      });
    },
    stop() {
      if (stopPromise) {
        return stopPromise;
      }
      stopped = true;
      stopPromise = Promise.resolve().then(async () => {
        await queue.stop();
        await projectionTail.catch(() => undefined);
        if (lease && input.replica) {
          await input.replica.release(lease);
        }
        doc?.destroy();
        doc = null;
        connections.clear();
      });
      return stopPromise;
    },
    getState() {
      return {
        revision,
        queueSize: queue.size,
        connections: connections.size,
        projectionFailure,
      } as const;
    },
  });
}
