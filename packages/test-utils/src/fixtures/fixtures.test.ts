/** @vitest-environment node */
import { describe, expect, it } from "vite-plus/test";

import {
  createBlockNoteCommentAnchorTestKeyRings,
  getCommentAnchorCryptoFixtureCases,
} from "./comment-anchor-crypto.js";
import {
  getCommentsBehaviorFixtureCases,
  getCommentServerAdapterFixtureCases,
} from "./comments.js";
import { getServerLifecycleFixtureCases } from "./server.js";
import { getSessionBehaviorFixtureCases } from "./session.js";
import { getSuggestionsBehaviorFixtureCases } from "./suggestions.js";

async function pass(cases: readonly { name: string; run(): Promise<void> }[]) {
  for (const fixture of cases) {
    await fixture.run();
  }
}

async function fail(
  cases: readonly { name: string; run(): Promise<void> }[],
  name: string,
) {
  await expect(
    cases.find((value) => value.name === name)!.run(),
  ).rejects.toThrow(`[BlockNote contract: ${name}]`);
}

describe("public behavior fixtures", () => {
  it("creates retained Web Crypto Ed25519 test key rings", async () => {
    const keys = await createBlockNoteCommentAnchorTestKeyRings({
      keyIds: ["test-v1", "test-v2"],
    });
    const first = keys.activate("test-v1", 1);
    const second = keys.activate("test-v2", 2);
    const message = new TextEncoder().encode("blocknote-test");
    expect(first.verificationKeys).toHaveLength(2);
    expect(second.verificationKeys).toHaveLength(2);
    expect(await first.signer.sign(message)).toHaveLength(64);
    expect(first.verificationKeys[0]).not.toBe(second.verificationKeys[0]);
  });

  it("accepts comment and anchor behavior models", async () => {
    const model = createCommentsModel();
    await pass(
      getCommentsBehaviorFixtureCases({ create: async () => model() }),
    );
    await pass(
      getCommentAnchorCryptoFixtureCases({ create: async () => model() }),
    );
  });

  it("names browser sealing and conflicting-key failures", async () => {
    const comments = createCommentsModel({ sealLocation: "browser" });
    await fail(
      getCommentsBehaviorFixtureCases({ create: async () => comments() }),
      "server-sealed-comment",
    );
    const crypto = createCommentsModel({ mergeConflictingKeys: true });
    await fail(
      getCommentAnchorCryptoFixtureCases({ create: async () => crypto() }),
      "conflicting-verification-bundle",
    );
  });

  it("accepts server adapter ordering and rejects policy-before-receipt", async () => {
    await pass(
      getCommentServerAdapterFixtureCases({
        create: async () => createCommentServerModel(),
      }),
    );
    await fail(
      getCommentServerAdapterFixtureCases({
        create: async () =>
          createCommentServerModel({ authorizeBeforeReceipt: true }),
      }),
      "receipt-before-current-policy",
    );
    await fail(
      getCommentServerAdapterFixtureCases({
        create: async () =>
          createCommentServerModel({ allocateNewKeyOnRetry: true }),
      }),
      "stable-idempotency-key",
    );
    await fail(
      getCommentServerAdapterFixtureCases({
        create: async () =>
          createCommentServerModel({ substituteAnchor: true }),
      }),
      "sealed-anchor-receipt",
    );
    await fail(
      getCommentServerAdapterFixtureCases({
        create: async () =>
          createCommentServerModel({ persistBeforeSignature: true }),
      }),
      "sealed-anchor-receipt",
    );
  });

  it("accepts suggestion behavior and rejects actor substitution", async () => {
    await pass(
      getSuggestionsBehaviorFixtureCases({
        create: async () => createSuggestionModel(),
      }),
    );
    await fail(
      getSuggestionsBehaviorFixtureCases({
        create: async () =>
          createSuggestionModel({ trustRequestedActor: true }),
      }),
      "server-bound-actor",
    );
  });

  it("accepts session/recovery behavior and rejects shared cache scope", async () => {
    await pass(
      getSessionBehaviorFixtureCases({
        create: async () => createSessionModel(),
      }),
    );
    await fail(
      getSessionBehaviorFixtureCases({
        create: async () => createSessionModel({ sharedCache: true }),
      }),
      "cache-isolation",
    );
  });

  it("accepts server lifecycle and rejects leaked resources", async () => {
    await pass(
      getServerLifecycleFixtureCases({
        create: async () => createServerModel(),
      }),
    );
    await fail(
      getServerLifecycleFixtureCases({
        create: async () => createServerModel({ leakSocket: true }),
      }),
      "resource-cleanup",
    );
  });
});

