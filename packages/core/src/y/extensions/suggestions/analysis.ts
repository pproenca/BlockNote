import type { Node as ProseMirrorNode } from "prosemirror-model";

import type { NativeSuggestionKind, NativeSuggestionRecord } from "./native.js";
import { SUGGESTION_ID_ATTR } from "./native.js";

export type SuggestionRange = {
  readonly from: number;
  readonly to: number;
};

export type AnalyzedSuggestion = {
  readonly id: string;
  readonly authorId: string | null;
  readonly kind: NativeSuggestionKind;
  readonly preview: string;
  readonly status: "pending";
  readonly ranges: readonly SuggestionRange[];
  readonly order: number;
};

type MutableAnalysis = {
  authorIds: Set<string>;
  insertions: Array<{ text: string; range: SuggestionRange }>;
  deletions: Array<{ text: string; range: SuggestionRange }>;
  formats: Array<{ text: string; range: SuggestionRange }>;
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

function preview(parts: readonly { text: string }[]) {
  return parts
    .map((part) => part.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function analyzeSuggestions(
  doc: ProseMirrorNode,
  records: ReadonlyMap<string, NativeSuggestionRecord>,
) {
  const analyses = new Map<string, MutableAnalysis>();

  doc.descendants((node, pos) => {
    const text = node.isText ? (node.text ?? "") : "";
    const range = { from: pos, to: pos + node.nodeSize };
    for (const mark of node.marks) {
      const id = mark.attrs[SUGGESTION_ID_ATTR] as unknown;
      if (typeof id !== "string") {
        continue;
      }
      const record = records.get(id);
      if (!record || record.status !== "pending") {
        continue;
      }
      let analysis = analyses.get(id);
      if (!analysis) {
        analysis = {
          authorIds: new Set(),
          insertions: [],
          deletions: [],
          formats: [],
        };
        analyses.set(id, analysis);
      }
      const userIds = mark.attrs["userIds"] as unknown;
      if (Array.isArray(userIds)) {
        for (const userId of userIds) {
          if (typeof userId === "string") {
            analysis.authorIds.add(userId);
          }
        }
      }
      const part = { text, range };
      if (mark.type.name === "y-attributed-insert") {
        analysis.insertions.push(part);
      } else if (mark.type.name === "y-attributed-delete") {
        analysis.deletions.push(part);
      } else if (mark.type.name === "y-attributed-format") {
        analysis.formats.push(part);
      }
    }
    return true;
  });

  const result = new Map<string, AnalyzedSuggestion>();
  for (const [id, analysis] of analyses) {
    const record = records.get(id)!;
    const hasInsertion = analysis.insertions.length > 0;
    const hasDeletion = analysis.deletions.length > 0;
    const kind: NativeSuggestionKind =
      analysis.formats.length > 0 || (hasInsertion && hasDeletion)
        ? "replacement"
        : hasDeletion
          ? "deletion"
          : "insertion";
    const parts = [
      ...analysis.insertions,
      ...analysis.deletions,
      ...analysis.formats,
    ];
    const ranges = mergeRanges(parts.map((part) => part.range));
    const proposedPreview = preview(
      hasInsertion
        ? analysis.insertions
        : analysis.formats.length > 0
          ? analysis.formats
          : analysis.deletions,
    );
    result.set(id, {
      id,
      authorId: record.authorId ?? [...analysis.authorIds].sort()[0] ?? null,
      kind,
      preview: proposedPreview,
      status: "pending",
      ranges,
      order: ranges[0]?.from ?? Number.MAX_SAFE_INTEGER,
    });
  }
  return result;
}
