import { redoCommand, undoCommand, yUndoPlugin } from "@y/prosemirror";
import { UndoManager } from "@y/y";

import {
  createExtension,
  type ExtensionOptions,
} from "../../editor/BlockNoteExtension.js";
import type { CollaborationOptions } from "./index.js";

export const YUndoExtension = createExtension(
  ({ options }: ExtensionOptions<Pick<CollaborationOptions, "fragment">>) => {
    const undoManager = new UndoManager(options.fragment);

    return {
      key: "yUndo",
      prosemirrorPlugins: [yUndoPlugin(undoManager)],
      dependsOn: ["ySync"],
      undoCommand,
      redoCommand,
      destroy: () => undoManager.destroy(),
    } as const;
  },
);
