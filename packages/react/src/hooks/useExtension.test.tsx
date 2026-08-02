import type { BlockNoteEditor } from "@blocknote/core";
import {
  type BlockNoteSuggestionsExtension,
  SuggestionsExtension,
} from "@blocknote/core/y";
import { expectTypeOf, it } from "vite-plus/test";

import { useExtension } from "./useExtension.js";

function SuggestionsInferenceHarness({
  editor,
}: {
  editor: BlockNoteEditor<any, any, any>;
}) {
  const extension = useExtension(SuggestionsExtension, { editor });

  expectTypeOf(extension).toEqualTypeOf<BlockNoteSuggestionsExtension>();
  return null;
}

it("infers document extension factory instances", () => {
  expectTypeOf(SuggestionsInferenceHarness).toBeFunction();
});
