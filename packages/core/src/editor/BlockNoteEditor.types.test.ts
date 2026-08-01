/**
 * @vitest-environment jsdom
 */
import { expectTypeOf, it } from "vite-plus/test";

import {
  BlockNoteSchema,
  type DefaultBlockSchema,
  type DefaultInlineContentSchema,
  type DefaultStyleSchema,
} from "../blocks/index.js";
import { defaultBlockSpecs } from "../blocks/defaultBlocks.js";
import { defineBlockNoteDocument } from "../document/BlockNoteDocument.js";
import {
  createExtension,
  type ExtensionOptions,
} from "./BlockNoteExtension.js";
import {
  BlockNoteEditor,
  type BlockNoteEditorFor,
  type BlockNoteEditorOptions,
} from "./BlockNoteEditor.js";

interface RequiredContext {
  readonly service: {
    readonly ready: true;
  };
}

const ContextExtension = createExtension(
  ({ context }: ExtensionOptions<undefined, RequiredContext>) => ({
    key: "create-types-context",
    ready: context.service.ready,
  }),
  { name: "create-types-context", version: "1" },
);

const customSchema = BlockNoteSchema.create({
  blockSpecs: { paragraph: defaultBlockSpecs.paragraph },
});

const typedDocument = defineBlockNoteDocument({
  id: "create-types",
  version: "1",
  schema: customSchema,
  extensions: [ContextExtension()],
});

function createLegacyEditor<
  Options extends
    | Partial<
        BlockNoteEditorOptions<
          DefaultBlockSchema,
          DefaultInlineContentSchema,
          DefaultStyleSchema
        >
      >
    | undefined,
>(options?: Options) {
  return BlockNoteEditor.create(options);
}

function rejectGenericTypedOverrides<
  Options extends {
    readonly document: typeof typedDocument;
    readonly context: RequiredContext;
    readonly schema: typeof customSchema;
    readonly extensions: readonly [];
  },
>(options: Options) {
  // @ts-expect-error typed documents own their schema and extensions
  return BlockNoteEditor.create(options);
}

function checkCreateTypes() {
  const context: RequiredContext = { service: { ready: true } };
  const defaultEditor = BlockNoteEditor.create();
  expectTypeOf(defaultEditor).toEqualTypeOf<
    BlockNoteEditor<
      DefaultBlockSchema,
      DefaultInlineContentSchema,
      DefaultStyleSchema
    >
  >();

  const wrappedEditor = createLegacyEditor();
  expectTypeOf(wrappedEditor).toEqualTypeOf<typeof defaultEditor>();

  const customEditor = BlockNoteEditor.create({ schema: customSchema });
  expectTypeOf(customEditor.schema).toEqualTypeOf<typeof customSchema>();

  const documentEditor = BlockNoteEditor.create({
    document: typedDocument,
    context: { service: { ready: true } },
  });
  expectTypeOf(documentEditor.schema).toEqualTypeOf<typeof customSchema>();
  expectTypeOf(documentEditor).toEqualTypeOf<
    BlockNoteEditorFor<typeof typedDocument>
  >();

  // @ts-expect-error typed document context is required
  BlockNoteEditor.create({ document: typedDocument });

  // @ts-expect-error malformed values are not document definitions
  BlockNoteEditor.create({ document: { id: "malformed" } });

  const schemaOverride = {
    document: typedDocument,
    schema: customSchema,
    context,
  };
  // @ts-expect-error document definitions own their schema
  BlockNoteEditor.create(schemaOverride);

  const extensionsOverride = {
    document: typedDocument,
    extensions: [],
    context,
  };
  // @ts-expect-error document definitions own their extensions
  BlockNoteEditor.create(extensionsOverride);
}

it("preserves legacy and typed document create overloads", () => {
  expectTypeOf(checkCreateTypes).toBeFunction();
  expectTypeOf(rejectGenericTypedOverrides).toBeFunction();
});
