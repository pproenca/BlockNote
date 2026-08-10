"use client";

import type { BlockNoteEditor, BlockNoteSuggestion } from "@blocknote/core";
import { SuggestionsExtension } from "@blocknote/core/y";
import { type ReactNode, useCallback, useRef, useState } from "react";

import { useExtension, useExtensionState } from "../../hooks/useExtension.js";

export type BlockNoteSuggestionReview = {
  readonly action: "accept" | "reject";
  readonly id: string | null;
};

export type BlockNoteSuggestionsControllerState = {
  readonly suggestions: readonly BlockNoteSuggestion[];
  readonly pending: readonly BlockNoteSuggestion[];
  readonly selected: BlockNoteSuggestion | undefined;
  readonly review: BlockNoteSuggestionReview | null;
  readonly error: Error | null;
  select(id: string | null): void;
  accept(id: string): Promise<void>;
  reject(id: string): Promise<void>;
  acceptAll(): Promise<void>;
  rejectAll(): Promise<void>;
};

type LocalState = {
  readonly selectedId: string | null;
  readonly review: BlockNoteSuggestionReview | null;
  readonly error: Error | null;
};

export function BlockNoteSuggestionsController({
  children,
  editor,
}: {
  children: (state: BlockNoteSuggestionsControllerState) => ReactNode;
  editor?: BlockNoteEditor<any, any, any>;
}) {
  const extension = useExtension(SuggestionsExtension, { editor });
  const suggestions = useExtensionState(SuggestionsExtension, {
    editor,
  }) as readonly BlockNoteSuggestion[];
  const [state, setState] = useState<LocalState>({
    selectedId: null,
    review: null,
    error: null,
  });
  const active = useRef<Promise<void> | null>(null);

  const select = useCallback(
    (id: string | null) => {
      extension.select(id);
      setState((current) => ({ ...current, selectedId: id, error: null }));
    },
    [extension],
  );

  const run = useCallback(
    (review: BlockNoteSuggestionReview) => {
      if (active.current) {
        return active.current;
      }
      setState((current) => ({ ...current, review, error: null }));
      const command =
        review.id === null
          ? review.action === "accept"
            ? extension.acceptAll()
            : extension.rejectAll()
          : review.action === "accept"
            ? extension.accept(review.id)
            : extension.reject(review.id);
      const operation = Promise.resolve(command)
        .catch((cause: unknown) => {
          const error =
            cause instanceof Error ? cause : new Error(String(cause));
          setState((current) => ({ ...current, error }));
          throw error;
        })
        .finally(() => {
          active.current = null;
          setState((current) => ({ ...current, review: null }));
        });
      active.current = operation;
      return operation;
    },
    [extension],
  );

  return children({
    suggestions,
    pending: suggestions.filter(
      (suggestion) => suggestion.status === "pending",
    ),
    selected: suggestions.find(
      (suggestion) => suggestion.id === state.selectedId,
    ),
    review: state.review,
    error: state.error,
    select,
    accept: (id) => run({ action: "accept", id }),
    reject: (id) => run({ action: "reject", id }),
    acceptAll: () => run({ action: "accept", id: null }),
    rejectAll: () => run({ action: "reject", id: null }),
  });
}
