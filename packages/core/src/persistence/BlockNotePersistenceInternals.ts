import type {
  BlockNoteBootstrap,
  BlockNoteChange,
  BlockNoteCheckpoint,
} from "./BlockNotePersistence.js";
import { blockNotePersistence } from "./BlockNotePersistence.js";
import {
  BLOCK_NOTE_PERSISTENCE_MAX_FRAME_BYTES,
  decodeBlockNotePersistenceFrame,
  encodeBlockNotePersistenceFrame,
} from "./BlockNotePersistenceFrame.js";
import { BlockNoteError } from "../platform/BlockNoteError.js";
import { fromBase64UrlEncoded, toBase64UrlEncoded } from "lib0/buffer";

const maxBootstrapCharacters = Math.floor(
  (BLOCK_NOTE_PERSISTENCE_MAX_FRAME_BYTES * 4 + 2) / 3,
);
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

function invalidBootstrap() {
  return new BlockNoteError(
    "invalid-document",
    "BlockNote bootstrap is invalid.",
  );
}

function oversizedBootstrap() {
  return new BlockNoteError(
    "document-too-large",
    "BlockNote bootstrap exceeds the persistence frame limit.",
  );
}

function decodeBase64Url(value: string) {
  if (value.length > maxBootstrapCharacters) {
    throw oversizedBootstrap();
  }
  if (!base64UrlPattern.test(value)) {
    throw invalidBootstrap();
  }

  let decoded: Uint8Array;
  try {
    decoded = fromBase64UrlEncoded(value);
  } catch {
    throw invalidBootstrap();
  }
  if (toBase64UrlEncoded(decoded) !== value) {
    throw invalidBootstrap();
  }
  return decoded;
}

export const blockNotePersistenceInternals = Object.freeze({
  checkpointFromPayload(value: Uint8Array): BlockNoteCheckpoint {
    return blockNotePersistence.checkpointFromBytes(
      encodeBlockNotePersistenceFrame("checkpoint", value),
    );
  },
  checkpointToPayload(value: BlockNoteCheckpoint) {
    return decodeBlockNotePersistenceFrame(
      blockNotePersistence.checkpointToBytes(value),
      "checkpoint",
    ).payload;
  },
  changeFromPayload(value: Uint8Array): BlockNoteChange {
    return blockNotePersistence.changeFromBytes(
      encodeBlockNotePersistenceFrame("change", value),
    );
  },
  changeToPayload(value: BlockNoteChange) {
    return decodeBlockNotePersistenceFrame(
      blockNotePersistence.changeToBytes(value),
      "change",
    ).payload;
  },
  bootstrapFromPayload(value: Uint8Array): BlockNoteBootstrap {
    return toBase64UrlEncoded(
      encodeBlockNotePersistenceFrame("bootstrap", value),
    ) as BlockNoteBootstrap;
  },
  bootstrapToPayload(value: BlockNoteBootstrap) {
    if (typeof value !== "string") {
      throw invalidBootstrap();
    }
    return decodeBlockNotePersistenceFrame(decodeBase64Url(value), "bootstrap")
      .payload;
  },
});
