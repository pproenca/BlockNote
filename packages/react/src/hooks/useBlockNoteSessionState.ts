"use client";

import type {
  AnyBlockNoteDocumentDefinition,
  RegisteredBlockNoteDocument,
} from "@blocknote/core";
import { BlockNoteError } from "@blocknote/core";
import type {
  BlockNoteSession,
  BlockNoteSessionState,
} from "@blocknote/collaboration";
import { useMemo, useRef, useSyncExternalStore } from "react";

import { useOptionalBlockNoteSession } from "../session/BlockNoteSessionContext.js";

const identitySelector = (state: BlockNoteSessionState) => state;

export function useBlockNoteSessionState<
  Selected = BlockNoteSessionState,
  Document extends AnyBlockNoteDocumentDefinition = RegisteredBlockNoteDocument,
>(
  options: {
    readonly session?: BlockNoteSession<Document>;
    readonly select?: (state: BlockNoteSessionState) => Selected;
    readonly equals?: (left: Selected, right: Selected) => boolean;
  } = {},
) {
  const contextual = useOptionalBlockNoteSession<Document>();
  const session = options.session ?? contextual;
  if (!session) {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote session context is not mounted.",
    );
  }
  const select =
    options.select ??
    (identitySelector as (state: BlockNoteSessionState) => Selected);
  const equals = options.equals ?? Object.is;
  const selected = useRef(select(session.getState()));
  const rendered = select(session.getState());
  if (!equals(selected.current, rendered)) {
    selected.current = rendered;
  }
  const subscribe = useMemo(
    () => (notify: () => void) =>
      session.subscribe((state) => {
        const next = select(state);
        if (!equals(selected.current, next)) {
          selected.current = next;
          notify();
        }
      }),
    [equals, select, session],
  );
  return useSyncExternalStore(
    subscribe,
    () => selected.current,
    () => selected.current,
  );
}
