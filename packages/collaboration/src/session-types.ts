import type {
  AnyBlockNoteDocumentDefinition,
  BlockNoteAccess,
  BlockNoteAccessStore,
  BlockNoteBootstrap,
  BlockNoteCommentAnchorVerificationBundle,
  BlockNoteEditorFor,
  BlockNoteError,
  BlockNoteRuntimeContext,
} from "@blocknote/core";

export interface BlockNoteSessionState {
  readonly phase: "starting" | "ready" | "failed";
  readonly readiness: "none" | "local" | "live";
  readonly connection: "connecting" | "online" | "offline" | "degraded";
  readonly durability: "saved" | "pending" | "offline" | "error";
  readonly access: BlockNoteAccess;
  readonly error?: BlockNoteError;
}

export interface BlockNoteRecoverySummary {
  readonly createdAt: Date;
  readonly byteLength: number;
}

export interface BlockNoteAccessRejection {
  readonly action: "edit" | "comment" | "suggest" | "review";
  readonly access: BlockNoteAccess;
}

export interface BlockNoteSessionEvents {
  readonly recoveryAvailable: BlockNoteRecoverySummary;
  readonly recoveryApplied: BlockNoteRecoverySummary;
  readonly accessRejected: BlockNoteAccessRejection;
  readonly fatalError: BlockNoteError;
}

export interface BlockNoteCommentAnchorKeyRefresh {
  readonly current: BlockNoteCommentAnchorVerificationBundle;
  readonly signal: AbortSignal;
}

export interface BlockNoteSession<
  TDocument extends AnyBlockNoteDocumentDefinition,
> {
  readonly document: TDocument;
  readonly editor: BlockNoteEditorFor<TDocument>;
  getState(): BlockNoteSessionState;
  subscribe(listener: (state: BlockNoteSessionState) => void): () => void;
  on<TEvent extends keyof BlockNoteSessionEvents>(
    event: TEvent,
    listener: (value: BlockNoteSessionEvents[TEvent]) => void,
  ): () => void;
  applyRecovery(): Promise<void>;
  discardRecovery(): Promise<void>;
  destroy(): Promise<void>;
}

export interface BlockNoteSessionOptions<
  TDocument extends AnyBlockNoteDocumentDefinition,
> {
  readonly document: TDocument;
  readonly bootstrap: BlockNoteBootstrap;
  readonly context: BlockNoteRuntimeContext<TDocument>;
  readonly access: BlockNoteAccessStore;
  readonly collaboration: {
    readonly endpoint: string;
    readonly documentName: string;
    readonly credentials?: () => Promise<string>;
    readonly user: Readonly<{ name: string; color: string }>;
  };
  readonly offline?: {
    readonly accountId: string;
    readonly databaseName?: string;
  };
  readonly refreshCommentAnchorVerification?: (
    input: BlockNoteCommentAnchorKeyRefresh,
  ) => Promise<BlockNoteCommentAnchorVerificationBundle>;
}