function createCommentsModel(
  broken: {
    readonly sealLocation?: "browser";
    readonly mergeConflictingKeys?: boolean;
  } = {},
) {
  return () => {
    let version = 1;
    const anchors = new Map<string, "attached" | "detached" | "unknown">();
    let refreshes = 0;
    return {
      documentVersion: () => version,
      seedUnloadedThread(id: string) {
        anchors.set(id, "unknown");
      },
      anchorStatus: (id: string) => anchors.get(id) ?? "unknown",
      async createCommentOnly() {
        anchors.set("created", "attached");
        return {
          threadId: "created",
          sealLocation: broken.sealLocation ?? ("server" as const),
        };
      },
      async resolveThread() {},
      editBeforeAnchor() {
        version += 1;
      },
      deleteAnchorRange() {
        version += 1;
        anchors.set("created", "detached");
      },
      async validateAnchor(variant: string) {
        return variant === "valid" || variant === "retained-key";
      },
      async refreshVerification(variant: string) {
        refreshes += 1;
        if (variant === "conflicting" && !broken.mergeConflictingKeys) {
          throw new Error("conflicting verification keys");
        }
      },
      refreshCount: () => refreshes,
      async verifyWithUnknownKey() {
        refreshes += 1;
        return false;
      },
      copyPublicKey() {
        return Uint8Array.of(1, 2, 3);
      },
      async requireEd25519(supported: boolean) {
        if (!supported) {
          throw new Error("Ed25519 unavailable");
        }
      },
    };
  };
}

function createCommentServerModel(
  broken: {
    readonly authorizeBeforeReceipt?: boolean;
    readonly allocateNewKeyOnRetry?: boolean;
    readonly substituteAnchor?: boolean;
    readonly persistBeforeSignature?: boolean;
  } = {},
) {
  let permission = true;
  let threads = 0;
  const receipts = new Map<
    string,
    { id: string; anchor: string; sealed: boolean }
  >();
  let timeout = false;
  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;
  let dispatchSequence = 0;
  const traces: string[][] = [];
  return {
    setPermission(value: boolean) {
      permission = value;
    },
    holdAfterCommit() {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    },
    releaseAfterCommit() {
      releaseGate?.();
    },
    timeoutAfterCommitOnce() {
      timeout = true;
    },
    threadCount: () => threads,
    traces: () => traces,
    async dispatch(key: string) {
      const receiptKey = broken.allocateNewKeyOnRetry
        ? `${key}:${++dispatchSequence}`
        : key;
      const trace = ["authenticate", "fence"];
      traces.push(trace);
      if (broken.authorizeBeforeReceipt) {
        trace.push("authorize");
        if (!permission) {
          throw new Error("access-denied");
        }
      }
      trace.push("receipt");
      const existing = receipts.get(receiptKey);
      if (existing) {
        return existing;
      }
      if (!broken.authorizeBeforeReceipt) {
        trace.push("authorize");
        if (!permission) {
          throw new Error("access-denied");
        }
      }
      trace.push(
        ...(broken.persistBeforeSignature
          ? ["store", "seal", "commit"]
          : ["seal", "store", "commit"]),
      );
      const receipt = {
        id: key,
        anchor: broken.substituteAnchor ? `unsealed:${key}` : `sealed:${key}`,
        sealed: !broken.substituteAnchor,
      };
      receipts.set(receiptKey, receipt);
      threads += 1;
      await gate;
      if (timeout) {
        timeout = false;
        throw new Error("timeout");
      }
      return receipt;
    },
  };
}

