import {
  assertContract,
  contractCase,
  defineBlockNoteContractCases,
  type BlockNoteContractCase,
  type BlockNoteContractTestApi,
} from "../contracts/shared.js";

export interface BlockNoteServerLifecycleResources {
  readonly sockets: number;
  readonly listeners: number;
  readonly timers: number;
}

export interface BlockNoteServerLifecycleFixtureHarness {
  start(): Promise<number>;
  connect(): Promise<void>;
  holdPersistence(): void;
  persist(value: string): Promise<void>;
  releasePersistence(): void;
  disconnect(): Promise<void>;
  stop(): Promise<void>;
  durableHead(): string;
  resources(): BlockNoteServerLifecycleResources;
}

export interface BlockNoteServerLifecycleFixtureOptions {
  readonly create: () => Promise<BlockNoteServerLifecycleFixtureHarness>;
}

export function getServerLifecycleFixtureCases(
  options: BlockNoteServerLifecycleFixtureOptions,
): readonly BlockNoteContractCase[] {
  return Object.freeze([
    contractCase("ephemeral-connect", async () => {
      const harness = await options.create();
      const port = await harness.start();
      assertContract(
        Number.isSafeInteger(port) && port > 0,
        "Server startup must expose an assigned ephemeral port.",
      );
      await harness.connect();
      await harness.stop();
    }),
    contractCase("pending-disconnect-drain", async () => {
      const harness = await options.create();
      await harness.start();
      await harness.connect();
      harness.holdPersistence();
      const persistence = harness.persist("durable-head");
      await harness.disconnect();
      const stopping = harness.stop();
      harness.releasePersistence();
      await Promise.all([persistence, stopping]);
      assertContract(
        harness.durableHead() === "durable-head",
        "Disconnect and stop must drain pending persistence before completion.",
      );
    }),
    contractCase("idempotent-stop", async () => {
      const harness = await options.create();
      await harness.start();
      await Promise.all([harness.stop(), harness.stop()]);
    }),
    contractCase("resource-cleanup", async () => {
      const harness = await options.create();
      await harness.start();
      await harness.connect();
      await harness.disconnect();
      await harness.stop();
      const resources = harness.resources();
      assertContract(
        resources.sockets === 0 &&
          resources.listeners === 0 &&
          resources.timers === 0,
        "Stopped servers must retain zero sockets, listeners, and timers.",
      );
    }),
  ]);
}

export function defineBlockNoteServerLifecycleFixtures(
  options: BlockNoteServerLifecycleFixtureOptions,
  test?: BlockNoteContractTestApi,
) {
  defineBlockNoteContractCases(
    "BlockNote server lifecycle behavior",
    getServerLifecycleFixtureCases(options),
    test,
  );
}
