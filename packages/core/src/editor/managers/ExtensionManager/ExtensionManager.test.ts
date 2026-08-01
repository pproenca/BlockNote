/**
 * @vitest-environment jsdom
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtension } from "../../BlockNoteExtension.js";
import { BlockNoteEditor } from "../../BlockNoteEditor.js";
import { BlockNoteError } from "../../../platform/BlockNoteError.js";

function createMountedEditor(
  extensions: BlockNoteEditor<any, any, any>["options"]["extensions"],
) {
  const editor = BlockNoteEditor.create({ extensions });
  editor.mount(document.createElement("div"));
  return editor;
}

/**
 * Returns the index of the plugin identified by `key` within the editor's
 * ProseMirror plugin list. A lower index means it runs/applies earlier.
 */
function pluginIndex(
  editor: BlockNoteEditor<any, any, any>,
  key: PluginKey,
): number {
  return editor.prosemirrorState.plugins.findIndex(
    (plugin) => (plugin as any).spec?.key === key,
  );
}

describe("ExtensionManager de-duplication by key", () => {
  it("registers only the first extension when two share a key", () => {
    let mountCount = 0;

    const first = createExtension(() => ({
      key: "dup",
      value: "first",
      mount() {
        mountCount++;
        return () => {};
      },
    }));
    const second = createExtension(() => ({
      key: "dup",
      value: "second",
      mount() {
        mountCount++;
        return () => {};
      },
    }));

    const editor = createMountedEditor([first(), second()]);

    // The first registration wins.
    expect(editor.getExtension(first)?.value).toBe("first");
    // The second registration was skipped entirely.
    expect(editor.getExtension(second)).toBeUndefined();
    expect((editor.extensions.get("dup") as any)?.value).toBe("first");
    expect(
      [...editor.extensions.values()].filter((e) => e.key === "dup").length,
    ).toBe(1);
    // Only the registered extension was mounted.
    expect(mountCount).toBe(1);
  });

  it("does not re-register a dependency declared via blockNoteExtensions when it is already registered", () => {
    // Two distinct factories sharing the key "dep".
    const depDirect = createExtension(() => ({
      key: "dep",
      value: "direct",
    }));
    const depFromParent = createExtension(() => ({
      key: "dep",
      value: "from-parent",
    }));
    const parent = createExtension(() => ({
      key: "parent",
      blockNoteExtensions: [depFromParent()],
    }));

    // Register the dependency directly first, then a parent that also pulls in
    // its own "dep" via blockNoteExtensions.
    const editor = createMountedEditor([depDirect(), parent()]);

    expect(editor.getExtension(parent)).toBeDefined();
    // The directly-registered dependency wins; the one declared by the parent
    // is skipped rather than overriding it.
    expect(editor.getExtension(depDirect)?.value).toBe("direct");
    expect(editor.getExtension(depFromParent)).toBeUndefined();
    expect((editor.extensions.get("dep") as any)?.value).toBe("direct");
  });

  it("registers a dependency declared via blockNoteExtensions when it isn't registered otherwise", () => {
    const dep = createExtension(() => ({
      key: "lonely-dep",
      value: "dep",
    }));
    const parent = createExtension(() => ({
      key: "lonely-parent",
      blockNoteExtensions: [dep()],
    }));

    const editor = createMountedEditor([parent()]);

    expect(editor.getExtension(parent)).toBeDefined();
    expect(editor.getExtension(dep)?.value).toBe("dep");
  });
});

