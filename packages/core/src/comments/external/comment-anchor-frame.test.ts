import { describe, expect, it } from "vite-plus/test";

import { isBlockNoteError } from "../../platform/BlockNoteError.js";
import { blockNoteDocumentBinding } from "../../persistence/BlockNoteDocumentBinding.js";
import { blockNoteCommentAnchor } from "./BlockNoteCommentAnchor.js";
import { blockNoteCommentAnchorCapture } from "./BlockNoteCommentAnchorCapture.js";
import { blockNoteCommentAnchorVerificationBundle } from "./BlockNoteCommentAnchorVerificationBundle.js";
import { decodeBase64Url, encodeBase64Url } from "./comment-anchor-frame.js";
import { blockNoteCommentAnchorInternals } from "../internal.js";

const from = Uint8Array.of(0, 1, 2, 0);
const to = Uint8Array.of(0, 1, 6, 1);

function expectInvalid(action: () => unknown) {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(isBlockNoteError(failure)).toBe(true);
  expect(failure).toMatchObject({ code: "invalid-anchor" });
}

describe("external comment anchor frames", () => {
  it("round-trips copied opaque capture, anchor, and verification values", () => {
    const binding = blockNoteDocumentBinding.fromBytes(
      new Uint8Array(32).fill(7),
    );
    const capture = blockNoteCommentAnchorInternals.createCapture({ from, to });
    const anchor = blockNoteCommentAnchorInternals.createAnchor({
      keyId: "key-1",
      documentBinding: binding,
      definitionFingerprint: "definition-v1",
      from,
      to,
      signature: new Uint8Array(64).fill(9),
    });
    const verification =
      blockNoteCommentAnchorInternals.createVerificationBundle({
        revision: 4,
        keys: [{ keyId: "key-1", publicKey: new Uint8Array(32).fill(3) }],
      });

    expect(
      blockNoteCommentAnchorCapture.parse(
        blockNoteCommentAnchorCapture.serialize(capture),
      ),
    ).toEqual(capture);
    expect(
      blockNoteCommentAnchor.parse(blockNoteCommentAnchor.serialize(anchor)),
    ).toEqual(anchor);
    expect(
      blockNoteCommentAnchorVerificationBundle.parse(
        blockNoteCommentAnchorVerificationBundle.serialize(verification),
      ),
    ).toEqual(verification);
    expect(Object.keys(capture)).toEqual(["kind", "byteLength"]);
    expect(Object.keys(anchor)).toEqual(["kind", "byteLength"]);
    expect(Object.keys(verification)).toEqual(["kind", "byteLength"]);

    from.fill(255);
    to.fill(255);
    expect(blockNoteCommentAnchorInternals.inspectCapture(capture)).toEqual({
      from: Uint8Array.of(0, 1, 2, 0),
      to: Uint8Array.of(0, 1, 6, 1),
    });
  });

  it("rejects non-canonical, truncated, trailing, oversized, and name-only frames", () => {
    const capture = blockNoteCommentAnchorInternals.createCapture({
      from: Uint8Array.of(0, 1, 2, 0),
      to: Uint8Array.of(0, 1, 6, 1),
    });
    const encoded = blockNoteCommentAnchorCapture.serialize(capture);

    expectInvalid(() => blockNoteCommentAnchorCapture.parse(`${encoded}=`));
    expectInvalid(() =>
      blockNoteCommentAnchorCapture.parse(encoded.slice(0, -2)),
    );
    expectInvalid(() => blockNoteCommentAnchorCapture.parse(`${encoded}AA`));
    expectInvalid(() =>
      blockNoteCommentAnchorInternals.createCapture({
        from: Uint8Array.of(1, 3, 100, 111, 99, 0),
        to: Uint8Array.of(0, 1, 6, 1),
      }),
    );
    expectInvalid(() =>
      blockNoteCommentAnchorInternals.createCapture({
        from: new Uint8Array(524_001),
        to: Uint8Array.of(0, 1, 6, 1),
      }),
    );
  });

  it("uses the exact signed payload and domain-separated message", () => {
    const binding = blockNoteDocumentBinding.fromBytes(
      new Uint8Array(32).fill(5),
    );
    const anchor = blockNoteCommentAnchorInternals.createAnchor({
      keyId: "k",
      documentBinding: binding,
      definitionFingerprint: "fp",
      from: Uint8Array.of(0, 1, 2, 0),
      to: Uint8Array.of(0, 1, 6, 1),
      signature: new Uint8Array(64).fill(8),
    });
    const inspected = blockNoteCommentAnchorInternals.inspectAnchor(anchor);
    const domain = new TextEncoder().encode("@blocknote/comment-anchor/v1\0");

    expect(inspected.payload.slice(0, 5)).toEqual(
      Uint8Array.of(66, 78, 67, 65, 1),
    );
    expect(inspected.signature).toEqual(new Uint8Array(64).fill(8));
    expect(
      blockNoteCommentAnchorInternals.signatureMessage(inspected.payload),
    ).toEqual(Uint8Array.from([...domain, ...inspected.payload]));
  });

  it("rejects incompatible anchor framing and invalid field encodings", () => {
    const binding = blockNoteDocumentBinding.fromBytes(new Uint8Array(32));
    const anchor = blockNoteCommentAnchorInternals.createAnchor({
      keyId: "k",
      documentBinding: binding,
      definitionFingerprint: "f",
      from: Uint8Array.of(0, 1, 2, 0),
      to: Uint8Array.of(0, 1, 6, 1),
      signature: new Uint8Array(64),
    });
    const frame = decodeBase64Url(
      blockNoteCommentAnchor.serialize(anchor),
      1024 * 1024,
    );

    for (const [index, value] of [
      [0, 0],
      [4, 2],
      [41, 0xff],
    ] as const) {
      const malformed = Uint8Array.from(frame);
      malformed[index] = value;
      expectInvalid(() =>
        blockNoteCommentAnchor.parse(encodeBase64Url(malformed)),
      );
    }
    expectInvalid(() =>
      blockNoteCommentAnchor.parse(
        encodeBase64Url(Uint8Array.from([...frame, 0])),
      ),
    );

    for (const keyId of ["", "é", "k".repeat(65)]) {
      expectInvalid(() =>
        blockNoteCommentAnchorInternals.createAnchor({
          keyId,
          documentBinding: binding,
          definitionFingerprint: "f",
          from: Uint8Array.of(0, 1, 2, 0),
          to: Uint8Array.of(0, 1, 6, 1),
          signature: new Uint8Array(64),
        }),
      );
    }
    expectInvalid(() =>
      blockNoteCommentAnchorInternals.createAnchor({
        keyId: "k",
        documentBinding: binding,
        definitionFingerprint: "f".repeat(256),
        from: Uint8Array.of(0, 1, 2, 0),
        to: Uint8Array.of(0, 1, 6, 1),
        signature: new Uint8Array(64),
      }),
    );
  });

  it("rejects unsafe, duplicate, excessive, and malformed verification keys", () => {
    for (const revision of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expectInvalid(() =>
        blockNoteCommentAnchorInternals.createVerificationBundle({
          revision,
          keys: [],
        }),
      );
    }
    expectInvalid(() =>
      blockNoteCommentAnchorInternals.createVerificationBundle({
        revision: 1,
        keys: [
          { keyId: "k", publicKey: new Uint8Array(32) },
          { keyId: "k", publicKey: new Uint8Array(32).fill(1) },
        ],
      }),
    );
    expectInvalid(() =>
      blockNoteCommentAnchorInternals.createVerificationBundle({
        revision: 1,
        keys: Array.from({ length: 65 }, (_, index) => ({
          keyId: `k-${index}`,
          publicKey: new Uint8Array(32),
        })),
      }),
    );

    const bundle = blockNoteCommentAnchorInternals.createVerificationBundle({
      revision: 1,
      keys: [
        { keyId: "a", publicKey: new Uint8Array(32) },
        { keyId: "b", publicKey: new Uint8Array(32) },
      ],
    });
    const duplicate = decodeBase64Url(
      blockNoteCommentAnchorVerificationBundle.serialize(bundle),
      16 * 1024,
    );
    duplicate[50] = duplicate[16]!;
    expectInvalid(() =>
      blockNoteCommentAnchorVerificationBundle.parse(
        encodeBase64Url(duplicate),
      ),
    );

    const unsafeRevision = Uint8Array.from(duplicate);
    unsafeRevision.fill(0xff, 5, 13);
    expectInvalid(() =>
      blockNoteCommentAnchorVerificationBundle.parse(
        encodeBase64Url(unsafeRevision),
      ),
    );
  });

  it("rejects non-canonical and overflowing relative-position integers", () => {
    for (const malformed of [
      Uint8Array.of(0x80, 0, 1, 2, 0),
      Uint8Array.of(0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0),
    ]) {
      expectInvalid(() =>
        blockNoteCommentAnchorInternals.createCapture({
          from: malformed,
          to: Uint8Array.of(0, 1, 6, 1),
        }),
      );
    }
  });
});
