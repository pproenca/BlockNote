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

export type SuggestionProjection = {
  readonly documentType: Y.Type;
  readonly renderer: Y.DiffRenderer | null;
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
  projection: SuggestionProjection,
  client: number,
  clock: number,
  assoc: number,
) {
  return relativePositionToAbsolutePosition(
    new Y.RelativePosition(null, null, { client, clock }, assoc),
    projection.documentType,
    doc,
    projection.renderer,
  );
}

function rangesForIds(
  doc: ProseMirrorNode,
  projection: SuggestionProjection,
  ids: Y.IdSet,
) {
  const ranges: SuggestionRange[] = [];
  ids.forEach((range, client) => {
    const from = positionForId(doc, projection, client, range.clock, 0);
    const to = positionForId(
      doc,
      projection,
      client,
      range.clock + range.len - 1,
      -1,
    );
    if (from !== null && to !== null && from <= to) {
      ranges.push({ from, to });
    }
  });
  return ranges;
}

function itemForId(doc: Y.Doc, client: number, clock: number) {
  const structs = doc.store.clients.get(client);
  if (!structs) {
    return null;
  }
  let left = 0;
  let right = structs.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const struct = structs[middle]!;
    if (clock < struct.id.clock) {
      right = middle - 1;
    } else if (clock >= struct.id.clock + struct.length) {
      left = middle + 1;
    } else {
      return struct instanceof Y.Item ? struct : null;
    }
  }
  return null;
}

function mappedEdge(
  doc: ProseMirrorNode,
  projection: SuggestionProjection,
  item: Y.Item,
  side: "left" | "right",
) {
  const clock =
    side === "left" ? item.id.clock + item.length - 1 : item.id.clock;
  return positionForId(
    doc,
    projection,
    item.id.client,
    clock,
    side === "left" ? -1 : 0,
  );
}

function insertionAnchor(
  doc: ProseMirrorNode,
  binding: NativeSuggestionsBinding,
  projection: SuggestionProjection,
  client: number,
  clock: number,
) {
  let level = itemForId(binding.suggestionDoc, client, clock);
  let visited = 0;
  while (level && visited < 4_096) {
    let right = level.right;
    while (right && visited < 4_096) {
      visited += 1;
      const position = mappedEdge(doc, projection, right, "right");
      if (position !== null) {
        return position;
      }
      right = right.right;
    }
    let left = level.left;
    while (left && visited < 4_096) {
      visited += 1;
      const position = mappedEdge(doc, projection, left, "left");
      if (position !== null) {
        return position;
      }
      left = left.left;
    }
    const parent = level.parent as Y.Type & { _item?: Y.Item | null };
    level = parent._item ?? null;
  }
  return null;
}

export function findSuggestionRanges(
  doc: ProseMirrorNode,
  binding: NativeSuggestionsBinding,
  suggestion: NativeSuggestionRecord,
  projection: SuggestionProjection = {
    documentType: findTypeInOtherYdoc(binding.fragment, binding.suggestionDoc),
    renderer: binding.renderer,
  },
) {
  if (projection.documentType !== binding.fragment) {
    return mergeRanges(
      rangesForIds(
        doc,
        projection,
        Y.mergeIdSets([
          suggestion.contentIds.inserts,
          suggestion.contentIds.deletes,
        ]),
      ),
    );
  }

  const ranges = rangesForIds(
    doc,
    { documentType: binding.fragment, renderer: null },
    suggestion.contentIds.deletes,
  );
  suggestion.contentIds.inserts.forEach((range, client) => {
    const anchor = insertionAnchor(
      doc,
      binding,
      { documentType: binding.fragment, renderer: null },
      client,
      range.clock,
    );
    if (anchor !== null) {
      ranges.push({ from: anchor, to: anchor });
    }
  });
  return mergeRanges(ranges);
}
