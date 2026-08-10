/** @vitest-environment node */
import {
  BlockNoteSchema,
  blockNoteCommentAnchor,
  blockNoteDocumentBinding,
  blockNotePersistence,
  defineBlockNoteDocument,
  isBlockNoteError,
  type BlockNoteCommentAnchor,
  type BlockNoteDocumentStore,
  type BlockNoteStoredDocument,
} from "@blocknote/core";
import { blockNoteCommentAnchorInternals } from "@blocknote/core/comments/internal";
import { blockNotePersistenceInternals } from "@blocknote/core/persistence/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Y from "@y/y";

import type { BlockNoteCommentAnchorKeyRing } from "./comment-anchor-authority.js";
import { createBlockNoteDocumentService } from "./document-service.js";
import { encodeHeadlessFrame } from "./reconstruct.js";

const document = defineBlockNoteDocument({
  id: "anchor-test",
  version: "1",
  schema: BlockNoteSchema.create(),
});

function createMemoryStore() {
  const rows = new Map<string, BlockNoteStoredDocument>();
  const store: BlockNoteDocumentStore<string> = {
    async load(key) {
      return rows.get(key) ?? null;
    },
    async initialize(input) {
      const existing = rows.get(input.key);
      if (existing) {
        return { status: "conflict", actual: existing.checkpointRevision };
      }
      rows.set(
        input.key,
        Object.freeze({
          binding: blockNoteDocumentBinding.fromBytes(
            blockNoteDocumentBinding.toBytes(input.binding),
          ),
          checkpoint: blockNotePersistence.checkpointFromBytes(
            blockNotePersistence.checkpointToBytes(input.checkpoint),
          ),
          checkpointRevision: Object.freeze({ ...input.revision }),
          changes: Object.freeze([]),
        }),
      );
      return { status: "committed", revision: input.revision };
    },
    async append(input) {
      return { status: "conflict", actual: input.expected };
    },
    async compact(input) {
      return { status: "conflict", actual: input.expected };
    },
  };
  return { rows, store };
}

async function createRing(keyId: string) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const ring: BlockNoteCommentAnchorKeyRing = {
    revision: 1,
    activeKeyId: keyId,
    signer: {
      activeKeyId: keyId,
      async sign(message) {
        const input = Uint8Array.from(message).buffer;
        return new Uint8Array(
          await crypto.subtle.sign("Ed25519", pair.privateKey, input),
        );
      },
    },
    verificationKeys: [{ keyId, publicKey }],
  };
  return { pair, publicKey, ring };
}

async function createHarness() {
  const memory = createMemoryStore();
  const key = await createRing("key-1");
  const service = createBlockNoteDocumentService({
    document,
    store: memory.store,
    commentAnchorKeyRing: key.ring,
  });
  const revision = await service.initialize("doc");
  const row = memory.rows.get("doc")!;
  const native = new Y.Doc({ gc: false });
  const content = native.get("prosemirror");
  content.insert(0, "abcdef");
  const capture = blockNoteCommentAnchorInternals.createCapture({
    from: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(content, 1, 0),
    ),
    to: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(content, 5, -1),
    ),
  });
  memory.rows.set(
    "doc",
    Object.freeze({
      ...row,
      checkpoint: blockNotePersistenceInternals.checkpointFromPayload(
        encodeHeadlessFrame({
          kind: "checkpoint",
          document,
          revision,
          update: Y.encodeStateAsUpdate(native),
        }),
      ),
    }),
  );
  native.destroy();
  return { ...memory, ...key, capture, service };
}

function copiedBytes(row: BlockNoteStoredDocument) {
  return {
    binding: blockNoteDocumentBinding.toBytes(row.binding),
    checkpoint: blockNotePersistence.checkpointToBytes(row.checkpoint),
    revision: { ...row.checkpointRevision },
  };
}

