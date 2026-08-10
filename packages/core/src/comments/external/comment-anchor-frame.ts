import { BlockNoteError } from "../../platform/BlockNoteError.js";

export const BLOCK_NOTE_COMMENT_ANCHOR_MAX_FRAME_BYTES = 1024 * 1024;
export const BLOCK_NOTE_COMMENT_ANCHOR_MAX_POSITION_BYTES = 524_000;
export const BLOCK_NOTE_COMMENT_ANCHOR_MAX_BUNDLE_BYTES = 16 * 1024;

const CAPTURE_MAGIC = Uint8Array.of(66, 78, 67, 85);
const ANCHOR_MAGIC = Uint8Array.of(66, 78, 67, 65);
const VERIFICATION_MAGIC = Uint8Array.of(66, 78, 67, 86);
const VERSION = 1;
const SIGNATURE_BYTES = 64;
const PUBLIC_KEY_BYTES = 32;
const DOCUMENT_BINDING_BYTES = 32;
const MAX_KEY_ID_BYTES = 64;
const MAX_KEYS = 64;
const SIGNATURE_DOMAIN = new TextEncoder().encode(
  "@blocknote/comment-anchor/v1\0",
);
const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function invalidAnchor(message: string): never {
  throw new BlockNoteError("invalid-anchor", message);
}

function copyBytes(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (!(value instanceof Uint8Array)) {
    invalidAnchor("BlockNote comment anchor bytes must be a Uint8Array.");
  }
  if (value.byteLength > maximum) {
    invalidAnchor("BlockNote comment anchor bytes exceed the allowed size.");
  }
  return Uint8Array.from(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function concatBytes(parts: readonly Uint8Array[]) {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function u16(value: number) {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number) {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function u64(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidAnchor("BlockNote verification revision is invalid.");
  }
  const high = Math.floor(value / 0x100000000);
  const low = value - high * 0x100000000;
  return concatBytes([u32(high), u32(low)]);
}

class Reader {
  public offset = 0;

  constructor(public readonly bytes: Uint8Array) {}

  read(length: number) {
    if (!Number.isSafeInteger(length) || length < 0) {
      invalidAnchor("BlockNote comment anchor length is invalid.");
    }
    const end = this.offset + length;
    if (!Number.isSafeInteger(end) || end > this.bytes.byteLength) {
      invalidAnchor("BlockNote comment anchor frame is truncated.");
    }
    const value = this.bytes.slice(this.offset, end);
    this.offset = end;
    return value;
  }

  readU8() {
    return this.read(1)[0]!;
  }

  readU16() {
    const value = this.read(2);
    return value[0]! * 0x100 + value[1]!;
  }

  readU32() {
    const value = this.read(4);
    return (
      value[0]! * 0x1000000 +
      value[1]! * 0x10000 +
      value[2]! * 0x100 +
      value[3]!
    );
  }

  readU64() {
    const high = this.readU32();
    const low = this.readU32();
    const value = high * 0x100000000 + low;
    if (!Number.isSafeInteger(value)) {
      invalidAnchor("BlockNote verification revision is invalid.");
    }
    return value;
  }

  finish() {
    if (this.offset !== this.bytes.byteLength) {
      invalidAnchor("BlockNote comment anchor frame has trailing bytes.");
    }
  }
}

function expectMagic(reader: Reader, expected: Uint8Array) {
  if (!equalBytes(reader.read(expected.byteLength), expected)) {
    invalidAnchor("BlockNote comment anchor frame has invalid framing.");
  }
  if (reader.readU8() !== VERSION) {
    invalidAnchor("BlockNote comment anchor frame version is incompatible.");
  }
}

function encodeVarUint(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidAnchor("BlockNote relative position is invalid.");
  }
  const result: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    result.push(byte | (value > 0 ? 0x80 : 0));
  } while (value > 0);
  return Uint8Array.from(result);
}

function encodeVarInt(value: number) {
  if (!Number.isSafeInteger(value)) {
    invalidAnchor("BlockNote relative position is invalid.");
  }
  const negative = value < 0 || Object.is(value, -0);
  let remaining = Math.abs(value);
  const first =
    (remaining > 0x3f ? 0x80 : 0) | (negative ? 0x40 : 0) | (remaining & 0x3f);
  const result = [first];
  remaining = Math.floor(remaining / 64);
  while (remaining > 0) {
    result.push((remaining > 0x7f ? 0x80 : 0) | (remaining & 0x7f));
    remaining = Math.floor(remaining / 128);
  }
  return Uint8Array.from(result);
}

function readVarUint(reader: Reader) {
  let value = 0;
  let multiplier = 1;
  const start = reader.offset;
  for (;;) {
    const byte = reader.readU8();
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) {
      invalidAnchor("BlockNote relative position is invalid.");
    }
    if ((byte & 0x80) === 0) {
      break;
    }
    multiplier *= 128;
    if (!Number.isSafeInteger(multiplier)) {
      invalidAnchor("BlockNote relative position is invalid.");
    }
  }
  if (
    !equalBytes(reader.bytes.slice(start, reader.offset), encodeVarUint(value))
  ) {
    invalidAnchor("BlockNote relative position is non-canonical.");
  }
  return value;
}

