import type { BlockNoteReplicaCoordinator } from "@blocknote/collaboration-server";
import type { BlockNoteTestClock } from "../testing/fake-clock.js";
import { blockNoteContractName } from "../testing/fixtures.js";
import {
  assertContract,
  contractCase,
  defineBlockNoteContractCases,
  type BlockNoteContractCase,
  type BlockNoteContractTestApi,
} from "./shared.js";

export interface BlockNoteReplicaCoordinatorContractOptions<TKey> {
  readonly create: () => Promise<BlockNoteReplicaCoordinator<TKey>>;
  readonly key: (name: string) => TKey;
  readonly clock: BlockNoteTestClock;
}

export function getReplicaCoordinatorContractCases<TKey>(
  options: BlockNoteReplicaCoordinatorContractOptions<TKey>,
): readonly BlockNoteContractCase[] {
  let sequence = 0;
  const key = (name: string) =>
    options.key(blockNoteContractName(name, String(++sequence)));
  const acquire = (
    replica: BlockNoteReplicaCoordinator<TKey>,
    documentKey: TKey,
    replicaId: string,
  ) => replica.acquire({ key: documentKey, replicaId, durationMs: 100 });

  return Object.freeze([
    contractCase("stale-lease-fence", async () => {
      const replica = await options.create();
      const documentKey = key("fence");
      const first = await acquire(replica, documentKey, "replica-a");
      assertContract(first, "The first replica could not acquire a lease.");
      options.clock.advance(101);
      const second = await acquire(replica, documentKey, "replica-b");
      assertContract(
        second && second.fence > first.fence,
        "A replacement lease must advance the fencing token.",
      );
      assertContract(
        (await replica.publish(first)) === false &&
          (await replica.renew({ lease: first, durationMs: 100 })) === null,
        "An expired lease must not publish or renew after replacement.",
      );
    }),
    contractCase("invalidation", async () => {
      const replica = await options.create();
      const documentKey = key("invalidation");
      const received: Array<{ readonly key: TKey; readonly fence: number }> =
        [];
      const unsubscribe = replica.subscribe((value) => received.push(value));
      const lease = await acquire(replica, documentKey, "replica-a");
      assertContract(lease, "The replica could not acquire a lease.");
      assertContract(
        (await replica.publish(lease)) === true &&
          received.length === 1 &&
          received[0]!.fence === lease.fence,
        "Publishing a valid lease must emit one matching invalidation.",
      );
      unsubscribe();
    }),
    contractCase("single-node-lifecycle", async () => {
      const replica = await options.create();
      const documentKey = key("single-node");
      const lease = await acquire(replica, documentKey, "local");
      assertContract(lease, "The local replica could not acquire a lease.");
      assertContract(
        (await replica.locate(documentKey)) === "local",
        "A live lease must locate its owning replica.",
      );
      await replica.release(lease);
      assertContract(
        (await replica.locate(documentKey)) === null,
        "A released lease must no longer locate a replica.",
      );
    }),
    contractCase("subscription-cleanup", async () => {
      const replica = await options.create();
      const documentKey = key("unsubscribe");
      let received = 0;
      const unsubscribe = replica.subscribe(() => {
        received += 1;
      });
      unsubscribe();
      unsubscribe();
      const lease = await acquire(replica, documentKey, "local");
      assertContract(lease, "The local replica could not acquire a lease.");
      await replica.publish(lease);
      assertContract(
        received === 0,
        "An unsubscribed listener must not receive invalidations.",
      );
    }),
  ]);
}

export function defineBlockNoteReplicaCoordinatorContract<TKey>(
  options: BlockNoteReplicaCoordinatorContractOptions<TKey>,
  test?: BlockNoteContractTestApi,
) {
  defineBlockNoteContractCases(
    "BlockNote replica coordinator contract",
    getReplicaCoordinatorContractCases(options),
    test,
  );
}
