/** @vitest-environment node */
import type {
  BlockNoteChange,
  BlockNoteCheckpoint,
  BlockNoteDocumentBinding,
  BlockNoteDocumentStore,
  BlockNoteAccess,
  BlockNoteRevision,
  BlockNoteStoredDocument,
} from "@blocknote/core";
import type {
  BlockNoteAuthorizationProvider,
  BlockNoteProjectionSink,
  BlockNoteReplicaCoordinator,
} from "@blocknote/collaboration-server";
import { describe, expect, it } from "vite-plus/test";

import { getAuthorizationContractCases } from "./authorization.js";
import type { BlockNoteAuthorizationContractFixture } from "./authorization.js";
import { getDocumentStoreContractCases } from "./document-store.js";
import { getProjectionSinkContractCases } from "./projection-sink.js";
import { getReplicaCoordinatorContractCases } from "./replica-coordinator.js";
import { getSessionLifecycleContractCases } from "./session-lifecycle.js";
import { createBlockNoteTestClock } from "../testing/fake-clock.js";

type FixtureValue = Readonly<{ id: string }>;

const opaque = <Value>(id: string) => Object.freeze({ id }) as unknown as Value;
const cloneRevision = (value: BlockNoteRevision) => Object.freeze({ ...value });

function cloneDocument(
  value: BlockNoteStoredDocument,
): BlockNoteStoredDocument {
  return Object.freeze({
    binding: opaque<BlockNoteDocumentBinding>(
      (value.binding as unknown as FixtureValue).id,
    ),
    checkpoint: opaque<BlockNoteCheckpoint>(
      (value.checkpoint as unknown as FixtureValue).id,
    ),
    checkpointRevision: cloneRevision(value.checkpointRevision),
    changes: Object.freeze(
      value.changes.map((entry) =>
        Object.freeze({
          revision: cloneRevision(entry.revision),
          change: opaque<BlockNoteChange>(
            (entry.change as unknown as FixtureValue).id,
          ),
        }),
      ),
    ),
  });
}

function createReferenceStore(
  options: {
    readonly alias?: boolean;
    readonly throwConflicts?: boolean;
  } = {},
) {
  const documents = new Map<string, BlockNoteStoredDocument>();
  const head = (value: BlockNoteStoredDocument) =>
    value.changes.at(-1)?.revision ?? value.checkpointRevision;
  const same = (left: BlockNoteRevision, right: BlockNoteRevision) =>
    left.sequence === right.sequence && left.token === right.token;
  const copy = (value: BlockNoteStoredDocument) =>
    options.alias ? value : cloneDocument(value);
  const store: BlockNoteDocumentStore<string> = {
    async load(key) {
      const value = documents.get(key);
      return value ? copy(value) : null;
    },
    async initialize(input) {
      const current = documents.get(input.key);
      if (current) {
        const actual = head(current);
        if (!same(actual, input.revision) && options.throwConflicts) {
          throw new Error("conflict");
        }
        return same(actual, input.revision)
          ? { status: "committed", revision: cloneRevision(actual) }
          : { status: "conflict", actual: cloneRevision(actual) };
      }
      documents.set(
        input.key,
        copy({
          binding: input.binding,
          checkpoint: input.checkpoint,
          checkpointRevision: input.revision,
          changes: [],
        }),
      );
      return { status: "committed", revision: cloneRevision(input.revision) };
    },
    async append(input) {
      const current = documents.get(input.key)!;
      const actual = head(current);
      if (!same(actual, input.expected)) {
        if (!same(actual, input.next) && options.throwConflicts) {
          throw new Error("conflict");
        }
        return same(actual, input.next)
          ? { status: "committed", revision: cloneRevision(actual) }
          : { status: "conflict", actual: cloneRevision(actual) };
      }
      const next = copy({
        ...current,
        changes: [
          ...current.changes,
          { revision: input.next, change: input.change },
        ],
      });
      documents.set(input.key, next);
      return { status: "committed", revision: cloneRevision(input.next) };
    },
    async compact(input) {
      const current = documents.get(input.key)!;
      const actual = head(current);
      if (!same(actual, input.expected)) {
        if (!same(actual, input.next) && options.throwConflicts) {
          throw new Error("conflict");
        }
        return same(actual, input.next)
          ? { status: "committed", revision: cloneRevision(actual) }
          : { status: "conflict", actual: cloneRevision(actual) };
      }
      documents.set(
        input.key,
        copy({
          binding: current.binding,
          checkpoint: input.checkpoint,
          checkpointRevision: input.next,
          changes: [],
        }),
      );
      return { status: "committed", revision: cloneRevision(input.next) };
    },
  };
  return store;
}

