import type { BlockNoteDocumentBinding } from "../persistence/BlockNoteDocumentBinding.js";
import type { BlockNoteCommentAnchor } from "./external/BlockNoteCommentAnchor.js";
import type { BlockNoteCommentAnchorCapture } from "./external/BlockNoteCommentAnchorCapture.js";
import type { BlockNoteCommentAnchorVerificationBundle } from "./external/BlockNoteCommentAnchorVerificationBundle.js";
import { blockNoteCommentAnchorProtocol } from "../runtime/BlockNoteCommentAnchorRuntime.js";
import {
  encodeAnchorFrame,
  encodeCaptureFrame,
  encodeVerificationBundleFrame,
  signatureMessage,
} from "./external/comment-anchor-frame.js";

/** @internal */
export const blockNoteCommentAnchorInternals = Object.freeze({
  createCapture(input: { readonly from: Uint8Array; readonly to: Uint8Array }) {
    return blockNoteCommentAnchorProtocol.createValue(
      "capture",
      encodeCaptureFrame(input),
    ) as BlockNoteCommentAnchorCapture;
  },
  inspectCapture(value: BlockNoteCommentAnchorCapture) {
    return blockNoteCommentAnchorProtocol.inspectCapture(value);
  },
  createAnchor(input: {
    readonly keyId: string;
    readonly documentBinding: BlockNoteDocumentBinding;
    readonly definitionFingerprint: string;
    readonly from: Uint8Array;
    readonly to: Uint8Array;
    readonly signature: Uint8Array;
  }) {
    const documentBinding = blockNoteCommentAnchorProtocol.readBinding(
      input.documentBinding,
    );
    if (!documentBinding) {
      throw new TypeError("BlockNote document binding is invalid.");
    }
    return blockNoteCommentAnchorProtocol.createValue(
      "anchor",
      encodeAnchorFrame({ ...input, documentBinding }),
    ) as BlockNoteCommentAnchor;
  },
  inspectAnchor(value: BlockNoteCommentAnchor) {
    return blockNoteCommentAnchorProtocol.inspectAnchor(value);
  },
  createVerificationBundle(input: {
    readonly revision: number;
    readonly keys: readonly {
      readonly keyId: string;
      readonly publicKey: Uint8Array;
    }[];
  }) {
    return blockNoteCommentAnchorProtocol.createValue(
      "verification",
      encodeVerificationBundleFrame(input),
    ) as BlockNoteCommentAnchorVerificationBundle;
  },
  inspectVerificationBundle(value: BlockNoteCommentAnchorVerificationBundle) {
    return blockNoteCommentAnchorProtocol.inspectVerificationBundle(value);
  },
  signatureMessage,
});
