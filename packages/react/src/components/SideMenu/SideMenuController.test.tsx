/** @vitest-environment jsdom */
import { BlockNoteEditor } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";

import { BlockNoteContext } from "../../editor/BlockNoteContext.js";
import { useExtensionState } from "../../hooks/useExtension.js";
import { SideMenuController } from "./SideMenuController.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()!();
  }
});

it("observes a command-selected block without mouse input", async () => {
  const editor = BlockNoteEditor.create({
    initialContent: [
      { id: "first", type: "paragraph", content: "first" },
      { id: "second", type: "paragraph", content: "second" },
    ],
  });
  const host = document.createElement("div");
  const editorElement = document.createElement("div");
  const reactElement = document.createElement("div");
  host.append(editorElement, reactElement);
  document.body.append(host);
  editor.mount(editorElement);
  const root = createRoot(reactElement);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    editor.unmount();
    host.remove();
  });
  const SelectedBlock = () => {
    const block = useExtensionState(SideMenuExtension, {
      selector: (state) => state?.block,
    });
    return <span data-testid="selected-block">{block?.id}</span>;
  };
  await act(async () => {
    root.render(
      <BlockNoteContext.Provider value={{ editor }}>
        <SideMenuController sideMenu={SelectedBlock} />
      </BlockNoteContext.Provider>,
    );
  });

  await act(async () => {
    editor.getExtension(SideMenuExtension)!.showAtBlock("second");
    await Promise.resolve();
  });

  expect(
    host.querySelector('[data-testid="selected-block"]')?.textContent,
  ).toBe("second");
});
