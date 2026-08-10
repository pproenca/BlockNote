"use client";

import type { BlockNoteEditor } from "@blocknote/core";
import { CommentsExtension } from "@blocknote/core/comments";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import { useExtension } from "../../hooks/useExtension.js";
import {
  createBlockNoteCommentsController,
  type BlockNoteCommentsControllerInstance,
  type BlockNoteCommentsState,
} from "./BlockNoteCommentsController.js";

const Context = createContext<BlockNoteCommentsControllerInstance | null>(null);

export function BlockNoteCommentsController({
  children,
  editor,
}: {
  readonly children: ReactNode;
  readonly editor?: BlockNoteEditor<any, any, any>;
}) {
  const comments = useExtension(CommentsExtension, { editor });
  const controller = useMemo(
    () => createBlockNoteCommentsController(comments),
    [comments],
  );
  const lifecycle = useRef(0);
  useEffect(() => {
    const current = ++lifecycle.current;
    return () => {
      queueMicrotask(() => {
        // Strict Mode replays setup before this microtask; only the last
        // lifecycle generation owns disposal.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        if (lifecycle.current === current) {
          void controller.destroy();
        }
      });
    };
  }, [controller]);
  return createElement(Context.Provider, { value: controller }, children);
}

export function useBlockNoteCommentsController() {
  const controller = useContext(Context);
  if (!controller) {
    throw new Error("BlockNoteCommentsController is not mounted.");
  }
  return controller;
}

export function useOptionalBlockNoteCommentsController() {
  return useContext(Context);
}

export function useBlockNoteCommentsState<Selected = BlockNoteCommentsState>(
  selector: (state: BlockNoteCommentsState) => Selected = (state) =>
    state as Selected,
  equals: (left: Selected, right: Selected) => boolean = Object.is,
) {
  const controller = useBlockNoteCommentsController();
  const selected = useRef(selector(controller.getState()));
  const rendered = selector(controller.getState());
  if (!equals(selected.current, rendered)) {
    selected.current = rendered;
  }
  const subscribe = useMemo(
    () => (notify: () => void) =>
      controller.subscribe(() => {
        const next = selector(controller.getState());
        if (!equals(selected.current, next)) {
          selected.current = next;
          notify();
        }
      }),
    [controller, equals, selector],
  );
  return useSyncExternalStore(
    subscribe,
    () => selected.current,
    () => selected.current,
  );
}
