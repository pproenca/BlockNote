import type { BlockNoteSessionState } from "./session-types.js";

type Durability = BlockNoteSessionState["durability"];

function combine(left: Durability, right: Durability): Durability {
  if (left === "error" || right === "error") return "error";
  if (left === "offline" || right === "offline") return "offline";
  if (left === "pending" || right === "pending") return "pending";
  return "saved";
}

export function createBlockNoteDurabilityState(
  publish: (durability: Durability) => void,
) {
  let provider: Durability = "saved";
  let recovery: Durability = "saved";
  let current: Durability = "saved";
  const update = () => {
    const next = combine(provider, recovery);
    if (next === current) return;
    current = next;
    publish(current);
  };

  return Object.freeze({
    get: () => current,
    provider(value: Durability) {
      provider = value;
      update();
    },
    recovery(value: Durability) {
      recovery = value;
      update();
    },
  });
}
