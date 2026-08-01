import { describe, expect, it } from "vite-plus/test";

import { installBlockNoteErrorRuntime } from "./BlockNoteErrorRuntime.js";

const runtimeKey = Symbol.for("@blocknote/core/error-runtime/v1");

describe("BlockNoteErrorRuntime", () => {
  it("installs one immutable versioned runtime per realm", () => {
    const target = {};
    const first = installBlockNoteErrorRuntime(target);
    const second = installBlockNoteErrorRuntime(target);

    expect(second).toBe(first);
    expect(first.version).toBe(1);
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(target, runtimeKey)).toMatchObject({
      configurable: false,
      enumerable: false,
      value: first,
      writable: false,
    });
  });

  it("fails closed for incompatible and hostile registries", () => {
    const incompatible = {};
    Object.defineProperty(incompatible, runtimeKey, {
      value: Object.freeze(Object.create(null)),
    });
    const source = {};
    const tamperedRuntime = installBlockNoteErrorRuntime(source);
    Object.defineProperty(tamperedRuntime.BlockNoteError, "name", {
      value: "TamperedError",
    });
    const tampered = {};
    Object.defineProperty(tampered, runtimeKey, { value: tamperedRuntime });
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile registry");
        },
      },
    );

    expect(() => installBlockNoteErrorRuntime(incompatible)).toThrow(
      "BlockNote error runtime registry is incompatible.",
    );
    expect(() => installBlockNoteErrorRuntime(tampered)).toThrow(
      "BlockNote error runtime registry is incompatible.",
    );
    expect(() => installBlockNoteErrorRuntime(hostile)).toThrow(
      "BlockNote error runtime registry is incompatible.",
    );
  });
});
