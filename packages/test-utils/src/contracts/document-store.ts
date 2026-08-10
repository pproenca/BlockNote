import type {
  BlockNoteChange,
  BlockNoteCheckpoint,
  BlockNoteDocumentBinding,
  BlockNoteDocumentStore,
  BlockNoteRevision,
} from "@blocknote/core";
import {
  blockNoteContractName,
  blockNoteContractRevision,
} from "../testing/fixtures.js";
import {
  assertContract,
  contractCase,
  defineBlockNoteContractCases,
  sameSerialized,
  type BlockNoteContractCase,
  type BlockNoteContractTestApi,
} from "./shared.js";

type Serialized = string | number | bigint | boolean | Uint8Array;

export interface BlockNoteDocumentStoreContractOptions<TKey> {
  readonly create: () => Promise<BlockNoteDocumentStore<TKey>>;
  readonly key: (name: string) => TKey;
  readonly binding: (name: string) => BlockNoteDocumentBinding;
  readonly checkpoint: (name: string) => BlockNoteCheckpoint;
  readonly change: (name: string) => BlockNoteChange;
  readonly serializeBinding: (value: BlockNoteDocumentBinding) => Serialized;
  readonly serializeCheckpoint: (value: BlockNoteCheckpoint) => Serialized;
  readonly serializeChange: (value: BlockNoteChange) => Serialized;
}

function sameRevision(left: BlockNoteRevision, right: BlockNoteRevision) {
  return left.sequence === right.sequence && left.token === right.token;
}

function isConflict(
  value: Awaited<ReturnType<BlockNoteDocumentStore<unknown>["append"]>>,
  expected: BlockNoteRevision,
) {
  return value.status === "conflict" && sameRevision(value.actual, expected);
}

