import type { BlockNoteDocumentBinding } from "@blocknote/core";
import { blockNoteDocumentBinding } from "@blocknote/core";

export interface BlockNoteCacheIdentity {
  readonly accountId: string;
  readonly documentId: string;
  readonly definitionVersion: string;
  readonly definitionFingerprint: string;
  readonly binding: BlockNoteDocumentBinding;
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function blockNoteCacheKey(identity: BlockNoteCacheIdentity) {
  return [
    "blocknote-cache-v1",
    identity.accountId,
    identity.documentId,
    identity.definitionVersion,
    identity.definitionFingerprint,
    hex(blockNoteDocumentBinding.toBytes(identity.binding)),
  ]
    .map(encodeURIComponent)
    .join(":");
}