const documentStoreOptions = (
  options: { readonly alias?: boolean; readonly throwConflicts?: boolean } = {},
) => ({
  create: async () => createReferenceStore(options),
  key: (name: string) => name,
  binding: (name: string) => opaque<BlockNoteDocumentBinding>(name),
  checkpoint: (name: string) => opaque<BlockNoteCheckpoint>(name),
  change: (name: string) => opaque<BlockNoteChange>(name),
  serializeBinding: (value: BlockNoteDocumentBinding) =>
    (value as unknown as FixtureValue).id,
  serializeCheckpoint: (value: BlockNoteCheckpoint) =>
    (value as unknown as FixtureValue).id,
  serializeChange: (value: BlockNoteChange) =>
    (value as unknown as FixtureValue).id,
});

async function expectCasesPass(
  cases: readonly Readonly<{ name: string; run(): Promise<void> }>[],
) {
  for (const contractCase of cases) {
    await contractCase.run();
  }
}

async function expectInvariantFailure(
  cases: readonly Readonly<{ name: string; run(): Promise<void> }>[],
  invariant: string,
) {
  const contractCase = cases.find((value) => value.name === invariant)!;
  await expect(contractCase.run()).rejects.toThrow(
    `[BlockNote contract: ${invariant}]`,
  );
}

