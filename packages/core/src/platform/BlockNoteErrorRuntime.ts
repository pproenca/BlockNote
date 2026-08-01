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

export interface BlockNoteErrorRuntime {
  readonly version: 1;
  readonly BlockNoteError: SharedBlockNoteErrorConstructor;
  readonly errorBrand: WeakSet<object>;
}

const runtimeKey = Symbol.for("@blocknote/core/error-runtime/v1");
const runtimeKeys = ["version", "BlockNoteError", "errorBrand"] as const;
const reflectApply = Reflect.apply;
// oxlint-disable-next-line typescript/unbound-method -- invoked with an explicit receiver
const weakSetHas = WeakSet.prototype.has;
const registryProbe = Object.freeze({});

function hasWeakSetBrand(value: unknown) {
  try {
    reflectApply(weakSetHas, value, [registryProbe]);
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

function isBlockNoteErrorRuntime(
  value: unknown,
): value is BlockNoteErrorRuntime {
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

    const candidate = value as BlockNoteErrorRuntime;
    return (
      candidate.version === 1 &&
      typeof candidate.BlockNoteError === "function" &&
      candidate.BlockNoteError.name === "BlockNoteError" &&
      candidate.BlockNoteError.prototype instanceof Error &&
      hasWeakSetBrand(candidate.errorBrand)
    );
  } catch {
    return false;
  }
}

function createBlockNoteErrorRuntime(): BlockNoteErrorRuntime {
  const errorBrand = new WeakSet<object>();

  class BlockNoteError extends Error implements SharedBlockNoteError {
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
      errorBrand.add(this);
    }
  }
  Object.defineProperty(BlockNoteError, "name", { value: "BlockNoteError" });

  const runtime = Object.create(null) as BlockNoteErrorRuntime;
  Object.defineProperties(runtime, {
    version: { value: 1 },
    BlockNoteError: { value: BlockNoteError },
    errorBrand: { value: errorBrand },
  });
  return Object.freeze(runtime);
}

function incompatibleRuntime() {
  return new Error("BlockNote error runtime registry is incompatible.");
}

export function installBlockNoteErrorRuntime(target: object) {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, runtimeKey);
  } catch {
    throw incompatibleRuntime();
  }

  if (descriptor === undefined) {
    const runtime = createBlockNoteErrorRuntime();
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
    !isBlockNoteErrorRuntime(descriptor.value)
  ) {
    throw incompatibleRuntime();
  }
  return descriptor.value;
}

export const blockNoteErrorRuntime = installBlockNoteErrorRuntime(globalThis);

export function hasBlockNoteErrorBrand(value: object) {
  try {
    return reflectApply(weakSetHas, blockNoteErrorRuntime.errorBrand, [
      value,
    ]) as boolean;
  } catch {
    return false;
  }
}
