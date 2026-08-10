export {
  blockNotePersistence,
  BlockNoteError,
  blockNoteErrorCodes,
  isBlockNoteError,
  type BlockNoteBootstrap,
  type BlockNoteChange,
  type BlockNoteCheckpoint,
  type BlockNoteErrorCode,
  type BlockNoteRevision,
  type BlockNoteDocumentBinding,
  type BlockNoteDocumentStore,
  type BlockNoteStoredDocument,
  type BlockNoteStoredChange,
  type BlockNoteCommitResult,
} from "@blocknote/core/persistence";
export {
  createBlockNoteDocumentService,
  type BlockNoteDocumentService,
  type BlockNoteDocumentServiceOptions,
} from "./document-service.js";
export type {
  BlockNoteCommentAnchorKeyRing,
  BlockNoteCommentAnchorSigner,
  BlockNoteCommentAnchorVerificationKey,
} from "./comment-anchor-authority.js";
export { bindBlockNoteSuggestionActor } from "./suggestion-validation.js";
export {
  createBlockNoteProjector,
  type BlockNoteProjection,
} from "./project.js";
