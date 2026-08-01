import {
  BlockNoteEditor,
  BlockNoteSchema,
  createParagraphBlockSpec,
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema,
} from "@blocknote/core";
import { expectTypeOf, it } from "vite-plus/test";
import { useCreateBlockNote } from "./useCreateBlockNote.js";

const customSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: createParagraphBlockSpec(),
  },
});

function InferenceHarness() {
  const defaultEditor = useCreateBlockNote();
  const customEditor = useCreateBlockNote({ schema: customSchema });

  expectTypeOf(defaultEditor).toEqualTypeOf<
    BlockNoteEditor<
      DefaultBlockSchema,
      DefaultInlineContentSchema,
      DefaultStyleSchema
    >
  >();
  expectTypeOf(customEditor.schema).toEqualTypeOf<typeof customSchema>();

  return null;
}

it("preserves default and custom schema inference", () => {
  expectTypeOf(InferenceHarness).toBeFunction();
});
