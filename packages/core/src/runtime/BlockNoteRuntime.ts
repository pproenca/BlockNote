import {
  decodeBlockNotePersistenceFrameData,
  type BlockNotePersistenceFrameFailure,
  persistenceByteLength,
} from "../persistence/BlockNotePersistenceFrameData.js";

export interface SharedBlockNoteError extends Error {
  readonly code: string;
  readonly retryable: boolean;
}

export interface SharedBlockNoteErrorConstructor {
  new (
    code: string,
    message: string,
    options?: ErrorOptions & { retryable?: boolean },
  ): SharedBlockNoteError;
  readonly name: "BlockNoteError";
  readonly prototype: SharedBlockNoteError;
}

export const sharedBlockNoteErrorCodes = Object.freeze([
  "access-denied",
  "document-conflict",
  "document-too-large",
  "extension-cleanup-failed",
  "invalid-document",
  "invalid-anchor",
  "incompatible-document",
  "offline-unavailable",
] as const);

export type SharedBlockNotePersistenceFrameKind = "checkpoint" | "change";

export interface SharedBlockNotePersistenceValue {
  readonly kind: "blocknote-checkpoint" | "blocknote-change";
  readonly byteLength: number;
}

export type SharedBlockNotePersistenceCreation =
  | {
      readonly status: "created";
      readonly value: SharedBlockNotePersistenceValue;
    }
  | {
      readonly status: "rejected";
      readonly failure: BlockNotePersistenceFrameFailure;
    };

export type SharedBlockNotePersistenceRead =
  | { readonly status: "valid"; readonly bytes: Uint8Array }
  | { readonly status: "invalid" }
  | { readonly status: "wrong-kind" };

export interface BlockNoteRuntime {
  readonly version: 1;
  readonly BlockNoteError: SharedBlockNoteErrorConstructor;
  readonly isBlockNoteError: (value: unknown) => boolean;
  readonly createPersistenceValue: (
    kind: SharedBlockNotePersistenceFrameKind,
    frame: unknown,
  ) => SharedBlockNotePersistenceCreation;
  readonly readPersistenceValue: (
    value: unknown,
    expectedKind: SharedBlockNotePersistenceFrameKind,
  ) => SharedBlockNotePersistenceRead;
}

const runtimeKey = Symbol.for("@blocknote/core/runtime/v1");
const runtimeKeys = [
  "version",
  "BlockNoteError",
  "isBlockNoteError",
  "createPersistenceValue",
  "readPersistenceValue",
] as const;
const ErrorConstructor = Error;
const SetConstructor = Set;
const WeakMapConstructor = WeakMap;
const WeakSetConstructor = WeakSet;
const Uint8ArrayConstructor = Uint8Array;
const objectCreate = Object.create;
const objectDefineProperties = Object.defineProperties;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectIsFrozen = Object.isFrozen;
const reflectApply = Reflect.apply;
const reflectOwnKeys = Reflect.ownKeys;
const reflectSet = Reflect.set;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const uint8ArraySet = Uint8Array.prototype.set;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const weakMapGet = WeakMap.prototype.get;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const weakMapSet = WeakMap.prototype.set;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const weakSetAdd = WeakSet.prototype.add;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const weakSetHas = WeakSet.prototype.has;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const setHas = Set.prototype.has;

interface StoredPersistenceFrame {
  readonly kind: SharedBlockNotePersistenceFrameKind;
  readonly bytes: Uint8Array;
}

function immutableDataProperty(value: object, key: PropertyKey) {
  const descriptor = objectGetOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.configurable !== false ||
    descriptor.enumerable !== false ||
    descriptor.writable !== false
  ) {
    return undefined;
  }
  return descriptor.value as unknown;
}

function isFrozenFunction(
  value: unknown,
): value is (...args: never[]) => unknown {
  return typeof value === "function" && objectIsFrozen(value);
}

function hasValidErrorConstructor(
  value: unknown,
): value is SharedBlockNoteErrorConstructor {
  if (!isFrozenFunction(value) || value.name !== "BlockNoteError") {
    return false;
  }

  const prototype = immutableDataProperty(value, "prototype");
  return (
    typeof prototype === "object" &&
    prototype !== null &&
    objectIsFrozen(prototype) &&
    objectGetPrototypeOf(prototype) === ErrorConstructor.prototype
  );
}

