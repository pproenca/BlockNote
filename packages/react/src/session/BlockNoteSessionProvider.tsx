"use client";

import {
  BlockNoteError,
  type AnyBlockNoteDocumentDefinition,
} from "@blocknote/core";
import type { BlockNoteSession } from "@blocknote/collaboration";
import type { ReactNode } from "react";

import {
  BlockNoteSessionContext,
  useOptionalBlockNoteSession,
} from "./BlockNoteSessionContext.js";

export function BlockNoteSessionProvider<
  Document extends AnyBlockNoteDocumentDefinition,
>({
  session,
  children,
}: {
  readonly session: BlockNoteSession<Document>;
  readonly children: ReactNode;
}) {
  const parent = useOptionalBlockNoteSession();
  if (parent && parent !== session) {
    throw new BlockNoteError(
      "incompatible-document",
      "Nested BlockNote session providers must use the same session.",
    );
  }
  return (
    <BlockNoteSessionContext.Provider value={session}>
      {children}
    </BlockNoteSessionContext.Provider>
  );
}