describe("ExtensionManager ordering", () => {
  it("runs semantic dependencies before their dependents", () => {
    const dependencyKey = new PluginKey("semantic-dependency");
    const dependentKey = new PluginKey("semantic-dependent");
    const dependency = createExtension(
      () => ({
        key: "semantic-dependency-runtime",
        prosemirrorPlugins: [new Plugin({ key: dependencyKey })],
      }),
      { name: "semantic-dependency", version: "1" },
    );
    const dependent = createExtension(
      () => ({
        key: "semantic-dependent-runtime",
        prosemirrorPlugins: [new Plugin({ key: dependentKey })],
      }),
      {
        name: "semantic-dependent",
        version: "1",
        dependencies: ["semantic-dependency"] as const,
      },
    );

    const editor = createMountedEditor([dependency(), dependent()]);

    expect(pluginIndex(editor, dependencyKey)).toBeLessThan(
      pluginIndex(editor, dependentKey),
    );
  });

  it("orders an extension before another it declares in runsBefore", () => {
    const firstKey = new PluginKey("rb-first");
    const secondKey = new PluginKey("rb-second");

    const first = createExtension(() => ({
      key: "rb-first",
      runsBefore: ["rb-second"],
      prosemirrorPlugins: [new Plugin({ key: firstKey })],
    }));
    const second = createExtension(() => ({
      key: "rb-second",
      prosemirrorPlugins: [new Plugin({ key: secondKey })],
    }));

    // Register in the "wrong" order to prove runsBefore — not array order —
    // determines precedence.
    const editor = createMountedEditor([second(), first()]);

    expect(pluginIndex(editor, firstKey)).toBeLessThan(
      pluginIndex(editor, secondKey),
    );
  });

  it("flattens sub-extensions and runs the parent after its blockNoteExtensions dependency", () => {
    const subKey = new PluginKey("sub-order");
    const parentKey = new PluginKey("parent-order");

    const sub = createExtension(() => ({
      key: "ordered-sub",
      prosemirrorPlugins: [new Plugin({ key: subKey })],
    }));
    const parent = createExtension(() => ({
      key: "ordered-parent",
      blockNoteExtensions: [sub()],
      prosemirrorPlugins: [new Plugin({ key: parentKey })],
    }));

    const editor = createMountedEditor([parent()]);

    // The sub-extension is flattened into the editor's extensions...
    expect(editor.getExtension(sub)).toBeDefined();
    expect(editor.getExtension(parent)).toBeDefined();

    // ...and because the parent declares the sub as a dependency, the sub runs
    // before the parent (even though the parent is registered first).
    expect(pluginIndex(editor, subKey)).toBeLessThan(
      pluginIndex(editor, parentKey),
    );
  });

  it("forces a blockNoteExtensions dependency before a parent that has a higher base priority", () => {
    // The parent declares `runsBefore` on an unrelated extension, which raises
    // its priority above the default. Without an explicit dependency edge, the
    // higher-priority parent would run before its sub. The dependency must
    // override that so the sub still runs first.
    const subKey = new PluginKey("forced-sub");
    const parentKey = new PluginKey("forced-parent");
    const otherKey = new PluginKey("forced-other");

    const other = createExtension(() => ({
      key: "forced-other",
      prosemirrorPlugins: [new Plugin({ key: otherKey })],
    }));
    const sub = createExtension(() => ({
      key: "forced-sub",
      prosemirrorPlugins: [new Plugin({ key: subKey })],
    }));
    const parent = createExtension(() => ({
      key: "forced-parent",
      runsBefore: ["forced-other"],
      blockNoteExtensions: [sub()],
      prosemirrorPlugins: [new Plugin({ key: parentKey })],
    }));

    const editor = createMountedEditor([parent(), other()]);

    // The parent runs before the unrelated extension (its declared runsBefore)...
    expect(pluginIndex(editor, parentKey)).toBeLessThan(
      pluginIndex(editor, otherKey),
    );
    // ...but its dependency still runs before it.
    expect(pluginIndex(editor, subKey)).toBeLessThan(
      pluginIndex(editor, parentKey),
    );
  });

  it("runs a shared sub-dependency before both extensions that declare it", () => {
    const subKey = new PluginKey("shared-sub");
    const parentAKey = new PluginKey("shared-parent-a");
    const parentBKey = new PluginKey("shared-parent-b");
    const otherKey = new PluginKey("shared-other");

    const other = createExtension(() => ({
      key: "shared-other",
      prosemirrorPlugins: [new Plugin({ key: otherKey })],
    }));
    // A single sub-extension instance declared by two different parents. It is
    // registered once (de-duplicated) and must run before both parents.
    const sharedSub = createExtension(() => ({
      key: "shared-sub",
      prosemirrorPlugins: [new Plugin({ key: subKey })],
    }));
    const parentA = createExtension(() => ({
      key: "shared-parent-a",
      blockNoteExtensions: [sharedSub()],
      prosemirrorPlugins: [new Plugin({ key: parentAKey })],
    }));
    // parentB declares the *already-registered* sub (so its registration is
    // de-duplicated) and has a higher base priority via runsBefore. The
    // dependency must still be recorded on the de-duplicated path so the sub
    // runs before parentB too.
    const parentB = createExtension(() => ({
      key: "shared-parent-b",
      runsBefore: ["shared-other"],
      blockNoteExtensions: [sharedSub()],
      prosemirrorPlugins: [new Plugin({ key: parentBKey })],
    }));

    const editor = createMountedEditor([parentA(), parentB(), other()]);

    // The sub is registered exactly once despite being declared twice.
    expect(
      [...editor.extensions.values()].filter((e) => e.key === "shared-sub")
        .length,
    ).toBe(1);

    // parentB's higher base priority puts it before the unrelated extension...
    expect(pluginIndex(editor, parentBKey)).toBeLessThan(
      pluginIndex(editor, otherKey),
    );
    // ...but the shared sub still runs before both parents.
    expect(pluginIndex(editor, subKey)).toBeLessThan(
      pluginIndex(editor, parentAKey),
    );
    expect(pluginIndex(editor, subKey)).toBeLessThan(
      pluginIndex(editor, parentBKey),
    );
  });

  it("mounts initial dependencies before their parent", () => {
    const mounted: string[] = [];
    const Dependency = createExtension(() => ({
      key: "initial-mount-dependency",
      mount() {
        mounted.push("dependency");
      },
    }));
    const Parent = createExtension(() => ({
      key: "initial-mount-parent",
      blockNoteExtensions: [Dependency()],
      mount() {
        mounted.push("parent");
      },
    }));

    const editor = createMountedEditor([Parent()]);

    expect(mounted).toEqual(["dependency", "parent"]);
    editor.destroy();
  });
});

