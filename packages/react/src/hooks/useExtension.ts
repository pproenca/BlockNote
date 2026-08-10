import {
  BlockNoteEditor,
  createStore,
  type AnyExtensionFactory,
  Extension,
  type ExtensionInstanceFromFactory,
} from "@blocknote/core";
import { useStore } from "@tanstack/react-store";
import { useBlockNoteEditor } from "./useBlockNoteEditor.js";

type Store<T> = ReturnType<typeof createStore<T>>;

/**
 * Use an extension instance
 */
export function useExtension<
  const T extends AnyExtensionFactory | Extension | string,
>(
  plugin: T,
  ctx?: { editor?: BlockNoteEditor<any, any, any> },
): T extends AnyExtensionFactory
  ? NonNullable<ExtensionInstanceFromFactory<T>>
  : T extends string
    ? Extension
    : T extends Extension
      ? T
      : never {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const editor = ctx?.editor ?? useBlockNoteEditor();

  const instance = editor.getExtension(plugin as any);

  if (!instance) {
    throw new Error("Extension not found", { cause: { plugin } });
  }

  return instance;
}

type ExtractStore<T> =
  T extends Store<infer U>
    ? U
    : T extends { readonly state: infer U }
      ? U
      : never;

/**
 * Use the state of an extension
 */
export function useExtensionState<
  T extends AnyExtensionFactory | Extension,
  TExtension = T extends AnyExtensionFactory
    ? ExtensionInstanceFromFactory<T>
    : T,
  TStore = TExtension extends { store: Store<any> }
    ? TExtension["store"]
    : never,
  TSelected = NoInfer<ExtractStore<TStore>>,
>(
  plugin: T | string,
  ctx?: {
    editor?: BlockNoteEditor<any, any, any>;
    selector?: (state: NoInfer<ExtractStore<TStore>>) => TSelected;
  },
): TSelected {
  const extension = useExtension(
    plugin as AnyExtensionFactory | Extension | string,
    ctx,
  );
  const { store } = extension;
  if (!store) {
    throw new Error("Store not found on plugin", { cause: { plugin } });
  }
  return useStore<ExtractStore<TStore>, TSelected>(store, ctx?.selector as any);
}
