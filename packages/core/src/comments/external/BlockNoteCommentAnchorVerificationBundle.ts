import { BlockNoteError } from "../../platform/BlockNoteError.js";
import { blockNoteCommentAnchorProtocol } from "../../runtime/BlockNoteCommentAnchorRuntime.js";
import {
  BLOCK_NOTE_COMMENT_ANCHOR_MAX_BUNDLE_BYTES,
  decodeBase64Url,
  encodeBase64Url,
} from "./comment-anchor-frame.js";

declare const blockNoteCommentAnchorVerificationOpaque: unique symbol;

export interface BlockNoteCommentAnchorVerificationBundle {
  readonly kind: "blocknote-comment-anchor-verification";
  readonly byteLength: number;
  readonly [blockNoteCommentAnchorVerificationOpaque]: "verification-bundle";
}

export const blockNoteCommentAnchorVerificationBundle = Object.freeze({
  serialize(value: BlockNoteCommentAnchorVerificationBundle) {
    const frame = blockNoteCommentAnchorProtocol.readValue(
      value,
      "verification",
    );
    if (!frame) {
      throw new BlockNoteError(
        "invalid-anchor",
        "BlockNote verification bundle is invalid.",
      );
    }
    return encodeBase64Url(frame);
  },
  parse(value: string) {
    return blockNoteCommentAnchorProtocol.createValue(
      "verification",
      decodeBase64Url(value, BLOCK_NOTE_COMMENT_ANCHOR_MAX_BUNDLE_BYTES),
    ) as BlockNoteCommentAnchorVerificationBundle;
  },
});
