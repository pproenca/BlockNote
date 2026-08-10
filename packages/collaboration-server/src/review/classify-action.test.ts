import * as Y from "@y/y";
import { describe, expect, it } from "vite-plus/test";

import { classifyBlockNoteMutation } from "./classify-action.js";

describe("classifyBlockNoteMutation", () => {
  it("treats empty suggestion and review root initialization as an edit", () => {
    const before = new Y.Doc({ gc: false });
    const after = new Y.Doc({ gc: false });

    try {
      after.get("__blocknote_suggestions_v2_headers");
      after.get("__blocknote_suggestions_v2_ranges");
      after.get("__blocknote_suggestions_v2_dispositions");
      after.get("__blocknote_suggestions_v3_executions");
      after.get("__blocknote_suggestions_v2_receipts");
      after.get("content").insert(0, ["plain edit"]);

      expect(classifyBlockNoteMutation(before, after)).toBe("edit");
    } finally {
      before.destroy();
      after.destroy();
    }
  });
});
