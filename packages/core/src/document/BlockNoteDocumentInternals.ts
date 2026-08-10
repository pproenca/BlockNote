import type { AnyBlockNoteDocumentDefinition } from "./BlockNoteDocument.js";
import type { AnyBlockNoteDocumentExtension } from "./BlockNoteDocumentExtension.js";

export interface BlockNoteHeadlessProjectionInput {
  readonly blocks: readonly unknown[];
  readonly markdown: string;
  readonly suggestions: readonly unknown[];
}

export type BlockNoteHeadlessProjectionContribution = (
  input: BlockNoteHeadlessProjectionInput,
) => Readonly<Record<string, unknown>>;

export interface BlockNoteDocumentInternals {
  readonly formatFingerprint: string;
  readonly headlessProjectionContributions: readonly BlockNoteHeadlessProjectionContribution[];
}

const internals = new WeakMap<
  AnyBlockNoteDocumentDefinition,
  BlockNoteDocumentInternals
>();
const extensionHeadlessProjections = new WeakMap<
  object,
  BlockNoteHeadlessProjectionContribution
>();

export function registerBlockNoteExtensionHeadlessProjection(
  extension: AnyBlockNoteDocumentExtension,
  contribution: BlockNoteHeadlessProjectionContribution,
) {
  if (extensionHeadlessProjections.has(extension)) {
    throw new Error("BlockNote headless projection is already registered.");
  }
  extensionHeadlessProjections.set(extension, Object.freeze(contribution));
}

export function getBlockNoteExtensionHeadlessProjection(
  extension: AnyBlockNoteDocumentExtension,
) {
  return extensionHeadlessProjections.get(extension);
}

export function registerBlockNoteDocumentInternals(
  document: AnyBlockNoteDocumentDefinition,
  value: BlockNoteDocumentInternals,
) {
  internals.set(
    document,
    Object.freeze({
      ...value,
      headlessProjectionContributions: Object.freeze([
        ...value.headlessProjectionContributions,
      ]),
    }),
  );
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