function readVarInt(reader: Reader) {
  const start = reader.offset;
  const first = reader.readU8();
  const negative = (first & 0x40) !== 0;
  let value = first & 0x3f;
  let multiplier = 64;
  let byte = first;
  while ((byte & 0x80) !== 0) {
    byte = reader.readU8();
    value += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(multiplier)) {
      invalidAnchor("BlockNote relative position is invalid.");
    }
  }
  const signed = negative ? -value : value;
  if (
    !equalBytes(reader.bytes.slice(start, reader.offset), encodeVarInt(signed))
  ) {
    invalidAnchor("BlockNote relative position is non-canonical.");
  }
  return signed;
}

function validateRelativePosition(value: unknown) {
  const bytes = copyBytes(value, BLOCK_NOTE_COMMENT_ANCHOR_MAX_POSITION_BYTES);
  if (bytes.byteLength === 0) {
    invalidAnchor("BlockNote relative position is empty.");
  }
  const reader = new Reader(bytes);
  if (readVarUint(reader) !== 0) {
    invalidAnchor("BlockNote relative position has no item provenance.");
  }
  readVarUint(reader);
  readVarUint(reader);
  readVarInt(reader);
  reader.finish();
  return bytes;
}

function ascii(value: string) {
  if (typeof value !== "string" || value.length === 0) {
    invalidAnchor("BlockNote comment anchor key id is invalid.");
  }
  const bytes = textEncoder.encode(value);
  if (
    bytes.byteLength > MAX_KEY_ID_BYTES ||
    bytes.some((byte) => byte < 0x21 || byte > 0x7e)
  ) {
    invalidAnchor("BlockNote comment anchor key id is invalid.");
  }
  return bytes;
}

function decodeAscii(bytes: Uint8Array) {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_KEY_ID_BYTES ||
    bytes.some((byte) => byte < 0x21 || byte > 0x7e)
  ) {
    invalidAnchor("BlockNote comment anchor key id is invalid.");
  }
  return String.fromCharCode(...bytes);
}

function fingerprint(value: string) {
  if (typeof value !== "string") {
    invalidAnchor("BlockNote document definition fingerprint is invalid.");
  }
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength === 0 || bytes.byteLength > 255) {
    invalidAnchor("BlockNote document definition fingerprint is invalid.");
  }
  return bytes;
}

function decodeFingerprint(bytes: Uint8Array) {
  if (bytes.byteLength === 0 || bytes.byteLength > 255) {
    invalidAnchor("BlockNote document definition fingerprint is invalid.");
  }
  try {
    const value = textDecoder.decode(bytes);
    if (!equalBytes(textEncoder.encode(value), bytes)) {
      invalidAnchor("BlockNote document definition fingerprint is invalid.");
    }
    return value;
  } catch {
    invalidAnchor("BlockNote document definition fingerprint is invalid.");
  }
}