export function getDocumentStoreContractCases<TKey>(
  options: BlockNoteDocumentStoreContractOptions<TKey>,
): readonly BlockNoteContractCase[] {
  let scopeSequence = 0;
  const scope = (name: string) => `${name}-${++scopeSequence}`;
  const initialize = async (name: string) => {
    const currentScope = scope(name);
    const store = await options.create();
    const key = options.key(blockNoteContractName(currentScope, "document"));
    const first = blockNoteContractRevision(currentScope, 1);
    const binding = options.binding(
      blockNoteContractName(currentScope, "binding"),
    );
    const checkpoint = options.checkpoint(
      blockNoteContractName(currentScope, "checkpoint-1"),
    );
    const result = await store.initialize({
      key,
      binding,
      checkpoint,
      revision: first,
    });
    assertContract(
      result.status === "committed" && sameRevision(result.revision, first),
      "The initial document revision was not committed.",
    );
    return { store, key, first, binding, checkpoint, scope: currentScope };
  };

  return Object.freeze([
    contractCase("initialization-conflict", async () => {
      const fixture = await initialize("initialize");
      const competing = blockNoteContractRevision(fixture.scope, 2);
      const result = await fixture.store.initialize({
        key: fixture.key,
        binding: options.binding("competing-binding"),
        checkpoint: options.checkpoint("competing-checkpoint"),
        revision: competing,
      });
      assertContract(
        isConflict(result, fixture.first),
        "Reinitializing an existing key must return its current revision as a conflict.",
      );
    }),
    contractCase("expected-revision", async () => {
      const fixture = await initialize("expected");
      const result = await fixture.store.append({
        key: fixture.key,
        expected: blockNoteContractRevision(fixture.scope, 0),
        next: blockNoteContractRevision(fixture.scope, 2),
        change: options.change("stale-change"),
      });
      assertContract(
        isConflict(result, fixture.first),
        "A stale expected revision must return a conflict, not throw or commit.",
      );
    }),
    contractCase("append-fencing", async () => {
      const fixture = await initialize("append");
      const second = blockNoteContractRevision(fixture.scope, 2);
      const input = {
        key: fixture.key,
        expected: fixture.first,
        next: second,
        change: options.change("append-change"),
      };
      const committed = await fixture.store.append(input);
      const retried = await fixture.store.append(input);
      assertContract(
        committed.status === "committed" &&
          retried.status === "committed" &&
          sameRevision(retried.revision, second),
        "An identical append retry must be idempotently committed.",
      );
      const stale = await fixture.store.append({
        ...input,
        next: blockNoteContractRevision(fixture.scope, 3),
      });
      assertContract(
        isConflict(stale, second),
        "A competing append must be fenced by the current revision.",
      );
    }),
    contractCase("compact-fencing", async () => {
      const fixture = await initialize("compact");
      const second = blockNoteContractRevision(fixture.scope, 2);
      const input = {
        key: fixture.key,
        expected: fixture.first,
        next: second,
        checkpoint: options.checkpoint("compact-checkpoint"),
      };
      const committed = await fixture.store.compact(input);
      const retried = await fixture.store.compact(input);
      assertContract(
        committed.status === "committed" &&
          retried.status === "committed" &&
          sameRevision(retried.revision, second),
        "An identical compaction retry must be idempotently committed.",
      );
      const stale = await fixture.store.compact({
        ...input,
        next: blockNoteContractRevision(fixture.scope, 3),
      });
      assertContract(
        isConflict(stale, second),
        "A competing compaction must be fenced by the current revision.",
      );
    }),
    contractCase("mutable-byte-defense", async () => {
      const fixture = await initialize("copy");
      const first = await fixture.store.load(fixture.key);
      const second = await fixture.store.load(fixture.key);
      assertContract(
        first && second,
        "The initialized document was not loadable.",
      );
      assertContract(
        first !== second &&
          first.binding !== fixture.binding &&
          first.checkpoint !== fixture.checkpoint &&
          first.binding !== second.binding &&
          first.checkpoint !== second.checkpoint,
        "Every store boundary must return fresh opaque values.",
      );
      assertContract(
        sameSerialized(
          options.serializeBinding(first.binding),
          options.serializeBinding(fixture.binding),
        ) &&
          sameSerialized(
            options.serializeCheckpoint(first.checkpoint),
            options.serializeCheckpoint(fixture.checkpoint),
          ),
        "Copied opaque values must preserve their bytes.",
      );
    }),
    contractCase("concurrent-writers", async () => {
      const fixture = await initialize("concurrent");
      const results = await Promise.all([
        fixture.store.append({
          key: fixture.key,
          expected: fixture.first,
          next: blockNoteContractRevision(`${fixture.scope}-a`, 2),
          change: options.change("concurrent-a"),
        }),
        fixture.store.append({
          key: fixture.key,
          expected: fixture.first,
          next: blockNoteContractRevision(`${fixture.scope}-b`, 2),
          change: options.change("concurrent-b"),
        }),
      ]);
      assertContract(
        results.filter((value) => value.status === "committed").length === 1 &&
          results.filter((value) => value.status === "conflict").length === 1,
        "Concurrent writers must produce exactly one commit and one conflict.",
      );
      const loaded = await fixture.store.load(fixture.key);
      assertContract(
        loaded?.changes.length === 1,
        "A concurrent write conflict must not append a second change.",
      );
      const storedChange = loaded.changes[0]!.change;
      assertContract(
        ["concurrent-a", "concurrent-b"].some((name) =>
          sameSerialized(
            options.serializeChange(storedChange),
            options.serializeChange(options.change(name)),
          ),
        ),
        "The winning concurrent change was not stored.",
      );
    }),
  ]);
}

export function defineBlockNoteDocumentStoreContract<TKey>(
  options: BlockNoteDocumentStoreContractOptions<TKey>,
  test?: BlockNoteContractTestApi,
) {
  defineBlockNoteContractCases(
    "BlockNote document store contract",
    getDocumentStoreContractCases(options),
    test,
  );
}
