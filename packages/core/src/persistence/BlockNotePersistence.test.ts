import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { isBlockNoteError } from "../platform/BlockNoteError.js";
import {
  blockNotePersistence,
  type BlockNoteBootstrap,
  type BlockNoteChange,
  type BlockNoteCheckpoint,
  type BlockNoteRevision,
} from "./BlockNotePersistence.js";
import {
  BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES,
  BLOCK_NOTE_PERSISTENCE_MAX_FRAME_BYTES,
  BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES,
} from "./BlockNotePersistenceFrame.js";
import { blockNotePersistenceInternals } from "./BlockNotePersistenceInternals.js";

function captureFailure(action: () => void) {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  return failure;
}

function expectFailure(
  action: () => void,
  code: "document-too-large" | "incompatible-document" | "invalid-document",
  message?: string,
) {
  const failure = captureFailure(action);
  expect(isBlockNoteError(failure)).toBe(true);
  expect(failure).toMatchObject({ code, retryable: false });
  if (message) {
    expect(failure).toMatchObject({ message });
  }
}

describe("blockNotePersistence", () => {
  it("exposes only branded metadata and exact serialized byte length", () => {
    const checkpoint = blockNotePersistenceInternals.checkpointFromPayload(
      Uint8Array.from([1, 2, 3]),
    );
    const change = blockNotePersistenceInternals.changeFromPayload(
      Uint8Array.from([4, 5]),
    );
    const revision: BlockNoteRevision = { sequence: 7, token: "revision-7" };

    expect(checkpoint).toEqual({
      kind: "blocknote-checkpoint",
      byteLength: BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES + 3,
    });
    expect(change).toEqual({
      kind: "blocknote-change",
      byteLength: BLOCK_NOTE_PERSISTENCE_FRAME_HEADER_BYTES + 2,
    });
    expect(blockNotePersistence.checkpointToBytes(checkpoint)).toHaveLength(
      checkpoint.byteLength,
    );
    expect(blockNotePersistence.changeToBytes(change)).toHaveLength(
      change.byteLength,
    );
    expect(Object.isFrozen(checkpoint)).toBe(true);
    expect(Object.isFrozen(change)).toBe(true);
    expect(revision).toEqual({ sequence: 7, token: "revision-7" });
    expectTypeOf(checkpoint).toEqualTypeOf<BlockNoteCheckpoint>();
    expectTypeOf(change).toEqualTypeOf<BlockNoteChange>();
  });

  it("copies caller payloads, decoded frames, and encoded output", () => {
    const payload = Uint8Array.from([9, 8, 7, 6]);
    const checkpoint =
      blockNotePersistenceInternals.checkpointFromPayload(payload);
    const frame = blockNotePersistence.checkpointToBytes(checkpoint);
    const decoded = blockNotePersistence.checkpointFromBytes(frame);
    const stableFrame = blockNotePersistence.checkpointToBytes(decoded);

    payload.fill(0);
    frame.fill(0);
    expect(
      blockNotePersistenceInternals.checkpointToPayload(checkpoint),
    ).toEqual(Uint8Array.from([9, 8, 7, 6]));
    expect(blockNotePersistence.checkpointToBytes(decoded)).toEqual(
      stableFrame,
    );

    const returned = blockNotePersistence.checkpointToBytes(decoded);
    returned.fill(255);
    expect(blockNotePersistence.checkpointToBytes(decoded)).toEqual(
      stableFrame,
    );

    const returnedPayload =
      blockNotePersistenceInternals.checkpointToPayload(decoded);
    returnedPayload.fill(3);
    expect(blockNotePersistenceInternals.checkpointToPayload(decoded)).toEqual(
      Uint8Array.from([9, 8, 7, 6]),
    );
  });

  it("round-trips change frames without sharing mutable bytes", () => {
    const payload = Uint8Array.from([0, 255, 128, 42]);
    const change = blockNotePersistenceInternals.changeFromPayload(payload);
    const frame = blockNotePersistence.changeToBytes(change);
    const decoded = blockNotePersistence.changeFromBytes(frame);

    payload.fill(1);
    frame.fill(2);
    expect(blockNotePersistenceInternals.changeToPayload(change)).toEqual(
      Uint8Array.from([0, 255, 128, 42]),
    );
    expect(blockNotePersistenceInternals.changeToPayload(decoded)).toEqual(
      Uint8Array.from([0, 255, 128, 42]),
    );

    const stableFrame = blockNotePersistence.changeToBytes(decoded);
    const returnedFrame = blockNotePersistence.changeToBytes(decoded);
    returnedFrame.fill(3);
    expect(blockNotePersistence.changeToBytes(decoded)).toEqual(stableFrame);

    const returnedPayload =
      blockNotePersistenceInternals.changeToPayload(decoded);
    returnedPayload.fill(4);
    expect(blockNotePersistenceInternals.changeToPayload(decoded)).toEqual(
      Uint8Array.from([0, 255, 128, 42]),
    );
  });

  it("rejects wrong-kind frames and values stably", () => {
    const checkpoint = blockNotePersistenceInternals.checkpointFromPayload(
      Uint8Array.of(1),
    );
    const frame = blockNotePersistence.checkpointToBytes(checkpoint);

    expectFailure(
      () => blockNotePersistence.changeFromBytes(frame),
      "invalid-document",
      "BlockNote persistence frame has the wrong kind.",
    );
    expectFailure(
      () =>
        blockNotePersistence.changeToBytes(
          checkpoint as unknown as BlockNoteChange,
        ),
      "invalid-document",
      "BlockNote persistence value has the wrong kind.",
    );
  });

  it("rejects truncated and trailing frames stably", () => {
    const checkpoint = blockNotePersistenceInternals.checkpointFromPayload(
      Uint8Array.from([1, 2, 3]),
    );
    const frame = blockNotePersistence.checkpointToBytes(checkpoint);

    expectFailure(
      () => blockNotePersistence.checkpointFromBytes(frame.slice(0, -1)),
      "invalid-document",
      "BlockNote persistence frame is truncated.",
    );
    expectFailure(
      () =>
        blockNotePersistence.checkpointFromBytes(
          Uint8Array.from([...frame, 4]),
        ),
      "invalid-document",
      "BlockNote persistence frame has trailing bytes.",
    );
  });

  it("rejects oversized payload declarations before payload parsing", () => {
    const checkpoint = blockNotePersistenceInternals.checkpointFromPayload(
      Uint8Array.of(1),
    );
    const frame = blockNotePersistence.checkpointToBytes(checkpoint);
    const oversizedLength = BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES + 1;
    frame[4] = (oversizedLength >>> 24) & 0xff;
    frame[5] = (oversizedLength >>> 16) & 0xff;
    frame[6] = (oversizedLength >>> 8) & 0xff;
    frame[7] = oversizedLength & 0xff;

    expectFailure(
      () => blockNotePersistence.checkpointFromBytes(frame),
      "document-too-large",
    );
    expectFailure(
      () =>
        blockNotePersistenceInternals.changeFromPayload(
          new Uint8Array(BLOCK_NOTE_PERSISTENCE_MAX_PAYLOAD_BYTES + 1),
        ),
      "document-too-large",
    );
    expectFailure(
      () =>
        blockNotePersistence.checkpointFromBytes(
          new Uint8Array(BLOCK_NOTE_PERSISTENCE_MAX_FRAME_BYTES + 1),
        ),
      "document-too-large",
    );
  });

  it("rejects incompatible frame versions stably", () => {
    const checkpoint = blockNotePersistenceInternals.checkpointFromPayload(
      Uint8Array.of(1),
    );
    const frame = blockNotePersistence.checkpointToBytes(checkpoint);
    frame[2] = 2;

    expectFailure(
      () => blockNotePersistence.checkpointFromBytes(frame),
      "incompatible-document",
      "BlockNote persistence frame version is incompatible.",
    );
  });

  it("rejects malformed framing and forged values stably", () => {
    const checkpoint = blockNotePersistenceInternals.checkpointFromPayload(
      Uint8Array.of(1),
    );
    const frame = blockNotePersistence.checkpointToBytes(checkpoint);
    frame[0] = 0;

    expectFailure(
      () => blockNotePersistence.checkpointFromBytes(frame),
      "invalid-document",
    );
    expectFailure(
      () =>
        blockNotePersistence.checkpointFromBytes(
          "not bytes" as unknown as Uint8Array,
        ),
      "invalid-document",
    );

    const detached = Uint8Array.of(1);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expectFailure(
      () => blockNotePersistence.checkpointFromBytes(detached),
      "invalid-document",
    );
    expectFailure(
      () => blockNotePersistenceInternals.changeFromPayload(detached),
      "invalid-document",
    );
    expectFailure(
      () =>
        blockNotePersistence.checkpointToBytes({
          kind: "blocknote-checkpoint",
          byteLength: 9,
        } as BlockNoteCheckpoint),
      "invalid-document",
    );
  });
});