export function encodeBase64Url(value: Uint8Array) {
  const bytes = copyBytes(value);
  let result = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += BASE64URL[first >>> 2];
    result += BASE64URL[((first & 3) << 4) | ((second ?? 0) >>> 4)];
    if (second !== undefined) {
      result += BASE64URL[((second & 15) << 2) | ((third ?? 0) >>> 6)];
    }
    if (third !== undefined) {
      result += BASE64URL[third & 63];
    }
  }
  return result;
}

export function decodeBase64Url(value: string, maximum: number) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    Math.floor((value.length * 3) / 4) > maximum
  ) {
    invalidAnchor("BlockNote comment anchor encoding is invalid.");
  }
  const output: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const remaining = value.length - index;
    const a = BASE64URL.indexOf(value[index]!);
    const b = BASE64URL.indexOf(value[index + 1]!);
    const c = remaining > 2 ? BASE64URL.indexOf(value[index + 2]!) : 0;
    const d = remaining > 3 ? BASE64URL.indexOf(value[index + 3]!) : 0;
    output.push((a << 2) | (b >>> 4));
    if (remaining > 2) {
      output.push(((b & 15) << 4) | (c >>> 2));
    }
    if (remaining > 3) {
      output.push(((c & 3) << 6) | d);
    }
  }
  const bytes = Uint8Array.from(output);
  if (bytes.byteLength > maximum || encodeBase64Url(bytes) !== value) {
    invalidAnchor("BlockNote comment anchor encoding is non-canonical.");
  }
  return bytes;
}

export function encodeCaptureFrame(input: {
  readonly from: Uint8Array;
  readonly to: Uint8Array;
}) {
  const from = validateRelativePosition(input.from);
  const to = validateRelativePosition(input.to);
  const frame = concatBytes([
    CAPTURE_MAGIC,
    Uint8Array.of(VERSION),
    u32(from.byteLength),
    from,
    u32(to.byteLength),
    to,
  ]);
  return copyBytes(frame, BLOCK_NOTE_COMMENT_ANCHOR_MAX_FRAME_BYTES);
}

export function decodeCaptureFrame(value: unknown) {
  const frame = copyBytes(value, BLOCK_NOTE_COMMENT_ANCHOR_MAX_FRAME_BYTES);
  const reader = new Reader(frame);
  expectMagic(reader, CAPTURE_MAGIC);
  const from = validateRelativePosition(reader.read(reader.readU32()));
  const to = validateRelativePosition(reader.read(reader.readU32()));
  reader.finish();
  return { from, to };
}

export function encodeAnchorFrame(input: {
  readonly keyId: string;
  readonly documentBinding: Uint8Array;
  readonly definitionFingerprint: string;
  readonly from: Uint8Array;
  readonly to: Uint8Array;
  readonly signature: Uint8Array;
}) {
  const keyId = ascii(input.keyId);
  const documentBinding = copyBytes(input.documentBinding);
  if (documentBinding.byteLength !== DOCUMENT_BINDING_BYTES) {
    invalidAnchor("BlockNote document binding is invalid.");
  }
  const definitionFingerprint = fingerprint(input.definitionFingerprint);
  const from = validateRelativePosition(input.from);
  const to = validateRelativePosition(input.to);
  const signature = copyBytes(input.signature);
  if (signature.byteLength !== SIGNATURE_BYTES) {
    invalidAnchor("BlockNote comment anchor signature is invalid.");
  }
  const payload = concatBytes([
    ANCHOR_MAGIC,
    Uint8Array.of(VERSION, keyId.byteLength),
    keyId,
    documentBinding,
    u16(definitionFingerprint.byteLength),
    definitionFingerprint,
    u32(from.byteLength),
    from,
    u32(to.byteLength),
    to,
  ]);
  const frame = concatBytes([payload, signature]);
  if (frame.byteLength > BLOCK_NOTE_COMMENT_ANCHOR_MAX_FRAME_BYTES) {
    invalidAnchor("BlockNote comment anchor bytes exceed the allowed size.");
  }
  return frame;
}

