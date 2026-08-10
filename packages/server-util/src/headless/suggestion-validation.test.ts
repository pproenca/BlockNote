/** @vitest-environment node */
import * as Y from "@y/y";
import { describe, expect, it } from "vite-plus/test";

import { bindBlockNoteSuggestionActor } from "./suggestion-validation.js";

describe("bindBlockNoteSuggestionActor", () => {
  it("replaces a client-supplied author with the authenticated actor", () => {
    const before = new Y.Doc();
    const doc = new Y.Doc();
    const headers = doc.get("__blocknote_suggestions_v2_headers");
    headers.setAttr("suggestion", {
      version: 2,
      id: "suggestion",
      authorId: "spoofed",
      creatorId: "creator",
    });
    bindBlockNoteSuggestionActor({ before, doc, actorId: "authenticated" });
    expect(headers.getAttr("suggestion")).toMatchObject({
      authorId: "authenticated",
    });
    before.destroy();
    doc.destroy();
  });

  it("does not rewrite historical suggestion authors", () => {
    const before = new Y.Doc();
    before.get("__blocknote_suggestions_v2_headers").setAttr("old", {
      version: 2,
      id: "old",
      authorId: "alice",
      creatorId: "alice",
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(before));
    doc.get("__blocknote_suggestions_v2_headers").setAttr("new", {
      version: 2,
      id: "new",
      authorId: "spoofed",
      creatorId: "client",
    });
    bindBlockNoteSuggestionActor({ before, doc, actorId: "bob" });
    expect(
      doc.get("__blocknote_suggestions_v2_headers").getAttr("old"),
    ).toMatchObject({
      authorId: "alice",
    });
    expect(
      doc.get("__blocknote_suggestions_v2_headers").getAttr("new"),
    ).toMatchObject({
      authorId: "bob",
    });
    before.destroy();
    doc.destroy();
  });
});
