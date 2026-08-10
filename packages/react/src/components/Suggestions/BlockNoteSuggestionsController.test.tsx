import {
  createBlockNoteStore,
  type BlockNoteEditor,
  type BlockNoteSuggestion,
  type BlockNoteSuggestionsExtension,
} from "@blocknote/core";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import {
  BlockNoteSuggestionsController,
  type BlockNoteSuggestionsControllerState,
} from "./BlockNoteSuggestionsController.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function fixture() {
  const suggestion: BlockNoteSuggestion = {
    id: "suggestion-1",
    authorId: "alice",
    kind: "insertion",
    preview: "X",
    status: "pending",
  };
  const source = createBlockNoteStore<readonly BlockNoteSuggestion[]>([
    suggestion,
  ]);
  let subscriptions = 0;
  let reviewCommands = 0;
  const store = {
    get state() {
      return source.state;
    },
    get: source.get,
    subscribe(listener: (value: readonly BlockNoteSuggestion[]) => void) {
      subscriptions += 1;
      const unsubscribe = source.subscribe(listener);
      return () => {
        subscriptions -= 1;
        unsubscribe();
      };
    },
  };
  const extension = {
    key: "suggestions",
    store,
    select() {},
    async accept() {
      reviewCommands += 1;
    },
    async reject() {
      reviewCommands += 1;
    },
    async acceptAll() {
      reviewCommands += 1;
    },
    async rejectAll() {
      reviewCommands += 1;
    },
  } as unknown as BlockNoteSuggestionsExtension;
  const editor = {
    getExtension: () => extension,
  } as unknown as BlockNoteEditor<any, any, any>;
  return {
    editor,
    get reviewCommands() {
      return reviewCommands;
    },
    get subscriptions() {
      return subscriptions;
    },
  };
}

describe("BlockNoteSuggestionsController", () => {
  it("keeps one subscription and publishes no command across Strict Mode remount", async () => {
    const test = fixture();
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <BlockNoteSuggestionsController editor={test.editor}>
            {() => null}
          </BlockNoteSuggestionsController>
        </StrictMode>,
      );
    });

    expect(test.subscriptions).toBe(1);
    expect(test.reviewCommands).toBe(0);

    await act(async () => root.unmount());
    expect(test.subscriptions).toBe(0);
  });

  it("delegates review and exposes selected pending state", async () => {
    const test = fixture();
    const container = document.createElement("div");
    const root = createRoot(container);
    let state: BlockNoteSuggestionsControllerState | undefined;

    await act(async () => {
      root.render(
        <BlockNoteSuggestionsController editor={test.editor}>
          {(next) => {
            state = next;
            return null;
          }}
        </BlockNoteSuggestionsController>,
      );
    });
    await act(async () => {
      state!.select("suggestion-1");
      await state!.accept("suggestion-1");
    });

    expect(state?.selected?.id).toBe("suggestion-1");
    expect(state?.pending).toHaveLength(1);
    expect(state?.review).toBeNull();
    expect(state?.error).toBeNull();
    expect(test.reviewCommands).toBe(1);

    await act(async () => root.unmount());
  });
});
