import { Node } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { BlockNoteError } from "../platform/BlockNoteError.js";
import {
  createExtension,
  createStore,
  ExtensionOptions,
} from "../editor/BlockNoteExtension.js";
import type {
  BlockNoteDocumentExtension,
  BlockNoteEmptyContext,
} from "../document/BlockNoteDocumentExtension.js";
import { ShowSelectionExtension } from "../extensions/ShowSelection/ShowSelection.js";
import { normalizeToUserStore, UserStoreOrResolver } from "../user/index.js";
import { CustomBlockNoteSchema } from "../schema/schema.js";
import { CommentMark } from "./mark.js";
import type { ThreadStore } from "./threadstore/ThreadStore.js";
import type { CommentBody } from "./types.js";
import {
  createExternalCommentsRuntime,
  type ExternalCommentsVerifier,
} from "./external/ExternalCommentsRuntime.js";
import type { BlockNoteAccessStore } from "../access/BlockNoteAccess.js";
import type { BlockNoteCommentAnchorCapture } from "./external/BlockNoteCommentAnchorCapture.js";

type DocumentCommentsOptions = {
  target?: "document";
  threadStore: ThreadStore;
  resolveUsers: UserStoreOrResolver;
  schema?: CustomBlockNoteSchema<any, any, any>;
  confirmBeforeDiscard?: boolean;
};

type ExternalCommentsOptions = {
  target: "external";
  schema?: CustomBlockNoteSchema<any, any, any>;
  confirmBeforeDiscard?: boolean;
};

type CommentsOptions = DocumentCommentsOptions | ExternalCommentsOptions;

export interface BlockNoteExternalCommentsContext {
  readonly threadStore: ThreadStore;
  readonly resolveUsers: UserStoreOrResolver;
}

interface ResolvedExternalCommentsContext extends BlockNoteExternalCommentsContext {
  readonly access: BlockNoteAccessStore;
  readonly isOnline: () => boolean;
  readonly capture: (range: {
    readonly from: number;
    readonly to: number;
  }) => BlockNoteCommentAnchorCapture;
  readonly verifier: ExternalCommentsVerifier;
}

type CommentsContext =
  | BlockNoteEmptyContext
  | { readonly commentsExternal: BlockNoteExternalCommentsContext };

function isResolvedExternalCommentsContext(
  value: BlockNoteExternalCommentsContext | undefined,
): value is ResolvedExternalCommentsContext {
  return (
    !!value &&
    "access" in value &&
    "isOnline" in value &&
    typeof value.isOnline === "function" &&
    "capture" in value &&
    typeof value.capture === "function" &&
    "verifier" in value
  );
}

const PLUGIN_KEY = new PluginKey("blocknote-comments");

type CommentsPluginState = {
  /**
   * Decorations to be rendered, specifically to indicate the selected thread
   */
  decorations: DecorationSet;
};

/**
 * Calculate the thread positions from the current document state
 */
function getUpdatedThreadPositions(doc: Node, markType: string) {
  const threadPositions = new Map<string, { from: number; to: number }>();

  // find all thread marks and store their position + create decoration for selected thread
  doc.descendants((node, pos) => {
    node.marks.forEach((mark) => {
      if (mark.type.name === markType) {
        const thisThreadId = (mark.attrs as { threadId: string | undefined })
          .threadId;
        if (!thisThreadId) {
          return;
        }
        const from = pos;
        const to = from + node.nodeSize;

        // FloatingThreads component uses "to" as the position, so always store the largest "to" found
        // AnchoredThreads component uses "from" as the position, so always store the smallest "from" found
        const currentPosition = threadPositions.get(thisThreadId) ?? {
          from: Infinity,
          to: 0,
        };
        threadPositions.set(thisThreadId, {
          from: Math.min(from, currentPosition.from),
          to: Math.max(to, currentPosition.to),
        });
      }
    });
  });
  return threadPositions;
}

