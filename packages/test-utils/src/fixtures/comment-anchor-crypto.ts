import type {
  BlockNoteCommentAnchorKeyRing,
  BlockNoteCommentAnchorVerificationKey,
} from "@blocknote/server-util/headless";
import {
  assertContract,
  contractCase,
  defineBlockNoteContractCases,
  type BlockNoteContractCase,
  type BlockNoteContractTestApi,
} from "../contracts/shared.js";

export interface BlockNoteCommentAnchorTestKeyRings {
  activate(
    activeKeyId: string,
    revision: number,
  ): BlockNoteCommentAnchorKeyRing;
}

export async function createBlockNoteCommentAnchorTestKeyRings(options: {
  readonly keyIds: readonly string[];
}): Promise<BlockNoteCommentAnchorTestKeyRings> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "BlockNote test key rings require Web Crypto Ed25519 support.",
    );
  }
  if (
    options.keyIds.length === 0 ||
    new Set(options.keyIds).size !== options.keyIds.length
  ) {
    throw new Error("BlockNote test key IDs must be non-empty and unique.");
  }
  const subtle = globalThis.crypto.subtle;
  const pairs = new Map<string, CryptoKeyPair>();
  for (const keyId of options.keyIds) {
    try {
      pairs.set(
        keyId,
        (await subtle.generateKey({ name: "Ed25519" }, true, [
          "sign",
          "verify",
        ])) as CryptoKeyPair,
      );
    } catch (cause) {
      throw new Error(
        "BlockNote test key rings require Web Crypto Ed25519 support.",
        {
          cause,
        },
      );
    }
  }
  const exported = new Map<string, Uint8Array>();
  for (const [keyId, pair] of pairs) {
    exported.set(
      keyId,
      new Uint8Array(await subtle.exportKey("raw", pair.publicKey)),
    );
  }
  return Object.freeze({
    activate(activeKeyId: string, revision: number) {
      const active = pairs.get(activeKeyId);
      if (!active) {
        throw new Error(`Unknown BlockNote test key: ${activeKeyId}`);
      }
      const verificationKeys: readonly BlockNoteCommentAnchorVerificationKey[] =
        Object.freeze(
          [...exported].map(([keyId, publicKey]) =>
            Object.freeze({ keyId, publicKey: Uint8Array.from(publicKey) }),
          ),
        );
      return Object.freeze({
        revision,
        activeKeyId,
        verificationKeys,
        signer: Object.freeze({
          activeKeyId,
          async sign(
            message: Uint8Array,
            input?: { readonly signal?: AbortSignal },
          ) {
            input?.signal?.throwIfAborted();
            const signature = await subtle.sign(
              { name: "Ed25519" },
              active.privateKey,
              Uint8Array.from(message),
            );
            input?.signal?.throwIfAborted();
            return new Uint8Array(signature);
          },
        }),
      });
    },
  });
}

export interface BlockNoteCommentAnchorCryptoFixtureHarness {
  validateAnchor(variant: string): Promise<boolean>;
  refreshVerification(variant: string): Promise<void>;
  refreshCount(): number;
  verifyWithUnknownKey(): Promise<boolean>;
  copyPublicKey(): Uint8Array;
  requireEd25519(supported: boolean): Promise<void>;
}

export interface BlockNoteCommentAnchorCryptoFixtureOptions {
  readonly create: () => Promise<BlockNoteCommentAnchorCryptoFixtureHarness>;
}

export function getCommentAnchorCryptoFixtureCases(
  options: BlockNoteCommentAnchorCryptoFixtureOptions,
): readonly BlockNoteContractCase[] {
  return Object.freeze([
    contractCase("invalid-anchor-variants", async () => {
      const harness = await options.create();
      for (const variant of [
        "malformed",
        "cross-definition",
        "cross-binding",
        "retagged",
        "tampered",
      ]) {
        assertContract(
          !(await harness.validateAnchor(variant)),
          `${variant} anchors must fail verification.`,
        );
      }
    }),
    contractCase("retained-key-rotation", async () => {
      const harness = await options.create();
      assertContract(
        await harness.validateAnchor("retained-key"),
        "A retained verification key must validate pre-rotation anchors.",
      );
    }),
    contractCase("conflicting-verification-bundle", async () => {
      const harness = await options.create();
      let rejected = false;
      try {
        await harness.refreshVerification("conflicting");
      } catch {
        rejected = true;
      }
      assertContract(
        rejected,
        "Conflicting verification keys must reject instead of merging.",
      );
    }),
    contractCase("unsupported-ed25519", async () => {
      const harness = await options.create();
      let rejected = false;
      try {
        await harness.requireEd25519(false);
      } catch {
        rejected = true;
      }
      assertContract(rejected, "Unavailable Ed25519 support must fail closed.");
    }),
    contractCase("unknown-key-single-refresh", async () => {
      const harness = await options.create();
      assertContract(
        !(await harness.verifyWithUnknownKey()) && harness.refreshCount() === 1,
        "An unknown key must refresh exactly once, then fail closed.",
      );
    }),
    contractCase("public-key-copy-defense", async () => {
      const harness = await options.create();
      const first = harness.copyPublicKey();
      first.fill(255);
      const second = harness.copyPublicKey();
      assertContract(
        second.some((value) => value !== 255),
        "Public verification key bytes must be copied at every boundary.",
      );
    }),
  ]);
}

export function defineBlockNoteCommentAnchorCryptoFixtures(
  options: BlockNoteCommentAnchorCryptoFixtureOptions,
  test?: BlockNoteContractTestApi,
) {
  defineBlockNoteContractCases(
    "BlockNote comment anchor crypto behavior",
    getCommentAnchorCryptoFixtureCases(options),
    test,
  );
}
