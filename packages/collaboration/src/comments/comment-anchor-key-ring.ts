import type { BlockNoteCommentAnchorVerificationBundle } from "@blocknote/core";
import { blockNoteCommentAnchorInternals } from "@blocknote/core/comments/internal";
import { BlockNoteError } from "@blocknote/core/persistence";

function incompatible(message: string): never {
  throw new BlockNoteError("incompatible-document", message);
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

export function createCommentAnchorKeyRing(
  initial: BlockNoteCommentAnchorVerificationBundle,
) {
  let current = initial;
  let inspected =
    blockNoteCommentAnchorInternals.inspectVerificationBundle(initial);
  let keys = new Map(
    inspected.keys.map(({ keyId, publicKey }) => [
      keyId,
      Uint8Array.from(publicKey),
    ]),
  );

  return Object.freeze({
    bundle: () => current,
    key(keyId: string) {
      const value = keys.get(keyId);
      return value ? Uint8Array.from(value) : null;
    },
    merge(next: BlockNoteCommentAnchorVerificationBundle) {
      const candidate =
        blockNoteCommentAnchorInternals.inspectVerificationBundle(next);
      if (candidate.revision <= inspected.revision) return false;
      const merged = new Map(keys);
      for (const { keyId, publicKey } of candidate.keys) {
        const existing = merged.get(keyId);
        if (existing && !equalBytes(existing, publicKey)) {
          incompatible("BlockNote comment anchor verification keys conflict.");
        }
        merged.set(keyId, Uint8Array.from(publicKey));
      }
      current = next;
      inspected = candidate;
      keys = merged;
      return true;
    },
  });
}

export type CommentAnchorKeyRing = ReturnType<
  typeof createCommentAnchorKeyRing
>;
