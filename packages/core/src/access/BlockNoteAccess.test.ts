import { describe, expect, it, vi } from "vite-plus/test";
import {
  createBlockNoteAccess,
  isBlockNoteActionAllowed,
  type BlockNoteAccess,
} from "./BlockNoteAccess.js";

const editingAccess: BlockNoteAccess = {
  mode: "editing",
  edit: true,
  comment: true,
  suggest: false,
  review: false,
};

describe("createBlockNoteAccess", () => {
  it("publishes immutable access snapshots", () => {
    const store = createBlockNoteAccess(editingAccess);
    const listener = vi.fn();

    store.subscribe(listener);
    store.set({ ...editingAccess, mode: "viewing", edit: false });

    expect(listener).toHaveBeenCalledOnce();
    expect(store.get()).toEqual({
      ...editingAccess,
      mode: "viewing",
      edit: false,
    });
    expect(Object.isFrozen(store.get())).toBe(true);
  });

  it("does not publish equivalent snapshots", () => {
    const store = createBlockNoteAccess(editingAccess);
    const listener = vi.fn();

    store.subscribe(listener);
    store.set({ ...editingAccess });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("isBlockNoteActionAllowed", () => {
  it("uses capabilities rather than mode as authorization", () => {
    const access: BlockNoteAccess = {
      mode: "editing",
      edit: false,
      comment: true,
      suggest: false,
      review: false,
    };

    expect(isBlockNoteActionAllowed(access, "edit")).toBe(false);
    expect(isBlockNoteActionAllowed(access, "comment")).toBe(true);
  });
});
