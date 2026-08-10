import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  BlockNoteError,
  blockNotePersistence,
  createBlockNoteProjector,
  isBlockNoteError,
  type BlockNoteCheckpoint,
} from "@blocknote/server-util/headless";
import { BlockNoteSchema, defineBlockNoteDocument } from "@blocknote/core";

describe("headless persistence facade", () => {
  it("exports the opaque collaboration projector", () => {
    const project = createBlockNoteProjector(
      defineBlockNoteDocument({
        id: "headless-entrypoint",
        version: "1",
        schema: BlockNoteSchema.create(),
      }),
    );

    expectTypeOf<
      Parameters<typeof project>[0]["doc"]
    >().toEqualTypeOf<unknown>();
    expectTypeOf(project).toBeFunction();
  });

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
