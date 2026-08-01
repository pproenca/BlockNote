import { BlockNoteError } from "../../platform/BlockNoteError.js";

const capturedDateReadOperationNames = [
  "getDate",
  "getDay",
  "getFullYear",
  "getHours",
  "getMilliseconds",
  "getMinutes",
  "getMonth",
  "getSeconds",
  "getTime",
  "getTimezoneOffset",
  "getUTCDate",
  "getUTCDay",
  "getUTCFullYear",
  "getUTCHours",
  "getUTCMilliseconds",
  "getUTCMinutes",
  "getUTCMonth",
  "getUTCSeconds",
  "getYear",
  "toDateString",
  "toISOString",
  "toLocaleDateString",
  "toLocaleString",
  "toLocaleTimeString",
  "toString",
  "toTimeString",
  "toUTCString",
  "toGMTString",
  "valueOf",
] as const;
const capturedDateReadOperations = new Map<PropertyKey, CallableFunction>(
  capturedDateReadOperationNames.map((property) => [
    property,
    captureDateOperation(property),
  ]),
);
const capturedDateToISOString = captureDateOperation("toISOString");
const capturedDateToString = captureDateOperation("toString");
const readonlyMapTargets = new WeakMap<object, Map<unknown, unknown>>();
const readonlySetTargets = new WeakMap<object, Set<unknown>>();

function captureDateOperation(property: PropertyKey) {
  const operation = Reflect.get(Date.prototype, property);
  if (typeof operation !== "function") {
    throw new TypeError(`Date operation ${String(property)} is unavailable.`);
  }
  return operation as CallableFunction;
}

export function immutableSnapshotDate(value: Date) {
  let time: number;
  try {
    time = value.getTime();
  } catch (error) {
    throw invalidSnapshotValue("Thread snapshot date is not readable.", error);
  }
  const target = new Date(time);
  Object.freeze(target);
  return new Proxy(target, {
    get(date, property) {
      if (property === "constructor") {
        return Date;
      }
      if (property === "toJSON") {
        return () =>
          Number.isFinite(time)
            ? Reflect.apply(capturedDateToISOString, date, [])
            : null;
      }
      if (property === Symbol.toPrimitive) {
        return (hint: string) => {
          if (hint === "number") {
            return time;
          }
          if (hint === "default" || hint === "string") {
            return Reflect.apply(capturedDateToString, date, []);
          }
          throw new TypeError("Invalid Date primitive hint.");
        };
      }
      const operation = capturedDateReadOperations.get(property);
      if (operation) {
        return (...args: unknown[]) => Reflect.apply(operation, date, args);
      }
      if (property in date) {
        return rejectSnapshotDateProperty(property);
      }
      return undefined;
    },
    set: rejectSnapshotMutation,
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  });
}

function rejectSnapshotDateProperty(_property: PropertyKey): never {
  throw new TypeError("Thread store snapshot Dates are immutable.");
}

export function cloneOwnedSnapshotValue(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (value instanceof Date) {
    const next = immutableSnapshotDate(value);
    seen.set(value, next);
    return next;
  }
  const readonlyMapTarget = readonlyMapTargets.get(value);
  if (readonlyMapTarget) {
    return cloneMap(readonlyMapTarget, value, seen);
  }
  const readonlySetTarget = readonlySetTargets.get(value);
  if (readonlySetTarget) {
    return cloneSet(readonlySetTarget, value, seen);
  }
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    seen.set(value, next);
    const length = value.length;
    for (let index = 0; index < length; index += 1) {
      const item = value[index];
      next.push(cloneOwnedSnapshotValue(item, seen));
    }
    return Object.freeze(next);
  }
  if (value instanceof Map) {
    return cloneMap(value, value, seen);
  }
  if (value instanceof Set) {
    return cloneSet(value, value, seen);
  }

  const next: Record<PropertyKey, unknown> = {};
  seen.set(value, next);
  for (const key of Reflect.ownKeys(value)) {
    const item = (value as Record<PropertyKey, unknown>)[key];
    Object.defineProperty(next, key, {
      configurable: false,
      enumerable: true,
      value: cloneOwnedSnapshotValue(item, seen),
      writable: false,
    });
  }
  return Object.freeze(next);
}

