import {
  InputRule,
  inputRules as inputRulesPlugin,
} from "@handlewithcare/prosemirror-inputrules";
import {
  AnyExtension as AnyTiptapExtension,
  Extension as TiptapExtension,
} from "@tiptap/core";
import { keymap } from "@tiptap/pm/keymap";
import { Plugin, TextSelection } from "prosemirror-state";
import { updateBlockTr } from "../../../api/blockManipulation/commands/updateBlock/updateBlock.js";
import { setTextCursorPosition } from "../../../api/blockManipulation/selections/textCursorPosition.js";
import {
  getBlockInfoFromSelection,
  getNodeId,
} from "../../../api/getBlockInfoFromPos.js";
import { sortByDependencies } from "../../../util/topo-sort.js";
import { isBlockNoteDocumentExtension } from "../../../document/validateBlockNoteDocumentExtensions.js";
import type { AnyBlockNoteDocumentExtension } from "../../../document/BlockNoteDocumentExtension.js";
import type {
  BlockNoteEditor,
  BlockNoteEditorOptions,
} from "../../BlockNoteEditor.js";
import type {
  AnyExtensionFactory,
  Extension,
  ExtensionInstanceFromFactory,
  ExtensionFactoryInstance,
} from "../../BlockNoteExtension.js";
import { BlockNoteError } from "../../../platform/BlockNoteError.js";
import { originalFactorySymbol } from "./symbol.js";
import {
  getDefaultExtensions,
  getDefaultTiptapExtensions,
} from "./extensions.js";
import { ExtensionLifecycle } from "./ExtensionLifecycle.js";
import { SemanticExtensionRegistry } from "./SemanticExtensionRegistry.js";

type ExtensionInput =
  | Extension
  | ExtensionFactoryInstance
  | AnyBlockNoteDocumentExtension;

type ExtensionReference = undefined | string | Extension | AnyExtensionFactory;

type ExtensionReferences = ExtensionReference | readonly ExtensionReference[];

export class ExtensionManager {
  /**
   * A set of extension keys which are disabled by the options
   */
  private disabledExtensions = new Set<string>();
  /**
   * A list of all the extensions that are registered to the editor
   */
  private extensions: Extension[] = [];
  /**
   * A map of all the extension factories that are registered to the editor
   */
  private extensionFactories = new Map<AnyExtensionFactory, Extension>();

  private semanticExtensions = new SemanticExtensionRegistry();

  private lifecycle = new ExtensionLifecycle();

  private initializing = true;

  private destroyed = false;

  private replacingExtensions = false;

  private extensionReadSnapshot:
    | {
        readonly extensions: readonly Extension[];
        readonly factories: ReadonlyMap<AnyExtensionFactory, Extension>;
      }
    | undefined;
  /**
   * Because a single blocknote extension can both have it's own prosemirror plugins & additional generated ones (e.g. keymap & input rules plugins)
   * We need to keep track of all the plugins for each extension, so that we can remove them when the extension is unregistered
   */
  private extensionPlugins: Map<Extension, Plugin[]> = new Map();
  /**
   * Maps an extension key to the set of extension keys that declared it as a
   * dependency via `blockNoteExtensions`. A sub-extension is a dependency of
   * the extension that declares it, so it must run *before* its parent(s).
   */
  private blockNoteExtensionDependents: Map<string, Set<string>> = new Map();

