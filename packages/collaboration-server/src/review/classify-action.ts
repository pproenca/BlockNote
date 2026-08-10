import { BlockNoteError, type BlockNoteMutationAction } from "@blocknote/core";
import type * as Y from "@y/y";

import { validateBlockNoteSuggestionMutation } from "./validate-suggestion.js";

const suggestionRoots = [
  "__blocknote_suggestions_v2_headers",
  "__blocknote_suggestions_v2_ranges",
] as const;
const reviewRoots = [
  "__blocknote_suggestions_v2_dispositions",
  "__blocknote_suggestions_v3_executions",
  "__blocknote_suggestions_v2_receipts",
] as const;

function signature(doc: Y.Doc, name: string) {
  const value = doc.share.get(name);
  if (value === undefined) {
    return "empty";
  }
  const json = value.toJSON();
  return Object.keys(json).length === 0 ? "empty" : JSON.stringify(json);
}

function changed(before: Y.Doc, after: Y.Doc, names: readonly string[]) {
  return names.some(
    (name) => signature(before, name) !== signature(after, name),
  );
}

export function classifyBlockNoteMutation(
  before: Y.Doc,
  after: Y.Doc,
): BlockNoteMutationAction {
  const suggestion = changed(before, after, suggestionRoots);
  const review = changed(before, after, reviewRoots);
  if (suggestion && review) {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote mutation mixes suggestion creation and review authority.",
    );
  }
  if (review) {
    return "review";
  }
  if (suggestion) {
    validateBlockNoteSuggestionMutation(before, after);
    return "suggest";
  }
  return "edit";
}
