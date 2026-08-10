import {
  BlockNoteError,
  blockNotePersistence,
  type AnyBlockNoteDocumentDefinition,
  type BlockNoteDocumentStore,
  type BlockNoteRevision,
  type BlockNoteStoredDocument,
} from "@blocknote/core";
import { blockNotePersistenceInternals } from "@blocknote/core/persistence/internal";
import { getBlockNoteDocumentInternals } from "@blocknote/core/runtime";
import * as Y from "@y/y";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAGIC = Uint8Array.of(66, 78, 72, 68);

function concat(parts: readonly Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
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
  return concat([u32(Math.floor(value / 0x100000000)), u32(value >>> 0)]);
}

function text(value: string) {
  const bytes = encoder.encode(value);
  return concat([u32(bytes.byteLength), bytes]);
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  read(length: number) {
    const end = this.offset + length;
    if (
      !Number.isSafeInteger(end) ||
      length < 0 ||
      end > this.bytes.byteLength
    ) {
      throw new BlockNoteError(
        "invalid-document",
        "BlockNote collaboration frame is truncated.",
      );
    }
    const result = this.bytes.slice(this.offset, end);
    this.offset = end;
    return result;
  }
  u8() {
    return this.read(1)[0]!;
  }
  u32() {
    const bytes = this.read(4);
    return (
      bytes[0]! * 0x1000000 +
      bytes[1]! * 0x10000 +
      bytes[2]! * 0x100 +
      bytes[3]!
    );
  }
  u64() {
    return this.u32() * 0x100000000 + this.u32();
  }
  text() {
    return decoder.decode(this.read(this.u32()));
  }
  finish() {
    if (this.offset !== this.bytes.byteLength) {
      throw new BlockNoteError(
        "invalid-document",
        "BlockNote collaboration frame has trailing bytes.",
      );
    }
  }
}

function frame(input: {
  readonly kind: "checkpoint" | "change";
  readonly document: AnyBlockNoteDocumentDefinition;
  readonly revision: BlockNoteRevision;
  readonly update: Uint8Array;
}) {
  return concat([
    MAGIC,
    Uint8Array.of(1, input.kind === "checkpoint" ? 1 : 2),
    text(input.document.id),
    text(input.document.version),
    text(getBlockNoteDocumentInternals(input.document).formatFingerprint),
    u64(input.revision.sequence),
    text(input.revision.token),
    u32(input.update.byteLength),
    input.update,
  ]);
}

function unframe(
  bytes: Uint8Array,
  kind: "checkpoint" | "change",
  document: AnyBlockNoteDocumentDefinition,
) {
  const reader = new Reader(bytes);
  if (!reader.read(4).every((byte, index) => byte === MAGIC[index])) {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote collaboration frame is invalid.",
    );
  }
  if (reader.u8() !== 1 || reader.u8() !== (kind === "checkpoint" ? 1 : 2)) {
    throw new BlockNoteError(
      "incompatible-document",
      "BlockNote collaboration frame is incompatible.",
    );
  }
  const id = reader.text();
  const version = reader.text();
  const fingerprint = reader.text();
  const revision = Object.freeze({
    sequence: reader.u64(),
    token: reader.text(),
  });
  const update = reader.read(reader.u32());
  reader.finish();
  if (
    id !== document.id ||
    version !== document.version ||
    fingerprint !== getBlockNoteDocumentInternals(document).formatFingerprint
  ) {
    throw new BlockNoteError(
      "incompatible-document",
      "BlockNote document definition is incompatible.",
    );
  }
  return { revision, update } as const;
}

function sameRevision(left: BlockNoteRevision, right: BlockNoteRevision) {
  return left.sequence === right.sequence && left.token === right.token;
}

export function reconstructRuntimeDocument(
  document: AnyBlockNoteDocumentDefinition,
  stored: BlockNoteStoredDocument,
) {
  const checkpoint = unframe(
    blockNotePersistenceInternals.checkpointToPayload(stored.checkpoint),
    "checkpoint",
    document,
  );
  if (!sameRevision(checkpoint.revision, stored.checkpointRevision)) {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote checkpoint revision is invalid.",
    );
  }
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, checkpoint.update);
  let revision = checkpoint.revision;
  for (const storedChange of stored.changes) {
    const change = unframe(
      blockNotePersistenceInternals.changeToPayload(storedChange.change),
      "change",
      document,
    );
    if (
      storedChange.revision.sequence !== revision.sequence + 1 ||
      !sameRevision(change.revision, storedChange.revision)
    ) {
      doc.destroy();
      throw new BlockNoteError(
        "invalid-document",
        "BlockNote change revision is invalid.",
      );
    }
    Y.applyUpdate(doc, change.update);
    revision = storedChange.revision;
  }
  return { doc, revision } as const;
}

async function updateHash(update: Uint8Array) {
  const bytes = new Uint8Array(update.byteLength);
  bytes.set(update);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function nextRevision(
  current: BlockNoteRevision,
  update: Uint8Array,
) {
  return Object.freeze({
    sequence: current.sequence + 1,
    token: `${current.sequence + 1}-${await updateHash(update)}`,
  });
}

export function createChange(
  document: AnyBlockNoteDocumentDefinition,
  revision: BlockNoteRevision,
  update: Uint8Array,
) {
  return blockNotePersistenceInternals.changeFromPayload(
    frame({ kind: "change", document, revision, update }),
  );
}

export function createCheckpoint(
  document: AnyBlockNoteDocumentDefinition,
  revision: BlockNoteRevision,
  doc: Y.Doc,
) {
  return blockNotePersistenceInternals.checkpointFromPayload(
    frame({
      kind: "checkpoint",
      document,
      revision,
      update: Y.encodeStateAsUpdate(doc),
    }),
  );
}

export async function appendDurably<TKey>(input: {
  readonly key: TKey;
  readonly document: AnyBlockNoteDocumentDefinition;
  readonly store: BlockNoteDocumentStore<TKey>;
  readonly expected: BlockNoteRevision;
  readonly update: Uint8Array;
}) {
  const next = await nextRevision(input.expected, input.update);
  const result = await input.store.append({
    key: input.key,
    expected: input.expected,
    next,
    change: createChange(input.document, next, input.update),
  });
  return { result, next } as const;
}

export function persistenceBytes(value: ReturnType<typeof createChange>) {
  return blockNotePersistence.changeToBytes(value).byteLength;
}
