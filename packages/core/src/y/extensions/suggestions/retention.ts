import * as Y from "@y/y";

import type { NativeSuggestionsBinding } from "./model.js";

type RetentionState = {
  readonly bySuggestion: Map<string, Set<Y.Item>>;
  readonly references: Map<Y.Item, number>;
};

const states = new WeakMap<Y.Doc, RetentionState>();

function getState(doc: Y.Doc) {
  let state = states.get(doc);
  if (!state) {
    state = { bySuggestion: new Map(), references: new Map() };
    states.set(doc, state);
  }
  return state;
}

function parentItem(item: Y.Item) {
  const parent = item.parent as Y.Type & { _item?: Y.Item | null };
  return parent._item ?? null;
}

function retainItem(
  state: RetentionState,
  retained: Set<Y.Item>,
  start: Y.Item,
) {
  let item: Y.Item | null = start;
  while (item) {
    if (!retained.has(item)) {
      retained.add(item);
      state.references.set(item, (state.references.get(item) ?? 0) + 1);
      item.keep = true;
    }
    item = parentItem(item);
  }
}

export function retainDeletedContent(
  binding: NativeSuggestionsBinding,
  transaction: Y.Transaction,
  suggestionId: string,
  deletes: Y.IdSet,
) {
  if (deletes.isEmpty()) {
    return;
  }
  const state = getState(binding.suggestionDoc);
  const retained = state.bySuggestion.get(suggestionId) ?? new Set<Y.Item>();
  state.bySuggestion.set(suggestionId, retained);
  Y.iterateStructsByIdSet(transaction, deletes, (struct) => {
    if (struct instanceof Y.Item) {
      retainItem(state, retained, struct);
    }
  });
}

export function releaseDeletedContent(
  binding: NativeSuggestionsBinding,
  suggestionId: string,
) {
  const state = states.get(binding.suggestionDoc);
  const retained = state?.bySuggestion.get(suggestionId);
  if (!state || !retained) {
    return;
  }
  state.bySuggestion.delete(suggestionId);
  for (const item of retained) {
    const references = (state.references.get(item) ?? 1) - 1;
    if (references === 0) {
      state.references.delete(item);
      item.keep = false;
    } else {
      state.references.set(item, references);
    }
  }
}
