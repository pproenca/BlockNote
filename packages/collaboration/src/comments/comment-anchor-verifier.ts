import type {
  BlockNoteCommentAnchor,
  BlockNoteCommentAnchorMappingResult,
  BlockNoteCommentAnchorVerificationBundle,
  BlockNoteDocumentBinding,
} from "@blocknote/core";
import { blockNoteCommentAnchorInternals } from "@blocknote/core/comments/internal";
import {
  BlockNoteError,
  blockNoteDocumentBinding,
} from "@blocknote/core/persistence";

import { createCommentAnchorKeyRing } from "./comment-anchor-key-ring.js";

export interface BlockNoteCommentAnchorVerifierCapability {
  verifyAndMap(
    anchor: BlockNoteCommentAnchor,
    signal?: AbortSignal,
  ): Promise<BlockNoteCommentAnchorMappingResult>;
  getStatus(): Readonly<{ status: "idle" | "verifying" | "error" }>;
  destroy(): void;
}

function incompatible(message: string, cause?: unknown): never {
  throw new BlockNoteError("incompatible-document", message, { cause });
}

function invalid(message: string): never {
  throw new BlockNoteError("invalid-anchor", message);
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

export function createBlockNoteCommentAnchorVerifier(input: {
  readonly documentBinding: BlockNoteDocumentBinding;
  readonly definitionFingerprint: string;
  readonly verificationBundle: BlockNoteCommentAnchorVerificationBundle;
  readonly mapAnchor: (
    anchor: BlockNoteCommentAnchor,
  ) => BlockNoteCommentAnchorMappingResult;
  readonly refresh?: (input: {
    readonly current: BlockNoteCommentAnchorVerificationBundle;
    readonly signal: AbortSignal;
  }) => Promise<BlockNoteCommentAnchorVerificationBundle>;
}): BlockNoteCommentAnchorVerifierCapability {
  const runtimeCrypto = globalThis.crypto;
  if (!runtimeCrypto?.subtle) {
    incompatible("Ed25519 verification is unavailable.");
  }
  const subtle = runtimeCrypto.subtle;
  const keyRing = createCommentAnchorKeyRing(input.verificationBundle);
  const expectedBinding = blockNoteDocumentBinding.toBytes(
    input.documentBinding,
  );
  const imported = new Map<string, Promise<CryptoKey>>();
  const refreshedUnknown = new Set<string>();
  const controller = new AbortController();
  let refreshPromise: Promise<void> | null = null;
  let destroyed = false;
  let status: Readonly<{ status: "idle" | "verifying" | "error" }> =
    Object.freeze({ status: "idle" });

  const importedKey = (keyId: string, bytes: Uint8Array) => {
    let operation = imported.get(keyId);
    if (!operation) {
      operation = subtle
        .importKey("raw", Uint8Array.from(bytes), { name: "Ed25519" }, false, [
          "verify",
        ])
        .catch((error) =>
          incompatible(
            "BlockNote Ed25519 verification key is incompatible.",
            error,
          ),
        );
      imported.set(keyId, operation);
    }
    return operation;
  };

  const refresh = async (keyId: string, signal?: AbortSignal) => {
    if (!refreshPromise) {
      if (!input.refresh || refreshedUnknown.has(keyId)) return;
      refreshedUnknown.add(keyId);
      refreshPromise = input
        .refresh({ current: keyRing.bundle(), signal: controller.signal })
        .then((bundle) => {
          if (!destroyed) keyRing.merge(bundle);
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    if (!signal) {
      await refreshPromise;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      void refreshPromise!.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  };

  return Object.freeze({
    destroy() {
      if (destroyed) return;
      destroyed = true;
      controller.abort();
      imported.clear();
      status = Object.freeze({ status: "idle" });
    },
    getStatus() {
      return status;
    },
    async verifyAndMap(anchor: BlockNoteCommentAnchor, signal?: AbortSignal) {
      throwIfAborted(signal);
      if (destroyed) invalid("BlockNote comment anchor verifier is disposed.");
      status = Object.freeze({ status: "verifying" });
      try {
        const inspected = blockNoteCommentAnchorInternals.inspectAnchor(anchor);
        if (
          !equalBytes(
            blockNoteDocumentBinding.toBytes(inspected.documentBinding),
            expectedBinding,
          ) ||
          inspected.definitionFingerprint !== input.definitionFingerprint
        ) {
          invalid("BlockNote comment anchor belongs to another document.");
        }
        let publicKey = keyRing.key(inspected.keyId);
        if (!publicKey) {
          await refresh(inspected.keyId, signal);
          throwIfAborted(signal);
          publicKey = keyRing.key(inspected.keyId);
        }
        if (!publicKey) invalid("BlockNote comment anchor key is unavailable.");
        const key = await importedKey(inspected.keyId, publicKey);
        throwIfAborted(signal);
        const valid = await subtle.verify(
          { name: "Ed25519" },
          key,
          Uint8Array.from(inspected.signature),
          Uint8Array.from(
            blockNoteCommentAnchorInternals.signatureMessage(inspected.payload),
          ),
        );
        throwIfAborted(signal);
        if (!valid) invalid("BlockNote comment anchor signature is invalid.");
        const mapped = input.mapAnchor(anchor);
        if (mapped.status === "unknown") {
          invalid("BlockNote comment anchor cannot be mapped.");
        }
        status = Object.freeze({ status: "idle" });
        return mapped;
      } catch (error) {
        status = Object.freeze({ status: "error" });
        throw error;
      }
    },
  });
}
