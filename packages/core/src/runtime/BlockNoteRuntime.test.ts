import { describe, expect, it } from "vite-plus/test";

import { installBlockNoteRuntime } from "./BlockNoteRuntime.js";

const runtimeKey = Symbol.for("@blocknote/core/runtime/v1");

function runtimeValues(runtime: object) {
  return Reflect.ownKeys(runtime).map(
    (key) => Object.getOwnPropertyDescriptor(runtime, key)!.value as unknown,
  );
}

describe("BlockNoteRuntime", () => {
  it("installs one frozen facade with no exposed branding containers", () => {
    const target = {};
    const first = installBlockNoteRuntime(target);
    const second = installBlockNoteRuntime(target);

    expect(second).toBe(first);
    expect(first.version).toBe(1);
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.ownKeys(first)).toEqual([
      "version",
      "BlockNoteError",
      "isBlockNoteError",
      "createPersistenceValue",
      "readPersistenceValue",
    ]);
    expect(
      runtimeValues(first).some(
        (value) => value instanceof WeakMap || value instanceof WeakSet,
      ),
    ).toBe(false);
    expect(Object.isFrozen(first.BlockNoteError)).toBe(true);
    expect(Object.isFrozen(first.BlockNoteError.prototype)).toBe(true);
    expect(Object.isFrozen(first.isBlockNoteError)).toBe(true);
    expect(Object.isFrozen(first.createPersistenceValue)).toBe(true);
    expect(Object.isFrozen(first.readPersistenceValue)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(target, runtimeKey)).toMatchObject({
      configurable: false,
      enumerable: false,
      value: first,
      writable: false,
    });
  });

  it("mints only canonical values and keeps stored bytes private", () => {
    const runtime = installBlockNoteRuntime({});
    const frame = Uint8Array.from([66, 78, 1, 1, 0, 0, 0, 1, 7]);
    const created = runtime.createPersistenceValue("checkpoint", frame);

    expect(created.status).toBe("created");
    if (created.status !== "created") {
      throw new Error("expected a created persistence value");
    }
    expect(created.value).toEqual({
      kind: "blocknote-checkpoint",
      byteLength: 9,
    });
    expect(Object.isFrozen(created.value)).toBe(true);

    frame.fill(0);
    const firstRead = runtime.readPersistenceValue(created.value, "checkpoint");
    expect(firstRead).toMatchObject({ status: "valid" });
    if (firstRead.status !== "valid") {
      throw new Error("expected readable persistence bytes");
    }
    expect(firstRead.bytes).toEqual(
      Uint8Array.from([66, 78, 1, 1, 0, 0, 0, 1, 7]),
    );
    firstRead.bytes.fill(255);
    expect(runtime.readPersistenceValue(created.value, "checkpoint")).toEqual({
      status: "valid",
      bytes: Uint8Array.from([66, 78, 1, 1, 0, 0, 0, 1, 7]),
    });

    const forged = Object.freeze({
      kind: "blocknote-checkpoint" as const,
      byteLength: 9,
    });
    expect(runtime.readPersistenceValue(forged, "checkpoint")).toEqual({
      status: "invalid",
    });
    expect(
      runtime.createPersistenceValue(
        "checkpoint",
        Uint8Array.from([0, 78, 1, 1, 0, 0, 0, 1, 7]),
      ),
    ).toMatchObject({
      status: "rejected",
      failure: { code: "invalid-document" },
    });
  });

  it("does not let prototype lookalikes forge error branding", () => {
    const runtime = installBlockNoteRuntime({});
    const error = new runtime.BlockNoteError("document-conflict", "Try again", {
      retryable: true,
    });
    const forged = Object.assign(
      Object.create(runtime.BlockNoteError.prototype) as Error,
      {
        code: "document-conflict",
        retryable: true,
      },
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(runtime.BlockNoteError);
    expect(error.name).toBe("BlockNoteError");
    expect(runtime.isBlockNoteError(error)).toBe(true);
    expect(forged).toBeInstanceOf(runtime.BlockNoteError);
    expect(runtime.isBlockNoteError(forged)).toBe(false);
    expect(
      runtime.isBlockNoteError(
        new runtime.BlockNoteError("not-a-public-code", "Forged"),
      ),
    ).toBe(false);
  });

  it("prevents replacement or mutation of installed authority", () => {
    const target = {};
    const runtime = installBlockNoteRuntime(target);

    expect(Reflect.set(runtime, "version", 2)).toBe(false);
    expect(
      Reflect.defineProperty(target, runtimeKey, {
        value: Object.freeze(Object.create(null)),
      }),
    ).toBe(false);
    expect(() =>
      Object.defineProperty(runtime.BlockNoteError, "name", {
        value: "ForgedError",
      }),
    ).toThrow();
    expect(installBlockNoteRuntime(target)).toBe(runtime);
  });

  it("fails closed for hostile or incompatible preinstallation", () => {
    const incompatible = {};
    Object.defineProperty(incompatible, runtimeKey, {
      value: Object.freeze(Object.create(null)),
    });

    const source = {};
    const mutable = {};
    Object.defineProperty(mutable, runtimeKey, {
      value: installBlockNoteRuntime(source),
      writable: true,
    });

    const FakeBlockNoteError = class BlockNoteError extends Error {};
    Object.freeze(FakeBlockNoteError.prototype);
    Object.freeze(FakeBlockNoteError);
    const alwaysTrue = Object.freeze(() => true);
    const fakeRuntime = Object.create(null);
    Object.defineProperties(fakeRuntime, {
      version: { value: 1 },
      BlockNoteError: { value: FakeBlockNoteError },
      isBlockNoteError: { value: alwaysTrue },
      createPersistenceValue: { value: alwaysTrue },
      readPersistenceValue: { value: alwaysTrue },
    });
    Object.freeze(fakeRuntime);
    const plausible = {};
    Object.defineProperty(plausible, runtimeKey, { value: fakeRuntime });

    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile registry");
        },
      },
    );
    const droppedInstallation = new Proxy(
      {},
      {
        defineProperty() {
          return true;
        },
        getOwnPropertyDescriptor() {
          return undefined;
        },
      },
    );

    for (const target of [
      incompatible,
      mutable,
      plausible,
      hostile,
      droppedInstallation,
    ]) {
      expect(() => installBlockNoteRuntime(target)).toThrow(
        "BlockNote runtime registry is incompatible.",
      );
    }
  });
});