function copyBytes(value: Uint8Array) {
  const copy = new Uint8ArrayConstructor(persistenceByteLength(value));
  reflectApply(uint8ArraySet, copy, [value]);
  return copy;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  const byteLength = persistenceByteLength(left);
  if (byteLength !== persistenceByteLength(right)) {
    return false;
  }
  for (let index = 0; index < byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function createBlockNoteRuntime(): BlockNoteRuntime {
  const errorBrand = new WeakSetConstructor<object>();
  const allowedErrorCodes = new SetConstructor<string>(
    sharedBlockNoteErrorCodes,
  );
  const storedFrames = new WeakMapConstructor<object, StoredPersistenceFrame>();

  class BlockNoteError
    extends ErrorConstructor
    implements SharedBlockNoteError
  {
    public readonly code: string;
    public readonly retryable: boolean;

    constructor(
      code: string,
      message: string,
      options: ErrorOptions & { retryable?: boolean } = {},
    ) {
      super(message, options);
      this.name = "BlockNoteError";
      this.code = code;
      this.retryable = options.retryable ?? false;
      reflectApply(weakSetAdd, errorBrand, [this]);
    }
  }

  const isBlockNoteError = objectFreeze(function (value: unknown): boolean {
    if (
      (typeof value !== "object" && typeof value !== "function") ||
      value === null
    ) {
      return false;
    }
    try {
      if (!(reflectApply(weakSetHas, errorBrand, [value]) as boolean)) {
        return false;
      }
      const candidate = value as {
        code?: unknown;
        retryable?: unknown;
      };
      return (
        typeof candidate.code === "string" &&
        (reflectApply(setHas, allowedErrorCodes, [
          candidate.code,
        ]) as boolean) &&
        typeof candidate.retryable === "boolean"
      );
    } catch {
      return false;
    }
  });

  const createPersistenceValue = objectFreeze(function (
    kind: SharedBlockNotePersistenceFrameKind,
    frame: unknown,
  ): SharedBlockNotePersistenceCreation {
    if (kind !== "checkpoint" && kind !== "change") {
      return objectFreeze({
        status: "rejected",
        failure: objectFreeze({
          code: "invalid-document",
          message: "BlockNote persistence frame kind is invalid.",
        }),
      });
    }

    const decoded = decodeBlockNotePersistenceFrameData(frame, kind);
    if (!decoded.ok) {
      return objectFreeze({
        status: "rejected",
        failure: objectFreeze({ ...decoded.failure }),
      });
    }

    const value = objectFreeze({
      kind:
        kind === "checkpoint"
          ? ("blocknote-checkpoint" as const)
          : ("blocknote-change" as const),
      byteLength: persistenceByteLength(decoded.value),
    });
    reflectApply(weakMapSet, storedFrames, [
      value,
      { kind, bytes: decoded.value },
    ]);
    return objectFreeze({ status: "created", value });
  });

  const readPersistenceValue = objectFreeze(function (
    value: unknown,
    expectedKind: SharedBlockNotePersistenceFrameKind,
  ): SharedBlockNotePersistenceRead {
    if (
      (typeof value !== "object" && typeof value !== "function") ||
      value === null
    ) {
      return objectFreeze({ status: "invalid" });
    }

    let stored: StoredPersistenceFrame | undefined;
    try {
      stored = reflectApply(weakMapGet, storedFrames, [value]) as
        | StoredPersistenceFrame
        | undefined;
    } catch {
      return objectFreeze({ status: "invalid" });
    }
    if (!stored) {
      return objectFreeze({ status: "invalid" });
    }
    if (stored.kind !== expectedKind) {
      return objectFreeze({ status: "wrong-kind" });
    }

    return objectFreeze({
      status: "valid",
      bytes: copyBytes(stored.bytes),
    });
  });

  objectDefineProperty(BlockNoteError, "name", {
    value: "BlockNoteError",
  });
  objectFreeze(BlockNoteError.prototype);
  objectFreeze(BlockNoteError);

  const runtime = objectCreate(null) as BlockNoteRuntime;
  objectDefineProperties(runtime, {
    version: { value: 1 },
    BlockNoteError: { value: BlockNoteError },
    isBlockNoteError: { value: isBlockNoteError },
    createPersistenceValue: { value: createPersistenceValue },
    readPersistenceValue: { value: readPersistenceValue },
  });
  return objectFreeze(runtime);
}

function hasValidRuntimeShape(value: unknown): value is BlockNoteRuntime {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      objectGetPrototypeOf(value) !== null ||
      !objectIsFrozen(value) ||
      reflectOwnKeys(value).length !== runtimeKeys.length
    ) {
      return false;
    }

    const version = immutableDataProperty(value, "version");
    const BlockNoteError = immutableDataProperty(value, "BlockNoteError");
    const isBlockNoteError = immutableDataProperty(value, "isBlockNoteError");
    const createPersistenceValue = immutableDataProperty(
      value,
      "createPersistenceValue",
    );
    const readPersistenceValue = immutableDataProperty(
      value,
      "readPersistenceValue",
    );

    return (
      version === 1 &&
      hasValidErrorConstructor(BlockNoteError) &&
      isFrozenFunction(isBlockNoteError) &&
      isFrozenFunction(createPersistenceValue) &&
      isFrozenFunction(readPersistenceValue)
    );
  } catch {
    return false;
  }
}

