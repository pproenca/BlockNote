import {
  assertContract,
  contractCase,
  defineBlockNoteContractCases,
  type BlockNoteContractCase,
  type BlockNoteContractTestApi,
} from "../contracts/shared.js";

export interface BlockNoteSuggestionFixtureValue {
  readonly actor: string;
  readonly status: string;
  readonly base: string;
}

export interface BlockNoteSuggestionsBehaviorFixtureHarness {
  baseView(): string;
  setAccess(value: {
    readonly suggest?: boolean;
    readonly review?: boolean;
    readonly edit?: boolean;
  }): void;
  directEdit(): Promise<void>;
  suggest(kind: string, requestedActor?: string): Promise<string>;
  suggestion(id: string): BlockNoteSuggestionFixtureValue | undefined;
  holdReview(): void;
  releaseReview(): void;
  review(
    id: string,
    action: "accepted" | "rejected",
    idempotencyKey: string,
  ): Promise<string>;
  physicalResult(id: string): string | undefined;
}

export interface BlockNoteSuggestionsBehaviorFixtureOptions {
  readonly create: () => Promise<BlockNoteSuggestionsBehaviorFixtureHarness>;
}

export function getSuggestionsBehaviorFixtureCases(
  options: BlockNoteSuggestionsBehaviorFixtureOptions,
): readonly BlockNoteContractCase[] {
  return Object.freeze([
    contractCase("base-view-preservation", async () => {
      const harness = await options.create();
      const before = harness.baseView();
      for (const kind of ["insertion", "deletion", "replacement"]) {
        const id = await harness.suggest(kind);
        assertContract(
          harness.suggestion(id)?.base === before &&
            harness.baseView() === before,
          `${kind} suggestions must preserve the base view while pending.`,
        );
      }
    }),
    contractCase("server-bound-actor", async () => {
      const harness = await options.create();
      const id = await harness.suggest("insertion", "substituted-actor");
      assertContract(
        harness.suggestion(id)?.actor === "authenticated",
        "Suggestion actor identity must be bound by the authenticated server context.",
      );
    }),
    contractCase("suggest-cannot-edit-or-review", async () => {
      const harness = await options.create();
      harness.setAccess({ suggest: true, edit: false, review: false });
      const id = await harness.suggest("insertion");
      let editDenied = false;
      let reviewDenied = false;
      try {
        await harness.directEdit();
      } catch {
        editDenied = true;
      }
      try {
        await harness.review(id, "accepted", "suggest-review");
      } catch {
        reviewDenied = true;
      }
      assertContract(
        editDenied && reviewDenied,
        "Suggest access must not grant direct edit or review authority.",
      );
    }),
    contractCase("reviewer-without-edit", async () => {
      const harness = await options.create();
      const id = await harness.suggest("insertion");
      harness.setAccess({ review: true, edit: false });
      assertContract(
        (await harness.review(id, "accepted", "review-only")) === "accepted",
        "Review authority must work without direct edit authority.",
      );
    }),
    contractCase("review-revocation-mid-flight", async () => {
      const harness = await options.create();
      const id = await harness.suggest("insertion");
      harness.holdReview();
      const pending = harness.review(id, "accepted", "revoked");
      harness.setAccess({ review: false });
      harness.releaseReview();
      let denied = false;
      try {
        await pending;
      } catch {
        denied = true;
      }
      assertContract(
        denied && harness.suggestion(id)?.status === "pending",
        "Review revocation before commit must win and preserve pending state.",
      );
    }),
    contractCase("review-retry-idempotency", async () => {
      const harness = await options.create();
      const id = await harness.suggest("insertion");
      const first = await harness.review(id, "accepted", "retry");
      const second = await harness.review(id, "accepted", "retry");
      assertContract(
        first === second && harness.physicalResult(id) === "accepted",
        "A repeated review command must return one matching physical result.",
      );
    }),
    contractCase("concurrent-review-conflict", async () => {
      const harness = await options.create();
      const id = await harness.suggest("replacement");
      harness.holdReview();
      const pending = [
        harness.review(id, "accepted", "accept"),
        harness.review(id, "rejected", "reject"),
      ];
      harness.releaseReview();
      const results = await Promise.allSettled(pending);
      const fulfilled = results.filter(
        (value): value is PromiseFulfilledResult<string> =>
          value.status === "fulfilled",
      );
      assertContract(
        fulfilled.length === 1 &&
          harness.physicalResult(id) === fulfilled[0]!.value &&
          harness.suggestion(id)?.status === fulfilled[0]!.value,
        "Concurrent accept/reject must produce one matching public and physical result.",
      );
    }),
  ]);
}

export function defineBlockNoteSuggestionsBehaviorFixtures(
  options: BlockNoteSuggestionsBehaviorFixtureOptions,
  test?: BlockNoteContractTestApi,
) {
  defineBlockNoteContractCases(
    "BlockNote suggestions behavior",
    getSuggestionsBehaviorFixtureCases(options),
    test,
  );
}
