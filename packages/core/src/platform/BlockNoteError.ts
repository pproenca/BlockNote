export const blockNoteErrorCodes = [
  "access-denied",
  "document-conflict",
  "document-too-large",
  "invalid-document",
  "invalid-anchor",
  "incompatible-document",
  "offline-unavailable",
] as const;

export type BlockNoteErrorCode = (typeof blockNoteErrorCodes)[number];

const blockNoteErrorCodeSet = new Set<string>(blockNoteErrorCodes);

export class BlockNoteError extends Error {
  public readonly code: BlockNoteErrorCode;
  public readonly retryable: boolean;

  constructor(
    code: BlockNoteErrorCode,
    message: string,
    options: ErrorOptions & { retryable?: boolean } = {},
  ) {
    super(message, options);
    this.name = "BlockNoteError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export function isBlockNoteError(value: unknown): value is BlockNoteError {
  return (
    value instanceof Error &&
    "code" in value &&
    typeof value.code === "string" &&
    blockNoteErrorCodeSet.has(value.code) &&
    "retryable" in value &&
    typeof value.retryable === "boolean"
  );
}
