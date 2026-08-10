import { BlockNoteError } from "@blocknote/core";

export function createAwarenessRuntime(options: {
  readonly maxBytes: number;
  readonly maxIdentities: number;
}) {
  const owners = new Map<string, Map<string, Uint8Array>>();
  return Object.freeze({
    update(connectionId: string, identity: string, value: Uint8Array) {
      if (value.byteLength > options.maxBytes) {
        throw new BlockNoteError(
          "document-too-large",
          "BlockNote awareness update is too large.",
        );
      }
      const owned = owners.get(connectionId) ?? new Map<string, Uint8Array>();
      if (!owned.has(identity) && owned.size >= options.maxIdentities) {
        throw new BlockNoteError(
          "offline-unavailable",
          "BlockNote awareness identity limit exceeded.",
        );
      }
      owned.set(identity, Uint8Array.from(value));
      owners.set(connectionId, owned);
    },
    removeConnection(connectionId: string) {
      owners.delete(connectionId);
    },
    count(connectionId: string) {
      return owners.get(connectionId)?.size ?? 0;
    },
    clear() {
      owners.clear();
    },
  });
}
