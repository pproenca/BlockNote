import {
  createBlockNoteStore,
  type BlockNoteWritableStore,
} from "../platform/BlockNoteStore.js";

export type BlockNoteMode = "editing" | "suggesting" | "viewing";

export interface BlockNoteAccess {
  readonly mode: BlockNoteMode;
  readonly edit: boolean;
  readonly comment: boolean;
  readonly suggest: boolean;
  readonly review: boolean;
}

export type BlockNoteMutationAction = "edit" | "suggest" | "review";

export type BlockNoteAccessAction = BlockNoteMutationAction | "comment";

export interface BlockNoteAccessStore extends BlockNoteWritableStore<BlockNoteAccess> {}

function equalAccess(previous: BlockNoteAccess, next: BlockNoteAccess) {
  return (
    previous.mode === next.mode &&
    previous.edit === next.edit &&
    previous.comment === next.comment &&
    previous.suggest === next.suggest &&
    previous.review === next.review
  );
}

function immutableAccess(access: BlockNoteAccess): BlockNoteAccess {
  return Object.freeze({ ...access });
}

export function createBlockNoteAccess(
  initial: BlockNoteAccess,
): BlockNoteAccessStore {
  const store = createBlockNoteStore(immutableAccess(initial), {
    equals: equalAccess,
  });

  return {
    get() {
      return store.get();
    },
    subscribe(listener) {
      return store.subscribe(listener);
    },
    set(next) {
      store.set(immutableAccess(next));
    },
  };
}

export function isBlockNoteActionAllowed(
  access: BlockNoteAccess,
  action: BlockNoteAccessAction,
) {
  return access[action];
}
