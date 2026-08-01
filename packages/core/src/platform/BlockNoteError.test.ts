import { describe, expect, it } from "vite-plus/test";
import { BlockNoteError, isBlockNoteError } from "./BlockNoteError.js";

describe("BlockNoteError", () => {
  it("exposes stable machine-readable failure state", () => {
    const cause = new Error("internal detail");
    const error = new BlockNoteError("document-conflict", "Try again", {
      cause,
      retryable: true,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BlockNoteError");
    expect(error.code).toBe("document-conflict");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
    expect(isBlockNoteError(error)).toBe(true);
  });

  it("does not classify arbitrary coded errors", () => {
    const error = Object.assign(new Error("not BlockNote"), {
      code: "internal-error",
      retryable: false,
    });

    expect(isBlockNoteError(error)).toBe(false);
    expect(
      isBlockNoteError({
        code: "document-conflict",
        retryable: true,
      }),
    ).toBe(false);
  });
});
