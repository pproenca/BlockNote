/** @vitest-environment node */
import {
  BlockNoteSchema,
  defineBlockNoteDocument,
  type BlockNoteRevision,
} from "@blocknote/core";
import * as Y from "@y/y";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { createBlockNoteProjector } from "./project.js";

const document = defineBlockNoteDocument({
  id: "projector-test",
  version: "1",
  schema: BlockNoteSchema.create(),
});

function paragraph(doc: Y.Doc, text: string) {
  const root = doc.get("prosemirror");
  const group = new Y.Type("blockGroup");
  const container = new Y.Type("blockContainer");
  const content = new Y.Type("paragraph");
  container.setAttr("id", "root");
  content.insert(0, text);
  container.insert(0, [content]);
  group.insert(0, [container]);
  root.insert(0, [group]);
}

describe("createBlockNoteProjector", () => {
  it("projects an opaque collaboration runtime with document types", () => {
    const project = createBlockNoteProjector(document);
    const revision = Object.freeze({ sequence: 3, token: "head" });
    const doc = new Y.Doc({ gc: false });
    try {
      paragraph(doc, "hello");

      const projected = project({ doc, revision });

      expect(projected).toMatchObject({
        blocks: [{ id: "root", type: "paragraph" }],
        markdown: "hello",
        revision,
      });
      expectTypeOf<Parameters<typeof project>[0]>().toEqualTypeOf<{
        readonly doc: unknown;
        readonly revision: BlockNoteRevision;
      }>();
      expectTypeOf(projected.blocks).toEqualTypeOf<
        readonly (typeof document.schema.Block)[]
      >();
    } finally {
      doc.destroy();
    }
  });
});
