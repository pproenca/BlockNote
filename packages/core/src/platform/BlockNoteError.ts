import {
  blockNoteErrorRuntime,
  hasBlockNoteErrorBrand,
} from "./BlockNoteErrorRuntime.js";

export const blockNoteErrorCodes = [
  "access-denied",
  "document-conflict",
  "document-too-large",
  "extension-cleanup-failed",
  "invalid-document",
  "invalid-anchor",
  "incompatible-document",
  "offline-unavailable",
] as const;

export type BlockNoteErrorCode = (typeof blockNoteErrorCodes)[number];

const blockNoteErrorCodeSet = new Set<string>(blockNoteErrorCodes);

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
  blockNoteErrorRuntime.BlockNoteError as BlockNoteErrorConstructor;

export function isBlockNoteError(value: unknown): value is BlockNoteError {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    !hasBlockNoteErrorBrand(value)
  ) {
    return false;
  }
  const candidate = value as { code?: unknown; retryable?: unknown };
  try {
    return (
      typeof candidate.code === "string" &&
      blockNoteErrorCodeSet.has(candidate.code) &&
      typeof candidate.retryable === "boolean"
    );
  } catch {
    return false;
  }
}
