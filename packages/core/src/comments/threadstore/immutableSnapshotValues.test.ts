import { describe, expect, it } from "vite-plus/test";

import {
  cloneOwnedSnapshotValue,
  immutableSnapshotDate,
} from "./immutableSnapshotValues.js";

const dateReadCases: readonly {
  readonly args?: readonly unknown[];
  readonly name: string;
  readonly property: PropertyKey;
}[] = [
  { name: "getDate", property: "getDate" },
  { name: "getDay", property: "getDay" },
  { name: "getFullYear", property: "getFullYear" },
  { name: "getHours", property: "getHours" },
  { name: "getMilliseconds", property: "getMilliseconds" },
  { name: "getMinutes", property: "getMinutes" },
  { name: "getMonth", property: "getMonth" },
  { name: "getSeconds", property: "getSeconds" },
  { name: "getTime", property: "getTime" },
  { name: "getTimezoneOffset", property: "getTimezoneOffset" },
  { name: "getUTCDate", property: "getUTCDate" },
  { name: "getUTCDay", property: "getUTCDay" },
  { name: "getUTCFullYear", property: "getUTCFullYear" },
  { name: "getUTCHours", property: "getUTCHours" },
  { name: "getUTCMilliseconds", property: "getUTCMilliseconds" },
  { name: "getUTCMinutes", property: "getUTCMinutes" },
  { name: "getUTCMonth", property: "getUTCMonth" },
  { name: "getUTCSeconds", property: "getUTCSeconds" },
  { name: "getYear (legacy)", property: "getYear" },
  { name: "toDateString", property: "toDateString" },
  { name: "toISOString", property: "toISOString" },
  { name: "toJSON", property: "toJSON" },
  { name: "toLocaleDateString", property: "toLocaleDateString" },
  { name: "toLocaleString", property: "toLocaleString" },
  { name: "toLocaleTimeString", property: "toLocaleTimeString" },
  { name: "toString", property: "toString" },
  { name: "toTimeString", property: "toTimeString" },
  { name: "toUTCString", property: "toUTCString" },
  { name: "toGMTString (legacy)", property: "toGMTString" },
  { name: "valueOf", property: "valueOf" },
  {
    args: ["default"],
    name: "Symbol.toPrimitive(default)",
    property: Symbol.toPrimitive,
  },
  {
    args: ["number"],
    name: "Symbol.toPrimitive(number)",
    property: Symbol.toPrimitive,
  },
  {
    args: ["string"],
    name: "Symbol.toPrimitive(string)",
    property: Symbol.toPrimitive,
  },
];

describe("immutable snapshot values", () => {
  it("exposes a non-leaking map facade through cycles and forEach", () => {
    const source = new Map<unknown, unknown>();
    source.set("self", source);

    const facade = cloneOwnedSnapshotValue(source) as ReadonlyMap<
      unknown,
      unknown
    >;
    let callbackMap: ReadonlyMap<unknown, unknown> | undefined;
    facade.forEach((_value, _key, map) => {
      callbackMap = map;
    });

    expect(facade instanceof Map).toBe(false);
    expect(facade.get("self")).toBe(facade);
    expect(callbackMap).toBe(facade);
    expect((facade as unknown as { set?: unknown }).set).toBeUndefined();
    expect(() => Map.prototype.set.call(facade, "escaped", true)).toThrow();
    expect(facade.has("escaped")).toBe(false);

    const republished = cloneOwnedSnapshotValue(facade) as ReadonlyMap<
      unknown,
      unknown
    >;
    expect(republished).not.toBe(facade);
    expect(republished.get("self")).toBe(republished);
  });

  it("exposes a non-leaking set facade through cycles and forEach", () => {
    const source = new Set<unknown>();
    source.add(source);

    const facade = cloneOwnedSnapshotValue(source) as ReadonlySet<unknown>;
    let callbackSet: ReadonlySet<unknown> | undefined;
    facade.forEach((_value, _key, set) => {
      callbackSet = set;
    });

    expect(facade instanceof Set).toBe(false);
    expect(facade.has(facade)).toBe(true);
    expect(callbackSet).toBe(facade);
    expect((facade as unknown as { add?: unknown }).add).toBeUndefined();
    expect(() => Set.prototype.add.call(facade, "escaped")).toThrow();
    expect(facade.has("escaped")).toBe(false);

    const republished = cloneOwnedSnapshotValue(facade) as ReadonlySet<unknown>;
    expect(republished).not.toBe(facade);
    expect(republished.has(republished)).toBe(true);
  });

  it("keeps Date reads and JSON working without exposing mutation", () => {
    const facade = immutableSnapshotDate(new Date(123));

    expect(facade).toBeInstanceOf(Date);
    expect(facade.getTime()).toBe(123);
    expect(facade.toJSON()).toBe(new Date(123).toJSON());
    expect(JSON.stringify({ at: facade })).toBe(
      JSON.stringify({ at: new Date(123) }),
    );
    expect(() => facade.setTime(456)).toThrow("immutable");
    expect(() => Date.prototype.setTime.call(facade, 789)).toThrow();
    expect(facade.getTime()).toBe(123);

    const invalid = immutableSnapshotDate(new Date(Number.NaN));
    expect(invalid.getTime()).toBeNaN();
    expect(invalid.toJSON()).toBeNull();
  });

  it.each(dateReadCases)(
    "preserves Date read semantics for $name",
    ({ args = [], property }) => {
      const source = new Date("2026-08-01T12:34:56.789Z");
      const facade = immutableSnapshotDate(source);

      expect(invokeDateOperation(facade, property, args)).toEqual(
        invokeDateOperation(source, property, args),
      );
    },
  );

  it("rejects aliased mutators and arbitrary Date prototype accessors", () => {
    const mutatorAlias = Symbol("mutatorAlias");
    const accessorAlias = Symbol("accessorAlias");
    const setTime = Reflect.get(Date.prototype, "setTime");
    let accessorReads = 0;
    Object.defineProperty(Date.prototype, mutatorAlias, {
      configurable: true,
      value: setTime,
    });
    Object.defineProperty(Date.prototype, accessorAlias, {
      configurable: true,
      get() {
        accessorReads += 1;
        return setTime;
      },
    });

    try {
      const facade = immutableSnapshotDate(new Date(123));
      const properties = facade as unknown as Record<PropertyKey, unknown>;

      expect(() =>
        (properties[mutatorAlias] as (value: number) => number)(456),
      ).toThrow("immutable");
      expect(() => properties[accessorAlias]).toThrow("immutable");
      expect(accessorReads).toBe(0);
      expect(facade.getTime()).toBe(123);
    } finally {
      Reflect.deleteProperty(Date.prototype, mutatorAlias);
      Reflect.deleteProperty(Date.prototype, accessorAlias);
    }
  });
});

function invokeDateOperation(
  value: Date,
  property: PropertyKey,
  args: readonly unknown[],
) {
  const operation = Reflect.get(value, property);
  if (typeof operation !== "function") {
    throw new TypeError(`Date operation ${String(property)} is unavailable.`);
  }
  return Reflect.apply(operation, value, args);
}
