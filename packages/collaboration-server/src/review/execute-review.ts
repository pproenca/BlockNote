import type { BlockNoteRevision } from "@blocknote/core";

import type { BlockNoteReviewCommand } from "./review-command.js";

export interface BlockNoteReviewExecution {
  readonly doc: unknown;
  readonly command: BlockNoteReviewCommand;
  readonly actorId: string;
  readonly revision: BlockNoteRevision;
  readonly fence: Readonly<{ token: string; sequence: number }>;
}

export type BlockNoteReviewExecutor = (
  input: BlockNoteReviewExecution,
) => Promise<void> | void;
