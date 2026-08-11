import type {
  BlockNoteCacheRecord,
  BlockNoteRecoveryRecord,
} from "./cache-manifest.js";
import { copyCacheRecord } from "./cache-manifest.js";
import type { BlockNoteRecoveryStore } from "./recovery-store.js";

const ACTIVE = "active";
const RECOVERY = "recovery";

function request<Result>(value: IDBRequest<Result>) {
  return new Promise<Result>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () =>
      reject(value.error ?? new Error("IndexedDB request failed."));
  });
}

function complete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

export async function createIndexedDbRecoveryStore(
  databaseName = "blocknote-collaboration-v1",
): Promise<BlockNoteRecoveryStore> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is unavailable.");
  }
  const opening = indexedDB.open(databaseName, 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore(ACTIVE, { keyPath: "key" });
    opening.result.createObjectStore(RECOVERY, { keyPath: "key" });
  };
  const database = await request(opening);
  let closed = false;
  const read = async <Value>(storeName: string, key: string) => {
    const transaction = database.transaction(storeName, "readonly");
    const result = await request(transaction.objectStore(storeName).get(key));
    await complete(transaction);
    return result
      ? copyCacheRecord(result as Value & BlockNoteCacheRecord)
      : null;
  };
  return {
    loadActive: (key) => read<BlockNoteCacheRecord>(ACTIVE, key),
    async compareAndSetActive(record, expectedRevision) {
      const transaction = database.transaction(ACTIVE, "readwrite");
      const store = transaction.objectStore(ACTIVE);
      const current = (await request(store.get(record.key))) as
        | BlockNoteCacheRecord
        | undefined;
      if ((current?.revision ?? null) !== expectedRevision) {
        transaction.abort();
        await complete(transaction).catch(() => undefined);
        return false;
      }
      store.put(copyCacheRecord(record));
      await complete(transaction);
      return true;
    },
    async deleteActive(key, generation) {
      const transaction = database.transaction(ACTIVE, "readwrite");
      const store = transaction.objectStore(ACTIVE);
      const current = (await request(store.get(key))) as
        | BlockNoteCacheRecord
        | undefined;
      if (!current || current.generation !== generation) {
        transaction.abort();
        await complete(transaction).catch(() => undefined);
        return false;
      }
      store.delete(key);
      await complete(transaction);
      return true;
    },
    loadRecovery: (key) => read<BlockNoteRecoveryRecord>(RECOVERY, key),
    async archive(record) {
      const transaction = database.transaction(RECOVERY, "readwrite");
      const store = transaction.objectStore(RECOVERY);
      const current = (await request(store.get(record.key))) as
        | BlockNoteRecoveryRecord
        | undefined;
      if (
        !current ||
        record.generation > current.generation ||
        (record.generation === current.generation &&
          record.revision >= current.revision)
      ) {
        store.put(copyCacheRecord(record));
      }
      await complete(transaction);
    },
    async deleteRecovery(key, generation) {
      const transaction = database.transaction(RECOVERY, "readwrite");
      const store = transaction.objectStore(RECOVERY);
      const current = (await request(store.get(key))) as
        | BlockNoteRecoveryRecord
        | undefined;
      if (!current || current.generation !== generation) {
        transaction.abort();
        await complete(transaction).catch(() => undefined);
        return false;
      }
      store.delete(key);
      await complete(transaction);
      return true;
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      database.close();
    },
  };
}