  constructor(
    private editor: BlockNoteEditor<any, any, any>,
    private options: BlockNoteEditorOptions<any, any, any>,
  ) {
    /**
     * When the editor is first mounted, we need to initialize all the extensions
     */
    this.lifecycle.addSubscription(
      editor.onMount(() => {
        for (const extension of this.orderExtensionsForLifecycle(
          this.extensions,
        )) {
          this.lifecycle.mount(extension, {
            dom: editor.prosemirrorView.dom,
            root: editor.prosemirrorView.root,
          });
        }
      }),
    );

    /**
     * When the editor is unmounted, we need to abort all the extensions' abort controllers
     */
    this.lifecycle.addSubscription(
      editor.onUnmount(() => {
        this.lifecycle.unmountAll();
      }),
    );

    // TODO do disabled extensions need to be only for editor base extensions? Or all of them?
    this.disabledExtensions = new Set(options.disableExtensions || []);

    try {
      // Add the default extensions
      for (const extension of getDefaultExtensions(this.editor, this.options)) {
        this.addExtension(extension);
      }

      // Add the extensions from the options
      for (const extension of this.options.extensions ?? []) {
        this.addExtension(extension);
      }

      // Add the extensions from blocks specs
      for (const block of Object.values(this.editor.schema.blockSpecs)) {
        for (const extension of block.extensions ?? []) {
          this.addExtension(extension);
        }
      }

      this.semanticExtensions.validate();
      this.initializing = false;
    } catch (error) {
      try {
        this.destroy();
      } catch {
        // Preserve the initialization failure.
      }
      throw error;
    }
  }

  /**
   * Register one or more extensions to the editor after the editor is initialized.
   *
   * This allows users to switch on & off extensions "at runtime".
   */
  public registerExtension(extension: ExtensionInput | ExtensionInput[]): void {
    this.replaceExtension(undefined, extension);
  }

  /**
   * Register an extension to the editor
   * @param extension - The extension to register
   * @returns The extension instance
   */
  private addExtension(
    extension: ExtensionInput,
    /**
     * When this extension is being added as a dependency declared in another
     * extension's `blockNoteExtensions`, this is the key of that declaring
     * (parent) extension.
     */
    parentKey?: string,
  ): Extension | undefined {
    const semanticExtension = isBlockNoteDocumentExtension(extension)
      ? extension
      : undefined;
    if (semanticExtension && !this.initializing) {
      throw new BlockNoteError(
        "incompatible-document",
        `Semantic BlockNote extension "${semanticExtension.name}" cannot be registered at runtime.`,
      );
    }

    let instance: Extension;
    if (typeof extension === "function") {
      instance = (extension as ExtensionFactoryInstance)({
        editor: this.editor,
        context: this.options.context ?? {},
      });
    } else {
      instance = extension as Extension;
    }

    if (!instance) {
      return undefined;
    }

    if (this.lifecycle.isDisposed(instance)) {
      throw new Error(
        `Cannot register disposed extension instance "${instance.key}". Create a fresh extension instance instead.`,
      );
    }

    const disabled =
      this.disabledExtensions.has(instance.key) ||
      (semanticExtension
        ? this.disabledExtensions.has(semanticExtension.name)
        : false);
    if (disabled) {
      let disposalFailure: unknown;
      try {
        this.lifecycle.dispose(instance);
      } catch (error) {
        disposalFailure = error;
      }

      if (semanticExtension) {
        throw new BlockNoteError(
          "incompatible-document",
          `Semantic BlockNote extension "${semanticExtension.name}" cannot be disabled at runtime.`,
        );
      }
      if (disposalFailure) {
        throw disposalFailure;
      }
      return undefined;
    }

    // A sub-extension declared via `blockNoteExtensions` must run before the
    // extension that declares it. We record this dependency before the
    // de-duplication check below, so that it applies even when multiple
    // extensions declare the same sub-extension (and all but the first are
    // de-duplicated).
    if (parentKey) {
      let dependents = this.blockNoteExtensionDependents.get(instance.key);
      if (!dependents) {
        dependents = new Set();
        this.blockNoteExtensionDependents.set(instance.key, dependents);
      }
      dependents.add(parentKey);
    }

    // De-duplicate by key: if an extension with the same key is already
    // registered, don't register it again. This allows an extension to declare
    // a dependency on another extension via `blockNoteExtensions` without
    // conflicting when the user (or another extension) registers that same
    // extension directly. The first registration wins.
    const existing = this.extensions.find((e) => e.key === instance.key);
    if (existing) {
      let disposalFailure: unknown;
      if (existing !== instance) {
        try {
          this.lifecycle.dispose(instance);
        } catch (error) {
          disposalFailure = error;
        }
      }

      if (semanticExtension) {
        throw new BlockNoteError(
          "incompatible-document",
          `Semantic BlockNote extension "${semanticExtension.name}" uses duplicate runtime key "${instance.key}".`,
        );
      }
      if (disposalFailure) {
        throw disposalFailure;
      }
      return undefined;
    }

    // Now that we know that the extension is not disabled, we can add it to the extension factories
    if (typeof extension === "function") {
      const originalFactory = (instance as any)[
        originalFactorySymbol
      ] as AnyExtensionFactory;

      if (typeof originalFactory === "function") {
        this.extensionFactories.set(originalFactory, instance);
      }
    }

    this.extensions.push(instance);
    if (semanticExtension) {
      this.semanticExtensions.add(instance, semanticExtension);
    }

    if (instance.blockNoteExtensions) {
      for (const subExtension of instance.blockNoteExtensions) {
        this.addExtension(subExtension, instance.key);
      }
    }

    return instance as any;
  }

