/** @vitest-environment node */
import { describe, expect, it, vi } from "vite-plus/test";

import { createBlockNoteDurabilityState } from "./durability-state.js";

describe("createBlockNoteDurabilityState", () => {
  it("does not let a local cache save hide pending provider work", () => {
    const publish = vi.fn();
    const durability = createBlockNoteDurabilityState(publish);

    durability.provider("pending");
    durability.recovery("pending");
    durability.recovery("saved");

    expect(durability.get()).toBe("pending");
    expect(publish).toHaveBeenLastCalledWith("pending");

    durability.provider("saved");
    expect(durability.get()).toBe("saved");
  });

  it("keeps errors terminal until the failing source recovers", () => {
    const durability = createBlockNoteDurabilityState(vi.fn());

    durability.recovery("error");
    durability.provider("pending");
    expect(durability.get()).toBe("error");

    durability.recovery("saved");
    expect(durability.get()).toBe("pending");
  });
});
