import { BlockNoteEditor } from "@blocknote/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { BlockNoteViewRaw } from "./BlockNoteView.js";

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
      root.render(<BlockNoteViewRaw editor={editor} />);
    });

    expect(editor.isEditable).toBe(false);
    expect(
      host.querySelector(".bn-editor")?.getAttribute("contenteditable"),
    ).toBe("false");

    await act(async () => root.unmount());
    editor.destroy();
  });
});
