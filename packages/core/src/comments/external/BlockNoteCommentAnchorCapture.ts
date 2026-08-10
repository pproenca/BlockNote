import { BlockNoteError } from "../../platform/BlockNoteError.js";
import { blockNoteCommentAnchorProtocol } from "../../runtime/BlockNoteCommentAnchorRuntime.js";
import {
  BLOCK_NOTE_COMMENT_ANCHOR_MAX_FRAME_BYTES,
  decodeBase64Url,
  encodeBase64Url,
} from "./comment-anchor-frame.js";

declare const blockNoteCommentAnchorCaptureOpaque: unique symbol;

export interface BlockNoteCommentAnchorCapture {
  readonly kind: "blocknote-comment-anchor-capture";
  readonly byteLength: number;
  readonly [blockNoteCommentAnchorCaptureOpaque]: "comment-anchor-capture";
}

export const blockNoteCommentAnchorCapture = Object.freeze({
  serialize(value: BlockNoteCommentAnchorCapture) {
    const frame = blockNoteCommentAnchorProtocol.readValue(value, "capture");
    if (!frame) {
      throw new BlockNoteError(
        "invalid-anchor",
        "BlockNote comment anchor capture is invalid.",
      );
    }
    return encodeBase64Url(frame);
  },
  parse(value: string) {
    return blockNoteCommentAnchorProtocol.createValue(
      "capture",
      decodeBase64Url(value, BLOCK_NOTE_COMMENT_ANCHOR_MAX_FRAME_BYTES),
    ) as BlockNoteCommentAnchorCapture;
  },
});