  /**
   * Resolve an extension or a list of extensions into a list of extension instances
   * @param toResolve - The extension or list of extensions to resolve
   * @returns A list of extension instances
   */
  private resolveExtensions(toResolve: ExtensionReferences): Extension[] {
    const extensions = [] as Extension[];
    if (typeof toResolve === "function") {
      const instance = this.extensionFactories.get(toResolve);
      if (instance) {
        extensions.push(instance);
      }
    } else if (Array.isArray(toResolve)) {
      for (const extension of toResolve) {
        extensions.push(...this.resolveExtensions(extension));
      }
    } else if (typeof toResolve === "object" && "key" in toResolve) {
      extensions.push(toResolve);
    } else if (typeof toResolve === "string") {
      const instance = this.extensions.find((e) => e.key === toResolve);
      if (instance) {
        extensions.push(instance);
      }
    }
    return extensions;
  }

  /**
   * Unregister an extension from the editor
   * @param toUnregister - The extension to unregister
   * @returns void
   */
  public unregisterExtension(toUnregister: ExtensionReferences): void {
    this.replaceExtension(toUnregister, []);
  }

  /**
   * Atomically replace extension instances in the editor.
   * @param toUnregister - The extensions to unregister, can be a string key, an extension instance, an extension factory, or an array of any of those
   * @param toRegister - The extensions to register, can be an extension instance, an extension factory, or an array of any of those
   * @returns void
   */
  public replaceExtension(
    toUnregister: ExtensionReferences,
    toRegister: ExtensionInput | ExtensionInput[],
  ): void {
    if (this.destroyed) {
      throw new Error("Cannot change extensions on a destroyed editor.");
    }

    if (this.replacingExtensions) {
      throw new Error(
        "Cannot change extensions during another extension change.",
      );
    }

    this.replacingExtensions = true;
    this.extensionReadSnapshot = {
      extensions: [...this.extensions],
      factories: new Map(this.extensionFactories),
    };
    try {
      this.replaceExtensionTransaction(toUnregister, toRegister);
    } finally {
      this.extensionReadSnapshot = undefined;
      this.replacingExtensions = false;
    }
  }

