import { describe, expect, it, vi } from "vite-plus/test";
import { createBlockNoteStore } from "./BlockNoteStore.js";

describe("createBlockNoteStore", () => {
  it("separates snapshots from subscriptions", () => {
    const store = createBlockNoteStore({ value: 1 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(store.get()).toEqual({ value: 1 });
    expect(listener).not.toHaveBeenCalled();

    store.set({ value: 2 });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith({ value: 2 });

    unsubscribe();
    unsubscribe();
    store.set({ value: 3 });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("supports domain equality without changing the store protocol", () => {
    const listener = vi.fn();
    const store = createBlockNoteStore(
      { id: "first", revision: 1 },
      { equals: (previous, next) => previous.revision === next.revision },
    );

    store.subscribe(listener);
    store.set({ id: "second", revision: 1 });

    expect(store.get()).toEqual({ id: "first", revision: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});
