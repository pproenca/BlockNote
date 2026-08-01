export type SharedBlockNotePersistenceFrameKind = "checkpoint" | "change";

export interface SharedBlockNotePersistenceFrame {
  readonly kind: SharedBlockNotePersistenceFrameKind;
  readonly bytes: Uint8Array;
}

export interface BlockNotePersistenceRuntime {
  readonly version: 1;
  readonly storedFrames: WeakMap<object, SharedBlockNotePersistenceFrame>;
}

const runtimeKey = Symbol.for("@blocknote/core/persistence-runtime/v1");
const runtimeKeys = ["version", "storedFrames"] as const;
const reflectApply = Reflect.apply;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const weakMapHas = WeakMap.prototype.has;
const registryProbe = Object.freeze({});

function hasWeakMapBrand(value: unknown) {
  try {
    reflectApply(weakMapHas, value, [registryProbe]);
    return true;
  } catch {
    return false;
  }
}

function isImmutableDataProperty(
  value: object,
  key: (typeof runtimeKeys)[number],
) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return (
    descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.configurable === false &&
    descriptor.enumerable === false &&
    descriptor.writable === false
  );
}

function isBlockNotePersistenceRuntime(
  value: unknown,
): value is BlockNotePersistenceRuntime {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== null ||
      !Object.isFrozen(value) ||
      Reflect.ownKeys(value).length !== runtimeKeys.length ||
      !runtimeKeys.every((key) => isImmutableDataProperty(value, key))
    ) {
      return false;
    }

    const candidate = value as BlockNotePersistenceRuntime;
    return candidate.version === 1 && hasWeakMapBrand(candidate.storedFrames);
  } catch {
    return false;
  }
}

function createBlockNotePersistenceRuntime(): BlockNotePersistenceRuntime {
  const runtime = Object.create(null) as BlockNotePersistenceRuntime;
  Object.defineProperties(runtime, {
    version: { value: 1 },
    storedFrames: { value: new WeakMap() },
  });
  return Object.freeze(runtime);
}

function incompatibleRuntime() {
  return new Error("BlockNote persistence runtime registry is incompatible.");
}

export function installBlockNotePersistenceRuntime(target: object) {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, runtimeKey);
  } catch {
    throw incompatibleRuntime();
  }

  if (descriptor === undefined) {
    const runtime = createBlockNotePersistenceRuntime();
    try {
      Object.defineProperty(target, runtimeKey, {
        configurable: false,
        enumerable: false,
        value: runtime,
        writable: false,
      });
    } catch {
      throw incompatibleRuntime();
    }
    return runtime;
  }

  if (
    !("value" in descriptor) ||
    descriptor.configurable !== false ||
    descriptor.enumerable !== false ||
    descriptor.writable !== false ||
    !isBlockNotePersistenceRuntime(descriptor.value)
  ) {
    throw incompatibleRuntime();
  }
  return descriptor.value;
}

export const blockNotePersistenceRuntime =
  installBlockNotePersistenceRuntime(globalThis);
