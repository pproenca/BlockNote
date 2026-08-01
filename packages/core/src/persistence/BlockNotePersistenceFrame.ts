import { BlockNoteError } from "../platform/BlockNoteError.js";

export const BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES = 8;
export const BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const BLOCK_NOTE_PERSISTENCE_MAX_FRAME_BYTES =
  BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES +
  BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES;

const FRAME_MAGIC_0 = 0x42;
const FRAME_MAGIC_1 = 0x4e;
const FRAME_VERSION = 1;

const frameKindCodes = {
  checkpoint: 1,
  change: 2,
  bootstrap: 3,
} as const;

export type BlockNotePersistenceFrameKind = keyof typeof frameKindCodes;

const frameKinds = new Map<number, BlockNotePersistenceFrameKind>(
  Object.entries(frameKindCodes).map(([kind, code]) => [
    code,
    kind as BlockNotePersistenceFrameKind,
  ]),
);

function invalidFrame(message: string) {
  return new BlockNoteError("invalid-document", message);
}

function oversizedFrame() {
  return new BlockNoteError(
    "document-too-large",
    `BlockNote persistence payload exceeds ${BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES} bytes.`,
  );
}

function assertBytes(value: unknown): asserts value is Uint8Array {
  let isBytes = false;
  try {
    isBytes = value instanceof Uint8Array;
  } catch {
    // A revoked Proxy can throw while checking its prototype.
  }
  if (!isBytes) {
    throw invalidFrame("BlockNote persistence bytes must be a Uint8Array.");
  }
}

function copyBytes(value: Uint8Array) {
  try {
    return new Uint8Array(value);
  } catch {
    throw invalidFrame("BlockNote persistence bytes are invalid.");
  }
}

function readPayloadLength(frame: Uint8Array) {
  return (
    frame[4]! * 0x1000000 + frame[5]! * 0x10000 + frame[6]! * 0x100 + frame[7]!
  );
}

function writePayloadLength(frame: Uint8Array, length: number) {
  frame[4] = (length >>> 24) & 0xff;
  frame[5] = (length >>> 16) & 0xff;
  frame[6] = (length >>> 8) & 0xff;
  frame[7] = length & 0xff;
}

export function encodeBlockNotePersistenceFrame(
  kind: BlockNotePersistenceFrameKind,
  value: Uint8Array,
) {
  assertBytes(value);
  const payload = copyBytes(value);
  if (payload.byteLength > BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES) {
    throw oversizedFrame();
  }

  const frame = new Uint8Array(
    BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES + payload.byteLength,
  );
  frame[0] = FRAME_MAGIC_0;
  frame[1] = FRAME_MAGIC_1;
  frame[2] = FRAME_VERSION;
  frame[3] = frameKindCodes[kind];
  writePayloadLength(frame, payload.byteLength);
  frame.set(payload, BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeBlockNotePersistenceFrame(
  value: Uint8Array,
  expectedKind: BlockNotePersistenceFrameKind,
) {
  assertBytes(value);
  const frame = copyBytes(value);
  if (frame.byteLength > BLOCK_NOTE_PERSISTENCE_MAX_FRAME_BYTES) {
    throw oversizedFrame();
  }
  if (frame.byteLength < BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES) {
    throw invalidFrame("BlockNote persistence frame is truncated.");
  }
  if (frame[0] !== FRAME_MAGIC_0 || frame[1] !== FRAME_MAGIC_1) {
    throw invalidFrame("BlockNote persistence frame has invalid framing.");
  }
  if (frame[2] !== FRAME_VERSION) {
    throw new BlockNoteError(
      "incompatible-document",
      "BlockNote persistence frame version is incompatible.",
    );
  }

  const kind = frameKinds.get(frame[3]!);
  if (!kind) {
    throw invalidFrame("BlockNote persistence frame kind is invalid.");
  }
  if (kind !== expectedKind) {
    throw invalidFrame("BlockNote persistence frame has the wrong kind.");
  }

  const payloadLength = readPayloadLength(frame);
  if (payloadLength > BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES) {
    throw oversizedFrame();
  }

  const expectedLength =
    BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES + payloadLength;
  if (frame.byteLength < expectedLength) {
    throw invalidFrame("BlockNote persistence frame is truncated.");
  }
  if (frame.byteLength > expectedLength) {
    throw invalidFrame("BlockNote persistence frame has trailing bytes.");
  }

  return {
    frame,
    payload: frame.slice(BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES),
  };
}
