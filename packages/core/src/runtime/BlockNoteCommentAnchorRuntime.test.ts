import { describe, expect, it } from "vite-plus/test";

import { blockNoteCommentAnchorInternals } from "../comments/internal.js";
import { blockNoteDocumentBinding } from "../persistence/BlockNoteDocumentBinding.js";
import {
  createBlockNoteCommentAnchorRuntime,
  installBlockNoteCommentAnchorProtocol,
} from "./BlockNoteCommentAnchorRuntime.js";

describe("BlockNoteCommentAnchorRuntime", () => {
  it("installs separately from runtime-v1 and rejects anchor realm mismatch before mapping", () => {
    const target = {};
    const protocol = installBlockNoteCommentAnchorProtocol(target);
    const binding = blockNoteDocumentBinding.fromBytes(
      new Uint8Array(32).fill(1),
    );
    const otherBinding = blockNoteDocumentBinding.fromBytes(
      new Uint8Array(32).fill(2),
    );
    let mapped = 0;
    const runtime = createBlockNoteCommentAnchorRuntime({
      definitionFingerprint: "definition-a",
      documentBinding: binding,
      mapping: {
        capture: () =>
          blockNoteCommentAnchorInternals.createCapture({
            from: Uint8Array.of(0, 1, 1, 0),
            to: Uint8Array.of(0, 1, 2, 1),
          }),
        mapCapture: () => ({ status: "attached", range: { from: 1, to: 2 } }),
        mapAnchor: () => {
          mapped += 1;
          return { status: "attached", range: { from: 1, to: 2 } };
        },
      },
    });
    const anchor = blockNoteCommentAnchorInternals.createAnchor({
      keyId: "key",
      documentBinding: otherBinding,
      definitionFingerprint: "definition-a",
      from: Uint8Array.of(0, 1, 1, 0),
      to: Uint8Array.of(0, 1, 2, 1),
      signature: new Uint8Array(64),
    });

    expect(
      Object.getOwnPropertyDescriptor(
        target,
        Symbol.for("@blocknote/core/runtime/v1"),
      ),
    ).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(
        target,
        Symbol.for("@blocknote/core/comment-anchor-runtime/v1"),
      ),
    ).toMatchObject({
      configurable: false,
      enumerable: false,
      value: protocol,
      writable: false,
    });
    expect(() => runtime.mapAnchor(anchor)).toThrow();
    expect(mapped).toBe(0);
  });
});
