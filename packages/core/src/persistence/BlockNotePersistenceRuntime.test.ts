import { describe, expect, it } from "vite-plus/test";

import { installBlockNotePersistenceRuntime } from "./BlockNotePersistenceRuntime.js";

const runtimeKey = Symbol.for("@blocknote/core/persistence-runtime/v1");

describe("BlockNotePersistenceRuntime", () => {
  it("installs one immutable versioned runtime per realm", () => {
    const target = {};
    const first = installBlockNotePersistenceRuntime(target);
    const second = installBlockNotePersistenceRuntime(target);

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
    const mutable = {};
    Object.defineProperty(mutable, runtimeKey, {
      value: installBlockNotePersistenceRuntime(source),
      writable: true,
    });
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile registry");
        },
      },
    );

    expect(() => installBlockNotePersistenceRuntime(incompatible)).toThrow(
      "BlockNote persistence runtime registry is incompatible.",
    );
    expect(() => installBlockNotePersistenceRuntime(mutable)).toThrow(
      "BlockNote persistence runtime registry is incompatible.",
    );
    expect(() => installBlockNotePersistenceRuntime(hostile)).toThrow(
      "BlockNote persistence runtime registry is incompatible.",
    );
  });
});
