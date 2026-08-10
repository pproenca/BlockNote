import type {
  BlockNoteCommentAnchor,
  BlockNoteCommentAnchorCapture,
  BlockNoteCommentAnchorVerificationBundle,
} from "@blocknote/core";
import { blockNoteCommentAnchorInternals } from "@blocknote/core/comments/internal";
import {
  BlockNoteError,
  blockNoteDocumentBinding,
  isBlockNoteError,
} from "@blocknote/core/persistence";
import * as Y from "@y/y";

import type { ReconstructedBlockNoteDocument } from "./reconstruct.js";

export interface BlockNoteCommentAnchorSigner {
  readonly activeKeyId: string;
  sign(
    message: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Uint8Array>;
}

export interface BlockNoteCommentAnchorVerificationKey {
  readonly keyId: string;
  readonly publicKey: Uint8Array;
}

export interface BlockNoteCommentAnchorKeyRing {
  readonly revision: number;
  readonly activeKeyId: string;
  readonly signer: BlockNoteCommentAnchorSigner;
  readonly verificationKeys: readonly BlockNoteCommentAnchorVerificationKey[];
}

const keyIdPattern = /^[\x21-\x7e]{1,64}$/;

function incompatible(message: string, cause?: unknown): never {
  throw new BlockNoteError("incompatible-document", message, { cause });
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function abort(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function mapRelativePositions(
  runtime: ReconstructedBlockNoteDocument,
  fromBytes: Uint8Array,
  toBytes: Uint8Array,
) {
  try {
    const doc = runtime.doc as Y.Doc;
    const content = runtime.content as Y.Type;
    const fromRelative = Y.decodeRelativePosition(fromBytes);
    const toRelative = Y.decodeRelativePosition(toBytes);
    if (
      fromRelative.item === null ||
      toRelative.item === null ||
      fromRelative.assoc !== 0 ||
      toRelative.assoc !== -1
    ) {
      return false;
    }
    const from = Y.createAbsolutePositionFromRelativePosition(
      fromRelative,
      doc,
    );
    const to = Y.createAbsolutePositionFromRelativePosition(toRelative, doc);
    return (
      from !== null &&
      to !== null &&
      from.type === content &&
      to.type === content &&
      from.index < to.index
    );
  } catch {
    return false;
  }
}

function validateRing(input: BlockNoteCommentAnchorKeyRing) {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    incompatible("BlockNote comment anchor key-ring revision is invalid.");
  }
  if (
    !keyIdPattern.test(input.activeKeyId) ||
    input.signer.activeKeyId !== input.activeKeyId ||
    input.verificationKeys.length === 0 ||
    input.verificationKeys.length > 64
  ) {
    incompatible("BlockNote comment anchor key ring is invalid.");
  }
  const keys = new Map<string, Uint8Array>();
  for (const entry of input.verificationKeys) {
    if (
      !keyIdPattern.test(entry.keyId) ||
      !(entry.publicKey instanceof Uint8Array) ||
      entry.publicKey.byteLength !== 32 ||
      keys.has(entry.keyId)
    ) {
      incompatible("BlockNote comment anchor verification key is invalid.");
    }
    keys.set(entry.keyId, Uint8Array.from(entry.publicKey));
  }
  if (!keys.has(input.activeKeyId)) {
    incompatible("BlockNote active comment anchor key is missing.");
  }
  return keys;
}

export function createBlockNoteCommentAnchorAuthority(
  input: BlockNoteCommentAnchorKeyRing,
) {
  const keyBytes = validateRing(input);
  const runtimeCrypto = globalThis.crypto;
  if (!runtimeCrypto?.subtle) {
    incompatible("Ed25519 verification is unavailable.");
  }
  const subtle = runtimeCrypto.subtle;
  const importedKeys = Promise.all(
    [...keyBytes].map(async ([keyId, bytes]) => {
      try {
        const key = await subtle.importKey(
          "raw",
          Uint8Array.from(bytes),
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        return [keyId, key] as const;
      } catch (error) {
        incompatible(
          "BlockNote Ed25519 verification key is incompatible.",
          error,
        );
      }
    }),
  ).then((entries) => new Map(entries));

  const verify = async (
    keyId: string,
    message: Uint8Array,
    signature: Uint8Array,
  ) => {
    const keys = await importedKeys;
    const key = keys.get(keyId);
    if (!key) {
      return false;
    }
    try {
      return await subtle.verify(
        { name: "Ed25519" },
        key,
        Uint8Array.from(signature),
        Uint8Array.from(message),
      );
    } catch (error) {
      incompatible("Ed25519 verification failed at runtime.", error);
    }
  };

  return Object.freeze({
    async createVerificationBundle(): Promise<BlockNoteCommentAnchorVerificationBundle> {
      await importedKeys;
      return blockNoteCommentAnchorInternals.createVerificationBundle({
        revision: input.revision,
        keys: [...keyBytes].map(([keyId, publicKey]) => ({
          keyId,
          publicKey: Uint8Array.from(publicKey),
        })),
      });
    },
    async seal(
      runtime: ReconstructedBlockNoteDocument,
      capture: BlockNoteCommentAnchorCapture,
      options?: { readonly signal?: AbortSignal },
    ): Promise<BlockNoteCommentAnchor> {
      abort(options?.signal);
      const inspected = blockNoteCommentAnchorInternals.inspectCapture(capture);
      if (!mapRelativePositions(runtime, inspected.from, inspected.to)) {
        throw new BlockNoteError(
          "invalid-anchor",
          "BlockNote comment anchor capture is detached.",
        );
      }
      const unsigned = blockNoteCommentAnchorInternals.createAnchor({
        keyId: input.activeKeyId,
        documentBinding: runtime.binding,
        definitionFingerprint: runtime.definitionFingerprint,
        from: inspected.from,
        to: inspected.to,
        signature: new Uint8Array(64),
      });
      const payload =
        blockNoteCommentAnchorInternals.inspectAnchor(unsigned).payload;
      const message = blockNoteCommentAnchorInternals.signatureMessage(payload);
      let returned: Uint8Array;
      try {
        returned = await input.signer.sign(Uint8Array.from(message), {
          signal: options?.signal,
        });
      } catch (error) {
        abort(options?.signal);
        throw new BlockNoteError(
          "offline-unavailable",
          "BlockNote comment anchor signer is unavailable.",
          { cause: error, retryable: true },
        );
      }
      abort(options?.signal);
      const signature =
        returned instanceof Uint8Array ? Uint8Array.from(returned) : null;
      if (
        !signature ||
        signature.byteLength !== 64 ||
        !(await verify(input.activeKeyId, message, signature))
      ) {
        incompatible(
          "BlockNote comment anchor signer does not match its active key.",
        );
      }
      return blockNoteCommentAnchorInternals.createAnchor({
        keyId: input.activeKeyId,
        documentBinding: runtime.binding,
        definitionFingerprint: runtime.definitionFingerprint,
        from: inspected.from,
        to: inspected.to,
        signature,
      });
    },
    async validate(
      runtime: ReconstructedBlockNoteDocument,
      anchor: BlockNoteCommentAnchor,
      options?: { readonly signal?: AbortSignal },
    ) {
      abort(options?.signal);
      try {
        const inspected = blockNoteCommentAnchorInternals.inspectAnchor(anchor);
        const actualBinding = blockNoteDocumentBinding.toBytes(
          inspected.documentBinding,
        );
        const expectedBinding = blockNoteDocumentBinding.toBytes(
          runtime.binding,
        );
        if (
          !equalBytes(actualBinding, expectedBinding) ||
          inspected.definitionFingerprint !== runtime.definitionFingerprint ||
          !keyBytes.has(inspected.keyId)
        ) {
          return false;
        }
        const verified = await verify(
          inspected.keyId,
          blockNoteCommentAnchorInternals.signatureMessage(inspected.payload),
          inspected.signature,
        );
        abort(options?.signal);
        return (
          verified &&
          mapRelativePositions(runtime, inspected.from, inspected.to)
        );
      } catch (error) {
        if (
          isBlockNoteError(error) &&
          (error.code === "invalid-anchor" || error.code === "invalid-document")
        ) {
          return false;
        }
        throw error;
      }
    },
  });
}