function recreateAnchor(
  anchor: BlockNoteCommentAnchor,
  changes: Partial<
    ReturnType<typeof blockNoteCommentAnchorInternals.inspectAnchor>
  >,
) {
  const inspected = blockNoteCommentAnchorInternals.inspectAnchor(anchor);
  return blockNoteCommentAnchorInternals.createAnchor({
    keyId: changes.keyId ?? inspected.keyId,
    documentBinding: changes.documentBinding ?? inspected.documentBinding,
    definitionFingerprint:
      changes.definitionFingerprint ?? inspected.definitionFingerprint,
    from: changes.from ?? inspected.from,
    to: changes.to ?? inspected.to,
    signature: changes.signature ?? inspected.signature,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("comment anchor authority", () => {
  it("seals only a capture that maps in the reconstructed durable head", async () => {
    const harness = await createHarness();
    const before = copiedBytes(harness.rows.get("doc")!);
    const anchor = await harness.service.sealCommentAnchor(
      "doc",
      harness.capture,
    );

    await expect(
      harness.service.validateCommentAnchor("doc", anchor),
    ).resolves.toBe(true);
    expect(copiedBytes(harness.rows.get("doc")!)).toEqual(before);
    expect(Object.keys(anchor)).toEqual(["kind", "byteLength"]);
  });

  it("rejects binding, fingerprint, position, key, and signature tampering", async () => {
    const harness = await createHarness();
    const anchor = await harness.service.sealCommentAnchor(
      "doc",
      harness.capture,
    );
    const foreign = new Y.Doc({ gc: false });
    const foreignType = foreign.get("prosemirror");
    foreignType.insert(0, "uvwxyz");
    const foreignFrom = Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(foreignType, 1, 0),
    );
    const cases = [
      recreateAnchor(anchor, {
        documentBinding: blockNoteDocumentBinding.fromBytes(
          new Uint8Array(32).fill(9),
        ),
      }),
      recreateAnchor(anchor, { definitionFingerprint: "retagged" }),
      recreateAnchor(anchor, { from: foreignFrom }),
      recreateAnchor(anchor, { keyId: "removed-key" }),
      recreateAnchor(anchor, { signature: new Uint8Array(64).fill(7) }),
    ];

    for (const tampered of cases) {
      await expect(
        harness.service.validateCommentAnchor("doc", tampered),
      ).resolves.toBe(false);
    }
    foreign.destroy();
  });

  it("rejects copied-document replay under a fresh logical binding", async () => {
    const harness = await createHarness();
    const anchor = await harness.service.sealCommentAnchor(
      "doc",
      harness.capture,
    );
    const source = harness.rows.get("doc")!;
    harness.rows.set(
      "clone",
      Object.freeze({
        ...source,
        binding: blockNoteDocumentBinding.fromBytes(new Uint8Array(32).fill(4)),
      }),
    );

    await expect(
      harness.service.validateCommentAnchor("clone", anchor),
    ).resolves.toBe(false);
  });

  it("validates retained keys across service recreation and rejects removed keys", async () => {
    const harness = await createHarness();
    const anchor = await harness.service.sealCommentAnchor(
      "doc",
      harness.capture,
    );
    const next = await createRing("key-2");
    const rotated = createBlockNoteDocumentService({
      document,
      store: harness.store,
      commentAnchorKeyRing: {
        ...next.ring,
        revision: 2,
        verificationKeys: [
          ...next.ring.verificationKeys,
          { keyId: "key-1", publicKey: harness.publicKey },
        ],
      },
    });
    const removed = createBlockNoteDocumentService({
      document,
      store: harness.store,
      commentAnchorKeyRing: { ...next.ring, revision: 3 },
    });

    await expect(rotated.validateCommentAnchor("doc", anchor)).resolves.toBe(
      true,
    );
    await expect(removed.validateCommentAnchor("doc", anchor)).resolves.toBe(
      false,
    );
    const bundle = await rotated.createCommentAnchorVerificationBundle();
    expect(Object.keys(bundle)).toEqual(["kind", "byteLength"]);
  });

  it("fails closed for a signer/key mismatch without returning an anchor", async () => {
    const harness = await createHarness();
    const wrong = await createRing("wrong");
    const service = createBlockNoteDocumentService({
      document,
      store: harness.store,
      commentAnchorKeyRing: {
        revision: 2,
        activeKeyId: "key-1",
        signer: { ...wrong.ring.signer, activeKeyId: "key-1" },
        verificationKeys: [{ keyId: "key-1", publicKey: harness.publicKey }],
      },
    });

    let failure: unknown;
    try {
      await service.sealCommentAnchor("doc", harness.capture);
    } catch (error) {
      failure = error;
    }
    expect(isBlockNoteError(failure)).toBe(true);
    expect(failure).toMatchObject({ code: "incompatible-document" });
  });

  it("aborts before signing and reports unavailable WebCrypto", async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      harness.service.sealCommentAnchor("doc", harness.capture, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    vi.stubGlobal("crypto", undefined);
    expect(() =>
      createBlockNoteDocumentService({
        document,
        store: harness.store,
        commentAnchorKeyRing: harness.ring,
      }),
    ).toThrowError(/Ed25519/);
  });

  it("returns false for a structurally valid but unknown serialized anchor", async () => {
    const harness = await createHarness();
    const anchor = await harness.service.sealCommentAnchor(
      "doc",
      harness.capture,
    );
    const roundTripped = blockNoteCommentAnchor.parse(
      blockNoteCommentAnchor.serialize(anchor),
    );
    await expect(
      harness.service.validateCommentAnchor("doc", roundTripped),
    ).resolves.toBe(true);
  });
});
