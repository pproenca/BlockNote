import {
  assertContract,
  contractCase,
  defineBlockNoteContractCases,
  type BlockNoteContractCase,
  type BlockNoteContractTestApi,
} from "../contracts/shared.js";

export interface BlockNoteCommentsBehaviorFixtureHarness {
  documentVersion(): string | number;
  seedUnloadedThread(id: string): void;
  anchorStatus(id: string): "attached" | "detached" | "unknown";
  createCommentOnly(): Promise<{
    readonly threadId: string;
    readonly sealLocation: "browser" | "server";
  }>;
  resolveThread(id: string): Promise<void>;
  editBeforeAnchor(): void;
  deleteAnchorRange(): void;
}

export interface BlockNoteCommentsBehaviorFixtureOptions {
  readonly create: () => Promise<BlockNoteCommentsBehaviorFixtureHarness>;
}

export function getCommentsBehaviorFixtureCases(
  options: BlockNoteCommentsBehaviorFixtureOptions,
): readonly BlockNoteContractCase[] {
  return Object.freeze([
    contractCase("partial-thread-not-orphaned", async () => {
      const harness = await options.create();
      harness.seedUnloadedThread("unloaded");
      assertContract(
        harness.anchorStatus("unloaded") === "unknown",
        "An unloaded thread must remain unknown, not be classified as detached.",
      );
    }),
    contractCase("comment-only-non-mutating", async () => {
      const harness = await options.create();
      const before = harness.documentVersion();
      const created = await harness.createCommentOnly();
      await harness.resolveThread(created.threadId);
      assertContract(
        Object.is(harness.documentVersion(), before),
        "Comment capture, creation, and resolution must not mutate document state.",
      );
    }),
    contractCase("server-sealed-comment", async () => {
      const harness = await options.create();
      const created = await harness.createCommentOnly();
      assertContract(
        created.sealLocation === "server",
        "Authenticated anchors must be sealed on the server, never in the browser.",
      );
    }),
    contractCase("edit-maps-anchor", async () => {
      const harness = await options.create();
      const created = await harness.createCommentOnly();
      harness.editBeforeAnchor();
      assertContract(
        harness.anchorStatus(created.threadId) === "attached",
        "A surviving range must remain attached after surrounding edits.",
      );
    }),
    contractCase("deleted-range-detaches", async () => {
      const harness = await options.create();
      const created = await harness.createCommentOnly();
      harness.deleteAnchorRange();
      assertContract(
        harness.anchorStatus(created.threadId) === "detached",
        "Deleting the anchored range must detach its comment anchor.",
      );
    }),
  ]);
}

export interface BlockNoteCommentServerReceipt {
  readonly id: string;
  readonly anchor: string;
  readonly sealed: boolean;
}

export interface BlockNoteCommentServerAdapterFixtureHarness {
  setPermission(value: boolean): void;
  holdAfterCommit(): void;
  releaseAfterCommit(): void;
  timeoutAfterCommitOnce(): void;
  threadCount(): number;
  traces(): readonly (readonly string[])[];
  dispatch(idempotencyKey: string): Promise<BlockNoteCommentServerReceipt>;
}

export interface BlockNoteCommentServerAdapterFixtureOptions {
  readonly create: () => Promise<BlockNoteCommentServerAdapterFixtureHarness>;
}