export function decodeAnchorFrame(value: unknown) {
  const frame = copyBytes(value, BLOCK_NOTE_COMMENT_ANCHOR_MAX_FRAME_BYTES);
  if (frame.byteLength < SIGNATURE_BYTES) {
    invalidAnchor("BlockNote comment anchor frame is truncated.");
  }
  const payload = frame.slice(0, -SIGNATURE_BYTES);
  const signature = frame.slice(-SIGNATURE_BYTES);
  const reader = new Reader(payload);
  expectMagic(reader, ANCHOR_MAGIC);
  const keyId = decodeAscii(reader.read(reader.readU8()));
  const documentBinding = reader.read(DOCUMENT_BINDING_BYTES);
  const definitionFingerprint = decodeFingerprint(
    reader.read(reader.readU16()),
  );
  const from = validateRelativePosition(reader.read(reader.readU32()));
  const to = validateRelativePosition(reader.read(reader.readU32()));
  reader.finish();
  return {
    keyId,
    documentBinding,
    definitionFingerprint,
    from,
    to,
    payload,
    signature,
  };
}

export function signatureMessage(payload: Uint8Array) {
  return concatBytes([SIGNATURE_DOMAIN, copyBytes(payload)]);
}

export function encodeVerificationBundleFrame(input: {
  readonly revision: number;
  readonly keys: readonly {
    readonly keyId: string;
    readonly publicKey: Uint8Array;
  }[];
}) {
  if (!Array.isArray(input.keys) || input.keys.length > MAX_KEYS) {
    invalidAnchor("BlockNote verification key ring is invalid.");
  }
  const seen = new Set<string>();
  const parts: Uint8Array[] = [
    VERIFICATION_MAGIC,
    Uint8Array.of(VERSION),
    u64(input.revision),
    u16(input.keys.length),
  ];
  for (const key of input.keys) {
    const keyId = ascii(key.keyId);
    if (seen.has(key.keyId)) {
      invalidAnchor("BlockNote verification key ids must be unique.");
    }
    seen.add(key.keyId);
    const publicKey = copyBytes(key.publicKey);
    if (publicKey.byteLength !== PUBLIC_KEY_BYTES) {
      invalidAnchor("BlockNote verification public key is invalid.");
    }
    parts.push(Uint8Array.of(keyId.byteLength), keyId, publicKey);
  }
  return copyBytes(
    concatBytes(parts),
    BLOCK_NOTE_COMMENT_ANCHOR_MAX_BUNDLE_BYTES,
  );
}

export function decodeVerificationBundleFrame(value: unknown) {
  const frame = copyBytes(value, BLOCK_NOTE_COMMENT_ANCHOR_MAX_BUNDLE_BYTES);
  const reader = new Reader(frame);
  expectMagic(reader, VERIFICATION_MAGIC);
  const revision = reader.readU64();
  const keyCount = reader.readU16();
  if (keyCount > MAX_KEYS) {
    invalidAnchor("BlockNote verification key ring is invalid.");
  }
  const seen = new Set<string>();
  const keys: { keyId: string; publicKey: Uint8Array }[] = [];
  for (let index = 0; index < keyCount; index += 1) {
    const keyId = decodeAscii(reader.read(reader.readU8()));
    if (seen.has(keyId)) {
      invalidAnchor("BlockNote verification key ids must be unique.");
    }
    seen.add(keyId);
    keys.push({ keyId, publicKey: reader.read(PUBLIC_KEY_BYTES) });
  }
  reader.finish();
  return { revision, keys: Object.freeze(keys) };
}
