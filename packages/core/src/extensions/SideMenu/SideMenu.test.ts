/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BlockNoteEditor } from "../../editor/BlockNoteEditor.js";
import { SideMenuExtension } from "./SideMenu.js";

const active: Array<{
  readonly container: HTMLElement;
  readonly editor: BlockNoteEditor;
}> = [];

afterEach(() => {
  while (active.length > 0) {
    const fixture = active.pop()!;
    fixture.editor.unmount();
    fixture.container.remove();
  }
});

function createEditor() {
  const editor = BlockNoteEditor.create({
    initialContent: [
      {
        id: "first",
        type: "paragraph",
        content: "first",
        children: [
          {
            id: "nested",
            type: "paragraph",
            content: "nested",
          },
        ],
      },
      { id: "second", type: "paragraph", content: "second" },
    ],
  });
  const container = document.createElement("div");
  document.body.append(container);
  editor.mount(container);
  active.push({ container, editor });
  return editor;
}

describe("SideMenuExtension.showAtBlock", () => {
  it("shows and freezes at the current cursor block", () => {
    const editor = createEditor();
    const sideMenu = editor.getExtension(SideMenuExtension)!;

    expect(sideMenu.showAtBlock()).toBe(true);
    expect(sideMenu.store.state).toMatchObject({
      show: true,
      block: { id: editor.getTextCursorPosition().block.id },
    });
  });

  it("resolves explicit top-level and nested block identifiers", () => {
    const editor = createEditor();
    const sideMenu = editor.getExtension(SideMenuExtension)!;

    expect(sideMenu.showAtBlock({ id: "nested" })).toBe(true);
    expect(sideMenu.store.state?.block.id).toBe("nested");
    sideMenu.unfreezeMenu();
    expect(sideMenu.showAtBlock("second")).toBe(true);
    expect(sideMenu.store.state?.block.id).toBe("second");
  });

  it("rejects missing, non-editable, and destroyed targets", () => {
    const editor = createEditor();
    const sideMenu = editor.getExtension(SideMenuExtension)!;

    expect(sideMenu.showAtBlock("missing")).toBe(false);
    editor.isEditable = false;
    expect(sideMenu.showAtBlock("first")).toBe(false);
    editor.isEditable = true;
    editor.unmount();
    expect(sideMenu.showAtBlock("first")).toBe(false);
  });
});
