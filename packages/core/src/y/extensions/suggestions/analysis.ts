import { relativePositionToAbsolutePosition } from "@y/prosemirror";
import * as Y from "@y/y";
import type { Node as ProseMirrorNode } from "prosemirror-model";

import { findTypeInOtherYdoc } from "../../utils.js";
import type {
  NativeSuggestionRecord,
  NativeSuggestionsBinding,
} from "./model.js";

export type SuggestionRange = {
  readonly from: number;
  readonly to: number;
};

function mergeRanges(ranges: readonly SuggestionRange[]) {
  const sorted = [...ranges].sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
  const merged: SuggestionRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      merged[merged.length - 1] = {
        from: previous.from,
        to: Math.max(previous.to, range.to),
      };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function positionForId(
  doc: ProseMirrorNode,
  documentType: Y.Type,
  renderer: Y.DiffRenderer,
  client: number,
  clock: number,
  assoc: number,
) {
  return relativePositionToAbsolutePosition(
    new Y.RelativePosition(null, null, { client, clock }, assoc),
    documentType,
    doc,
    renderer,
  );
}

export function findSuggestionRanges(
  doc: ProseMirrorNode,
  binding: NativeSuggestionsBinding,
  suggestion: NativeSuggestionRecord,
) {
  const ranges: SuggestionRange[] = [];
  const documentType = findTypeInOtherYdoc(
    binding.fragment,
    binding.suggestionDoc,
  );
  const ids = Y.mergeIdSets([
    suggestion.contentIds.inserts,
    suggestion.contentIds.deletes,
  ]);
  ids.forEach((range, client) => {
    const from = positionForId(
      doc,
      documentType,
      binding.renderer,
      client,
      range.clock,
      0,
    );
    const to = positionForId(
      doc,
      documentType,
      binding.renderer,
      client,
      range.clock + range.len - 1,
      -1,
    );
    if (from !== null && to !== null && from <= to) {
      ranges.push({ from, to });
    }
  });
  return mergeRanges(ranges);
}
