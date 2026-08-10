import type { BlockNoteRevision } from "@blocknote/core";
import type { BlockNoteProjectionSink } from "@blocknote/collaboration-server";
import {
  blockNoteContractName,
  blockNoteContractRevision,
} from "../testing/fixtures.js";
import {
  assertContract,
  contractCase,
  defineBlockNoteContractCases,
  type BlockNoteContractCase,
  type BlockNoteContractTestApi,
} from "./shared.js";

export interface BlockNoteProjectionContractHarness<TKey, Projection> {
  readonly sink: BlockNoteProjectionSink<TKey, Projection>;
  failNextAfterWrite(): void;
  read(key: TKey, revision: BlockNoteRevision): Projection | undefined;
  attempts(): number;
}

export interface BlockNoteProjectionSinkContractOptions<TKey, Projection> {
  readonly create: () => Promise<
    BlockNoteProjectionContractHarness<TKey, Projection>
  >;
  readonly key: (name: string) => TKey;
  readonly projection?: (name: string) => Projection;
}

export function getProjectionSinkContractCases<TKey, Projection>(
  options: BlockNoteProjectionSinkContractOptions<TKey, Projection>,
): readonly BlockNoteContractCase[] {
  let sequence = 0;
  const fixture = (name: string) => {
    const scope = blockNoteContractName(name, String(++sequence));
    return {
      key: options.key(blockNoteContractName(scope, "document")),
      revision: blockNoteContractRevision(scope, 1),
      projection: options.projection
        ? options.projection(scope)
        : ({ value: sequence } as Projection),
    };
  };
  return Object.freeze([
    contractCase("idempotent-retry", async () => {
      const harness = await options.create();
      const value = fixture("retry");
      await harness.sink.commit(value);
      await harness.sink.commit(value);
      assertContract(
        harness.read(value.key, value.revision) !== undefined,
        "Retrying an identical projection commit must preserve the projection.",
      );
    }),
    contractCase("partial-failure", async () => {
      const harness = await options.create();
      const value = fixture("partial");
      harness.failNextAfterWrite();
      let failed = false;
      try {
        await harness.sink.commit(value);
      } catch {
        failed = true;
      }
      assertContract(
        failed,
        "The configured partial failure was not surfaced.",
      );
      await harness.sink.commit(value);
      assertContract(
        harness.read(value.key, value.revision) !== undefined &&
          harness.attempts() === 2,
        "A projection retry after partial failure must converge in one retry.",
      );
    }),
  ]);
}

export function defineBlockNoteProjectionSinkContract<TKey, Projection>(
  options: BlockNoteProjectionSinkContractOptions<TKey, Projection>,
  test?: BlockNoteContractTestApi,
) {
  defineBlockNoteContractCases(
    "BlockNote projection sink contract",
    getProjectionSinkContractCases(options),
    test,
  );
}