export function readonlyMapFacade<TKey, TValue>(
  target: Map<TKey, TValue>,
): ReadonlyMap<TKey, TValue> {
  // Intentionally not a Map instance: Map.prototype mutators cannot reach target.
  let facade: ReadonlyMap<TKey, TValue>;
  facade = Object.freeze({
    get size() {
      return target.size;
    },
    get(key: TKey) {
      return target.get(key);
    },
    has(key: TKey) {
      return target.has(key);
    },
    entries() {
      return target.entries();
    },
    keys() {
      return target.keys();
    },
    values() {
      return target.values();
    },
    forEach(
      callback: (
        value: TValue,
        key: TKey,
        map: ReadonlyMap<TKey, TValue>,
      ) => void,
      thisArg?: unknown,
    ) {
      for (const [key, value] of target) {
        callback.call(thisArg, value, key, facade);
      }
    },
    [Symbol.iterator]() {
      return target[Symbol.iterator]();
    },
    [Symbol.toStringTag]: "Map",
  });
  readonlyMapTargets.set(facade as object, target as Map<unknown, unknown>);
  return facade;
}

function readonlySetFacade<TValue>(target: Set<TValue>): ReadonlySet<TValue> {
  let facade: ReadonlySet<TValue>;
  facade = Object.freeze({
    get size() {
      return target.size;
    },
    has(value: TValue) {
      return target.has(value);
    },
    entries() {
      return target.entries();
    },
    keys() {
      return target.keys();
    },
    values() {
      return target.values();
    },
    union<U>(other: ReadonlySetLike<U>) {
      const result = new Set<TValue | U>(target);
      visitSetLike(other, (value) => result.add(value));
      return result;
    },
    intersection<U>(other: ReadonlySetLike<U>) {
      const result = new Set<TValue & U>();
      const comparable = other as ReadonlySetLike<unknown>;
      for (const value of target) {
        if (comparable.has(value)) {
          result.add(value as TValue & U);
        }
      }
      return result;
    },
    difference<U>(other: ReadonlySetLike<U>) {
      const result = new Set<TValue>();
      const comparable = other as ReadonlySetLike<unknown>;
      for (const value of target) {
        if (!comparable.has(value)) {
          result.add(value);
        }
      }
      return result;
    },
    symmetricDifference<U>(other: ReadonlySetLike<U>) {
      const result = new Set<TValue | U>(target);
      visitSetLike(other, (value) => {
        if (target.has(value as unknown as TValue)) {
          result.delete(value);
        } else {
          result.add(value);
        }
      });
      return result;
    },
    isSubsetOf(other: ReadonlySetLike<unknown>) {
      for (const value of target) {
        if (!other.has(value)) {
          return false;
        }
      }
      return true;
    },
    isSupersetOf(other: ReadonlySetLike<unknown>) {
      let result = true;
      visitSetLike(other, (value) => {
        if (!target.has(value as TValue)) {
          result = false;
        }
      });
      return result;
    },
    isDisjointFrom(other: ReadonlySetLike<unknown>) {
      let result = true;
      visitSetLike(other, (value) => {
        if (target.has(value as TValue)) {
          result = false;
        }
      });
      return result;
    },
    forEach(
      callback: (value: TValue, key: TValue, set: ReadonlySet<TValue>) => void,
      thisArg?: unknown,
    ) {
      for (const value of target) {
        callback.call(thisArg, value, value, facade);
      }
    },
    [Symbol.iterator]() {
      return target[Symbol.iterator]();
    },
    [Symbol.toStringTag]: "Set",
  });
  readonlySetTargets.set(facade as object, target as Set<unknown>);
  return facade;
}

function cloneMap(
  source: ReadonlyMap<unknown, unknown>,
  identity: object,
  seen: WeakMap<object, unknown>,
) {
  const target = new Map<unknown, unknown>();
  const facade = readonlyMapFacade(target);
  seen.set(identity, facade);
  for (const [key, item] of source) {
    target.set(
      cloneOwnedSnapshotValue(key, seen),
      cloneOwnedSnapshotValue(item, seen),
    );
  }
  return facade;
}

function cloneSet(
  source: ReadonlySet<unknown>,
  identity: object,
  seen: WeakMap<object, unknown>,
) {
  const target = new Set<unknown>();
  const facade = readonlySetFacade(target);
  seen.set(identity, facade);
  for (const item of source) {
    target.add(cloneOwnedSnapshotValue(item, seen));
  }
  return facade;
}

function visitSetLike<TValue>(
  value: ReadonlySetLike<TValue>,
  visitor: (item: TValue) => void,
) {
  const iterator = value.keys();
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    visitor(next.value);
  }
}

function rejectSnapshotMutation(): never {
  throw new TypeError("Thread store snapshots are immutable.");
}

function invalidSnapshotValue(message: string, cause?: unknown) {
  return new BlockNoteError("invalid-document", message, { cause });
}
