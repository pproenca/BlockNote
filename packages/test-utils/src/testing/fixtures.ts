import type { BlockNoteRevision } from "@blocknote/core";

export function blockNoteContractName(scope: string, name: string) {
  return `blocknote-contract:${scope}:${name}`;
}

export function blockNoteContractRevision(
  scope: string,
  sequence: number,
): BlockNoteRevision {
  return Object.freeze({
    sequence,
    token: blockNoteContractName(scope, `revision-${sequence}`),
  });
}
