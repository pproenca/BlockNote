export interface BlockNoteStore<TValue> {
  readonly state: TValue;
  get(): TValue;
  subscribe(listener: (value: TValue) => void): () => void;
}

export interface BlockNoteWritableStore<TValue> extends BlockNoteStore<TValue> {
  set(value: TValue): void;
}

export function createBlockNoteStore<TValue>(
  initialValue: TValue,
  options: {
    equals?: (previous: TValue, next: TValue) => boolean;
  } = {},
): BlockNoteWritableStore<TValue> {
  const equals = options.equals ?? Object.is;
  const listeners = new Set<(value: TValue) => void>();
  let value = initialValue;

  return {
    get state() {
      return value;
    },
    get() {
      return value;
    },
    set(next) {
      if (equals(value, next)) {
        return;
      }

      value = next;
      for (const listener of [...listeners]) {
        listener(value);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      let subscribed = true;

      return () => {
        if (!subscribed) {
          return;
        }

        subscribed = false;
        listeners.delete(listener);
      };
    },
  };
}
