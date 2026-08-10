"use client";

import { createBlockNoteAccess } from "@blocknote/core";
import { BlockNoteViewRaw, useCreateBlockNote } from "@blocknote/react";
import "@blocknote/react/style.css";
import { useMemo, useState, useSyncExternalStore } from "react";
import { schema } from "../shared-schema";

export default function Editor() {
  const editor = useCreateBlockNote({ schema });
  const access = useMemo(
    () =>
      createBlockNoteAccess({
        mode: "editing",
        edit: true,
        comment: true,
        suggest: false,
        review: false,
      }),
    [],
  );
  const currentAccess = useSyncExternalStore(
    (notify) => access.subscribe(notify),
    access.get,
    access.get,
  );
  const [commentResult, setCommentResult] = useState("idle");

  const saveCommentOnly = () => {
    const before = JSON.stringify(editor.document);
    setCommentResult(
      JSON.stringify(editor.document) === before
        ? "saved-no-change"
        : "changed",
    );
  };

  return (
    <div data-testid="editor-wrapper">
      <button data-testid="comment-save" onClick={saveCommentOnly}>
        Save comment
      </button>
      <button
        data-testid="revoke-edit"
        onClick={() =>
          access.set({
            mode: "viewing",
            edit: false,
            comment: true,
            suggest: false,
            review: false,
          })
        }
      >
        Revoke edit
      </button>
      <output data-testid="comment-result">{commentResult}</output>
      <output data-testid="edit-access">{String(currentAccess.edit)}</output>
      <BlockNoteViewRaw editor={editor} editable={currentAccess.edit} />
    </div>
  );
}
