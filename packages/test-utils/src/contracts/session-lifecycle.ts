import {
  assertContract,
  contractCase,
  defineBlockNoteContractCases,
  type BlockNoteContractCase,
  type BlockNoteContractTestApi,
} from "./shared.js";

export interface BlockNoteDisposableSession {
  destroy(): Promise<void>;
}

export interface BlockNoteSessionLifecycleContractHarness {
  start(signal: AbortSignal): Promise<BlockNoteDisposableSession>;
  releaseStartup(): void;
  disposalCount(): number;
}

export interface BlockNoteSessionLifecycleContractOptions {
  readonly create: () => Promise<BlockNoteSessionLifecycleContractHarness>;
}

export function getSessionLifecycleContractCases(
  options: BlockNoteSessionLifecycleContractOptions,
): readonly BlockNoteContractCase[] {
  return Object.freeze([
    contractCase("startup-cancellation", async () => {
      const harness = await options.create();
      const controller = new AbortController();
      const startup = harness.start(controller.signal);
      controller.abort();
      harness.releaseStartup();
      let cancellation: unknown;
      try {
        await startup;
      } catch (error) {
        cancellation = error;
      }
      assertContract(
        cancellation instanceof DOMException &&
          cancellation.name === "AbortError" &&
          harness.disposalCount() === 1,
        "Canceled startup must reject with AbortError and dispose the late session once.",
      );
    }),
    contractCase("repeated-disposal", async () => {
      const harness = await options.create();
      const controller = new AbortController();
      harness.releaseStartup();
      const session = await harness.start(controller.signal);
      await Promise.all(Array.from({ length: 100 }, () => session.destroy()));
      assertContract(
        harness.disposalCount() === 1,
        "Repeated and concurrent disposal must clean the session exactly once.",
      );
    }),
  ]);
}

export function defineBlockNoteSessionLifecycleContract(
  options: BlockNoteSessionLifecycleContractOptions,
  test?: BlockNoteContractTestApi,
) {
  defineBlockNoteContractCases(
    "BlockNote session lifecycle contract",
    getSessionLifecycleContractCases(options),
    test,
  );
}
