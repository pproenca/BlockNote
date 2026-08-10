/** @vitest-environment node */
import {
  BlockNoteSchema,
  blockNoteDocumentBinding,
  blockNotePersistence,
  defineBlockNoteDocument,
  isBlockNoteError,
  type AnyBlockNoteDocumentDefinition,
  type BlockNoteDocumentStore,
  type BlockNoteRevision,
  type BlockNoteStoredDocument,
} from "@blocknote/core";
import { blockNotePersistenceInternals } from "@blocknote/core/persistence/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Y from "@y/y";

import { createBlockNoteDocumentService } from "./document-service.js";
import { createBlockNoteProjector } from "./project.js";
import { encodeHeadlessFrame } from "./reconstruct.js";

function createMemoryStore() {
  const rows = new Map<string, BlockNoteStoredDocument>();
  const store: BlockNoteDocumentStore<string> = {
    async load(key) {
      return rows.get(key) ?? null;
    },
    async initialize(input) {
      const existing = rows.get(input.key);
      if (existing) {
        return { status: "conflict", actual: existing.checkpointRevision };
      }
      rows.set(
        input.key,
        Object.freeze({
          binding: blockNoteDocumentBinding.fromBytes(
            blockNoteDocumentBinding.toBytes(input.binding),
          ),
          checkpoint: blockNotePersistence.checkpointFromBytes(
            blockNotePersistence.checkpointToBytes(input.checkpoint),
          ),
          checkpointRevision: Object.freeze({ ...input.revision }),
          changes: Object.freeze([]),
        }),
      );
      return { status: "committed", revision: input.revision };
    },
    async append(input) {
      const existing = rows.get(input.key);
      return existing
        ? { status: "conflict", actual: existing.checkpointRevision }
        : { status: "conflict", actual: input.expected };
    },
    async compact(input) {
      const existing = rows.get(input.key);
      return existing
        ? { status: "conflict", actual: existing.checkpointRevision }
        : { status: "conflict", actual: input.expected };
    },
  };
  return { rows, store };
}

const document = defineBlockNoteDocument({
  id: "headless-test",
  version: "1",
  schema: BlockNoteSchema.create(),
});

function checkpointFor(
  definition: AnyBlockNoteDocumentDefinition,
  revision: BlockNoteRevision,
  configure?: (doc: Y.Doc) => void,
) {
  const doc = new Y.Doc({ gc: false });
  try {
    configure?.(doc);
    return blockNotePersistenceInternals.checkpointFromPayload(
      encodeHeadlessFrame({
        kind: "checkpoint",
        document: definition,
        revision,
        update: Y.encodeStateAsUpdate(doc),
      }),
    );
  } finally {
    doc.destroy();
  }
}

function paragraph(doc: Y.Doc, text: string, nested = false) {
  const root = doc.get("prosemirror");
  const group = new Y.Type("blockGroup");
  const container = new Y.Type("blockContainer");
  const content = new Y.Type("paragraph");
  container.setAttr("id", nested ? "child" : "root");
  content.insert(0, text);
  container.insert(0, [content]);
  if (nested) {
    const children = new Y.Type("blockGroup");
    const child = new Y.Type("blockContainer");
    const childContent = new Y.Type("paragraph");
    child.setAttr("id", "nested");
    childContent.insert(0, "nested");
    child.insert(0, [childContent]);
    children.insert(0, [child]);
    container.insert(1, [children]);
  }
  group.insert(0, [container]);
  root.insert(0, [group]);
}

async function caught(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to fail.");
}

