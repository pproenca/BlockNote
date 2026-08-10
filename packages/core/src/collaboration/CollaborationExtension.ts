import { createExtension } from "../editor/BlockNoteExtension.js";

export interface BlockNoteCollaborationExtension {
  readonly key: "collaboration";
}

export const CollaborationExtension = createExtension(
  (): BlockNoteCollaborationExtension => ({ key: "collaboration" }),
  { name: "collaboration", version: "1" },
);
