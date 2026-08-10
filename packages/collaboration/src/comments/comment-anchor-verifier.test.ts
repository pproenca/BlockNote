/** @vitest-environment node */
import {
  blockNoteDocumentBinding,
  type BlockNoteCommentAnchor,
} from "@blocknote/core";
import { blockNoteCommentAnchorInternals } from "@blocknote/core/comments/internal";
import * as Y from "@y/y";
import { describe, expect, it, vi } from "vite-plus/test";

import { createBlockNoteCommentAnchorVerifier } from "./comment-anchor-verifier.js";

async function key(keyId: string) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return { keyId, pair, publicKey };
}

function bundle(
  revision: number,
  keys: readonly { keyId: string; publicKey: Uint8Array }[],
) {
  return blockNoteCommentAnchorInternals.createVerificationBundle({
    revision,
    keys,
  });
}

async function anchor(input: {
  keyId: string;
  privateKey: CryptoKey;
  binding: ReturnType<typeof blockNoteDocumentBinding.fromBytes>;
  fingerprint?: string;
}) {
  const doc = new Y.Doc();
  const content = doc.get("content");
  content.insert(0, "abc");
  const from = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(content, 1, 0),
  );
  const to = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(content, 2, -1),
  );
  doc.destroy();
  const fields = {
    keyId: input.keyId,
    documentBinding: input.binding,
    definitionFingerprint: input.fingerprint ?? "fingerprint",
    from,
    to,
  };
  const unsigned = blockNoteCommentAnchorInternals.createAnchor({
    ...fields,
    signature: new Uint8Array(64),
  });
  const payload =
    blockNoteCommentAnchorInternals.inspectAnchor(unsigned).payload;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      input.privateKey,
      Uint8Array.from(blockNoteCommentAnchorInternals.signatureMessage(payload))
        .buffer,
    ),
  );
  return blockNoteCommentAnchorInternals.createAnchor({
    ...fields,
    signature,
  }) as BlockNoteCommentAnchor;
}

describe("browser comment anchor verifier", () => {
  it("verifies current and retiring keys before mapping", async () => {
    const current = await key("current");
    const retiring = await key("retiring");
    const binding = blockNoteDocumentBinding.fromBytes(
      new Uint8Array(32).fill(7),
    );
    const mapAnchor = vi.fn(() => ({
      status: "attached" as const,
      range: { from: 1, to: 2 },
    }));
    const verifier = createBlockNoteCommentAnchorVerifier({
      documentBinding: binding,
      definitionFingerprint: "fingerprint",
      verificationBundle: bundle(2, [current, retiring]),
      mapAnchor,
    });

    await expect(
      verifier.verifyAndMap(
        await anchor({
          keyId: retiring.keyId,
          privateKey: retiring.pair.privateKey,
          binding,
        }),
      ),
    ).resolves.toEqual({ status: "attached", range: { from: 1, to: 2 } });
    expect(mapAnchor).toHaveBeenCalledTimes(1);
  });

  it("fails closed for signature, binding, and definition replay", async () => {
    const active = await key("active");
    const binding = blockNoteDocumentBinding.fromBytes(
      new Uint8Array(32).fill(1),
    );
    const verifier = createBlockNoteCommentAnchorVerifier({
      documentBinding: binding,
      definitionFingerprint: "fingerprint",
      verificationBundle: bundle(1, [active]),
      mapAnchor: () => ({ status: "attached", range: { from: 1, to: 2 } }),
    });
    const valid = await anchor({
      keyId: active.keyId,
      privateKey: active.pair.privateKey,
      binding,
    });
    const inspected = blockNoteCommentAnchorInternals.inspectAnchor(valid);
    const tampered = blockNoteCommentAnchorInternals.createAnchor({
      ...inspected,
      signature: Uint8Array.from(inspected.signature, (byte, index) =>
        index === 0 ? byte ^ 1 : byte,
      ),
    });
    await expect(verifier.verifyAndMap(tampered)).rejects.toMatchObject({
      code: "invalid-anchor",
    });
    await expect(
      verifier.verifyAndMap(
        await anchor({
          keyId: active.keyId,
          privateKey: active.pair.privateKey,
          binding: blockNoteDocumentBinding.fromBytes(
            new Uint8Array(32).fill(2),
          ),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-anchor" });
    await expect(
      verifier.verifyAndMap(
        await anchor({
          keyId: active.keyId,
          privateKey: active.pair.privateKey,
          binding,
          fingerprint: "foreign",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-anchor" });
  });

  it("deduplicates one monotonic unknown-key refresh", async () => {
    const old = await key("old");
    const next = await key("next");
    const binding = blockNoteDocumentBinding.fromBytes(
      new Uint8Array(32).fill(3),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      await gate;
      return bundle(2, [old, next]);
    });
    const verifier = createBlockNoteCommentAnchorVerifier({
      documentBinding: binding,
      definitionFingerprint: "fingerprint",
      verificationBundle: bundle(1, [old]),
      refresh,
      mapAnchor: () => ({ status: "attached", range: { from: 1, to: 2 } }),
    });
    const value = await anchor({
      keyId: next.keyId,
      privateKey: next.pair.privateKey,
      binding,
    });
    const first = verifier.verifyAndMap(value);
    const second = verifier.verifyAndMap(value);
    release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting refresh keys and unavailable Ed25519", async () => {
    const active = await key("active");
    const conflict = await key("active");
    const unknown = await key("unknown");
    const binding = blockNoteDocumentBinding.fromBytes(
      new Uint8Array(32).fill(4),
    );
    const verifier = createBlockNoteCommentAnchorVerifier({
      documentBinding: binding,
      definitionFingerprint: "fingerprint",
      verificationBundle: bundle(1, [active]),
      refresh: async () => bundle(2, [conflict, unknown]),
      mapAnchor: () => ({ status: "detached" }),
    });
    await expect(
      verifier.verifyAndMap(
        await anchor({
          keyId: unknown.keyId,
          privateKey: unknown.pair.privateKey,
          binding,
        }),
      ),
    ).rejects.toMatchObject({ code: "incompatible-document" });

    vi.stubGlobal("crypto", undefined);
    try {
      expect(() =>
        createBlockNoteCommentAnchorVerifier({
          documentBinding: binding,
          definitionFingerprint: "fingerprint",
          verificationBundle: bundle(1, [active]),
          mapAnchor: () => ({ status: "detached" }),
        }),
      ).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
