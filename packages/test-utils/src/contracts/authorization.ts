import type { BlockNoteAccess } from "@blocknote/core";
import type {
  BlockNoteActor,
  BlockNoteAuthorizationAction,
  BlockNoteAuthorizationProvider,
} from "@blocknote/collaboration-server";
import { blockNoteContractName } from "../testing/fixtures.js";
import {
  assertContract,
  contractCase,
  defineBlockNoteContractCases,
  type BlockNoteContractCase,
  type BlockNoteContractTestApi,
} from "./shared.js";

export interface BlockNoteAuthorizationContractFixture<TKey> {
  readonly key: TKey;
  readonly actorId: string;
  canConnect(): boolean;
  getAccess(action: BlockNoteAuthorizationAction): BlockNoteAccess | null;
  onClose(): Promise<void>;
}

export interface BlockNoteAuthorizationContractOptions<TKey> {
  readonly create: (
    fixture: BlockNoteAuthorizationContractFixture<TKey>,
  ) => Promise<BlockNoteAuthorizationProvider<TKey>>;
  readonly key: (name: string) => TKey;
}

const access = (action: Exclude<BlockNoteAuthorizationAction, "connect">) =>
  Object.freeze({
    mode: action === "review" ? ("viewing" as const) : ("editing" as const),
    edit: action === "edit",
    comment: action === "edit",
    suggest: action === "suggest",
    review: action === "review",
  });

export function getAuthorizationContractCases<TKey>(
  options: BlockNoteAuthorizationContractOptions<TKey>,
): readonly BlockNoteContractCase[] {
  let sequence = 0;
  const harness = async (name: string) => {
    const scope = blockNoteContractName(name, String(++sequence));
    let connect = true;
    const grants = new Map<
      BlockNoteAuthorizationAction,
      BlockNoteAccess | null
    >();
    let closeCount = 0;
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const key = options.key(blockNoteContractName(scope, "document"));
    const actor: BlockNoteActor = Object.freeze({
      id: blockNoteContractName(scope, "actor"),
    });
    const provider = await options.create({
      key,
      actorId: actor.id,
      canConnect: () => connect,
      getAccess: (action) => grants.get(action) ?? null,
      async onClose() {
        closeCount += 1;
        await closeGate;
      },
    });
    return {
      provider,
      key,
      actor,
      denyConnect: () => {
        connect = false;
      },
      grant: (
        action: BlockNoteAuthorizationAction,
        value: BlockNoteAccess | null,
      ) => {
        grants.set(action, value);
      },
      releaseClose,
      closeCount: () => closeCount,
    };
  };
  const open = (provider: BlockNoteAuthorizationProvider<TKey>) =>
    provider.open({
      request: new Request("https://blocknote.contract.test"),
      documentName: "contract-document",
    });

  return Object.freeze([
    contractCase("connect-denial", async () => {
      const fixture = await harness("denial");
      fixture.denyConnect();
      assertContract(
        (await open(fixture.provider)) === null,
        "Denied connections must not create an authorization session.",
      );
    }),
    contractCase("per-action-revocation", async () => {
      const fixture = await harness("revocation");
      const session = await open(fixture.provider);
      assertContract(
        session,
        "An allowed connection did not create a session.",
      );
      assertContract(
        Object.is(session.documentKey, fixture.key) &&
          session.actor.id === fixture.actor.id,
        "The authorization session changed the document key or actor.",
      );
      for (const action of ["edit", "suggest", "review"] as const) {
        const granted = access(action);
        fixture.grant(action, granted);
        assertContract(
          (await session.getAccess(action)) === granted,
          `${action} access was not evaluated for the current action.`,
        );
        fixture.grant(action, null);
        assertContract(
          (await session.getAccess(action)) === null,
          `${action} access was cached after revocation.`,
        );
      }
      fixture.releaseClose();
      await session.close();
    }),
    contractCase("delayed-close-race", async () => {
      const fixture = await harness("close-race");
      const session = await open(fixture.provider);
      assertContract(
        session,
        "An allowed connection did not create a session.",
      );
      const closing = Promise.all([session.close(), session.close()]);
      await Promise.resolve();
      assertContract(
        fixture.closeCount() === 1,
        "Concurrent close calls must share one in-flight cleanup.",
      );
      fixture.releaseClose();
      await closing;
    }),
    contractCase("exactly-once-close", async () => {
      const fixture = await harness("close-once");
      const session = await open(fixture.provider);
      assertContract(
        session,
        "An allowed connection did not create a session.",
      );
      fixture.releaseClose();
      await Promise.all(Array.from({ length: 100 }, () => session.close()));
      assertContract(
        fixture.closeCount() === 1,
        "Authorization cleanup must execute exactly once.",
      );
    }),
  ]);
}

export function defineBlockNoteAuthorizationContract<TKey>(
  options: BlockNoteAuthorizationContractOptions<TKey>,
  test?: BlockNoteContractTestApi,
) {
  defineBlockNoteContractCases(
    "BlockNote authorization contract",
    getAuthorizationContractCases(options),
    test,
  );
}
