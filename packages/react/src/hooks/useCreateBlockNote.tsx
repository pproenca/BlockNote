import {
  type AnyBlockNoteDocumentDefinition,
  BlockNoteEditor,
  type BlockNoteEditorFor,
  BlockNoteEditorOptions,
  type BlockNoteEditorOptionsForDocument,
  CustomBlockNoteSchema,
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema,
} from "@blocknote/core";
import { DependencyList, useMemo } from "react";

type DirectBlockNoteEditorOptions = Partial<
  BlockNoteEditorOptions<any, any, any>
> & {
  readonly document?: never;
};

type DirectBlockNoteEditor<Options> = Options extends {
  schema: CustomBlockNoteSchema<infer BSchema, infer ISchema, infer SSchema>;
}
  ? BlockNoteEditor<BSchema, ISchema, SSchema>
  : BlockNoteEditor<
      DefaultBlockSchema,
      DefaultInlineContentSchema,
      DefaultStyleSchema
    >;

/**
 * Synchronously creates and memoizes a BlockNote editor. This legacy hook does
 * not own editor disposal; use an owned session lifecycle when disposal must be
 * managed automatically.
 */
export function useCreateBlockNote<
  const Document extends AnyBlockNoteDocumentDefinition,
>(
  options: BlockNoteEditorOptionsForDocument<Document>,
  deps?: DependencyList,
): BlockNoteEditorFor<Document>;
export function useCreateBlockNote<
  Options extends DirectBlockNoteEditorOptions,
>(options: Options, deps?: DependencyList): DirectBlockNoteEditor<Options>;
export function useCreateBlockNote(
  options?: undefined,
  deps?: DependencyList,
): BlockNoteEditor<
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema
>;
export function useCreateBlockNote(
  options:
    | DirectBlockNoteEditorOptions
    | BlockNoteEditorOptionsForDocument<AnyBlockNoteDocumentDefinition> = {},
  deps: DependencyList = [],
) {
  return useMemo(
    () => BlockNoteEditor.create(options as any),
    deps, //eslint-disable-line react-hooks/exhaustive-deps
  );
}