function createSuggestionModel(
  broken: { readonly trustRequestedActor?: boolean } = {},
) {
  let suggest = true;
  let review = true;
  let edit = false;
  const suggestions = new Map<
    string,
    { actor: string; status: string; base: string }
  >();
  const receipts = new Map<string, string>();
  let reviewGate: Promise<void> | null = null;
  let releaseReview: (() => void) | null = null;
  return {
    baseView: () => "base",
    setAccess(value: { suggest?: boolean; review?: boolean; edit?: boolean }) {
      suggest = value.suggest ?? suggest;
      review = value.review ?? review;
      edit = value.edit ?? edit;
    },
    directEdit: async () => {
      if (!edit) {
        throw new Error("access-denied");
      }
    },
    async suggest(kind: string, requestedActor = "attacker") {
      if (!suggest) {
        throw new Error("access-denied");
      }
      const id = `${kind}-${suggestions.size}`;
      suggestions.set(id, {
        actor: broken.trustRequestedActor ? requestedActor : "authenticated",
        status: "pending",
        base: "base",
      });
      return id;
    },
    suggestion: (id: string) => suggestions.get(id),
    holdReview() {
      reviewGate = new Promise<void>((resolve) => {
        releaseReview = resolve;
      });
    },
    releaseReview() {
      releaseReview?.();
    },
    async review(id: string, action: string, key: string) {
      await reviewGate;
      if (!review) {
        throw new Error("access-denied");
      }
      const existing = receipts.get(key);
      if (existing) {
        return existing;
      }
      const value = suggestions.get(id)!;
      if (value.status !== "pending") {
        throw new Error("conflict");
      }
      value.status = action;
      receipts.set(key, action);
      return action;
    },
    physicalResult: (id: string) => suggestions.get(id)?.status,
  };
}

function createSessionModel(broken: { readonly sharedCache?: boolean } = {}) {
  let state = {
    readiness: "none",
    connection: "connecting",
    durability: "saved",
  };
  const cache = new Map<string, string>();
  let recovery = "pending";
  let disposals = 0;
  return {
    startLocal() {
      state = { ...state, readiness: "local" };
    },
    goLive() {
      state = { ...state, readiness: "live", connection: "online" };
    },
    reconnect() {
      state = { ...state, connection: "online", readiness: "live" };
    },
    setDurability(value: string) {
      state = { ...state, durability: value };
    },
    state: () => state,
    writeCache(scope: string, value: string) {
      cache.set(broken.sharedCache ? "shared" : scope, value);
    },
    readCache: (scope: string) =>
      cache.get(broken.sharedCache ? "shared" : scope),
    async loadStaleBootstrap() {
      throw new Error("incompatible-document");
    },
    async applyRecovery() {
      if (recovery === "pending") {
        recovery = "applied";
      }
      return recovery;
    },
    async discardRecovery() {
      if (recovery === "pending") {
        recovery = "discarded";
      }
      return recovery;
    },
    recovery: () => recovery,
    duplicateTabWrite(value: string) {
      cache.set("duplicate", value);
    },
    duplicateTabRead: () => cache.get("duplicate"),
    async cancelStartup() {
      disposals += 1;
      throw new DOMException("Aborted", "AbortError");
    },
    async destroy() {
      if (disposals === 0) {
        disposals = 1;
      }
    },
    disposalCount: () => disposals,
  };
}

function createServerModel(broken: { readonly leakSocket?: boolean } = {}) {
  let started = false;
  let durable = "";
  let pending = "";
  let release!: () => void;
  let gate = Promise.resolve();
  return {
    async start() {
      started = true;
      return 31_337;
    },
    async connect() {
      if (!started) {
        throw new Error("not-started");
      }
    },
    holdPersistence() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    persist(value: string) {
      pending = value;
      return gate.then(() => {
        durable = pending;
      });
    },
    releasePersistence() {
      release();
    },
    async disconnect() {},
    async stop() {
      await gate;
      started = false;
    },
    durableHead: () => durable,
    resources: () => ({
      sockets: broken.leakSocket ? 1 : 0,
      listeners: 0,
      timers: 0,
    }),
  };
}
