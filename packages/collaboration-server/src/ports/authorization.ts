import type { BlockNoteAccess } from "@blocknote/core";

export type BlockNoteAuthorizationAction =
  | "connect"
  | "edit"
  | "suggest"
  | "review";

export interface BlockNoteActor {
  readonly id: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface BlockNoteAuthorizationSession<TKey> {
  readonly documentKey: TKey;
  readonly actor: BlockNoteActor;
  getAccess(
    action: BlockNoteAuthorizationAction,
  ): Promise<BlockNoteAccess | null>;
  close(): Promise<void>;
}

export interface BlockNoteAuthorizationProvider<TKey> {
  open(input: {
    readonly request: Request;
    readonly documentName: string;
  }): Promise<BlockNoteAuthorizationSession<TKey> | null>;
}