describe("createBlockNoteDocumentService", () => {
  it("projects the same stored head deterministically and disposes both reconstructions", async () => {
    const memory = createMemoryStore();
    const service = createBlockNoteDocumentService({
      document,
      store: memory.store,
    });
    await service.initialize("doc");
    const destroy = vi.spyOn(Y.Doc.prototype, "destroy");

    expect(await service.project("doc")).toEqual(await service.project("doc"));
    expect(destroy).toHaveBeenCalledTimes(2);
    destroy.mockRestore();
  });

  it("gives a logical clone a new binding even when checkpoint bytes match", async () => {
    const memory = createMemoryStore();
    const service = createBlockNoteDocumentService({
      document,
      store: memory.store,
    });
    await service.initialize("source");
    await service.initialize("clone");
    const source = memory.rows.get("source")!;
    const clone = memory.rows.get("clone")!;

    expect(blockNotePersistence.checkpointToBytes(clone.checkpoint)).toEqual(
      blockNotePersistence.checkpointToBytes(source.checkpoint),
    );
    expect(blockNoteDocumentBinding.toBytes(clone.binding)).not.toEqual(
      blockNoteDocumentBinding.toBytes(source.binding),
    );
  });

  it("preserves the winning binding after an initialize conflict", async () => {
    const memory = createMemoryStore();
    const first = createBlockNoteDocumentService({
      document,
      store: memory.store,
    });
    const second = createBlockNoteDocumentService({
      document,
      store: memory.store,
    });
    const revision = await first.initialize("doc");
    const binding = blockNoteDocumentBinding.toBytes(
      memory.rows.get("doc")!.binding,
    );

    expect(await second.initialize("doc")).toEqual(revision);
    expect(
      blockNoteDocumentBinding.toBytes(memory.rows.get("doc")!.binding),
    ).toEqual(binding);
  });

  it("projects native blocks and Markdown without a DOM", async () => {
    const memory = createMemoryStore();
    const service = createBlockNoteDocumentService({
      document,
      store: memory.store,
    });
    const revision = await service.initialize("doc");
    const stored = memory.rows.get("doc")!;
    memory.rows.set("doc", {
      ...stored,
      checkpoint: checkpointFor(document, revision, (doc) =>
        paragraph(doc, "hello"),
      ),
    });

    const native = new Y.Doc({ gc: false });
    try {
      paragraph(native, "hello");
      const direct = createBlockNoteProjector(document)({
        doc: native,
        revision,
      });

      await expect(service.project("doc")).resolves.toEqual(direct);
      expect(direct).toMatchObject({
        blocks: [{ id: "root", type: "paragraph" }],
        markdown: "hello",
        revision,
      });
    } finally {
      native.destroy();
    }
  });

  it("rejects malformed frames, revision mismatch, and discontinuous changes", async () => {
    const memory = createMemoryStore();
    const service = createBlockNoteDocumentService({
      document,
      store: memory.store,
    });
    await service.initialize("doc");
    const stored = memory.rows.get("doc")!;

    memory.rows.set("doc", {
      ...stored,
      checkpoint: blockNotePersistenceInternals.checkpointFromPayload(
        Uint8Array.of(1),
      ),
    });
    expect(await caught(() => service.project("doc"))).toMatchObject({
      code: "invalid-document",
    });

    memory.rows.set("doc", {
      ...stored,
      checkpointRevision: { sequence: 1, token: "mismatch" },
    });
    expect(await caught(() => service.project("doc"))).toMatchObject({
      code: "invalid-document",
    });

    const next = { sequence: 2, token: "gap" } as const;
    memory.rows.set("doc", {
      ...stored,
      changes: [
        {
          revision: next,
          change: blockNotePersistenceInternals.changeFromPayload(
            encodeHeadlessFrame({
              kind: "change",
              document,
              revision: next,
              update: Y.encodeStateAsUpdate(new Y.Doc()),
            }),
          ),
        },
      ],
    });
    expect(await caught(() => service.project("doc"))).toMatchObject({
      code: "invalid-document",
    });
  });

  it("enforces byte and semantic projection limits", async () => {
    const byteLimited = defineBlockNoteDocument({
      id: "byte-limited",
      version: "1",
      schema: BlockNoteSchema.create(),
      limits: { documentBytes: 1 },
    });
    const byteMemory = createMemoryStore();
    const byteService = createBlockNoteDocumentService({
      document: byteLimited,
      store: byteMemory.store,
    });
    await byteService.initialize("doc");
    expect(await caught(() => byteService.project("doc"))).toMatchObject({
      code: "document-too-large",
    });

    const semantic = defineBlockNoteDocument({
      id: "semantic-limited",
      version: "1",
      schema: BlockNoteSchema.create(),
      limits: { blocks: 1, depth: 1, textCharacters: 4 },
    });
    const semanticMemory = createMemoryStore();
    const semanticService = createBlockNoteDocumentService({
      document: semantic,
      store: semanticMemory.store,
    });
    const revision = await semanticService.initialize("doc");
    const stored = semanticMemory.rows.get("doc")!;
    semanticMemory.rows.set("doc", {
      ...stored,
      checkpoint: checkpointFor(semantic, revision, (doc) =>
        paragraph(doc, "hello", true),
      ),
    });
    expect(await caught(() => semanticService.project("doc"))).toMatchObject({
      code: "document-too-large",
    });
  });

  it("uses stable cleanup failures and preserves a primary error", async () => {
    const failingDocument = defineBlockNoteDocument({
      id: "cleanup",
      version: "1",
      schema: BlockNoteSchema.create(),
      limits: { textCharacters: 0 },
    });
    const memory = createMemoryStore();
    const service = createBlockNoteDocumentService({
      document: failingDocument,
      store: memory.store,
    });
    const revision = await service.initialize("doc");
    const stored = memory.rows.get("doc")!;
    memory.rows.set("doc", {
      ...stored,
      checkpoint: checkpointFor(failingDocument, revision, (doc) =>
        paragraph(doc, "failure"),
      ),
    });
    const destroy = vi
      .spyOn(Y.Doc.prototype, "destroy")
      .mockImplementation(() => {
        throw new Error("cleanup");
      });
    try {
      const failure = await caught(() => service.project("doc"));
      expect(isBlockNoteError(failure)).toBe(true);
      expect(failure).toMatchObject({ code: "document-too-large" });
      expect((failure as Error).cause).toMatchObject({
        code: "extension-cleanup-failed",
      });
    } finally {
      destroy.mockRestore();
    }

    const cleanMemory = createMemoryStore();
    const cleanService = createBlockNoteDocumentService({
      document,
      store: cleanMemory.store,
    });
    await cleanService.initialize("doc");
    const cleanupOnly = vi
      .spyOn(Y.Doc.prototype, "destroy")
      .mockImplementation(() => {
        throw new Error("cleanup");
      });
    try {
      expect(await caught(() => cleanService.project("doc"))).toMatchObject({
        code: "extension-cleanup-failed",
      });
    } finally {
      cleanupOnly.mockRestore();
    }
  });
});
