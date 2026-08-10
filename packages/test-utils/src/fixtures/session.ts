import {
  assertContract,
  contractCase,
  defineBlockNoteContractCases,
  type BlockNoteContractCase,
  type BlockNoteContractTestApi,
} from "../contracts/shared.js";

export interface BlockNoteSessionBehaviorState {
  readonly readiness: string;
  readonly connection: string;
  readonly durability: string;
}

export interface BlockNoteSessionBehaviorFixtureHarness {
  startLocal(): void;
  goLive(): void;
  reconnect(): void;
  setDurability(value: string): void;
  state(): BlockNoteSessionBehaviorState;
  writeCache(scope: string, value: string): void;
  readCache(scope: string): string | undefined;
  loadStaleBootstrap(): Promise<void>;
  applyRecovery(): Promise<string>;
  discardRecovery(): Promise<string>;
  recovery(): string;
  duplicateTabWrite(value: string): void;
  duplicateTabRead(): string | undefined;
  cancelStartup(): Promise<void>;
  destroy(): Promise<void>;
  disposalCount(): number;
}

export interface BlockNoteSessionBehaviorFixtureOptions {
  readonly create: () => Promise<BlockNoteSessionBehaviorFixtureHarness>;
}

export function getSessionBehaviorFixtureCases(
  options: BlockNoteSessionBehaviorFixtureOptions,
): readonly BlockNoteContractCase[] {
  return Object.freeze([
    contractCase("local-live-readiness", async () => {
      const harness = await options.create();
      harness.startLocal();
      assertContract(
        harness.state().readiness === "local",
        "Hydrated local state must become ready before the live connection.",
      );
      harness.goLive();
      assertContract(
        harness.state().readiness === "live" &&
          harness.state().connection === "online",
        "A synchronized connection must publish live readiness.",
      );
    }),
    contractCase("durability-transitions", async () => {
      const harness = await options.create();
      for (const value of ["pending", "offline", "error"]) {
        harness.setDurability(value);
        assertContract(
          harness.state().durability === value,
          `Durability state ${value} was not observable.`,
        );
      }
    }),
    contractCase("cache-isolation", async () => {
      const harness = await options.create();
      harness.writeCache("account-a:document", "a");
      harness.writeCache("account-b:document", "b");
      assertContract(
        harness.readCache("account-a:document") === "a" &&
          harness.readCache("account-b:document") === "b",
        "Offline cache state must be isolated by account and document scope.",
      );
    }),
    contractCase("stale-bootstrap-rejection", async () => {
      const harness = await options.create();
      let rejected = false;
      try {
        await harness.loadStaleBootstrap();
      } catch {
        rejected = true;
      }
      assertContract(rejected, "A stale incompatible bootstrap must reject.");
    }),
    contractCase("recovery-apply-discard-race", async () => {
      const harness = await options.create();
      await Promise.all([harness.applyRecovery(), harness.discardRecovery()]);
      assertContract(
        ["applied", "discarded"].includes(harness.recovery()),
        "Concurrent apply/discard must converge to one terminal recovery state.",
      );
    }),
    contractCase("duplicate-tab-recovery", async () => {
      const harness = await options.create();
      harness.duplicateTabWrite("latest");
      assertContract(
        harness.duplicateTabRead() === "latest",
        "A duplicate tab must observe recoverable pending state.",
      );
    }),
    contractCase("reconnect-convergence", async () => {
      const harness = await options.create();
      harness.startLocal();
      harness.reconnect();
      assertContract(
        harness.state().readiness === "live" &&
          harness.state().connection === "online",
        "Reconnect must converge from local state to the live head.",
      );
    }),
    contractCase("session-startup-cancellation", async () => {
      const harness = await options.create();
      let aborted = false;
      try {
        await harness.cancelStartup();
      } catch (error) {
        aborted = error instanceof DOMException && error.name === "AbortError";
      }
      assertContract(
        aborted && harness.disposalCount() === 1,
        "Canceled session startup must dispose late resources exactly once.",
      );
    }),
    contractCase("session-repeated-disposal", async () => {
      const harness = await options.create();
      await Promise.all(Array.from({ length: 100 }, () => harness.destroy()));
      assertContract(
        harness.disposalCount() === 1,
        "Repeated session disposal must clean resources exactly once.",
      );
    }),
  ]);
}

export function defineBlockNoteSessionBehaviorFixtures(
  options: BlockNoteSessionBehaviorFixtureOptions,
  test?: BlockNoteContractTestApi,
) {
  defineBlockNoteContractCases(
    "BlockNote session and recovery behavior",
    getSessionBehaviorFixtureCases(options),
    test,
  );
}
