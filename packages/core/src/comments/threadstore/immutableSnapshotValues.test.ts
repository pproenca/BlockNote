import { describe, expect, it } from "vite-plus/test";

import {
  cloneOwnedSnapshotValue,
  immutableSnapshotDate,
} from "./immutableSnapshotValues.js";

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
});
