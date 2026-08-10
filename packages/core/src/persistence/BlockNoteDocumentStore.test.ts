import { describe, expectTypeOf, it } from "vite-plus/test";

import type { BlockNoteDocumentBinding } from "./BlockNoteDocumentBinding.js";
import type {
  BlockNoteAppendInput,
  BlockNoteCompactInput,
  BlockNoteDocumentStore,
  BlockNoteInitializeInput,
  BlockNoteStoredDocument,
} from "./BlockNoteDocumentStore.js";
import type {
  BlockNoteChange,
  BlockNoteCheckpoint,
  BlockNoteRevision,
} from "./BlockNotePersistence.js";

describe("BlockNoteDocumentStore", () => {
  it("keeps binding initialization-only and every stored value readonly", () => {
    type Key = { readonly account: string; readonly document: string };
    type Store = BlockNoteDocumentStore<Key>;

    expectTypeOf<Parameters<Store["initialize"]>[0]>().toEqualTypeOf<
      BlockNoteInitializeInput<Key>
    >();
    expectTypeOf<Parameters<Store["append"]>[0]>().toEqualTypeOf<
      BlockNoteAppendInput<Key>
    >();
    expectTypeOf<Parameters<Store["compact"]>[0]>().toEqualTypeOf<
      BlockNoteCompactInput<Key>
    >();
    expectTypeOf<
      BlockNoteInitializeInput<Key>["binding"]
    >().toEqualTypeOf<BlockNoteDocumentBinding>();
    expectTypeOf<BlockNoteAppendInput<Key>>().not.toHaveProperty("binding");
    expectTypeOf<BlockNoteCompactInput<Key>>().not.toHaveProperty("binding");
    expectTypeOf<BlockNoteStoredDocument["changes"]>().toEqualTypeOf<
      readonly {
        readonly revision: BlockNoteRevision;
        readonly change: BlockNoteChange;
      }[]
    >();
    expectTypeOf<
      BlockNoteStoredDocument["checkpoint"]
    >().toEqualTypeOf<BlockNoteCheckpoint>();
  });

  it("keeps revisions literal and engine-neutral", () => {
    expectTypeOf<BlockNoteRevision>().toEqualTypeOf<{
      readonly sequence: number;
      readonly token: string;
    }>();
  });
});