  private replaceExtensionTransaction(
    toUnregister: ExtensionReferences,
    toRegister: ExtensionInput | ExtensionInput[],
  ) {
    const extensionsToRemove = this.resolveExtensions(toUnregister);

    for (const extension of extensionsToRemove) {
      const semantic = this.semanticExtensions.get(extension);
      if (semantic) {
        throw new BlockNoteError(
          "incompatible-document",
          `Semantic BlockNote extension "${semantic.name}" cannot be unregistered at runtime.`,
        );
      }
    }

    if (toUnregister && !extensionsToRemove.length) {
      // eslint-disable-next-line no-console
      console.warn(`No extensions found to unregister`, toUnregister);
    }

    const previousExtensions = [...this.extensions];
    const previousExtensionFactories = new Map(this.extensionFactories);
    const previousExtensionPlugins = new Map(this.extensionPlugins);
    const previousDependents = new Map(
      [...this.blockNoteExtensionDependents].map(([key, dependents]) => [
        key,
        new Set(dependents),
      ]),
    );
    const previousProsemirrorPlugins =
      this.editor.prosemirrorState.plugins.slice();
    const removed = new Set(extensionsToRemove);
    const removedKeys = new Set(extensionsToRemove.map(({ key }) => key));
    const managedPluginRefs = new Set<Plugin>();
    const managedPluginKeys = new Set<string>();
    let didWarnUnregister = false;

    for (const extension of extensionsToRemove) {
      if (extension.tiptapExtensions && !didWarnUnregister) {
        didWarnUnregister = true;
        // eslint-disable-next-line no-console
        console.warn(
          `Extension ${extension.key} has tiptap extensions, but they will not be removed. Please separate the extension into multiple extensions if you want to remove them, or re-initialize the editor.`,
          toUnregister,
        );
      }
    }

    for (const plugins of previousExtensionPlugins.values()) {
      for (const plugin of plugins) {
        managedPluginRefs.add(plugin);
        const key = (plugin as any).spec?.key;
        const keyStr = typeof key === "object" && key ? key.key : key;
        if (typeof keyStr === "string") {
          managedPluginKeys.add(keyStr);
        }
      }
    }

    this.extensions = this.extensions.filter(
      (extension) => !removed.has(extension),
    );
    this.extensionFactories.forEach((instance, factory) => {
      if (removed.has(instance)) {
        this.extensionFactories.delete(factory);
      }
    });
    for (const extension of extensionsToRemove) {
      this.extensionPlugins.delete(extension);
    }
    for (const [key, dependents] of this.blockNoteExtensionDependents) {
      if (removedKeys.has(key)) {
        this.blockNoteExtensionDependents.delete(key);
        continue;
      }
      for (const removedKey of removedKeys) {
        dependents.delete(removedKey);
      }
      if (dependents.size === 0) {
        this.blockNoteExtensionDependents.delete(key);
      }
    }

    const retained = new Set(this.extensions);
    const newExtensions = ([] as ExtensionInput[])
      .concat(toRegister)
      .filter(Boolean) as ExtensionInput[];
    let pluginUpdateAttempted = false;
    let stagedInLifecycleOrder: Extension[] | undefined;

    const rollback = () => {
      const staged = this.extensions.filter(
        (extension) => !previousExtensions.includes(extension),
      );
      this.extensions = previousExtensions;
      this.extensionFactories = previousExtensionFactories;
      this.extensionPlugins = previousExtensionPlugins;
      this.blockNoteExtensionDependents = previousDependents;

      const disposalOrder = stagedInLifecycleOrder
        ? [...stagedInLifecycleOrder].reverse()
        : staged.reverse();
      for (const extension of disposalOrder) {
        try {
          this.lifecycle.dispose(extension);
        } catch {
          // Preserve the transaction failure.
        }
      }
    };

    try {
      for (const extension of newExtensions) {
        this.addExtension(extension);
      }

      const staged = this.extensions.filter(
        (extension) => !retained.has(extension),
      );
      const extensionsInDependencyOrder = this.orderExtensionsForLifecycle(
        this.extensions,
      );
      const stagedInstances = new Set(
        staged.filter((extension) => !previousExtensions.includes(extension)),
      );
      stagedInLifecycleOrder = extensionsInDependencyOrder.filter((extension) =>
        stagedInstances.has(extension),
      );
      for (const extension of staged) {
        if (extension.tiptapExtensions) {
          // eslint-disable-next-line no-console
          console.warn(
            `Extension ${extension.key} has tiptap extensions, but these cannot be changed after initializing the editor. Please separate the extension into multiple extensions if you want to add them, or re-initialize the editor.`,
            extension,
          );
        }

        if (extension.inputRules?.length) {
          // eslint-disable-next-line no-console
          console.warn(
            `Extension ${extension.key} has input rules, but these cannot be changed after initializing the editor. Please separate the extension into multiple extensions if you want to add them, or re-initialize the editor.`,
            extension,
          );
        }

        this.getProsemirrorPluginsFromExtension(extension);
      }

      const managedPlugins = extensionsInDependencyOrder.flatMap(
        (extension) => this.extensionPlugins.get(extension) ?? [],
      );
      const didChangeExtensions =
        stagedInstances.size > 0 ||
        previousExtensions.some(
          (extension) => !this.extensions.includes(extension),
        );
      if (
        didChangeExtensions &&
        (managedPluginRefs.size ||
          managedPluginKeys.size ||
          managedPlugins.length)
      ) {
        pluginUpdateAttempted = true;
        this.updatePlugins((plugins) =>
          this.replaceManagedPlugins(
            plugins,
            managedPluginRefs,
            managedPluginKeys,
            managedPlugins,
          ),
        );
      }

      if (!this.editor.headless) {
        const context = {
          dom: this.editor.prosemirrorView.dom,
          root: this.editor.prosemirrorView.root,
        };
        for (const extension of stagedInLifecycleOrder) {
          this.lifecycle.mount(extension, context);
        }
      }
    } catch (error) {
      if (pluginUpdateAttempted) {
        try {
          this.updatePlugins(() => previousProsemirrorPlugins);
        } catch {
          // Preserve the transaction failure.
        }
      }
      rollback();
      throw error;
    }

    this.extensionReadSnapshot = undefined;

    let disposalFailure: unknown;
    for (const extension of extensionsToRemove) {
      if (this.extensions.includes(extension)) {
        continue;
      }
      try {
        this.lifecycle.dispose(extension);
      } catch (error) {
        disposalFailure ??= error;
      }
    }

    if (disposalFailure) {
      throw new BlockNoteError(
        "extension-cleanup-failed",
        "Extension replacement committed, but cleanup of removed extensions failed.",
        { cause: disposalFailure, retryable: false },
      );
    }
  }

