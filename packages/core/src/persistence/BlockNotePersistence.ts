import { BlockNoteError } from "../platform/BlockNoteError.js";
import {
  decodeBlockNotePersistenceFrame,
  type BlockNotePersistenceFrameKind,
} from "./BlockNotePersistenceFrame.js";

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

interface StoredFrame {
  readonly kind: BlockNotePersistenceFrameKind;
  readonly bytes: Uint8Array;
}

const storedFrames = new WeakMap<BlockNotePersistenceValue, StoredFrame>();

function createCheckpoint(frame: Uint8Array) {
  const value = Object.freeze({
    kind: "blocknote-checkpoint" as const,
    byteLength: frame.byteLength,
  }) as BlockNoteCheckpoint;
  storedFrames.set(value, { kind: "checkpoint", bytes: frame });
  return value;
}

function createChange(frame: Uint8Array) {
  const value = Object.freeze({
    kind: "blocknote-change" as const,
    byteLength: frame.byteLength,
  }) as BlockNoteChange;
  storedFrames.set(value, { kind: "change", bytes: frame });
  return value;
}

function valueToBytes(
  value: BlockNotePersistenceValue,
  expectedKind: BlockNotePersistenceFrameKind,
) {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote persistence value is invalid.",
    );
  }

  const stored = storedFrames.get(value);
  if (!stored) {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote persistence value is invalid.",
    );
  }
  if (stored.kind !== expectedKind) {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote persistence value has the wrong kind.",
    );
  }

  return new Uint8Array(stored.bytes);
}

export const blockNotePersistence: BlockNotePersistence = Object.freeze({
  checkpointToBytes(value: BlockNoteCheckpoint) {
    return valueToBytes(value, "checkpoint");
  },
  checkpointFromBytes(value: Uint8Array) {
    const { frame } = decodeBlockNotePersistenceFrame(value, "checkpoint");
    return createCheckpoint(frame);
  },
  changeToBytes(value: BlockNoteChange) {
    return valueToBytes(value, "change");
  },
  changeFromBytes(value: Uint8Array) {
    const { frame } = decodeBlockNotePersistenceFrame(value, "change");
    return createChange(frame);
  },
});
