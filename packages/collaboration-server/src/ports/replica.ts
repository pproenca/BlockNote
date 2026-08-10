export interface BlockNoteReplicaLease<TKey> {
  readonly key: TKey;
  readonly token: string;
  readonly fence: number;
  readonly expiresAt: Date;
}

export interface BlockNoteReplicaCoordinator<TKey> {
  locate(key: TKey): Promise<string | null>;
  acquire(input: {
    readonly key: TKey;
    readonly replicaId: string;
    readonly durationMs: number;
  }): Promise<BlockNoteReplicaLease<TKey> | null>;
  renew(input: {
    readonly lease: BlockNoteReplicaLease<TKey>;
    readonly durationMs: number;
  }): Promise<BlockNoteReplicaLease<TKey> | null>;
  release(lease: BlockNoteReplicaLease<TKey>): Promise<void>;
  publish(lease: BlockNoteReplicaLease<TKey>): Promise<boolean>;
  subscribe(
    listener: (invalidation: {
      readonly key: TKey;
      readonly fence: number;
    }) => void,
  ): () => void;
}
