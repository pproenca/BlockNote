import * as Y from "@y/y";

import type { BlockNoteCommentAnchor } from "../../../comments/external/BlockNoteCommentAnchor.js";
import type { BlockNoteCommentAnchorCapture } from "../../../comments/external/BlockNoteCommentAnchorCapture.js";
import { blockNoteCommentAnchorInternals } from "../../../comments/internal.js";
import type {
  BlockNoteCommentAnchorMapping,
  BlockNoteCommentAnchorMappingResult,
} from "../../../runtime/BlockNoteCommentAnchorRuntime.js";

export function createYCommentAnchorMapping(options: {
  readonly doc: Y.Doc;
  readonly type: Y.Type;
  readonly renderer?: Y.AbstractRenderer | null;
}): BlockNoteCommentAnchorMapping {
  const renderer = options.renderer ?? null;

  function mapPositions(fromBytes: Uint8Array, toBytes: Uint8Array) {
    try {
      const fromRelative = Y.decodeRelativePosition(fromBytes);
      const toRelative = Y.decodeRelativePosition(toBytes);
      if (
        fromRelative.item === null ||
        toRelative.item === null ||
        fromRelative.assoc !== 0 ||
        toRelative.assoc !== -1
      ) {
        return { status: "unknown" } as const;
      }
      const from = Y.createAbsolutePositionFromRelativePosition(
        fromRelative,
        options.doc,
        false,
        renderer,
      );
      const to = Y.createAbsolutePositionFromRelativePosition(
        toRelative,
        options.doc,
        false,
        renderer,
      );
      if (
        !from ||
        !to ||
        from.type !== options.type ||
        to.type !== options.type
      ) {
        return { status: "unknown" } as const;
      }
      if (from.index >= to.index) {
        return { status: "detached" } as const;
      }
      return {
        status: "attached",
        range: { from: from.index, to: to.index },
      } as const;
    } catch {
      return { status: "unknown" } as const;
    }
  }

  function mapCapture(value: BlockNoteCommentAnchorCapture) {
    const inspected = blockNoteCommentAnchorInternals.inspectCapture(value);
    return mapPositions(inspected.from, inspected.to);
  }

  function mapAnchor(value: BlockNoteCommentAnchor) {
    const inspected = blockNoteCommentAnchorInternals.inspectAnchor(value);
    return mapPositions(inspected.from, inspected.to);
  }

  return Object.freeze({
    capture(range: { readonly from: number; readonly to: number }) {
      if (
        !Number.isSafeInteger(range.from) ||
        !Number.isSafeInteger(range.to) ||
        range.from < 0 ||
        range.to > options.type.length ||
        range.from >= range.to
      ) {
        throw new RangeError("BlockNote comment anchor range is invalid.");
      }
      return blockNoteCommentAnchorInternals.createCapture({
        from: Y.encodeRelativePosition(
          Y.createRelativePositionFromTypeIndex(
            options.type,
            range.from,
            0,
            renderer,
          ),
        ),
        to: Y.encodeRelativePosition(
          Y.createRelativePositionFromTypeIndex(
            options.type,
            range.to,
            -1,
            renderer,
          ),
        ),
      }) as BlockNoteCommentAnchorCapture;
    },
    mapCapture,
    mapAnchor,
  }) satisfies BlockNoteCommentAnchorMapping & {
    mapCapture(
      value: BlockNoteCommentAnchorCapture,
    ): BlockNoteCommentAnchorMappingResult;
  };
}
