import { BlockNoteError } from "@blocknote/core";

import type { BlockNoteRecoverySummary } from "../session-types.js";
import {
  nextCacheRecord,
  type BlockNoteRecoveryRecord,
} from "./cache-manifest.js";
import type { BlockNoteRecoveryStore } from "./recovery-store.js";

export interface BlockNoteRecoveryDocument {
  apply(bytes: Uint8Array): void;
  snapshot(): Uint8Array;
  subscribe(listener: () => void): () => void;
}

export function createRecoveryController(input: {
  readonly key: string;
  readonly generation: number;
  readonly store: BlockNoteRecoveryStore;
  readonly document: BlockNoteRecoveryDocument;
  readonly now?: () => Date;
  readonly durability: (
    value: "saved" | "pending" | "offline" | "error",
  ) => void;
  readonly recoveryAvailable: (summary: BlockNoteRecoverySummary) => void;
}) {
  const now = input.now ?? (() => new Date());
  let activeRevision: number | null = null;
  let recovery: BlockNoteRecoveryRecord | null = null;
  let latestPending: Uint8Array | null = null;
  let queue = Promise.resolve();
  let writeError: unknown;
  let stopDocument: (() => void) | null = null;
  let destroyed = false;
  let destroyPromise: Promise<void> | null = null;

  const summary = (record: BlockNoteRecoveryRecord) =>
    Object.freeze({
      createdAt: new Date(record.updatedAt),
      byteLength: record.bytes.byteLength,
    });

  const archivePending = async (reason: BlockNoteRecoveryRecord["reason"]) => {
    if (!latestPending) {
      return;
    }
    const record = nextCacheRecord({
      key: input.key,
      generation: input.generation,
      previousRevision: activeRevision ?? undefined,
      bytes: latestPending,
      now: now().getTime(),
    });
    const archived = Object.freeze({ ...record, reason });
    await input.store.archive(archived);
    recovery = archived;
    input.recoveryAvailable(summary(archived));
  };

  const persist = (bytes: Uint8Array) => {
    latestPending = Uint8Array.from(bytes);
    input.durability("pending");
    writeError = undefined;
    queue = queue
      .then(async () => {
        if (destroyed || !latestPending) {
          return;
        }
        const pending = latestPending;
        const candidate = nextCacheRecord({
          key: input.key,
          generation: input.generation,
          previousRevision: activeRevision ?? undefined,
          bytes: pending,
          now: now().getTime(),
        });
        const committed = await input.store.compareAndSetActive(
          candidate,
          activeRevision,
        );
        if (!committed) {
          const current = await input.store.loadActive(input.key);
          activeRevision = current?.revision ?? null;
          throw new BlockNoteError(
            "offline-unavailable",
            "BlockNote offline cache changed in another tab.",
            { retryable: true },
          );
        }
        activeRevision = candidate.revision;
        if (latestPending === pending) {
          latestPending = null;
          input.durability("saved");
        }
        writeError = undefined;
      })
      .catch(async (cause) => {
        writeError = cause;
        input.durability("error");
        await archivePending("write-error").catch(() => undefined);
      });
  };

  return Object.freeze({
    async start() {
      try {
        const active = await input.store.loadActive(input.key);
        if (active) {
          activeRevision = active.revision;
          input.document.apply(Uint8Array.from(active.bytes));
        }
        recovery = await input.store.loadRecovery(input.key);
        if (recovery) {
          input.recoveryAvailable(summary(recovery));
        }
      } catch {
        input.durability("error");
      }
      stopDocument = input.document.subscribe(() =>
        persist(input.document.snapshot()),
      );
    },
    async applyRecovery() {
      const current = recovery ?? (await input.store.loadRecovery(input.key));
      if (!current || current.generation !== input.generation) {
        throw new BlockNoteError(
          "offline-unavailable",
          "BlockNote recovery is not available for this session.",
          { retryable: true },
        );
      }
      const claimed = await input.store.deleteRecovery(
        input.key,
        current.generation,
      );
      if (!claimed) {
        recovery = null;
        throw new BlockNoteError(
          "offline-unavailable",
          "BlockNote recovery was already handled in another session.",
          { retryable: true },
        );
      }
      input.document.apply(Uint8Array.from(current.bytes));
      persist(input.document.snapshot());
      await queue;
      if (writeError) {
        await input.store.archive(current);
        throw writeError;
      }
      recovery = null;
      return summary(current);
    },
    async discardRecovery() {
      const current = recovery ?? (await input.store.loadRecovery(input.key));
      if (!current) {
        return null;
      }
      const discarded = await input.store.deleteRecovery(
        input.key,
        current.generation,
      );
      recovery = null;
      return discarded ? summary(current) : null;
    },
    destroy() {
      if (destroyPromise) {
        return destroyPromise;
      }
      destroyPromise = Promise.resolve().then(async () => {
        stopDocument?.();
        stopDocument = null;
        await queue;
        if (latestPending) {
          await archivePending("pending");
        }
        destroyed = true;
        await input.store.close();
      });
      return destroyPromise;
    },
  });
}