describe("public adapter contracts", () => {
  it("accepts a conforming document store", async () => {
    await expectCasesPass(
      getDocumentStoreContractCases(documentStoreOptions()),
    );
  });

  it("names mutable-byte-defense failures", async () => {
    await expectInvariantFailure(
      getDocumentStoreContractCases(documentStoreOptions({ alias: true })),
      "mutable-byte-defense",
    );
  });

  it("names thrown conflict failures", async () => {
    await expectInvariantFailure(
      getDocumentStoreContractCases(
        documentStoreOptions({ throwConflicts: true }),
      ),
      "expected-revision",
    );
  });

  it("covers authorization revocation and close races", async () => {
    let cacheAccess = false;
    let duplicateClose = false;
    const options = {
      key: (name: string) => name,
      create: async (
        fixture: BlockNoteAuthorizationContractFixture<string>,
      ) => {
        let cached: BlockNoteAccess | null | undefined;
        let closePromise: Promise<void> | null = null;
        const provider: BlockNoteAuthorizationProvider<string> = {
          async open() {
            if (!fixture.canConnect()) {
              return null;
            }
            return {
              documentKey: fixture.key,
              actor: { id: fixture.actorId },
              async getAccess(action) {
                cached ??= fixture.getAccess(action);
                return cacheAccess ? cached : fixture.getAccess(action);
              },
              async close() {
                if (duplicateClose) {
                  await fixture.onClose();
                  await fixture.onClose();
                  return;
                }
                closePromise ??= fixture.onClose();
                await closePromise;
              },
            };
          },
        };
        return provider;
      },
    };
    await expectCasesPass(getAuthorizationContractCases(options));
    cacheAccess = true;
    await expectInvariantFailure(
      getAuthorizationContractCases(options),
      "per-action-revocation",
    );
    cacheAccess = false;
    duplicateClose = true;
    await expectInvariantFailure(
      getAuthorizationContractCases(options),
      "exactly-once-close",
    );
  });

  it("covers projection retries and partial failure", async () => {
    let loseRetry = false;
    const options = {
      key: (name: string) => name,
      create: async () => {
        const values = new Map<string, unknown>();
        let failAfterWrite = false;
        let attempts = 0;
        const sink: BlockNoteProjectionSink<string, { value: number }> = {
          async commit(input) {
            attempts += 1;
            const id = `${input.key}:${input.revision.sequence}:${input.revision.token}`;
            if (!(loseRetry && values.has(id))) {
              values.set(id, structuredClone(input.projection));
            } else {
              values.delete(id);
            }
            if (failAfterWrite) {
              failAfterWrite = false;
              throw new Error("injected partial failure");
            }
          },
        };
        return {
          sink,
          failNextAfterWrite() {
            failAfterWrite = true;
          },
          read(key: string, value: BlockNoteRevision) {
            return values.get(`${key}:${value.sequence}:${value.token}`);
          },
          attempts: () => attempts,
        };
      },
    };
    await expectCasesPass(getProjectionSinkContractCases(options));
    loseRetry = true;
    await expectInvariantFailure(
      getProjectionSinkContractCases(options),
      "idempotent-retry",
    );
  });

  it("covers replica fencing, invalidation, and unsubscription", async () => {
    let staleFence = false;
    let leakSubscription = false;
    const clock = createBlockNoteTestClock();
    const options = {
      key: (name: string) => name,
      clock,
      create: async () => {
        const leases = new Map<
          string,
          Readonly<{
            key: string;
            token: string;
            fence: number;
            expiresAt: Date;
            replicaId: string;
          }>
        >();
        const listeners = new Set<
          (value: { key: string; fence: number }) => void
        >();
        let sequence = 0;
        const valid = (lease: {
          key: string;
          token: string;
          fence: number;
        }) => {
          const current = leases.get(lease.key);
          return (
            !!current &&
            (staleFence ||
              (current.token === lease.token && current.fence === lease.fence))
          );
        };
        const replica: BlockNoteReplicaCoordinator<string> = {
          async locate(key) {
            const current = leases.get(key);
            return current && current.expiresAt > clock.now()
              ? current.replicaId
              : null;
          },
          async acquire({ key, replicaId, durationMs }) {
            const current = leases.get(key);
            if (current && current.expiresAt > clock.now()) {
              return null;
            }
            const lease = Object.freeze({
              key,
              replicaId,
              token: `lease-${++sequence}`,
              fence: (current?.fence ?? 0) + 1,
              expiresAt: new Date(clock.now().getTime() + durationMs),
            });
            leases.set(key, lease);
            return lease;
          },
          async renew({ lease, durationMs }) {
            if (!valid(lease)) {
              return null;
            }
            const current = leases.get(lease.key)!;
            const renewed = Object.freeze({
              ...current,
              expiresAt: new Date(clock.now().getTime() + durationMs),
            });
            leases.set(lease.key, renewed);
            return renewed;
          },
          async release(lease) {
            if (valid(lease)) {
              leases.delete(lease.key);
            }
          },
          async publish(lease) {
            if (!valid(lease)) {
              return false;
            }
            for (const listener of listeners) {
              listener({ key: lease.key, fence: lease.fence });
            }
            return true;
          },
          subscribe(listener) {
            listeners.add(listener);
            return () => {
              if (!leakSubscription) {
                listeners.delete(listener);
              }
            };
          },
        };
        return replica;
      },
    };
    await expectCasesPass(getReplicaCoordinatorContractCases(options));
    staleFence = true;
    await expectInvariantFailure(
      getReplicaCoordinatorContractCases(options),
      "stale-lease-fence",
    );
    staleFence = false;
    leakSubscription = true;
    await expectInvariantFailure(
      getReplicaCoordinatorContractCases(options),
      "subscription-cleanup",
    );
  });

  it("covers startup cancellation and repeated disposal", async () => {
    let ignoreCancellation = false;
    let duplicateDisposal = false;
    const options = {
      create: async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let disposals = 0;
        let destroyPromise: Promise<void> | null = null;
        const session = {
          async destroy() {
            if (duplicateDisposal) {
              disposals += 2;
              return;
            }
            destroyPromise ??= Promise.resolve().then(() => {
              disposals += 1;
            });
            await destroyPromise;
          },
        };
        return {
          async start(signal: AbortSignal) {
            await gate;
            if (signal.aborted && !ignoreCancellation) {
              await session.destroy();
              throw new DOMException("Aborted", "AbortError");
            }
            return session;
          },
          releaseStartup: release,
          disposalCount: () => disposals,
        };
      },
    };
    await expectCasesPass(getSessionLifecycleContractCases(options));
    ignoreCancellation = true;
    await expectInvariantFailure(
      getSessionLifecycleContractCases(options),
      "startup-cancellation",
    );
    ignoreCancellation = false;
    duplicateDisposal = true;
    await expectInvariantFailure(
      getSessionLifecycleContractCases(options),
      "repeated-disposal",
    );
  });
});
