import * as Y from "@y/y";
import { describe, expect, it } from "vite-plus/test";

import { blockNoteCommentAnchorCapture } from "../../../comments/external/BlockNoteCommentAnchorCapture.js";
import { blockNoteCommentAnchorInternals } from "../../../comments/internal.js";
import { createYCommentAnchorMapping } from "./YCommentAnchorMapping.js";

describe("YCommentAnchorMapping", () => {
  it("captures and maps without changing document bytes", () => {
    const doc = new Y.Doc({ gc: false });
    const content = doc.get("content");
    content.insert(0, "abcdef");
    const mapping = createYCommentAnchorMapping({ doc, type: content });
    const before = Y.encodeStateAsUpdate(doc);
    const capture = mapping.capture({ from: 1, to: 6 });
    const inspected = blockNoteCommentAnchorInternals.inspectCapture(capture);

    expect(Y.decodeRelativePosition(inspected.from).assoc).toBe(0);
    expect(Y.decodeRelativePosition(inspected.to).assoc).toBe(-1);
    expect(mapping.mapCapture(capture)).toEqual({
      status: "attached",
      range: { from: 1, to: 6 },
    });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(
      mapping.mapCapture(
        blockNoteCommentAnchorCapture.parse(
          blockNoteCommentAnchorCapture.serialize(capture),
        ),
      ),
    ).toEqual({ status: "attached", range: { from: 1, to: 6 } });
  });

  it("uses inward associations and reports deleted and foreign ranges safely", () => {
    const doc = new Y.Doc({ gc: false });
    const content = doc.get("content");
    content.insert(0, "abcdef");
    const mapping = createYCommentAnchorMapping({ doc, type: content });
    const capture = mapping.capture({ from: 1, to: 5 });

    content.insert(1, "L");
    content.insert(6, "R");
    expect(mapping.mapCapture(capture)).toEqual({
      status: "attached",
      range: { from: 2, to: 6 },
    });

    content.delete(2, 4);
    expect(mapping.mapCapture(capture)).toEqual({ status: "detached" });

    const foreign = new Y.Doc({ gc: false });
    const foreignType = foreign.get("content");
    foreignType.insert(0, "abcdef");
    expect(
      createYCommentAnchorMapping({
        doc: foreign,
        type: foreignType,
      }).mapCapture(capture),
    ).toEqual({ status: "unknown" });
  });
});
