import type {
  AnyBlockNoteDocumentDefinition,
  BlockNoteDocumentBinding,
  BlockNoteRevision,
  BlockNoteStoredDocument,
} from "@blocknote/core";
import {
  BlockNoteError,
  blockNoteDocumentBinding,
} from "@blocknote/core/persistence";
import { blockNotePersistenceInternals } from "@blocknote/core/persistence/internal";
import { getBlockNoteDocumentInternals } from "@blocknote/core/runtime";
import * as Y from "@y/y";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const HEADLESS_MAGIC = Uint8Array.of(66, 78, 72, 68);
const HEADLESS_VERSION = 1;
const MAX_IDENTITY_BYTES = 4_096;
const MAX_TOKEN_BYTES = 512;

type HeadlessFrameKind = "checkpoint" | "change";

export interface ReconstructedBlockNoteDocument {
  readonly doc: { destroy(): void };
  readonly content: unknown;
  readonly binding: BlockNoteDocumentBinding;
  readonly definitionFingerprint: string;
  readonly revision: BlockNoteRevision;
}

function invalidDocument(message: string, cause?: unknown): never {
  throw new BlockNoteError("invalid-document", message, { cause });
}

function incompatibleDocument(message: string): never {
  throw new BlockNoteError("incompatible-document", message);
}

function concat(parts: readonly Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function u32(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    invalidDocument("BlockNote headless frame length is invalid.");
  }
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function u64(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidDocument("BlockNote revision sequence is invalid.");
  }
  const high = Math.floor(value / 0x100000000);
  const low = value - high * 0x100000000;
  return concat([u32(high), u32(low)]);
}

class Reader {
  public offset = 0;

  constructor(public readonly bytes: Uint8Array) {}

  read(length: number) {
    if (!Number.isSafeInteger(length) || length < 0) {
      invalidDocument("BlockNote headless frame length is invalid.");
    }
    const end = this.offset + length;
    if (!Number.isSafeInteger(end) || end > this.bytes.byteLength) {
      invalidDocument("BlockNote headless frame is truncated.");
    }
    const value = this.bytes.slice(this.offset, end);
    this.offset = end;
    return value;
  }

  readU8() {
    return this.read(1)[0]!;
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
    const value = this.readU32() * 0x100000000 + this.readU32();
    if (!Number.isSafeInteger(value)) {
      invalidDocument("BlockNote revision sequence is invalid.");
    }
    return value;
  }

