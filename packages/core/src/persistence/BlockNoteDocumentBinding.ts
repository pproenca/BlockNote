import { BlockNoteError } from "../platform/BlockNoteError.js";
import { blockNoteCommentAnchorProtocol } from "../runtime/BlockNoteCommentAnchorRuntime.js";

declare const blockNoteDocumentBindingOpaque: unique symbol;

export interface BlockNoteDocumentBinding {
  readonly kind: "blocknote-document-binding";
  readonly byteLength: 32;
  readonly [blockNoteDocumentBindingOpaque]: "document-binding";
}

export const blockNoteDocumentBinding = Object.freeze({
  fromBytes(value: Uint8Array) {
    return blockNoteCommentAnchorProtocol.createBinding(value);
  },
  toBytes(value: BlockNoteDocumentBinding) {
    const bytes = blockNoteCommentAnchorProtocol.readBinding(value);
    if (!bytes) {
      throw new BlockNoteError(
        "invalid-document",
        "BlockNote document binding is invalid.",
      );
    }
    return bytes;
  },
});