  /**
   * Allows resetting the current prosemirror state's plugins
   * @param update - A function that takes the current plugins and returns the new plugins
   * @returns void
   */
  private updatePlugins(update: (plugins: Plugin[]) => Plugin[]): void {
    const currentState = this.editor.prosemirrorState;

    const state = currentState.reconfigure({
      plugins: update(currentState.plugins.slice()),
    });

    this.editor.prosemirrorView.updateState(state);
  }

  private replaceManagedPlugins(
    plugins: Plugin[],
    managedPluginRefs: ReadonlySet<Plugin>,
    managedPluginKeys: ReadonlySet<string>,
    managedPlugins: readonly Plugin[],
  ) {
    const isManaged = (plugin: Plugin) => {
      const key = (plugin as any).spec?.key;
      const keyStr = typeof key === "object" && key ? key.key : key;
      return (
        managedPluginRefs.has(plugin) ||
        (typeof keyStr === "string" && managedPluginKeys.has(keyStr))
      );
    };
    let lastManagedSlot = -1;
    for (let index = plugins.length - 1; index >= 0; index--) {
      if (isManaged(plugins[index])) {
        lastManagedSlot = index;
        break;
      }
    }
    const reordered: Plugin[] = [];
    let nextManaged = 0;

    for (const [index, plugin] of plugins.entries()) {
      if (isManaged(plugin)) {
        if (nextManaged < managedPlugins.length) {
          reordered.push(managedPlugins[nextManaged++]);
        }
        if (index === lastManagedSlot) {
          reordered.push(...managedPlugins.slice(nextManaged));
          nextManaged = managedPlugins.length;
        }
      } else {
        reordered.push(plugin);
      }
    }

    if (lastManagedSlot === -1) {
      reordered.push(...managedPlugins);
    }
    return reordered;
  }

  private getExtensionPriority() {
    return sortByDependencies(
      this.extensions.map((extension) => {
        const dependents = new Set([
          ...(this.blockNoteExtensionDependents.get(extension.key) ?? []),
          ...(this.semanticExtensions.getDependents(extension.key) ?? []),
        ]);
        if (!dependents.size) {
          return extension;
        }
        return {
          key: extension.key,
          runsBefore: [...(extension.runsBefore ?? []), ...dependents],
        };
      }),
    );
  }

  private orderExtensionsForLifecycle(extensions: readonly Extension[]) {
    const getPriority = this.getExtensionPriority();
    return [...extensions].sort(
      (left, right) => getPriority(right.key) - getPriority(left.key),
    );
  }