describe("BlockNoteBootstrap", () => {
  it("is a transport-safe branded string with private copied payload access", () => {
    const payload = Uint8Array.from([0, 255, 1, 128, 42]);
    const bootstrap =
      blockNotePersistenceInternals.bootstrapFromPayload(payload);
    const transported = JSON.parse(
      JSON.stringify(bootstrap),
    ) as BlockNoteBootstrap;

    payload.fill(7);
    expect(bootstrap).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(transported).toBe(bootstrap);
    expect(
      blockNotePersistenceInternals.bootstrapToPayload(transported),
    ).toEqual(Uint8Array.from([0, 255, 1, 128, 42]));

    const returned =
      blockNotePersistenceInternals.bootstrapToPayload(transported);
    returned.fill(9);
    expect(
      blockNotePersistenceInternals.bootstrapToPayload(transported),
    ).toEqual(Uint8Array.from([0, 255, 1, 128, 42]));
    expectTypeOf(bootstrap).toEqualTypeOf<BlockNoteBootstrap>();
  });

  it("rejects malformed and truncated transport strings stably", () => {
    const bootstrap = blockNotePersistenceInternals.bootstrapFromPayload(
      Uint8Array.from([1, 2, 3]),
    );

    expectFailure(
      () =>
        blockNotePersistenceInternals.bootstrapToPayload(
          "not+base64" as BlockNoteBootstrap,
        ),
      "invalid-document",
    );
    expectFailure(
      () =>
        blockNotePersistenceInternals.bootstrapToPayload(
          bootstrap.slice(0, -1) as BlockNoteBootstrap,
        ),
      "invalid-document",
    );
    expectFailure(
      () =>
        blockNotePersistenceInternals.bootstrapToPayload(
          `${bootstrap}A` as BlockNoteBootstrap,
        ),
      "invalid-document",
    );

    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastCharacter = bootstrap.at(-1)!;
    const noncanonical =
      bootstrap.slice(0, -1) + alphabet[alphabet.indexOf(lastCharacter) + 1]!;
    expectFailure(
      () =>
        blockNotePersistenceInternals.bootstrapToPayload(
          noncanonical as BlockNoteBootstrap,
        ),
      "invalid-document",
    );

    const maxBootstrapCharacters = Math.floor(
      (BLOCK_NOTE_PERSISTENCE_MAX_FRAME_BYTES * 4 + 2) / 3,
    );
    expectFailure(
      () =>
        blockNotePersistenceInternals.bootstrapToPayload(
          "A".repeat(maxBootstrapCharacters + 1) as BlockNoteBootstrap,
        ),
      "document-too-large",
    );
  });
});
