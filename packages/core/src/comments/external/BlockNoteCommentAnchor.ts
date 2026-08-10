import { BlockNoteError } from "../../platform/BlockNoteError.js";
import { blockNoteCommentAnchorProtocol } from "../../runtime/BlockNoteCommentAnchorRuntime.js";
import {
  BLOCK_NOTE_COMMENT_ANCHOR_MAX_FRAME_BYTES,
  decodeBase64Url,
  encodeBase64Url,
} from "./comment-anchor-frame.js";

declare const blockNoteCommentAnchorOpaque: unique symbol;

export interface BlockNoteCommentAnchor {
  readonly kind: "blocknote-comment-anchor";
  readonly byteLength: number;
  readonly [blockNoteCommentAnchorOpaque]: "comment-anchor";
}

export const blockNoteCommentAnchor = Object.freeze({
  serialize(value: BlockNoteCommentAnchor) {
    const frame = blockNoteCommentAnchorProtocol.readValue(value, "anchor");
    if (!frame) {
      throw new BlockNoteError(
        "invalid-anchor",
        "BlockNote comment anchor is invalid.",
      );
    }
    return encodeBase64Url(frame);
  },
  parse(value: string) {
    return blockNoteCommentAnchorProtocol.createValue(
      "anchor",
      decodeBase64Url(value, BLOCK_NOTE_COMMENT_ANCHOR_MAX_FRAME_BYTES),
    ) as BlockNoteCommentAnchor;
  },
});
