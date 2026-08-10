"use client";

import type {
  AnyBlockNoteDocumentDefinition,
  RegisteredBlockNoteDocument,
} from "@blocknote/core";
import type { BlockNoteSession } from "@blocknote/collaboration";
import { createContext, useContext } from "react";

export const BlockNoteSessionContext =
  createContext<BlockNoteSession<AnyBlockNoteDocumentDefinition> | null>(null);

export function useOptionalBlockNoteSession<
  Document extends AnyBlockNoteDocumentDefinition = RegisteredBlockNoteDocument,
>() {
  return useContext(
    BlockNoteSessionContext,
  ) as BlockNoteSession<Document> | null;
}
