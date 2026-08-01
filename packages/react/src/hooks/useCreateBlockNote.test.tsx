import {
  BlockNoteEditor,
  type BlockNoteEditorFor,
  BlockNoteSchema,
  createBlockNoteDocument,
  createParagraphBlockSpec,
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema,
} from "@blocknote/core";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, expectTypeOf, it, vi } from "vite-plus/test";
import { useCreateBlockNote } from "./useCreateBlockNote.js";

const customSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: createParagraphBlockSpec(),
  },
});
const documentDefinition = createBlockNoteDocument({
  id: "react-hook",
  version: "1",
  schema: customSchema,
});

function InferenceHarness() {
  const defaultEditor = useCreateBlockNote();
  const customEditor = useCreateBlockNote({ schema: customSchema });
  const documentEditor = useCreateBlockNote({ document: documentDefinition });
  const configuredEditor = useCreateBlockNote({
    pasteHandler({ editor, event }) {
      expectTypeOf(event).toEqualTypeOf<ClipboardEvent>();
      expectTypeOf(editor).not.toBeAny();
      return undefined;
    },
    async uploadFile(file) {
      expectTypeOf(file).toEqualTypeOf<File>();
      return "file";
    },
  });

  expectTypeOf(defaultEditor).toEqualTypeOf<
    BlockNoteEditor<
      DefaultBlockSchema,
      DefaultInlineContentSchema,
      DefaultStyleSchema
    >
  >();
  expectTypeOf(customEditor.schema).toEqualTypeOf<typeof customSchema>();
  expectTypeOf(documentEditor).toEqualTypeOf<
    BlockNoteEditorFor<typeof documentDefinition>
  >();
  expectTypeOf(configuredEditor).toEqualTypeOf<typeof defaultEditor>();

  return null;
}

it("preserves default and custom schema inference", () => {
  expectTypeOf(InferenceHarness).toBeFunction();
});

it("renders without accessing a browser window", () => {
  let editor: BlockNoteEditor | undefined;

  function ServerHarness() {
    editor = useCreateBlockNote();
    return null;
  }

  vi.stubGlobal("window", undefined);
  try {
    expect(renderToStaticMarkup(<ServerHarness />)).toBe("");
  } finally {
    vi.unstubAllGlobals();
    editor?.destroy();
  }
});
