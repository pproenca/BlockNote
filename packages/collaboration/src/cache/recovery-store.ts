import {
  copyCacheRecord,
  type BlockNoteCacheRecord,
  type BlockNoteRecoveryRecord,
} from "./cache-manifest.js";

export interface BlockNoteRecoveryStore {
  loadActive(key: string): Promise<BlockNoteCacheRecord | null>;
  compareAndSetActive(
    record: BlockNoteCacheRecord,
    expectedRevision: number | null,
  ): Promise<boolean>;
  deleteActive(key: string, generation: number): Promise<boolean>;
  loadRecovery(key: string): Promise<BlockNoteRecoveryRecord | null>;
  archive(record: BlockNoteRecoveryRecord): Promise<void>;
  deleteRecovery(key: string, generation: number): Promise<boolean>;
  close(): Promise<void>;
}

export function createMemoryRecoveryStore(): BlockNoteRecoveryStore {
  const active = new Map<string, BlockNoteCacheRecord>();
  const recovery = new Map<string, BlockNoteRecoveryRecord>();
  return {
    async loadActive(key) {
      const value = active.get(key);
      return value ? copyCacheRecord(value) : null;
    },
    async compareAndSetActive(record, expectedRevision) {
      const current = active.get(record.key);
      if ((current?.revision ?? null) !== expectedRevision) {
        return false;
      }
      active.set(record.key, copyCacheRecord(record));
      return true;
    },
    async deleteActive(key, generation) {
      const current = active.get(key);
      if (!current || current.generation !== generation) return false;
      active.delete(key);
      return true;
    },
    async loadRecovery(key) {
      const value = recovery.get(key);
      return value ? copyCacheRecord(value) : null;
    },
    async archive(record) {
      const current = recovery.get(record.key);
      if (
        !current ||
        record.generation > current.generation ||
        (record.generation === current.generation &&
          record.revision >= current.revision)
      ) {
        recovery.set(record.key, copyCacheRecord(record));
      }
    },
    async deleteRecovery(key, generation) {
      const current = recovery.get(key);
      if (!current || current.generation !== generation) {
        return false;
      }
      recovery.delete(key);
      return true;
    },
    async close() {},
  };
}