  finish() {
    if (this.offset !== this.bytes.byteLength) {
      invalidDocument("BlockNote headless frame has trailing bytes.");
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function encodedString(value: string, maximum: number) {
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    invalidDocument("BlockNote headless frame string is invalid.");
  }
  return concat([u32(bytes.byteLength), bytes]);
}

function decodedString(reader: Reader, maximum: number) {
  const length = reader.readU32();
  if (length === 0 || length > maximum) {
    invalidDocument("BlockNote headless frame string is invalid.");
  }
  const bytes = reader.read(length);
  let value: string;
  try {
    value = textDecoder.decode(bytes);
  } catch (error) {
    invalidDocument("BlockNote headless frame string is invalid.", error);
  }
  if (!equalBytes(textEncoder.encode(value), bytes)) {
    invalidDocument("BlockNote headless frame string is non-canonical.");
  }
  return value;
}

export function validateBlockNoteRevision(value: unknown): BlockNoteRevision {
  if (!value || typeof value !== "object") {
    invalidDocument("BlockNote revision is invalid.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "sequence" ||
    keys[1] !== "token" ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0 ||
    typeof record.token !== "string" ||
    textEncoder.encode(record.token).byteLength === 0 ||
    textEncoder.encode(record.token).byteLength > MAX_TOKEN_BYTES
  ) {
    invalidDocument("BlockNote revision is invalid.");
  }
  return Object.freeze({
    sequence: record.sequence as number,
    token: record.token,
  });
}

export function equalBlockNoteRevision(
  left: BlockNoteRevision,
  right: BlockNoteRevision,
) {
  return left.sequence === right.sequence && left.token === right.token;
}

export function encodeHeadlessFrame(input: {
  readonly kind: HeadlessFrameKind;
  readonly document: AnyBlockNoteDocumentDefinition;
  readonly revision: BlockNoteRevision;
  readonly update: Uint8Array;
}) {
  const revision = validateBlockNoteRevision(input.revision);
  const fingerprint = getBlockNoteDocumentInternals(
    input.document,
  ).formatFingerprint;
  return concat([
    HEADLESS_MAGIC,
    Uint8Array.of(HEADLESS_VERSION, input.kind === "checkpoint" ? 1 : 2),
    encodedString(input.document.id, MAX_IDENTITY_BYTES),
    encodedString(input.document.version, MAX_IDENTITY_BYTES),
    encodedString(fingerprint, MAX_IDENTITY_BYTES),
    u64(revision.sequence),
    encodedString(revision.token, MAX_TOKEN_BYTES),
    u32(input.update.byteLength),
    Uint8Array.from(input.update),
  ]);
}

function decodeHeadlessFrame(
  payload: Uint8Array,
  expectedKind: HeadlessFrameKind,
  document: AnyBlockNoteDocumentDefinition,
) {
  const reader = new Reader(payload);
  if (!equalBytes(reader.read(HEADLESS_MAGIC.byteLength), HEADLESS_MAGIC)) {
    invalidDocument("BlockNote headless frame has invalid framing.");
  }
  if (reader.readU8() !== HEADLESS_VERSION) {
    incompatibleDocument("BlockNote headless frame version is incompatible.");
  }
  const kind = reader.readU8();
  if (kind !== (expectedKind === "checkpoint" ? 1 : 2)) {
    invalidDocument("BlockNote headless frame has the wrong kind.");
  }
  const documentId = decodedString(reader, MAX_IDENTITY_BYTES);
  const definitionVersion = decodedString(reader, MAX_IDENTITY_BYTES);
  const definitionFingerprint = decodedString(reader, MAX_IDENTITY_BYTES);
  const revision = Object.freeze({
    sequence: reader.readU64(),
    token: decodedString(reader, MAX_TOKEN_BYTES),
  });
  const update = reader.read(reader.readU32());
  reader.finish();

  const expectedFingerprint =
    getBlockNoteDocumentInternals(document).formatFingerprint;
  if (
    documentId !== document.id ||
    definitionVersion !== document.version ||
    definitionFingerprint !== expectedFingerprint
  ) {
    incompatibleDocument("BlockNote document definition is incompatible.");
  }
  return { revision, update, definitionFingerprint } as const;
}

function configuredDocumentByteLimit(document: AnyBlockNoteDocumentDefinition) {
  const configured = document.limits?.documentBytes;
  if (configured === undefined) {
    return 16 * 1024 * 1024;
  }
  if (!Number.isSafeInteger(configured) || configured < 0) {
    incompatibleDocument("BlockNote document byte limit is invalid.");
  }
  return configured;
}

export function createEmptyCheckpoint(
  document: AnyBlockNoteDocumentDefinition,
  revision: BlockNoteRevision,
) {
  const doc = new Y.Doc({ gc: false });
  try {
    return blockNotePersistenceInternals.checkpointFromPayload(
      encodeHeadlessFrame({
        kind: "checkpoint",
        document,
        revision,
        update: Y.encodeStateAsUpdate(doc),
      }),
    );
  } finally {
    doc.destroy();
  }
}

export function reconstructBlockNoteDocument(
  document: AnyBlockNoteDocumentDefinition,
  stored: BlockNoteStoredDocument,
): ReconstructedBlockNoteDocument {
  const bindingBytes = blockNoteDocumentBinding.toBytes(stored.binding);
  const checkpointBytes = blockNotePersistenceInternals.checkpointToPayload(
    stored.checkpoint,
  );
  let documentBytes = checkpointBytes.byteLength;
  const changes = stored.changes.map((storedChange) => {
    const payload = blockNotePersistenceInternals.changeToPayload(
      storedChange.change,
    );
    documentBytes += payload.byteLength;
    return {
      payload,
      revision: validateBlockNoteRevision(storedChange.revision),
    };
  });
  if (documentBytes > configuredDocumentByteLimit(document)) {
    throw new BlockNoteError(
      "document-too-large",
      "BlockNote document exceeds its configured byte limit.",
    );
  }

  const checkpoint = decodeHeadlessFrame(
    checkpointBytes,
    "checkpoint",
    document,
  );
  const checkpointRevision = validateBlockNoteRevision(
    stored.checkpointRevision,
  );
  if (!equalBlockNoteRevision(checkpoint.revision, checkpointRevision)) {
    invalidDocument("BlockNote checkpoint revision does not match its frame.");
  }

  const doc = new Y.Doc({ gc: false });
  let revision = checkpointRevision;
  try {
    Y.applyUpdate(doc, checkpoint.update);
    for (const change of changes) {
      if (change.revision.sequence !== revision.sequence + 1) {
        invalidDocument("BlockNote change revisions are not continuous.");
      }
      const decoded = decodeHeadlessFrame(change.payload, "change", document);
      if (!equalBlockNoteRevision(decoded.revision, change.revision)) {
        invalidDocument("BlockNote change revision does not match its frame.");
      }
      Y.applyUpdate(doc, decoded.update);
      revision = change.revision;
    }
    return Object.freeze({
      doc,
      content: doc.get("prosemirror"),
      binding: blockNoteDocumentBinding.fromBytes(bindingBytes),
      definitionFingerprint: checkpoint.definitionFingerprint,
      revision,
    });
  } catch (error) {
    doc.destroy();
    if (error instanceof BlockNoteError) {
      throw error;
    }
    invalidDocument("BlockNote native document update is invalid.", error);
  }
}
