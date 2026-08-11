import type { BlockNoteCollaboration } from "@blocknote/collaboration-server";
import { getBlockNoteCollaborationInternals } from "@blocknote/collaboration-server/internal";
import {
  type Connection,
  OutgoingMessage,
  Server,
  isTransactionOrigin,
  type connectedPayload,
  type onConnectPayload,
  type onDisconnectPayload,
} from "@hocuspocus/server";

export interface BlockNoteLogger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface BlockNoteCollaborationServer {
  readonly address: { readonly host: string; readonly port: number };
  stop(): Promise<void>;
}

type Context = {
  runtimeConnection?: Awaited<
    ReturnType<ReturnType<typeof getBlockNoteCollaborationInternals>["connect"]>
  >;
  transport?: {
    connection?: Connection<Context>;
    pending: Uint8Array[];
  };
};

function sendUpdate(
  connection: Connection<Context>,
  documentName: string,
  update: Uint8Array,
) {
  connection.send(
    new OutgoingMessage(documentName)
      .createSyncMessage()
      .writeUpdate(update)
      .toUint8Array(),
  );
}

export async function serveBlockNoteCollaboration<TKey>(options: {
  readonly collaboration: BlockNoteCollaboration<TKey>;
  readonly host: string;
  readonly port: number;
  readonly logger?: BlockNoteLogger;
  readonly signals?: readonly NodeJS.Signals[];
}): Promise<BlockNoteCollaborationServer> {
  const runtime = getBlockNoteCollaborationInternals(options.collaboration);
  const transportScopes = new Map<string, object>();
  const awarenessEncoder = new TextEncoder();
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let stopPromise: Promise<void> | null = null;
  const server = new Server<Context>({
    address: options.host,
    port: options.port,
    quiet: true,
    stopOnSignals: false,
    async onConnect(payload: onConnectPayload<Context>) {
      const transport: NonNullable<Context["transport"]> = { pending: [] };
      const runtimeConnection = await runtime.connect({
        id: payload.socketId,
        request: payload.request,
        documentName: payload.documentName,
        send: ({ update }) => {
          if (transport.connection) {
            sendUpdate(transport.connection, payload.documentName, update);
          } else {
            transport.pending.push(Uint8Array.from(update));
          }
        },
      });
      const transportScope = transportScopes.get(payload.documentName);
      if (
        transportScope &&
        transportScope !== runtimeConnection.transportScope
      ) {
        await runtime.disconnect(runtimeConnection);
        throw new Error(
          "BlockNote transport document name resolved to a different document key.",
        );
      }
      transportScopes.set(
        payload.documentName,
        runtimeConnection.transportScope,
      );
      return { runtimeConnection, transport };
    },
    async onLoadDocument(payload) {
      const connection = payload.context?.runtimeConnection;
      if (!connection) {
        throw new Error("BlockNote collaboration connection is unavailable.");
      }
      payload.document.setApplyUpdateHandler(
        async ({ transactionOrigin, update }) => {
          if (
            !isTransactionOrigin(transactionOrigin) ||
            transactionOrigin.source !== "connection"
          ) {
            return false;
          }
          const current = transactionOrigin.connection.context as Context;
          if (!current.runtimeConnection) {
            return false;
          }
          await runtime.message(current.runtimeConnection, { update });
          return true;
        },
      );
    },
    async connected(payload: connectedPayload<Context>) {
      const runtimeConnection = payload.context.runtimeConnection;
      const transport = payload.context.transport;
      if (!runtimeConnection || !transport) {
        throw new Error("BlockNote collaboration connection is unavailable.");
      }
      const snapshot = await runtime.snapshot(runtimeConnection);
      sendUpdate(payload.connection, payload.documentName, snapshot.update);
      transport.connection = payload.connection;
      for (const update of transport.pending.splice(0)) {
        sendUpdate(payload.connection, payload.documentName, update);
      }
    },
    async beforeHandleAwareness(payload) {
      const connection = payload.context?.runtimeConnection;
      if (!connection) {
        throw new Error("BlockNote collaboration connection is unavailable.");
      }
      for (const [identity, state] of payload.states) {
        runtime.awareness(
          connection,
          String(identity),
          awarenessEncoder.encode(JSON.stringify(state)),
        );
      }
    },
    async onDisconnect(payload: onDisconnectPayload<Context>) {
      if (payload.context.transport) {
        payload.context.transport.connection = undefined;
        payload.context.transport.pending.length = 0;
      }
      if (payload.context.runtimeConnection) {
        await runtime.disconnect(payload.context.runtimeConnection);
      }
    },
  });

  const stop = () => {
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = Promise.resolve().then(async () => {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      signalHandlers.clear();
      await server.destroy();
      transportScopes.clear();
      await options.collaboration.stop();
      options.logger?.info("BlockNote collaboration server stopped.");
    });
    return stopPromise;
  };

  try {
    await server.listen(options.port);
  } catch (error) {
    await server.destroy().catch(() => undefined);
    await options.collaboration.stop().catch(() => undefined);
    throw error;
  }
  for (const signal of new Set(options.signals ?? [])) {
    const handler = () => {
      void stop().catch((error: unknown) =>
        options.logger?.error("BlockNote collaboration shutdown failed.", {
          error,
        }),
      );
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  const bound = server.address;
  const address = Object.freeze({
    host: bound.address,
    port: bound.port,
  });
  options.logger?.info("BlockNote collaboration server started.", address);
  return Object.freeze({ address, stop });
}