  /**
   * Get all the extensions that are registered to the editor
   */
  public getTiptapExtensions(): AnyTiptapExtension[] {
    // Start with the default tiptap extensions
    const tiptapExtensions = getDefaultTiptapExtensions(
      this.editor,
      this.options,
    ).filter((extension) => !this.disabledExtensions.has(extension.name));

    const getPriority = this.getExtensionPriority();

    const inputRulesByPriority = new Map<number, InputRule[]>();
    for (const extension of this.extensions) {
      if (extension.tiptapExtensions) {
        tiptapExtensions.push(...extension.tiptapExtensions);
      }

      const priority = getPriority(extension.key);

      const { plugins: prosemirrorPlugins, inputRules } =
        this.getProsemirrorPluginsFromExtension(extension);
      // Sometimes a blocknote extension might need to make additional prosemirror plugins, so we generate them here
      if (prosemirrorPlugins.length) {
        tiptapExtensions.push(
          TiptapExtension.create({
            name: extension.key,
            priority,
            addProseMirrorPlugins: () => prosemirrorPlugins,
          }),
        );
      }
      if (inputRules.length) {
        if (!inputRulesByPriority.has(priority)) {
          inputRulesByPriority.set(priority, []);
        }
        inputRulesByPriority.get(priority)!.push(...inputRules);
      }
    }

    // Collect all input rules into 1 extension to reduce conflicts
    tiptapExtensions.push(
      TiptapExtension.create({
        name: "blocknote-input-rules",
        addProseMirrorPlugins() {
          const rules = [] as InputRule[];
          Array.from(inputRulesByPriority.keys())
            // We sort the rules by their priority (the key)
            .sort((a, b) => a - b)
            .reverse()
            .forEach((priority) => {
              // Append in reverse priority order
              rules.push(...inputRulesByPriority.get(priority)!);
            });
          const inputRules = inputRulesPlugin({ rules });
          // Sidecar plugin: triggers the same input rules on Enter by
          // delegating to the inputRules plugin's handleTextInput with a
          // synthetic "\n" insertion. The handlewithcare regex `\s$` already
          // matches `\n`, so any rule that fires on space fires on Enter too.
          // We call its handleTextInput directly (rather than via
          // view.someProp) so other plugins don't observe the synthetic input,
          // and so the rule's undo metadata is keyed to the same plugin
          // instance that Tiptap's `commands.undoInputRule` reads from.
          const inputRulesEnter = new Plugin({
            props: {
              handleKeyDown(view, event) {
                if (event.key !== "Enter") {
                  return false;
                }
                // Only trigger on plain Enter — modifier combos like
                // Shift/Cmd/Ctrl/Alt+Enter are reserved for other handlers
                // (e.g. soft-break, submit) and should fall through.
                if (
                  event.shiftKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.altKey
                ) {
                  return false;
                }
                const { $cursor } = view.state.selection as TextSelection;
                if (!$cursor) {
                  return false;
                }
                return !!inputRules.props.handleTextInput?.call(
                  inputRules,
                  view,
                  $cursor.pos,
                  $cursor.pos,
                  "\n",
                  () =>
                    view.state.tr.insertText("\n", $cursor.pos, $cursor.pos),
                );
              },
            },
          });
          return [inputRules, inputRulesEnter];
        },
      }),
    );

    // Add any tiptap extensions from the `_tiptapOptions`
    for (const extension of this.options._tiptapOptions?.extensions ?? []) {
      tiptapExtensions.push(extension);
    }

    return tiptapExtensions;
  }

