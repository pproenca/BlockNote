import { BlockNoteError } from "../platform/BlockNoteError.js";
import {
  type BlockNotePersistenceFrameKind,
  throwBlockNotePersistenceFrameFailure,
} from "./BlockNotePersistenceFrame.js";
import { blockNoteRuntime } from "../runtime/BlockNoteRuntime.js";

declare const blockNoteOpaque: unique symbol;

export interface BlockNoteCheckpoint {
  readonly kind: "blocknote-checkpoint";
  readonly byteLength: number;
  readonly [blockNoteOpaque]: "checkpoint";
}

export interface BlockNoteChange {
  readonly kind: "blocknote-change";
  readonly byteLength: number;
  readonly [blockNoteOpaque]: "change";
}

export interface BlockNoteRevision {
  readonly sequence: number;
  readonly token: string;
}

export type BlockNoteBootstrap = string & {
  readonly [blockNoteOpaque]: "bootstrap";
};

interface BlockNotePersistence {
  readonly checkpointToBytes: (value: BlockNoteCheckpoint) => Uint8Array;
  readonly checkpointFromBytes: (value: Uint8Array) => BlockNoteCheckpoint;
  readonly changeToBytes: (value: BlockNoteChange) => Uint8Array;
  readonly changeFromBytes: (value: Uint8Array) => BlockNoteChange;
}

type BlockNotePersistenceValue = BlockNoteCheckpoint | BlockNoteChange;
type StoredFrameKind = Exclude<BlockNotePersistenceFrameKind, "bootstrap">;

function createValue(frame: Uint8Array, kind: StoredFrameKind) {
  const created = blockNoteRuntime.createPersistenceValue(kind, frame);
  if (created.status === "rejected") {
    throwBlockNotePersistenceFrameFailure(created.failure);
  }
  return created.value as BlockNotePersistenceValue;
}

function valueToBytes(
  value: BlockNotePersistenceValue,
  expectedKind: StoredFrameKind,
) {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote persistence value is invalid.",
    );
  }

  const stored = blockNoteRuntime.readPersistenceValue(value, expectedKind);
  if (stored.status === "invalid") {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote persistence value is invalid.",
    );
  }
  if (stored.status === "wrong-kind") {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote persistence value has the wrong kind.",
    );
  }
  return stored.bytes;
}

export const blockNotePersistence: BlockNotePersistence = Object.freeze({
  checkpointToBytes(value: BlockNoteCheckpoint) {
    return valueToBytes(value, "checkpoint");
  },
  checkpointFromBytes(value: Uint8Array) {
    return createValue(value, "checkpoint") as BlockNoteCheckpoint;
  },
  changeToBytes(value: BlockNoteChange) {
    return valueToBytes(value, "change");
  },
  changeFromBytes(value: Uint8Array) {
    return createValue(value, "change") as BlockNoteChange;
  },
});
