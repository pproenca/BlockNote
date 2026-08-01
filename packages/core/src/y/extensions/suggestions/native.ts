import type { BlockNoteEditor } from "../../../editor/BlockNoteEditor.js";
import { getIndexedRecords, observeNativeSuggestions } from "./ledger.js";
import type { NativeSuggestionsBinding } from "./model.js";

const bindings = new WeakMap<
  BlockNoteEditor<any, any, any>,
  NativeSuggestionsBinding
>();

export function registerNativeSuggestionsBinding(
  editor: BlockNoteEditor<any, any, any>,
  binding: NativeSuggestionsBinding,
) {
  bindings.set(editor, binding);
}

export function getNativeSuggestionsBinding(
  editor: BlockNoteEditor<any, any, any>,
) {
  return bindings.get(editor);
}

export function setNativeSuggestionsResolutionPhaseHook(
  editor: BlockNoteEditor<any, any, any>,
  hook: NativeSuggestionsBinding["onResolutionPhase"],
) {
  const binding = bindings.get(editor);
  if (binding) {
    binding.onResolutionPhase = hook;
  }
}

export {
  getIndexedRecords as getNativeSuggestionRecords,
  observeNativeSuggestions,
};
export {
  acceptNativeSuggestion,
  rejectNativeSuggestion,
  resolveNativeSuggestions,
} from "./resolution.js";
export {
  LEDGER_NAMES,
  NATIVE_SUGGESTION_LIMITS,
  SUGGESTION_ID_ATTR,
  type NativeIdRange,
  type NativeResolutionPhase,
  type NativeSuggestionKind,
  type NativeSuggestionRecord,
  type NativeSuggestionsBinding,
  type NativeSuggestionStatus,
} from "./model.js";
