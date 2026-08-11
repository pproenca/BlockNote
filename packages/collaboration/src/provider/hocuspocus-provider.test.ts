/** @vitest-environment node */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import * as Y from "@y/y";

import { observeBrowserConnectivity } from "./hocuspocus-provider.js";

describe("observeBrowserConnectivity", () => {
  it("disconnects immediately offline and reconnects online", () => {
    const target = new EventTarget();
    const connect = vi.fn();
    const disconnect = vi.fn();
    const status = vi.fn();
    const durability = vi.fn();
    const stop = observeBrowserConnectivity({
      connect,
      disconnect,
      durability,
      status,
      target,
    });

    target.dispatchEvent(new Event("offline"));
    expect(disconnect).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith("offline");
    expect(durability).toHaveBeenLastCalledWith("offline");

    target.dispatchEvent(new Event("online"));
    expect(status).toHaveBeenLastCalledWith("connecting");
    expect(connect).toHaveBeenCalledOnce();

    stop();
    target.dispatchEvent(new Event("offline"));
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe("HocuspocusProviderWebsocket reconnects", () => {
  it("clears the completed connection retry sentinel", () => {
    const websocket = new HocuspocusProviderWebsocket({
      autoConnect: false,
      url: "ws://example.test",
    });
    const cancel = vi.fn();
    websocket.cancelWebsocketRetry = cancel;
    websocket.connectionAttempt = {
      reject: vi.fn(),
      resolve: vi.fn(),
    };

    websocket.resolveConnectionAttempt();

    expect(websocket.cancelWebsocketRetry).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
    websocket.destroy();
  });

  it("retains an exact outbound update until its replay is acknowledged", () => {
    const document = new Y.Doc();
    const websocket = new HocuspocusProviderWebsocket({
      autoConnect: false,
      url: "ws://example.test",
    });
    const provider = new HocuspocusProvider({
      document: document as unknown as ConstructorParameters<
        typeof HocuspocusProvider
      >[0]["document"],
      flushDelay: false,
      name: "document",
      websocketProvider: websocket,
    });
    const internals = provider as unknown as {
      pendingSyncAcknowledgements: number;
      unacknowledgedUpdates: Uint8Array[];
    };
    const update = Uint8Array.of(1, 2, 3);
    const expectedReplay = Uint8Array.from(update);
    provider.attach();

    provider.documentUpdateHandler(update, undefined);
    update.fill(9);
    provider.onClose();
    provider.startSync();

    expect(internals.unacknowledgedUpdates).toEqual([expectedReplay]);
    expect(internals.pendingSyncAcknowledgements).toBe(1);
    provider.decrementUnsyncedChanges();
    expect(internals.unacknowledgedUpdates).toEqual([expectedReplay]);
    provider.decrementUnsyncedChanges();
    expect(internals.unacknowledgedUpdates).toEqual([]);

    provider.destroy();
    websocket.destroy();
    document.destroy();
  });
});
