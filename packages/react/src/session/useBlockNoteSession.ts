"use client";

import {
  BlockNoteError,
  type AnyBlockNoteDocumentDefinition,
  type RegisteredBlockNoteDocument,
} from "@blocknote/core";

import { useOptionalBlockNoteSession } from "./BlockNoteSessionContext.js";

export function useBlockNoteSession<
  Document extends AnyBlockNoteDocumentDefinition = RegisteredBlockNoteDocument,
>() {
  const session = useOptionalBlockNoteSession<Document>();
  if (!session) {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote session context is not mounted.",
    );
  }
  return session;
}