export function getCommentServerAdapterFixtureCases(
  options: BlockNoteCommentServerAdapterFixtureOptions,
): readonly BlockNoteContractCase[] {
  return Object.freeze([
    contractCase("server-adapter-order", async () => {
      const harness = await options.create();
      await harness.dispatch("ordered");
      assertContract(
        harness.traces()[0]!.join(",") ===
          "authenticate,fence,receipt,authorize,seal,store,commit",
        "Comment dispatch must authenticate, fence, check receipt, authorize, seal, store, then commit.",
      );
    }),
    contractCase("concurrent-idempotent-create", async () => {
      const harness = await options.create();
      const [first, second] = await Promise.all([
        harness.dispatch("concurrent"),
        harness.dispatch("concurrent"),
      ]);
      assertContract(
        first.id === second.id && harness.threadCount() === 1,
        "Concurrent calls with one idempotency key must create one thread.",
      );
    }),
    contractCase("timeout-after-commit-reconciliation", async () => {
      const harness = await options.create();
      harness.timeoutAfterCommitOnce();
      try {
        await harness.dispatch("timeout");
      } catch {
        // Retry must reconcile the committed receipt.
      }
      const receipt = await harness.dispatch("timeout");
      assertContract(
        receipt.id === "timeout" && harness.threadCount() === 1,
        "A timeout after commit must reconcile to the original receipt.",
      );
    }),
    contractCase("revocation-before-dispatch", async () => {
      const harness = await options.create();
      harness.setPermission(false);
      let denied = false;
      try {
        await harness.dispatch("denied");
      } catch {
        denied = true;
      }
      assertContract(
        denied && harness.threadCount() === 0,
        "Permission revoked before dispatch must deny without persisting.",
      );
    }),
    contractCase("revocation-after-commit", async () => {
      const harness = await options.create();
      harness.holdAfterCommit();
      const pending = harness.dispatch("committed");
      await Promise.resolve();
      harness.setPermission(false);
      harness.releaseAfterCommit();
      assertContract(
        (await pending).id === "committed",
        "Permission revocation after commit must not erase committed success.",
      );
    }),
    contractCase("receipt-before-current-policy", async () => {
      const harness = await options.create();
      const first = await harness.dispatch("receipt-first");
      harness.setPermission(false);
      const retried = await harness.dispatch("receipt-first");
      assertContract(
        retried.id === first.id,
        "An existing receipt must be returned before current permission policy.",
      );
    }),
    contractCase("denied-fence-no-racing-receipt", async () => {
      const harness = await options.create();
      harness.setPermission(false);
      try {
        await harness.dispatch("fenced-denial");
      } catch {
        // Expected denial.
      }
      harness.setPermission(true);
      const receipt = await harness.dispatch("fenced-denial");
      assertContract(
        receipt.id === "fenced-denial" && harness.threadCount() === 1,
        "A denied fenced attempt must leave no racing receipt or thread.",
      );
    }),
    contractCase("stable-idempotency-key", async () => {
      const harness = await options.create();
      const first = await harness.dispatch("stable-key");
      const second = await harness.dispatch("stable-key");
      assertContract(
        first.id === second.id && harness.threadCount() === 1,
        "Retries must reuse the caller's idempotency key.",
      );
    }),
    contractCase("sealed-anchor-receipt", async () => {
      const harness = await options.create();
      const receipt = await harness.dispatch("sealed");
      assertContract(
        receipt.sealed && receipt.anchor.startsWith("sealed:"),
        "The receipt must contain the same server-sealed anchor that was stored.",
      );
      const trace = harness.traces()[0]!;
      assertContract(
        trace.indexOf("seal") < trace.indexOf("store"),
        "Signature validation and sealing must happen before persistence.",
      );
    }),
  ]);
}

export function defineBlockNoteCommentsBehaviorFixtures(
  options: BlockNoteCommentsBehaviorFixtureOptions,
  test?: BlockNoteContractTestApi,
) {
  defineBlockNoteContractCases(
    "BlockNote comments behavior",
    getCommentsBehaviorFixtureCases(options),
    test,
  );
}

export function defineBlockNoteCommentServerAdapterFixtures(
  options: BlockNoteCommentServerAdapterFixtureOptions,
  test?: BlockNoteContractTestApi,
) {
  defineBlockNoteContractCases(
    "BlockNote comment server adapter behavior",
    getCommentServerAdapterFixtureCases(options),
    test,
  );
}