function hasValidRuntimeBehavior(runtime: BlockNoteRuntime) {
  try {
    const error = new runtime.BlockNoteError(
      "invalid-document",
      "runtime probe",
      { retryable: true },
    );
    const invalidCodeError = new runtime.BlockNoteError(
      "runtime-probe-invalid-code",
      "runtime probe",
    );
    if (
      error.name !== "BlockNoteError" ||
      error.code !== "invalid-document" ||
      error.retryable !== true ||
      !(error instanceof ErrorConstructor) ||
      !(error instanceof runtime.BlockNoteError) ||
      !runtime.isBlockNoteError(error) ||
      runtime.isBlockNoteError(invalidCodeError) ||
      runtime.isBlockNoteError(objectCreate(runtime.BlockNoteError.prototype))
    ) {
      return false;
    }

    const probeFrame = new Uint8ArrayConstructor(8);
    reflectApply(uint8ArraySet, probeFrame, [[66, 78, 1, 1, 0, 0, 0, 0]]);
    const created = runtime.createPersistenceValue("checkpoint", probeFrame);
    if (created.status !== "created") {
      return false;
    }
    const read = runtime.readPersistenceValue(created.value, "checkpoint");
    const forged = runtime.readPersistenceValue(
      objectFreeze({
        kind: "blocknote-checkpoint",
        byteLength: persistenceByteLength(probeFrame),
      }),
      "checkpoint",
    );
    if (
      read.status !== "valid" ||
      !equalBytes(read.bytes, probeFrame) ||
      forged.status !== "invalid"
    ) {
      return false;
    }
    reflectSet(read.bytes, 0, 0);
    const reread = runtime.readPersistenceValue(created.value, "checkpoint");
    return reread.status === "valid" && reread.bytes[0] === 66;
  } catch {
    return false;
  }
}

function isBlockNoteRuntime(value: unknown): value is BlockNoteRuntime {
  return hasValidRuntimeShape(value) && hasValidRuntimeBehavior(value);
}

function incompatibleRuntime() {
  return new ErrorConstructor("BlockNote runtime registry is incompatible.");
}

function getRuntimeDescriptor(target: object) {
  try {
    return objectGetOwnPropertyDescriptor(target, runtimeKey);
  } catch {
    throw incompatibleRuntime();
  }
}

function runtimeFromDescriptor(descriptor: PropertyDescriptor | undefined) {
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.configurable !== false ||
    descriptor.enumerable !== false ||
    descriptor.writable !== false ||
    !isBlockNoteRuntime(descriptor.value)
  ) {
    throw incompatibleRuntime();
  }
  return descriptor.value;
}

export function installBlockNoteRuntime(target: object) {
  const descriptor = getRuntimeDescriptor(target);
  if (descriptor !== undefined) {
    return runtimeFromDescriptor(descriptor);
  }

  const runtime = createBlockNoteRuntime();
  try {
    objectDefineProperty(target, runtimeKey, {
      configurable: false,
      enumerable: false,
      value: runtime,
      writable: false,
    });
  } catch {
    throw incompatibleRuntime();
  }

  const installed = runtimeFromDescriptor(getRuntimeDescriptor(target));
  if (installed !== runtime) {
    throw incompatibleRuntime();
  }
  return installed;
}

export const blockNoteRuntime = installBlockNoteRuntime(globalThis);
