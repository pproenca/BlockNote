import type { ExtensionFactoryInstance } from "../../../editor/BlockNoteExtension.js";
import type { CollaborationOptions } from "../index.js";
import { SuggestionsExtension } from "../Suggestions.js";
import { registerNativeSuggestionsBinding } from "./native.js";
import { uuidv4 } from "lib0/random";

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
      creatorId: uuidv4(),
      getActorId: () => options.user.id ?? null,
      authorityKey: options.suggestionDoc.guid,
    });
    return configured({ editor, context });
  };
  return runtime;
}
