/**
 * @vitest-environment jsdom
 */
import { expect, it } from "vite-plus/test";
import * as Y from "@y/y";

import { BlockNoteEditor } from "../../editor/BlockNoteEditor.js";
import { withCollaboration } from "./index.js";

it("undoes and redoes local collaborative edits", () => {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    withCollaboration({
      collaboration: {
        fragment: doc.get("prosemirror"),
        user: { color: "#ffffff", name: "Test User" },
      },
    }),
  );
  editor.mount(document.createElement("div"));

  editor.insertInlineContent("history");
  expect(editor.prosemirrorState.doc.textContent).toContain("history");
  expect(editor.undo()).toBe(true);
  expect(editor.prosemirrorState.doc.textContent).not.toContain("history");
  expect(editor.redo()).toBe(true);
  expect(editor.prosemirrorState.doc.textContent).toContain("history");

  editor.unmount();
  doc.destroy();
});
