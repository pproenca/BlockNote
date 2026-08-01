import { BlockNoteError } from "../platform/BlockNoteError.js";
import {
  BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES,
  BLOCK_NOTE_PERSISTENCE_MAX_FRAME_BYTES,
  BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES,
  decodeBlockNotePersistenceFrameData,
  encodeBlockNotePersistenceFrameData,
  type BlockNotePersistenceFrameFailure,
  type BlockNotePersistenceFrameKind,
  persistenceFramePayload,
} from "./BlockNotePersistenceFrameData.js";

export {
  BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES,
  BLOCK_NOTE_PERSISTENCE_MAX_FRAME_BYTES,
  BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES,
};
export type { BlockNotePersistenceFrameFailure, BlockNotePersistenceFrameKind };

export function throwBlockNotePersistenceFrameFailure(
  failure: BlockNotePersistenceFrameFailure,
): never {
  throw new BlockNoteError(failure.code, failure.message);
}

export function encodeBlockNotePersistenceFrame(
  kind: BlockNotePersistenceFrameKind,
  value: Uint8Array,
) {
  const encoded = encodeBlockNotePersistenceFrameData(kind, value);
  if (!encoded.ok) {
    throwBlockNotePersistenceFrameFailure(encoded.failure);
  }
  return encoded.value;
}

export function decodeBlockNotePersistenceFrame(
  value: Uint8Array,
  expectedKind: BlockNotePersistenceFrameKind,
) {
  const decoded = decodeBlockNotePersistenceFrameData(value, expectedKind);
  if (!decoded.ok) {
    throwBlockNotePersistenceFrameFailure(decoded.failure);
  }
  return {
    frame: decoded.value,
    payload: persistenceFramePayload(decoded.value),
  };
}
