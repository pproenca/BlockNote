import {
  blockNoteRuntime,
  sharedBlockNoteErrorCodes,
} from "../runtime/BlockNoteRuntime.js";

export const blockNoteErrorCodes = sharedBlockNoteErrorCodes;

export type BlockNoteErrorCode = (typeof blockNoteErrorCodes)[number];

export interface BlockNoteError extends Error {
  readonly code: BlockNoteErrorCode;
  readonly retryable: boolean;
}

interface BlockNoteErrorConstructor {
  new (
    code: BlockNoteErrorCode,
    message: string,
    options?: ErrorOptions & { retryable?: boolean },
  ): BlockNoteError;
  readonly name: "BlockNoteError";
  readonly prototype: BlockNoteError;
}

export const BlockNoteError =
  blockNoteRuntime.BlockNoteError as BlockNoteErrorConstructor;

export function isBlockNoteError(value: unknown): value is BlockNoteError {
  return blockNoteRuntime.isBlockNoteError(value);
}
