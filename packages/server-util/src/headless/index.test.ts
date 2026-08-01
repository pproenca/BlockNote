import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  BlockNoteError,
  blockNotePersistence,
  isBlockNoteError,
  type BlockNoteCheckpoint,
} from "./index.js";

describe("headless persistence facade", () => {
  it("round-trips framed values without exposing mutable bytes", () => {
    const frame = Uint8Array.from([66, 78, 1, 1, 0, 0, 0, 0]);
    const checkpoint = blockNotePersistence.checkpointFromBytes(frame);
    const returned = blockNotePersistence.checkpointToBytes(checkpoint);

    frame.fill(0);
    returned.fill(0);

    expect(blockNotePersistence.checkpointToBytes(checkpoint)).toEqual(
      Uint8Array.from([66, 78, 1, 1, 0, 0, 0, 0]),
    );
    expectTypeOf(checkpoint).toEqualTypeOf<BlockNoteCheckpoint>();
  });

  it("exposes stable headless errors", () => {
    let failure: unknown;
    try {
      blockNotePersistence.checkpointFromBytes(Uint8Array.of(1));
    } catch (error) {
      failure = error;
    }

    expect(isBlockNoteError(failure)).toBe(true);
    expect(failure).toBeInstanceOf(BlockNoteError);
    expect(failure).toMatchObject({
      code: "invalid-document",
      retryable: false,
    });
  });
});
