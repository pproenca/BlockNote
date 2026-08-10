import type { BlockNoteRevision } from "@blocknote/core";

export interface BlockNoteProjectionCommit<TKey, Projection> {
  readonly key: TKey;
  readonly revision: BlockNoteRevision;
  readonly projection: Projection;
}

export interface BlockNoteProjectionSink<TKey, Projection> {
  commit(input: BlockNoteProjectionCommit<TKey, Projection>): Promise<void>;
}
