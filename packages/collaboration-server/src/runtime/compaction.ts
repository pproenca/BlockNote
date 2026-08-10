import type {
  AnyBlockNoteDocumentDefinition,
  BlockNoteDocumentStore,
  BlockNoteRevision,
} from "@blocknote/core";
import type * as Y from "@y/y";

import { createCheckpoint, nextRevision } from "./persistence-loop.js";

export async function compactRuntimeDocument<TKey>(input: {
  readonly key: TKey;
  readonly document: AnyBlockNoteDocumentDefinition;
  readonly store: BlockNoteDocumentStore<TKey>;
  readonly doc: Y.Doc;
  readonly expected: BlockNoteRevision;
}) {
  const marker = new TextEncoder().encode(`compact:${input.expected.token}`);
  const next = await nextRevision(input.expected, marker);
  return input.store.compact({
    key: input.key,
    expected: input.expected,
    next,
    checkpoint: createCheckpoint(input.document, next, input.doc),
  });
}