const commentsExtensionFactory = createExtension(
  ({
    editor,
    options,
    context,
  }: ExtensionOptions<CommentsOptions, CommentsContext>) => {
    const {
      schema: commentEditorSchema,
      confirmBeforeDiscard = true,
      target = "document",
    } = options;
    const configuredExternal =
      "commentsExternal" in context ? context.commentsExternal : undefined;
    const externalContext =
      target === "external" &&
      isResolvedExternalCommentsContext(configuredExternal)
        ? configuredExternal
        : undefined;
    if (target === "external" && !externalContext) {
      throw new BlockNoteError(
        "incompatible-document",
        "External comments require the collaboration session context.",
      );
    }
    const threadStore =
      options.target === "external"
        ? externalContext!.threadStore
        : options.threadStore;
    const resolveUsers =
      options.target === "external"
        ? externalContext!.resolveUsers
        : options.resolveUsers;
    if (!resolveUsers) {
      throw new Error(
        "resolveUsers is required to be defined when using comments",
      );
    }
    if (!threadStore) {
      throw new Error(
        "threadStore is required to be defined when using comments",
      );
    }
    // Resolve users through this store, exposed on the extension instance so the
    // comments UI can read from it directly. Accepts a resolver callback or a
    // shared store (see the option docs above).
    const userStore = normalizeToUserStore(resolveUsers);
    const markType = CommentMark.name;

    const store = createStore(
      {
        pendingComment: false,
        selectedThreadId: undefined as string | undefined,
        threadPositions: new Map<string, { from: number; to: number }>(),
      },
      {
        onUpdate() {
          // If the selected thread id changed, we need to update the decorations
          if (
            store.state.selectedThreadId !== store.prevState.selectedThreadId
          ) {
            // So, we issue a transaction to update the decorations
            editor.transact((tr) => tr.setMeta(PLUGIN_KEY, true));
          }
        },
      },
    );
    const externalRuntime =
      target === "external" && externalContext
        ? createExternalCommentsRuntime(externalContext)
        : null;
    const guardedMutations = new Set([
      "createThread",
      "createThreadCommand",
      "addComment",
      "updateComment",
      "deleteComment",
      "deleteThread",
      "resolveThread",
      "unresolveThread",
      "reopenThread",
      "addReaction",
      "deleteReaction",
    ]);
    const boundThreadStoreMethods = new Map<PropertyKey, unknown>();
    const exposedThreadStore = externalContext
      ? new Proxy(threadStore, {
          get(targetStore, property) {
            const value = Reflect.get(targetStore, property, targetStore);
            if (typeof value !== "function") {
              return value;
            }
            const existing = boundThreadStoreMethods.get(property);
            if (existing) {
              return existing;
            }
            const bound = (...args: unknown[]) => {
              if (guardedMutations.has(String(property))) {
                if (!externalContext.isOnline()) {
                  throw new BlockNoteError(
                    "offline-unavailable",
                    "External comment mutations require an online server.",
                    { retryable: true },
                  );
                }
                if (!externalContext.access.get().comment) {
                  throw new BlockNoteError(
                    "access-denied",
                    "Comment access is required.",
                  );
                }
              }
              return Reflect.apply(value, targetStore, args);
            };
            boundThreadStoreMethods.set(property, bound);
            return bound;
          },
        })
      : threadStore;

    const updateMarksFromThreads = () => {
      if (externalRuntime) {
        return;
      }
      const snapshot = threadStore.getSnapshot();
      editor.transact((tr) => {
        tr.doc.descendants((node, pos) => {
          node.marks.forEach((mark) => {
            if (mark.type.name === markType) {
              const markTypeInstance = mark.type;
              const markThreadId = mark.attrs.threadId as string;
              const thread = snapshot.threads.get(markThreadId);
              const isOrphan = thread
                ? !!(thread.detached || thread.resolved || thread.deletedAt)
                : snapshot.completeness === "complete";

              if (isOrphan !== mark.attrs.orphan) {
                const trimmedFrom = Math.max(pos, 0);
                const trimmedTo = Math.min(
                  pos + node.nodeSize,
                  tr.doc.content.size - 1,
                  tr.doc.content.size - 1,
                );
                tr.removeMark(trimmedFrom, trimmedTo, mark);
                tr.addMark(
                  trimmedFrom,
                  trimmedTo,
                  markTypeInstance.create({
                    ...mark.attrs,
                    orphan: isOrphan,
                  }),
                );

                if (isOrphan && store.state.selectedThreadId === markThreadId) {
                  // unselect
                  store.setState((prev) => ({
                    ...prev,
                    selectedThreadId: undefined,
                  }));
                }
              }
            }
          });
        });
      });
    };

    return {
      key: "comments",
      store,
      userStore,
      runsBefore: ["link"],
      tiptapExtensions: [CommentMark],
      prosemirrorPlugins: [
        new Plugin<CommentsPluginState>({
          key: PLUGIN_KEY,
          state: {
            init() {
              return {
                decorations: DecorationSet.empty,
              };
            },
            apply(tr, state) {
              const action = tr.getMeta(PLUGIN_KEY);

              if (!tr.docChanged && !action) {
                return state;
              }

              // only update threadPositions if the doc changed
              const newThreadPositions = externalRuntime
                ? store.state.threadPositions
                : tr.docChanged
                  ? getUpdatedThreadPositions(tr.doc, markType)
                  : store.state.threadPositions;

              if (
                newThreadPositions.size > 0 ||
                store.state.threadPositions.size > 0
              ) {
                // small optimization; don't emit event if threadPositions before / after were both empty
                store.setState((prev) => ({
                  ...prev,
                  threadPositions: newThreadPositions,
                }));
              }

              // update decorations if doc or selected thread changed
              const decorations = [] as any[];

              if (store.state.selectedThreadId) {
                const selectedThreadPosition = newThreadPositions.get(
                  store.state.selectedThreadId,
                );

                if (selectedThreadPosition) {
                  decorations.push(
                    Decoration.inline(
                      selectedThreadPosition.from,
                      selectedThreadPosition.to,
                      {
                        class: "bn-thread-mark-selected",
                      },
                    ),
                  );
                }
              }

              return {
                decorations: DecorationSet.create(tr.doc, decorations),
              };
            },
          },
          props: {
            decorations(state) {
              return (
                PLUGIN_KEY.getState(state)?.decorations ?? DecorationSet.empty
              );
            },
            handleClick: (view, pos, event) => {
              if (event.button !== 0) {
                return false;
              }

              if (externalRuntime) {
                const selected = [...store.state.threadPositions].find(
                  ([, range]) => range.from <= pos && pos <= range.to,
                )?.[0];
                store.setState((previous) => ({
                  ...previous,
                  selectedThreadId: selected,
                }));
                return selected !== undefined;
              }

              const node = view.state.doc.nodeAt(pos);

              if (!node) {
                // unselect
                store.setState((prev) => ({
                  ...prev,
                  selectedThreadId: undefined,
                }));
                return false;
              }

              const commentMark = node.marks.find(
                (mark) =>
                  mark.type.name === markType && mark.attrs.orphan !== true,
              );

              if (!commentMark) {
                // Clicked outside any comment thread. Deselect if needed but
                // don't consume the event so other handlers (e.g. link
                // navigation) can process it.
                if (store.state.selectedThreadId !== undefined) {
                  store.setState((prev) => ({
                    ...prev,
                    selectedThreadId: undefined,
                  }));
                }
                return false;
              }

              const threadId = commentMark.attrs.threadId as string;

              // If the clicked thread is already selected, do nothing and let
              // other handlers process the event (e.g. navigating a link).
              if (threadId === store.state.selectedThreadId) {
                return false;
              }

              store.setState((prev) => ({
                ...prev,
                selectedThreadId: threadId,
              }));

              return true;
            },
          },
        }),
      ],
      threadStore: exposedThreadStore,
      access: externalContext?.access,
      externalRuntime,
      mount() {
        if (externalRuntime) {
          const updateExternalPositions = () => {
            const threadPositions = new Map<
              string,
              { from: number; to: number }
            >();
            for (const [threadId, anchor] of externalRuntime.getState()
              .anchors) {
              if (anchor.status === "attached") {
                threadPositions.set(threadId, anchor.range);
              }
            }
            store.setState((previous) => ({ ...previous, threadPositions }));
            editor.transact((transaction) =>
              transaction.setMeta(PLUGIN_KEY, true),
            );
          };
          const unsubscribe = externalRuntime.subscribe(
            updateExternalPositions,
          );
          updateExternalPositions();
          return unsubscribe;
        }
        const unsubscribe = threadStore.subscribe(updateMarksFromThreads);
        updateMarksFromThreads();

        const unsubscribeOnSelectionChange = editor.onSelectionChange(() => {
          if (store.state.pendingComment) {
            store.setState((prev) => ({
              ...prev,
              pendingComment: false,
            }));
          }
        });

        return () => {
          unsubscribe();
          unsubscribeOnSelectionChange();
        };
      },
      selectThread(threadId: string | undefined, scrollToThread = true) {
        if (store.state.selectedThreadId === threadId) {
          return;
        }
        store.setState((prev) => ({
          ...prev,
          pendingComment: false,
          selectedThreadId: threadId,
        }));

        if (threadId && scrollToThread) {
          const selectedThreadPosition =
            store.state.threadPositions.get(threadId);
          if (!selectedThreadPosition) {
            return;
          }
          (
            editor.prosemirrorView?.domAtPos(selectedThreadPosition.from)
              .node as Element | undefined
          )?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }
      },
      startPendingComment() {
        store.setState((prev) => ({
          ...prev,
          selectedThreadId: undefined,
          pendingComment: true,
        }));
        // Use `editor.domElement` as `editor.focus()` doesn't do anything if
        // the editor is non-editable. Editor needs to be focused as
        // `showSelection` will otherwise trigger a selection update which
        // triggers `stopPendingComment`.
        editor.domElement?.focus();
        editor
          .getExtension(ShowSelectionExtension)
          ?.showSelection(true, "comments");
      },
      stopPendingComment() {
        store.setState((prev) => ({
          ...prev,
          selectedThreadId: undefined,
          pendingComment: false,
        }));
        editor
          .getExtension(ShowSelectionExtension)
          ?.showSelection(false, "comments");
      },
      async createThread(options: {
        initialComment: { body: CommentBody; metadata?: any };
        metadata?: any;
      }) {
        await this.createThreadCommand(options).execute();
      },
      createThreadCommand(options: {
        initialComment: { body: CommentBody; metadata?: any };
        metadata?: any;
      }) {
        if (!externalRuntime) {
          const command = threadStore.createThreadCommand(options);
          let attach: Promise<void> | null = null;
          return {
            execute: async (executeOptions?: {
              readonly signal?: AbortSignal;
            }) => {
              const thread = await command.execute(executeOptions);
              attach ??= threadStore.addThreadToDocument
                ? threadStore.addThreadToDocument({
                    threadId: thread.id,
                    selection: editor.transact((tr) => tr.selection),
                    editor,
                  })
                : Promise.resolve().then(() => {
                    (editor as any)._tiptapEditor.commands.setMark(markType, {
                      orphan: false,
                      threadId: thread.id,
                    });
                  });
              await attach;
              return thread;
            },
          };
        }
        const selection = editor.transact(
          (transaction) => transaction.selection,
        );
        const from = Math.min(selection.anchor, selection.head);
        const to = Math.max(selection.anchor, selection.head);
        if (from >= to) {
          throw new BlockNoteError(
            "invalid-anchor",
            "External comments require a non-empty selection.",
          );
        }
        return externalRuntime.createThreadCommand({
          ...options,
          capture: externalRuntime.capture({ from, to }),
        });
      },
      destroy() {
        void externalRuntime?.destroy();
      },
      commentEditorSchema,
      confirmBeforeDiscard,
    } as const;
  },
  { name: "comments", version: "2" },
);

type CommentsExtensionInstance = ReturnType<
  typeof commentsExtensionFactory
>["~types"]["extension"];

type ConfiguredCommentsExtension<
  Options,
  Context extends object,
> = BlockNoteDocumentExtension<
  "comments",
  "2",
  readonly [],
  Options,
  Context,
  CommentsExtensionInstance
>;

type CommentsExtensionFactory = {
  (
    options: DocumentCommentsOptions,
  ): ConfiguredCommentsExtension<
    DocumentCommentsOptions,
    BlockNoteEmptyContext
  >;
  (
    options: ExternalCommentsOptions,
  ): ConfiguredCommentsExtension<
    ExternalCommentsOptions,
    { readonly commentsExternal: BlockNoteExternalCommentsContext }
  >;
};

export const CommentsExtension =
  commentsExtensionFactory as CommentsExtensionFactory;
