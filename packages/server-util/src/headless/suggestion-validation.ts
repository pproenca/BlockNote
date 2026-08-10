import { BlockNoteError } from "@blocknote/core";
import type * as Y from "@y/y";

const HEADERS = "__blocknote_suggestions_v2_headers";

export function bindBlockNoteSuggestionActor(input: {
  readonly before: unknown;
  readonly doc: unknown;
  readonly actorId: string;
}) {
  if (!input.actorId) {
    throw new BlockNoteError(
      "access-denied",
      "BlockNote suggestion actor is required.",
    );
  }
  const doc = input.doc as Y.Doc;
  const before = input.before as Y.Doc;
  const headers = doc.get(HEADERS);
  const previousHeaders = before.get(HEADERS);
  const replacements: Array<{ readonly key: string; readonly value: object }> =
    [];
  headers.forEachAttr((value: unknown, key: string | number) => {
    if (
      typeof key !== "string" ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new BlockNoteError(
        "invalid-document",
        "BlockNote suggestion header is invalid.",
      );
    }
    const previous = previousHeaders.getAttr(key);
    if (previous !== undefined) {
      if (JSON.stringify(previous) !== JSON.stringify(value)) {
        throw new BlockNoteError(
          "invalid-document",
          "BlockNote historical suggestion headers are immutable.",
        );
      }
      return;
    }
    replacements.push({
      key,
      value: Object.freeze({
        ...(value as Record<string, unknown>),
        authorId: input.actorId,
      }),
    });
  });
  previousHeaders.forEachAttr((_value: unknown, key: string | number) => {
    if (typeof key !== "string" || headers.getAttr(key) === undefined) {
      throw new BlockNoteError(
        "invalid-document",
        "BlockNote historical suggestion headers are immutable.",
      );
    }
  });
  for (const replacement of replacements) {
    headers.setAttr(replacement.key, replacement.value);
  }
}
