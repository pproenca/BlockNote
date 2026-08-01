import type { ExtensionFactoryInstance } from "../../../editor/BlockNoteExtension.js";
import type { CollaborationOptions } from "../index.js";
import { SuggestionsExtension } from "../Suggestions.js";
import { registerNativeSuggestionsBinding } from "./native.js";

export function createSuggestionsRuntimeExtension(
  options: CollaborationOptions,
) {
  const configured =
    SuggestionsExtension() as unknown as ExtensionFactoryInstance;
  const runtime: ExtensionFactoryInstance = ({ editor, context }) => {
    if (!options.suggestionDoc || !options.renderer) {
      throw new Error("Suggestions require a suggestion document and renderer");
    }
    registerNativeSuggestionsBinding(editor, {
      fragment: options.fragment,
      suggestionDoc: options.suggestionDoc,
      renderer: options.renderer,
      getActorId: () => options.user.id ?? null,
    });
    return configured({ editor, context });
  };
  return runtime;
}
