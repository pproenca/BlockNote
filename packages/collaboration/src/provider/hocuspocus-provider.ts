import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import * as Y from "@y/y";

export interface BlockNoteProviderSignals {
  readonly status: (
    status: "connecting" | "online" | "offline" | "degraded",
  ) => void;
  readonly synced: () => void;
  readonly durability: (
    state: "saved" | "pending" | "offline" | "error",
  ) => void;
  readonly fatal: (error: unknown) => void;
}

export interface BlockNoteProviderAdapter {
  connect(): void;
  awareness(): unknown;
  destroy(): void;
}

export function createHocuspocusProviderAdapter(input: {
  readonly document: unknown;
  readonly endpoint: string;
  readonly documentName: string;
  readonly credentials?: () => Promise<string>;
  readonly signals: BlockNoteProviderSignals;
}): BlockNoteProviderAdapter {
  const websocket = new HocuspocusProviderWebsocket({
    url: input.endpoint,
    autoConnect: false,
  });
  let destroyed = false;
  let provider: HocuspocusProvider | null = null;
  try {
    provider = new HocuspocusProvider({
      name: input.documentName,
      document: input.document as ConstructorParameters<
        typeof HocuspocusProvider
      >[0]["document"],
      websocketProvider: websocket,
      token: input.credentials,
      applyUpdate({ document, origin, update }) {
        Y.applyUpdate(document as unknown as Y.Doc, update, origin);
      },
      onStatus({ status }) {
        input.signals.status(
          status === "connected"
            ? "online"
            : status === "connecting"
              ? "connecting"
              : "offline",
        );
      },
      onSynced({ state }) {
        if (!state) return;
        input.signals.synced();
        input.signals.durability("saved");
      },
      onUnsyncedChanges({ number }) {
        input.signals.durability(number > 0 ? "pending" : "saved");
      },
      onDocumentQueueChange({ queuedUpdates, unsyncedChanges }) {
        input.signals.durability(
          queuedUpdates > 0 || unsyncedChanges > 0 ? "pending" : "saved",
        );
      },
      onClose({ event }) {
        const degraded =
          event.code === 1013 ||
          event.reason.includes("durability") ||
          event.reason.includes("queue");
        input.signals.status(degraded ? "degraded" : "offline");
        input.signals.durability(degraded ? "error" : "offline");
      },
      onAuthenticationFailed({ reason }) {
        input.signals.fatal(new Error(reason));
      },
    });
    provider.attach();
  } catch (error) {
    provider?.destroy();
    websocket.destroy();
    throw error;
  }

  const active = provider;
  return Object.freeze({
    awareness() {
      return active.awareness;
    },
    connect() {
      if (!destroyed) void websocket.connect();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      websocket.disconnect();
      active.destroy();
      websocket.destroy();
    },
  });
}
