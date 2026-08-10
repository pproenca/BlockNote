import { BlockNoteEditor } from "@blocknote/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { BlockNoteViewRaw } from "./BlockNoteView.js";
import { BlockNoteSessionContext } from "../session/BlockNoteSessionContext.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("BlockNoteView", () => {
  it("preserves session-controlled editability when the prop is omitted", async () => {
    const editor = BlockNoteEditor.create();
    editor.isEditable = false;
    const host = document.createElement("div");
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <BlockNoteSessionContext.Provider value={{ editor } as never}>
          <BlockNoteViewRaw editor={editor} />
        </BlockNoteSessionContext.Provider>,
      );
    });

    expect(editor.isEditable).toBe(false);
    expect(
      host.querySelector(".bn-editor")?.getAttribute("contenteditable"),
    ).toBe("false");

    await act(async () => root.unmount());
    editor.destroy();
  });

  it("restores the standalone default when editable becomes undefined", async () => {
    const editor = BlockNoteEditor.create();
    const host = document.createElement("div");
    const root = createRoot(host);

    await act(async () => {
      root.render(<BlockNoteViewRaw editable={false} editor={editor} />);
    });
    expect(editor.isEditable).toBe(false);

    await act(async () => {
      root.render(<BlockNoteViewRaw editor={editor} />);
    });
    expect(editor.isEditable).toBe(true);

    await act(async () => root.unmount());
    editor.destroy();
  });
});
