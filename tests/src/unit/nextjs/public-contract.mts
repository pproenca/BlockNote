import {
  BlockNoteSchema,
  blockNoteDocumentBinding,
  blockNotePersistence,
  createBlockNoteAccess,
  createBlockNoteDocument,
  createExtension,
  type BlockNoteChange,
  type BlockNoteCheckpoint,
  type BlockNoteEditorFor,
  type BlockNoteRuntimeContext,
  type ExtensionOptions,
} from "@blocknote/core";
import type { BlockNoteSession } from "@blocknote/collaboration";
import {
  createBlockNoteCollaboration,
  createInMemoryAuthorizationProvider,
  createInMemoryDocumentStore,
} from "@blocknote/collaboration-server";
import {
  BlockNoteSessionProvider,
  useBlockNoteSessionState,
} from "@blocknote/react";
import { serveBlockNoteCollaboration } from "@blocknote/server-util/node";
import {
  createBlockNoteTestClock,
  defineBlockNoteAuthorizationContract,
  defineBlockNoteDocumentStoreContract,
} from "@blocknote/test-utils";
import type { Doc as NativeYDoc } from "@y/y";

const Collaboration = createExtension(
  ({
    context,
  }: ExtensionOptions<undefined, { readonly endpoint: string }>) => ({
    key: "consumer-collaboration",
    endpoint: context.endpoint,
  }),
  { name: "collaboration", version: "1" },
);
const Comments = createExtension(
  ({
    context,
  }: ExtensionOptions<undefined, { readonly accountId: string }>) => ({
    key: "consumer-comments",
    accountId: context.accountId,
  }),
  {
    name: "comments",
    version: "1",
    dependencies: ["collaboration"] as const,
  },
);
const Suggestions = createExtension(
  ({ context }: ExtensionOptions<undefined, { readonly actorId: string }>) => ({
    key: "consumer-suggestions",
    actorId: context.actorId,
  }),
  {
    name: "suggestions",
    version: "1",
    dependencies: ["collaboration"] as const,
  },
);

const document = createBlockNoteDocument({
  id: "packed-consumer",
  version: "1",
  schema: BlockNoteSchema.create(),
  extensions: [Collaboration(), Comments(), Suggestions()],
});
type Context = BlockNoteRuntimeContext<typeof document>;
type Editor = BlockNoteEditorFor<typeof document>;
declare const context: Context;
declare const editor: Editor;
declare const session: BlockNoteSession<typeof document>;
declare const Provider: typeof BlockNoteSessionProvider;
declare const nativeDoc: NativeYDoc;
void context.endpoint;
void context.accountId;
void context.actorId;
void editor.documentDefinition;
void Provider;
void nativeDoc;

function selectorInference() {
  return useBlockNoteSessionState({
    session,
    select: (state) => state.readiness,
  });
}
void selectorInference;

const editing = Object.freeze({
  mode: "editing" as const,
  edit: true,
  comment: true,
  suggest: true,
  review: true,
});
const store = createInMemoryDocumentStore<string>();
const authorization = createInMemoryAuthorizationProvider<string>({
  resolve: async ({ documentName }) => ({
    key: documentName,
    actor: { id: "packed-actor" },
    access: async () => editing,
  }),
});
const collaboration = createBlockNoteCollaboration({
  document,
  store,
  authorization,
});
const nodeOptions: Parameters<typeof serveBlockNoteCollaboration<string>>[0] = {
  collaboration,
  host: "127.0.0.1",
  port: 0,
};
void nodeOptions;
void createBlockNoteAccess(editing);

function registerPublicContracts(fixtures: {
  readonly checkpoint: BlockNoteCheckpoint;
  readonly change: BlockNoteChange;
}) {
  defineBlockNoteDocumentStoreContract({
    create: async () => createInMemoryDocumentStore<string>(),
    key: (name) => name,
    binding: () => blockNoteDocumentBinding.fromBytes(new Uint8Array(32)),
    checkpoint: () => fixtures.checkpoint,
    change: () => fixtures.change,
    serializeBinding: blockNoteDocumentBinding.toBytes,
    serializeCheckpoint: blockNotePersistence.checkpointToBytes,
    serializeChange: blockNotePersistence.changeToBytes,
  });
  defineBlockNoteAuthorizationContract({
    key: (name) => name,
    create: async (fixture) =>
      createInMemoryAuthorizationProvider({
        resolve: async () =>
          fixture.canConnect()
            ? {
                key: fixture.key,
                actor: { id: fixture.actorId },
                access: async (action) => fixture.getAccess(action),
                close: () => fixture.onClose(),
              }
            : null,
      }),
  });
  return createBlockNoteTestClock();
}
void registerPublicContracts;