  /**
   * This maps a blocknote extension into an array of Prosemirror plugins if it has any of the following:
   * - plugins
   * - keyboard shortcuts
   * - input rules
   */
  private getProsemirrorPluginsFromExtension(extension: Extension): {
    plugins: Plugin[];
    inputRules: InputRule[];
  } {
    const plugins: Plugin[] = [...(extension.prosemirrorPlugins ?? [])];
    const inputRules: InputRule[] = [];
    if (
      !extension.prosemirrorPlugins?.length &&
      !Object.keys(extension.keyboardShortcuts || {}).length &&
      !extension.inputRules?.length
    ) {
      // We can bail out early if the extension has no features to add to the tiptap editor
      return { plugins, inputRules };
    }

    this.extensionPlugins.set(extension, plugins);

    if (extension.inputRules?.length) {
      inputRules.push(
        ...extension.inputRules.map((inputRule) => {
          return new InputRule(
            inputRule.find,
            (state, match, start, end) => {
              const replaceWith = inputRule.replace({
                match,
                range: { from: start, to: end },
                editor: this.editor,
              });
              if (replaceWith) {
                const tr = state.tr;
                const blockInfo = getBlockInfoFromSelection(tr);

                if (
                  !blockInfo.isBlockContainer ||
                  this.editor.schema.blockSchema[blockInfo.blockNoteType]
                    ?.content !== "inline"
                ) {
                  return null;
                }

                tr.deleteRange(start, end);
                updateBlockTr(tr, blockInfo.bnBlock.beforePos, replaceWith);
                // updateBlockTr's replaceWith path leaves the selection after
                // the new block when the content is replaced wholesale (e.g.
                // when the rule returns content: []). Move the cursor back
                // inside the new block so the user can keep typing.
                setTextCursorPosition(
                  tr,
                  getNodeId(blockInfo.bnBlock.node, tr.doc),
                  "start",
                );
                return tr;
              }
              return null;
            },
            { undoable: true },
          );
        }),
      );
    }

    if (Object.keys(extension.keyboardShortcuts || {}).length) {
      plugins.push(
        keymap(
          Object.fromEntries(
            Object.entries(extension.keyboardShortcuts!).map(([key, value]) => [
              key,
              () => value({ editor: this.editor }),
            ]),
          ),
        ),
      );
    }

    return { plugins, inputRules };
  }

  public destroy() {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    let failure: unknown;

    try {
      this.lifecycle.destroy(this.extensions);
    } catch (error) {
      failure = error;
    }

    this.extensions = [];
    this.extensionFactories.clear();
    this.extensionPlugins.clear();
    this.semanticExtensions.clear();
    this.blockNoteExtensionDependents.clear();

    if (failure) {
      throw failure;
    }
  }

  /**
   * Get all extensions
   */
  public getExtensions(): Map<string, Extension> {
    const extensions =
      this.extensionReadSnapshot?.extensions ?? this.extensions;
    return new Map(extensions.map((extension) => [extension.key, extension]));
  }

  /**
   * Get a specific extension by it's instance
   */
  public getExtension<
    const T extends Extension | AnyExtensionFactory = Extension,
  >(
    extension: string,
  ):
    | (T extends Extension
        ? T
        : T extends AnyExtensionFactory
          ? ExtensionInstanceFromFactory<T>
          : never)
    | undefined;
  public getExtension<const T extends AnyExtensionFactory>(
    extension: T,
  ): ExtensionInstanceFromFactory<T> | undefined;
  public getExtension<const T extends AnyExtensionFactory | string = string>(
    extension: T,
  ):
    | (T extends AnyExtensionFactory
        ? ExtensionInstanceFromFactory<T>
        : T extends string
          ? Extension
          : never)
    | undefined {
    const extensions =
      this.extensionReadSnapshot?.extensions ?? this.extensions;
    const factories =
      this.extensionReadSnapshot?.factories ?? this.extensionFactories;
    if (typeof extension === "string") {
      const instance = extensions.find((e) => e.key === extension);
      if (!instance) {
        return undefined;
      }
      return instance as any;
    } else if (typeof extension === "function") {
      const instance = factories.get(extension);
      if (!instance) {
        return undefined;
      }
      return instance as any;
    }
    throw new Error(`Invalid extension type: ${typeof extension}`);
  }

  /**
   * Check if an extension exists
   */
  public hasExtension(key: string | Extension | AnyExtensionFactory): boolean {
    const extensions =
      this.extensionReadSnapshot?.extensions ?? this.extensions;
    const factories =
      this.extensionReadSnapshot?.factories ?? this.extensionFactories;
    if (typeof key === "string") {
      return extensions.some((e) => e.key === key);
    } else if (typeof key === "object" && "key" in key) {
      return extensions.some((e) => e.key === key.key);
    } else if (typeof key === "function") {
      return factories.has(key);
    }
    return false;
  }
}
