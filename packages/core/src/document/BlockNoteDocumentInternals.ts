import type { AnyBlockNoteDocumentDefinition } from "./BlockNoteDocument.js";

export interface BlockNoteDocumentInternals {
  readonly formatFingerprint: string;
}

const internals = new WeakMap<
  AnyBlockNoteDocumentDefinition,
  BlockNoteDocumentInternals
>();

export function registerBlockNoteDocumentInternals(
  document: AnyBlockNoteDocumentDefinition,
  value: BlockNoteDocumentInternals,
) {
  internals.set(document, Object.freeze({ ...value }));
}

export function getBlockNoteDocumentInternals(
  document: AnyBlockNoteDocumentDefinition,
) {
  const value = internals.get(document);
  if (!value) {
    throw new Error("Unknown BlockNote document definition.");
  }
  return value;
}
