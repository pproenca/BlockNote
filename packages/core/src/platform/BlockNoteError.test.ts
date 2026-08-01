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
    expect(BlockNoteError.name).toBe("BlockNoteError");
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

    const prototypeForgery = Object.assign(
      Object.create(BlockNoteError.prototype) as Error,
      {
        code: "document-conflict",
        retryable: true,
      },
    );
    expect(prototypeForgery).toBeInstanceOf(BlockNoteError);
    expect(isBlockNoteError(prototypeForgery)).toBe(false);
  });

  it("returns false for hostile and revoked proxies", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile prototype");
        },
        get() {
          throw new Error("hostile property");
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    expect(() => isBlockNoteError(hostile)).not.toThrow();
    expect(isBlockNoteError(hostile)).toBe(false);
    expect(() => isBlockNoteError(revoked.proxy)).not.toThrow();
    expect(isBlockNoteError(revoked.proxy)).toBe(false);
  });

  it("rejects branded errors mutated beyond the current code union", () => {
    const error = new BlockNoteError("document-conflict", "Try again");
    Object.defineProperty(error, "code", { value: "future-error-code" });

    expect(isBlockNoteError(error)).toBe(false);
  });
});
