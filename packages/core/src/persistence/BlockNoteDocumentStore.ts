import type { BlockNoteDocumentBinding } from "./BlockNoteDocumentBinding.js";
import type {
  BlockNoteChange,
  BlockNoteCheckpoint,
  BlockNoteRevision,
} from "./BlockNotePersistence.js";

export type BlockNoteCommitResult =
  | { readonly status: "committed"; readonly revision: BlockNoteRevision }
  | { readonly status: "conflict"; readonly actual: BlockNoteRevision };

export interface BlockNoteStoredChange {
  readonly revision: BlockNoteRevision;
  readonly change: BlockNoteChange;
}

export interface BlockNoteStoredDocument {
  readonly binding: BlockNoteDocumentBinding;
  readonly checkpoint: BlockNoteCheckpoint;
  readonly checkpointRevision: BlockNoteRevision;
  readonly changes: readonly BlockNoteStoredChange[];
}

export interface BlockNoteInitializeInput<TKey> {
  readonly key: TKey;
  readonly binding: BlockNoteDocumentBinding;
  readonly checkpoint: BlockNoteCheckpoint;
  readonly revision: BlockNoteRevision;
}

export interface BlockNoteAppendInput<TKey> {
  readonly key: TKey;
  readonly expected: BlockNoteRevision;
  readonly change: BlockNoteChange;
  readonly next: BlockNoteRevision;
}

export interface BlockNoteCompactInput<TKey> {
  readonly key: TKey;
  readonly expected: BlockNoteRevision;
  readonly checkpoint: BlockNoteCheckpoint;
  readonly next: BlockNoteRevision;
}

export interface BlockNoteDocumentStore<TKey> {
  load(key: TKey): Promise<BlockNoteStoredDocument | null>;
  initialize(
    input: BlockNoteInitializeInput<TKey>,
  ): Promise<BlockNoteCommitResult>;
  append(input: BlockNoteAppendInput<TKey>): Promise<BlockNoteCommitResult>;
  compact(input: BlockNoteCompactInput<TKey>): Promise<BlockNoteCommitResult>;
}
