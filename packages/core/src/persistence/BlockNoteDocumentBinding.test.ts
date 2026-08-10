import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { isBlockNoteError } from "../platform/BlockNoteError.js";
import {
  blockNoteDocumentBinding,
  type BlockNoteDocumentBinding,
} from "./BlockNoteDocumentBinding.js";

describe("blockNoteDocumentBinding", () => {
  it("copies exactly 32 opaque bytes on ingress and egress", () => {
    const input = Uint8Array.from({ length: 32 }, (_, index) => index);
    const binding = blockNoteDocumentBinding.fromBytes(input);
    const first = blockNoteDocumentBinding.toBytes(binding);

    input.fill(255);
    first.fill(254);

    expect(binding).toEqual({
      kind: "blocknote-document-binding",
      byteLength: 32,
    });
    expect(Object.keys(binding)).toEqual(["kind", "byteLength"]);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(blockNoteDocumentBinding.toBytes(binding)).toEqual(
      Uint8Array.from({ length: 32 }, (_, index) => index),
    );
    expectTypeOf(binding).toEqualTypeOf<BlockNoteDocumentBinding>();
  });

  it("rejects wrong-sized and forged values", () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array(31),
      new Uint8Array(33),
    ]) {
      let failure: unknown;
      try {
        blockNoteDocumentBinding.fromBytes(bytes);
      } catch (error) {
        failure = error;
      }
      expect(isBlockNoteError(failure)).toBe(true);
      expect(failure).toMatchObject({ code: "invalid-document" });
    }

    expect(() =>
      blockNoteDocumentBinding.toBytes(
        Object.freeze({
          kind: "blocknote-document-binding",
          byteLength: 32,
        }) as BlockNoteDocumentBinding,
      ),
    ).toThrow();
  });
});
