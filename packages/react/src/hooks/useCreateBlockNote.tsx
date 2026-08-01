import {
  BlockNoteEditor,
  BlockNoteEditorOptions,
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

/**
 * Hook to instantiate a BlockNote Editor instance in React
 */
export const useCreateBlockNote = <
  Options extends DirectBlockNoteEditorOptions | undefined,
>(
  options: Options = {} as Options,
  deps: DependencyList = [],
): Options extends {
  schema: CustomBlockNoteSchema<infer BSchema, infer ISchema, infer SSchema>;
}
  ? BlockNoteEditor<BSchema, ISchema, SSchema>
  : BlockNoteEditor<
      DefaultBlockSchema,
      DefaultInlineContentSchema,
      DefaultStyleSchema
    > => {
  return useMemo(() => {
    const directOptions: DirectBlockNoteEditorOptions = options ?? {};
    const editor = BlockNoteEditor.create(directOptions) as any;
    if (window) {
      // for testing / dev purposes
      (window as any).ProseMirror = editor._tiptapEditor;
    }
    return editor;
  }, deps); //eslint-disable-line react-hooks/exhaustive-deps
};
