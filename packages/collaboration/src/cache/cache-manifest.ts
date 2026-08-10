export interface BlockNoteCacheRecord {
  readonly key: string;
  readonly generation: number;
  readonly revision: number;
  readonly updatedAt: number;
  readonly bytes: Uint8Array;
}

export interface BlockNoteRecoveryRecord extends BlockNoteCacheRecord {
  readonly reason: "obsolete" | "pending" | "write-error";
}

export function copyCacheRecord<T extends BlockNoteCacheRecord>(record: T): T {
  return Object.freeze({ ...record, bytes: Uint8Array.from(record.bytes) });
}

export function nextCacheRecord(input: {
  readonly key: string;
  readonly generation: number;
  readonly previousRevision?: number;
  readonly bytes: Uint8Array;
  readonly now: number;
}): BlockNoteCacheRecord {
  return copyCacheRecord({
    key: input.key,
    generation: input.generation,
    revision: (input.previousRevision ?? 0) + 1,
    updatedAt: input.now,
    bytes: input.bytes,
  });
}
