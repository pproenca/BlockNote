/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { BlockNoteSchema } from "../blocks/BlockNoteSchema.js";
import { defineBlockNoteDocument } from "../document/BlockNoteDocument.js";
import {
  createExtension,
  type ExtensionOptions,
} from "./BlockNoteExtension.js";
import { BlockNoteEditor } from "./BlockNoteEditor.js";

describe("BlockNoteEditor lifecycle", () => {
  it("disposes mount and extension lifetimes exactly once", () => {
    const mount = vi.fn();
    const unmount = vi.fn();
    const destroy = vi.fn();
    const LifecycleExtension = createExtension(() => ({
      key: "lifecycle",
      mount() {
        mount();
        return unmount;
      },
      destroy,
    }));
    const editor = BlockNoteEditor.create({
      extensions: [LifecycleExtension()],
    });

    editor.mount(document.createElement("div"));
    editor.destroy();
    editor.destroy();

    expect(mount).toHaveBeenCalledOnce();
    expect(unmount).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("cleans up extensions after a later factory fails", () => {
    const destroy = vi.fn();
    const FirstExtension = createExtension(() => ({
      key: "first-initialized",
      destroy,
    }));
    const FailingExtension = createExtension(() => {
      throw new Error("factory failed");
    });

    expect(() =>
      BlockNoteEditor.create({
        extensions: [FirstExtension(), FailingExtension()],
      }),
    ).toThrowError("factory failed");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("cleans up a semantic instance rejected before registration", () => {
    const destroyFirst = vi.fn();
    const destroyRejected = vi.fn();
    const FirstExtension = createExtension(
      () => ({ key: "duplicate-runtime", destroy: destroyFirst }),
      { name: "first-semantic", version: "1" },
    );
    const RejectedExtension = createExtension(
      () => ({ key: "duplicate-runtime", destroy: destroyRejected }),
      { name: "second-semantic", version: "1" },
    );

    expect(() =>
      BlockNoteEditor.create({
        extensions: [FirstExtension(), RejectedExtension()],
      }),
    ).toThrowError(
      'Semantic BlockNote extension "second-semantic" uses duplicate runtime key "duplicate-runtime".',
    );
    expect(destroyFirst).toHaveBeenCalledOnce();
    expect(destroyRejected).toHaveBeenCalledOnce();
  });

  it("cleans up extensions when document initialization fails", () => {
    const destroy = vi.fn();
    const LifecycleExtension = createExtension(() => ({
      key: "invalid-document-cleanup",
      destroy,
    }));

    expect(() =>
      BlockNoteEditor.create({
        extensions: [LifecycleExtension()],
        initialContent: [],
      }),
    ).toThrowError("Error creating document from blocks");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("cleans up extensions when final ordering fails", () => {
    const destroyDependency = vi.fn();
    const destroyDependent = vi.fn();
    const Dependency = createExtension(
      () => ({ key: "ordering-dependency", destroy: destroyDependency }),
      { name: "ordering-dependency", version: "1" },
    );
    const Dependent = createExtension(
      () => ({
        key: "ordering-dependent",
        runsBefore: ["ordering-dependency"],
        destroy: destroyDependent,
      }),
      {
        name: "ordering-dependent",
        version: "1",
        dependencies: ["ordering-dependency"] as const,
      },
    );
    const definition = defineBlockNoteDocument({
      id: "cyclic-runtime-order",
      version: "1",
      schema: BlockNoteSchema.create(),
      extensions: [Dependency(), Dependent()],
    });

    expect(() => BlockNoteEditor.create({ document: definition })).toThrow();
    expect(destroyDependency).toHaveBeenCalledOnce();
    expect(destroyDependent).toHaveBeenCalledOnce();
  });

  it("cleans up the complete editor when a create listener fails", () => {
    const failure = new Error("create listener failed");
    const destroy = vi.fn();
    let partialEditor: BlockNoteEditor | undefined;
    const FailingCreateExtension = createExtension(({ editor }) => {
      partialEditor = editor;
      editor.on("create", () => {
        throw failure;
      });
      return {
        key: "failing-create-listener",
        destroy,
      };
    });

    let thrown: unknown;
    try {
      BlockNoteEditor.create({ extensions: [FailingCreateExtension()] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(destroy).toHaveBeenCalledOnce();
    expect(partialEditor?._tiptapEditor.isDestroyed).toBe(true);

    partialEditor?.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("cleans up a mount that synchronously unregisters itself", () => {
    const cleanup = vi.fn();
    const destroy = vi.fn();
    let mountedSignal: AbortSignal | undefined;
    let editor: BlockNoteEditor;
    const SelfRemovingExtension = createExtension(() => ({
      key: "self-removing",
      mount({ signal }) {
        mountedSignal = signal;
        editor.unregisterExtension("self-removing");
        return cleanup;
      },
      destroy,
    }));
    editor = BlockNoteEditor.create({
      extensions: [SelfRemovingExtension()],
    });

    editor.mount(document.createElement("div"));

    expect(mountedSignal?.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    editor.destroy();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe("semantic BlockNote extensions", () => {
  it("receives inferred runtime context through the native manager", () => {
    interface Context {
      readonly service: {
        readonly value: "ready";
      };
    }

    const ContextExtension = createExtension(
      ({ context }: ExtensionOptions<undefined, Context>) => ({
        key: "context-extension",
        value: context.service.value,
      }),
      { name: "context", version: "1" },
    );
    const definition = defineBlockNoteDocument({
      id: "context-document",
      version: "1",
      schema: BlockNoteSchema.create(),
      extensions: [ContextExtension()],
    });
    const editor = BlockNoteEditor.create({
      document: definition,
      context: { service: { value: "ready" } },
    });

    expect(editor.documentDefinition).toBe(definition);
    expect(editor.getExtension(ContextExtension)?.value).toBe("ready");
    editor.destroy();
  });

  it("rejects duplicate semantic names outside a document definition", () => {
    const FirstExtension = createExtension(() => ({ key: "first-semantic" }), {
      name: "duplicate",
      version: "1",
    });
    const SecondExtension = createExtension(
      () => ({ key: "second-semantic" }),
      { name: "duplicate", version: "1" },
    );

    expect(() =>
      BlockNoteEditor.create({
        extensions: [FirstExtension(), SecondExtension()],
      }),
    ).toThrowError('Duplicate BlockNote extension "duplicate".');
  });
});
