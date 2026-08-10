export function createBlockNoteEvents<Events extends object>() {
  const listeners = new Map<keyof Events, Set<(value: never) => void>>();
  return Object.freeze({
    emit<Key extends keyof Events>(event: Key, value: Events[Key]) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(value as never);
      }
    },
    on<Key extends keyof Events>(
      event: Key,
      listener: (value: Events[Key]) => void,
    ) {
      const current = listeners.get(event) ?? new Set();
      current.add(listener as (value: never) => void);
      listeners.set(event, current);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        current.delete(listener as (value: never) => void);
      };
    },
    clear() {
      listeners.clear();
    },
  });
}