describe("ExtensionManager replacement", () => {
  it("mounts runtime dependencies before their parent and then disposes the old extension", () => {
    const dependencyPluginKey = new PluginKey("mounted-dependency");
    const parentPluginKey = new PluginKey("mounted-parent");
    const events: string[] = [];
    const OldExtension = createExtension(() => ({
      key: "mounted-old",
      mount() {
        events.push("old:mount");
        return () => events.push("old:cleanup");
      },
      destroy() {
        events.push("old:destroy");
      },
    }));
    const Dependency = createExtension(() => ({
      key: "mounted-dependency",
      prosemirrorPlugins: [new Plugin({ key: dependencyPluginKey })],
      mount() {
        events.push("dependency:mount");
      },
    }));
    const Parent = createExtension(() => ({
      key: "mounted-parent",
      blockNoteExtensions: [Dependency()],
      prosemirrorPlugins: [new Plugin({ key: parentPluginKey })],
      mount() {
        events.push("parent:mount");
      },
    }));
    const editor = createMountedEditor([OldExtension()]);

    editor.replaceExtension(OldExtension, Parent());

    expect(events).toEqual([
      "old:mount",
      "dependency:mount",
      "parent:mount",
      "old:cleanup",
      "old:destroy",
    ]);
    expect(editor.getExtension(OldExtension)).toBeUndefined();
    expect(editor.getExtension(Dependency)).toBeDefined();
    expect(editor.getExtension(Parent)).toBeDefined();
    expect(pluginIndex(editor, dependencyPluginKey)).toBeLessThan(
      pluginIndex(editor, parentPluginKey),
    );
    editor.destroy();
  });

  it("reorders retained managed plugins when a new extension runs before them", () => {
    const retainedPluginKey = new PluginKey("retained-plugin");
    const newPluginKey = new PluginKey("new-before-retained-plugin");
    const RetainedExtension = createExtension(() => ({
      key: "retained-plugin",
      prosemirrorPlugins: [new Plugin({ key: retainedPluginKey })],
    }));
    const NewExtension = createExtension(() => ({
      key: "new-before-retained-plugin",
      runsBefore: ["retained-plugin"],
      prosemirrorPlugins: [new Plugin({ key: newPluginKey })],
    }));
    const editor = createMountedEditor([RetainedExtension()]);

    editor.registerExtension(NewExtension());

    expect(pluginIndex(editor, newPluginKey)).toBeLessThan(
      pluginIndex(editor, retainedPluginKey),
    );
    editor.destroy();
  });

  it("reorders managed plugin slots without moving unmanaged plugins", () => {
    const firstManaged = new Plugin({ key: new PluginKey("slot-first") });
    const unmanaged = new Plugin({ key: new PluginKey("slot-unmanaged") });
    const secondManaged = new Plugin({ key: new PluginKey("slot-second") });
    const surplusManaged = new Plugin({ key: new PluginKey("slot-surplus") });
    const editor = createMountedEditor([]);
    const manager = (editor as any)._extensionManager;

    expect(
      manager.replaceManagedPlugins(
        [firstManaged, unmanaged, secondManaged],
        new Set([firstManaged, secondManaged]),
        new Set(),
        [secondManaged, firstManaged],
      ),
    ).toEqual([secondManaged, unmanaged, firstManaged]);
    expect(
      manager.replaceManagedPlugins(
        [firstManaged, unmanaged, secondManaged],
        new Set([firstManaged, secondManaged]),
        new Set(),
        [secondManaged, firstManaged, surplusManaged],
      ),
    ).toEqual([secondManaged, unmanaged, firstManaged, surplusManaged]);
    expect(
      manager.replaceManagedPlugins([unmanaged], new Set(), new Set(), [
        surplusManaged,
      ]),
    ).toEqual([unmanaged, surplusManaged]);
    editor.destroy();
  });

  it("rolls back plugins and staged mounts when runtime mounting fails", () => {
    const oldPluginKey = new PluginKey("mount-rollback-old");
    const dependencyPluginKey = new PluginKey("mount-rollback-dependency");
    const parentPluginKey = new PluginKey("mount-rollback-parent");
    const mountFailure = new Error("runtime mount failed");
    const events: string[] = [];
    let oldSignal: AbortSignal | undefined;
    const OldExtension = createExtension(() => ({
      key: "mount-rollback-old",
      prosemirrorPlugins: [new Plugin({ key: oldPluginKey })],
      mount({ signal }) {
        oldSignal = signal;
        events.push("old:mount");
        return () => events.push("old:cleanup");
      },
      destroy() {
        events.push("old:destroy");
      },
    }));
    const Dependency = createExtension(() => ({
      key: "mount-rollback-dependency",
      prosemirrorPlugins: [new Plugin({ key: dependencyPluginKey })],
      mount() {
        events.push("dependency:mount");
        return () => events.push("dependency:cleanup");
      },
      destroy() {
        events.push("dependency:destroy");
      },
    }));
    const Parent = createExtension(() => ({
      key: "mount-rollback-parent",
      blockNoteExtensions: [Dependency()],
      prosemirrorPlugins: [new Plugin({ key: parentPluginKey })],
      mount() {
        events.push("parent:mount");
        throw mountFailure;
      },
      destroy() {
        events.push("parent:destroy");
      },
    }));
    const editor = createMountedEditor([OldExtension()]);

    expect(() => editor.replaceExtension(OldExtension, Parent())).toThrow(
      mountFailure,
    );

    expect(events).toEqual([
      "old:mount",
      "dependency:mount",
      "parent:mount",
      "parent:destroy",
      "dependency:cleanup",
      "dependency:destroy",
    ]);
    expect(oldSignal?.aborted).toBe(false);
    expect(editor.getExtension(OldExtension)).toBeDefined();
    expect(editor.getExtension(Dependency)).toBeUndefined();
    expect(editor.getExtension(Parent)).toBeUndefined();
    expect(pluginIndex(editor, oldPluginKey)).toBeGreaterThanOrEqual(0);
    expect(pluginIndex(editor, dependencyPluginKey)).toBe(-1);
    expect(pluginIndex(editor, parentPluginKey)).toBe(-1);

    editor.destroy();
    expect(events.slice(-2)).toEqual(["old:cleanup", "old:destroy"]);
  });

  it("keeps staged registry changes hidden from factories and mounts", () => {
    const observations: Array<{
      phase: "factory" | "mount";
      oldInExtensions: boolean;
      stagedInExtensions: boolean;
      oldFromGetter: boolean;
      stagedFromGetter: boolean;
      oldFromHas: boolean;
      stagedFromHas: boolean;
    }> = [];
    const OldExtension = createExtension(() => ({
      key: "visibility-old",
    }));
    const observe = (
      phase: "factory" | "mount",
      editor: BlockNoteEditor<any, any, any>,
    ) => {
      const manager = (editor as any)._extensionManager;
      observations.push({
        phase,
        oldInExtensions: editor.extensions.has("visibility-old"),
        stagedInExtensions: editor.extensions.has("visibility-staged"),
        oldFromGetter: editor.getExtension(OldExtension) !== undefined,
        stagedFromGetter:
          editor.getExtension("visibility-staged") !== undefined,
        oldFromHas: manager.hasExtension("visibility-old"),
        stagedFromHas: manager.hasExtension("visibility-staged"),
      });
    };
    const StagedExtension = createExtension(({ editor }) => ({
      key: "visibility-staged",
      mount() {
        observe("mount", editor);
      },
    }));
    const ObservingExtension = createExtension(({ editor }) => {
      observe("factory", editor);
      return { key: "visibility-observer" };
    });
    const editor = createMountedEditor([OldExtension()]);

    editor.replaceExtension(OldExtension, [
      StagedExtension(),
      ObservingExtension(),
    ]);

    expect(observations).toEqual([
      {
        phase: "factory",
        oldInExtensions: true,
        stagedInExtensions: false,
        oldFromGetter: true,
        stagedFromGetter: false,
        oldFromHas: true,
        stagedFromHas: false,
      },
      {
        phase: "mount",
        oldInExtensions: true,
        stagedInExtensions: false,
        oldFromGetter: true,
        stagedFromGetter: false,
        oldFromHas: true,
        stagedFromHas: false,
      },
    ]);
    expect(editor.getExtension(OldExtension)).toBeUndefined();
    expect(editor.getExtension(StagedExtension)).toBeDefined();
    expect(editor.getExtension(ObservingExtension)).toBeDefined();
    editor.destroy();
  });

  it("rejects disposed object reuse but accepts fresh factory instances", () => {
    const reused = {
      key: "disposed-object",
      destroy: vi.fn(),
    };
    const FreshExtension = createExtension(() => ({
      key: "fresh-after-disposal",
    }));
    const editor = createMountedEditor([]);

    editor.registerExtension(reused);
    editor.unregisterExtension(reused);

    expect(reused.destroy).toHaveBeenCalledOnce();
    expect(() => editor.registerExtension(reused)).toThrowError(
      'Cannot register disposed extension instance "disposed-object". Create a fresh extension instance instead.',
    );
    expect(editor.getExtension("disposed-object")).toBeUndefined();

    editor.registerExtension(FreshExtension());
    const first = editor.getExtension(FreshExtension);
    editor.unregisterExtension(FreshExtension);
    editor.registerExtension(FreshExtension());
    expect(editor.getExtension(FreshExtension)).toBeDefined();
    expect(editor.getExtension(FreshExtension)).not.toBe(first);
    editor.destroy();
  });

  it("rejects reentrant public changes before they mutate state", () => {
    const nestedPluginKey = new PluginKey("reentrant-nested");
    const NestedExtension = createExtension(() => ({
      key: "reentrant-nested",
      prosemirrorPlugins: [new Plugin({ key: nestedPluginKey })],
    }));
    let reentrantFailure: unknown;
    const OuterExtension = createExtension(({ editor }) => {
      try {
        editor.registerExtension(NestedExtension());
      } catch (error) {
        reentrantFailure = error;
      }
      return { key: "reentrant-outer" };
    });
    const editor = createMountedEditor([]);

    editor.registerExtension(OuterExtension());

    expect(reentrantFailure).toEqual(
      new Error("Cannot change extensions during another extension change."),
    );
    expect(editor.getExtension(OuterExtension)).toBeDefined();
    expect(editor.getExtension(NestedExtension)).toBeUndefined();
    expect(pluginIndex(editor, nestedPluginKey)).toBe(-1);
    editor.destroy();
  });

  it("allows private expansion of declared dependencies", () => {
    const Dependency = createExtension(() => ({
      key: "runtime-declared-dependency",
    }));
    const Parent = createExtension(() => ({
      key: "runtime-declared-parent",
      blockNoteExtensions: [Dependency()],
    }));
    const editor = createMountedEditor([]);

    editor.registerExtension(Parent());

    expect(editor.getExtension(Parent)).toBeDefined();
    expect(editor.getExtension(Dependency)).toBeDefined();
    editor.destroy();
  });

  it("rolls back registrations when a replacement factory fails", () => {
    const oldPluginKey = new PluginKey("atomic-old");
    const stagedPluginKey = new PluginKey("atomic-staged");
    const destroyOld = vi.fn();
    const destroyStaged = vi.fn();
    const OldExtension = createExtension(() => ({
      key: "atomic-old",
      prosemirrorPlugins: [new Plugin({ key: oldPluginKey })],
      destroy: destroyOld,
    }));
    const StagedExtension = createExtension(() => ({
      key: "atomic-staged",
      prosemirrorPlugins: [new Plugin({ key: stagedPluginKey })],
      destroy: destroyStaged,
    }));
    const FailingExtension = createExtension(() => {
      throw new Error("replacement failed");
    });
    const editor = createMountedEditor([OldExtension()]);

    expect(() =>
      editor.replaceExtension("atomic-old", [
        StagedExtension(),
        FailingExtension(),
      ]),
    ).toThrowError("replacement failed");

    expect(editor.getExtension(OldExtension)).toBeDefined();
    expect(editor.getExtension(StagedExtension)).toBeUndefined();
    expect(pluginIndex(editor, oldPluginKey)).toBeGreaterThanOrEqual(0);
    expect(pluginIndex(editor, stagedPluginKey)).toBe(-1);
    expect(destroyOld).not.toHaveBeenCalled();
    expect(destroyStaged).toHaveBeenCalledOnce();

    editor.destroy();
    expect(destroyOld).toHaveBeenCalledOnce();
  });

  it("reports a committed replacement when removed cleanup fails", () => {
    const oldPluginKey = new PluginKey("cleanup-old");
    const replacementPluginKey = new PluginKey("cleanup-replacement");
    const cleanupFailure = new Error("old cleanup failed");
    const OldExtension = createExtension(() => ({
      key: "cleanup-old",
      prosemirrorPlugins: [new Plugin({ key: oldPluginKey })],
      destroy() {
        throw cleanupFailure;
      },
    }));
    const ReplacementExtension = createExtension(() => ({
      key: "cleanup-replacement",
      prosemirrorPlugins: [new Plugin({ key: replacementPluginKey })],
    }));
    const editor = createMountedEditor([OldExtension()]);

    let failure: unknown;
    try {
      editor.replaceExtension("cleanup-old", ReplacementExtension());
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(BlockNoteError);
    expect(failure).toMatchObject({
      code: "extension-cleanup-failed",
      retryable: false,
      message:
        "Extension replacement committed, but cleanup of removed extensions failed.",
      cause: cleanupFailure,
    });
    expect(editor.getExtension(OldExtension)).toBeUndefined();
    expect(editor.getExtension(ReplacementExtension)).toBeDefined();
    expect(pluginIndex(editor, oldPluginKey)).toBe(-1);
    expect(pluginIndex(editor, replacementPluginKey)).toBeGreaterThanOrEqual(0);
    editor.destroy();
  });
});
