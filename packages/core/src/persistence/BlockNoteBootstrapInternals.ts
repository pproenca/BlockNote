import {
  blockNoteCommentAnchorVerificationBundle,
  type BlockNoteCommentAnchorVerificationBundle,
} from "../comments/external/BlockNoteCommentAnchorVerificationBundle.js";
import { BlockNoteError } from "../platform/BlockNoteError.js";
import {
  blockNoteDocumentBinding,
  type BlockNoteDocumentBinding,
} from "./BlockNoteDocumentBinding.js";
import type { BlockNoteBootstrap } from "./BlockNotePersistence.js";
import { blockNotePersistenceInternals } from "./BlockNotePersistenceInternals.js";

const magic = Uint8Array.of(66, 78, 83, 66, 1);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const maxStringBytes = 4_096;

function invalid(cause?: unknown): never {
  throw new BlockNoteError(
    "invalid-document",
    "BlockNote bootstrap envelope is invalid.",
    {
      cause,
    },
  );
}

function concat(parts: readonly Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function u32(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
    invalid();
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function field(bytes: Uint8Array) {
  return concat([u32(bytes.byteLength), bytes]);
}

function text(value: string) {
  const bytes = encoder.encode(value);
  if (bytes.byteLength === 0 || bytes.byteLength > maxStringBytes) invalid();
  return field(bytes);
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(length: number) {
    const end = this.offset + length;
    if (!Number.isSafeInteger(end) || length < 0 || end > this.bytes.byteLength)
      invalid();
    const result = this.bytes.slice(this.offset, end);
    this.offset = end;
    return result;
  }

  readField(maximum = 0xffffffff) {
    const lengthBytes = this.read(4);
    const length =
      lengthBytes[0]! * 0x1000000 +
      lengthBytes[1]! * 0x10000 +
      lengthBytes[2]! * 0x100 +
      lengthBytes[3]!;
    if (length > maximum) invalid();
    return this.read(length);
  }

  finish() {
    if (this.offset !== this.bytes.byteLength) invalid();
  }
}

function decodeText(reader: Reader) {
  const bytes = reader.readField(maxStringBytes);
  if (bytes.byteLength === 0) invalid();
  try {
    const value = decoder.decode(bytes);
    if (!encoder.encode(value).every((byte, index) => byte === bytes[index]))
      invalid();
    return value;
  } catch (error) {
    invalid(error);
  }
}

export const blockNoteBootstrapInternals = Object.freeze({
  create(input: {
    readonly binding: BlockNoteDocumentBinding;
    readonly documentId: string;
    readonly definitionVersion: string;
    readonly definitionFingerprint: string;
    readonly verificationBundle?: BlockNoteCommentAnchorVerificationBundle;
    readonly checkpoint: Uint8Array;
  }): BlockNoteBootstrap {
    const verification = input.verificationBundle
      ? encoder.encode(
          blockNoteCommentAnchorVerificationBundle.serialize(
            input.verificationBundle,
          ),
        )
      : new Uint8Array();
    return blockNotePersistenceInternals.bootstrapFromPayload(
      concat([
        magic,
        blockNoteDocumentBinding.toBytes(input.binding),
        text(input.documentId),
        text(input.definitionVersion),
        text(input.definitionFingerprint),
        field(verification),
        field(Uint8Array.from(input.checkpoint)),
      ]),
    );
  },
  inspect(value: BlockNoteBootstrap) {
    const reader = new Reader(
      blockNotePersistenceInternals.bootstrapToPayload(value),
    );
    if (
      !reader
        .read(magic.byteLength)
        .every((byte, index) => byte === magic[index])
    ) {
      invalid();
    }
    const binding = blockNoteDocumentBinding.fromBytes(reader.read(32));
    const documentId = decodeText(reader);
    const definitionVersion = decodeText(reader);
    const definitionFingerprint = decodeText(reader);
    const verification = reader.readField(maxStringBytes * 4);
    const checkpoint = reader.readField();
    reader.finish();
    let verificationBundle:
      | BlockNoteCommentAnchorVerificationBundle
      | undefined;
    if (verification.byteLength > 0) {
      try {
        verificationBundle = blockNoteCommentAnchorVerificationBundle.parse(
          decoder.decode(verification),
        );
      } catch (error) {
        invalid(error);
      }
    }
    return Object.freeze({
      binding,
      documentId,
      definitionVersion,
      definitionFingerprint,
      verificationBundle,
      checkpoint: Uint8Array.from(checkpoint),
    });
  },
});
