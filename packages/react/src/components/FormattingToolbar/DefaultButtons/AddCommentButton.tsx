import { FormattingToolbarExtension } from "@blocknote/core/extensions";
// Specifically using type here to avoid pulling in the comments extensions into the main bundle
import type { CommentsExtension } from "@blocknote/core/comments";
import { useCallback } from "react";
import { RiChat3Line } from "react-icons/ri";

import { useComponentsContext } from "../../../editor/ComponentsContext.js";
import { useBlockNoteEditor } from "../../../hooks/useBlockNoteEditor.js";
import { useExtension } from "../../../hooks/useExtension.js";
import { useDictionary } from "../../../i18n/dictionary.js";
import { useOptionalBlockNoteCommentsController } from "../../Comments/useBlockNoteCommentsState.js";

export const AddCommentButtonInner = () => {
  const dict = useDictionary();
  const Components = useComponentsContext()!;

  const comments = useExtension("comments") as unknown as ReturnType<
    typeof CommentsExtension
  >["~types"]["extension"];
  const { store } = useExtension(FormattingToolbarExtension);
  const commentsController = useOptionalBlockNoteCommentsController();

  const onClick = useCallback(() => {
    if (commentsController) {
      commentsController.openComposer();
    } else {
      comments.startPendingComment();
    }
    store.setState(false);
  }, [comments, commentsController, store]);

  return (
    <Components.FormattingToolbar.Button
      className={"bn-button"}
      label={dict.formatting_toolbar.comment.tooltip}
      mainTooltip={dict.formatting_toolbar.comment.tooltip}
      icon={<RiChat3Line />}
      onClick={onClick}
    />
  );
};

export const AddCommentButton = () => {
  const editor = useBlockNoteEditor<any, any, any>();

  if (!editor.getExtension("comments")) {
    return null;
  }

  return <AddCommentButtonInner />;
};
