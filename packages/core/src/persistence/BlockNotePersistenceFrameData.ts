export const BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES = 8;
export const BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const BLOCK_NOTE_PERSISTENCE_MAX_FRAME_BYTES =
  BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES +
  BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES;

const FRAME_MAGIC_0 = 0x42;
const FRAME_MAGIC_1 = 0x4e;
const FRAME_VERSION = 1;

const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const typedArrayBrand = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)!.get!;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;
const reflectApply = Reflect.apply;
const Uint8ArrayConstructor = Uint8Array;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const uint8ArraySet = Uint8Array.prototype.set;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const uint8ArraySlice = Uint8Array.prototype.slice;

export type BlockNotePersistenceFrameKind =
  | "checkpoint"
  | "change"
  | "bootstrap";

export interface BlockNotePersistenceFrameFailure {
  readonly code:
    | "document-too-large"
    | "incompatible-document"
    | "invalid-document";
  readonly message: string;
}

type BlockNotePersistenceFrameResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly failure: BlockNotePersistenceFrameFailure;
    };

function invalidFrame(message: string): BlockNotePersistenceFrameResult<never> {
  return {
    ok: false,
    failure: { code: "invalid-document", message },
  };
}

function oversizedFrame(): BlockNotePersistenceFrameResult<never> {
  return {
    ok: false,
    failure: {
      code: "document-too-large",
      message: `BlockNote persistence payload exceeds ${BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES} bytes.`,
    },
  };
}

function incompatibleFrame(): BlockNotePersistenceFrameResult<never> {
  return {
    ok: false,
    failure: {
      code: "incompatible-document",
      message: "BlockNote persistence frame version is incompatible.",
    },
  };
}

function getByteLength(
  value: unknown,
): BlockNotePersistenceFrameResult<number> {
  try {
    if (reflectApply(typedArrayBrand, value, []) !== "Uint8Array") {
      throw new TypeError();
    }
    const buffer = reflectApply(typedArrayBuffer, value, []);
    reflectApply(arrayBufferByteLength, buffer, []);
    return {
      ok: true,
      value: persistenceByteLength(value as Uint8Array),
    };
  } catch {
    return invalidFrame("BlockNote persistence bytes must be a Uint8Array.");
  }
}

export function persistenceByteLength(value: Uint8Array) {
  return reflectApply(typedArrayByteLength, value, []) as number;
}

function copyBytes(
  value: unknown,
  maximumByteLength: number,
): BlockNotePersistenceFrameResult<Uint8Array> {
  const byteLength = getByteLength(value);
  if (!byteLength.ok) {
    return byteLength;
  }
  if (byteLength.value > maximumByteLength) {
    return oversizedFrame();
  }

  try {
    const copy = new Uint8ArrayConstructor(byteLength.value);
    reflectApply(uint8ArraySet, copy, [value]);
    return { ok: true, value: copy };
  } catch {
    return invalidFrame("BlockNote persistence bytes are invalid.");
  }
}

function frameKindCode(kind: BlockNotePersistenceFrameKind) {
  switch (kind) {
    case "checkpoint":
      return 1;
    case "change":
      return 2;
    case "bootstrap":
      return 3;
  }
}

function frameKind(code: number): BlockNotePersistenceFrameKind | undefined {
  switch (code) {
    case 1:
      return "checkpoint";
    case 2:
      return "change";
    case 3:
      return "bootstrap";
    default:
      return undefined;
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

export function encodeBlockNotePersistenceFrameData(
  kind: BlockNotePersistenceFrameKind,
  value: unknown,
): BlockNotePersistenceFrameResult<Uint8Array> {
  const payload = copyBytes(value, BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES);
  if (!payload.ok) {
    return payload;
  }
  const payloadByteLength = persistenceByteLength(payload.value);

  const frame = new Uint8ArrayConstructor(
    BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES + payloadByteLength,
  );
  frame[0] = FRAME_MAGIC_0;
  frame[1] = FRAME_MAGIC_1;
  frame[2] = FRAME_VERSION;
  frame[3] = frameKindCode(kind);
  writePayloadLength(frame, payloadByteLength);
  reflectApply(uint8ArraySet, frame, [
    payload.value,
    BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES,
  ]);
  return { ok: true, value: frame };
}

export function decodeBlockNotePersistenceFrameData(
  value: unknown,
  expectedKind: BlockNotePersistenceFrameKind,
): BlockNotePersistenceFrameResult<Uint8Array> {
  const copied = copyBytes(value, BLOCK_NOTE_PERSISTENCE_MAX_FRAME_BYTES);
  if (!copied.ok) {
    return copied;
  }
  const frame = copied.value;
  const frameByteLength = persistenceByteLength(frame);

  if (frameByteLength < BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES) {
    return invalidFrame("BlockNote persistence frame is truncated.");
  }
  if (frame[0] !== FRAME_MAGIC_0 || frame[1] !== FRAME_MAGIC_1) {
    return invalidFrame("BlockNote persistence frame has invalid framing.");
  }
  if (frame[2] !== FRAME_VERSION) {
    return incompatibleFrame();
  }

  const kind = frameKind(frame[3]!);
  if (!kind) {
    return invalidFrame("BlockNote persistence frame kind is invalid.");
  }
  if (kind !== expectedKind) {
    return invalidFrame("BlockNote persistence frame has the wrong kind.");
  }

  const payloadLength = readPayloadLength(frame);
  if (payloadLength > BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES) {
    return oversizedFrame();
  }

  const expectedLength =
    BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES + payloadLength;
  if (frameByteLength < expectedLength) {
    return invalidFrame("BlockNote persistence frame is truncated.");
  }
  if (frameByteLength > expectedLength) {
    return invalidFrame("BlockNote persistence frame has trailing bytes.");
  }

  return { ok: true, value: frame };
}

export function persistenceFramePayload(frame: Uint8Array) {
  return reflectApply(uint8ArraySlice, frame, [
    BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES,
  ]) as Uint8Array;
}
