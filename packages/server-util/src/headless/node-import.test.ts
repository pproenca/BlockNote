/** @vitest-environment node */
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vite-plus/test";

describe("headless Node import", () => {
  it("loads the packaged entry without browser-only modules or globals", () => {
    const entry = fileURLToPath(
      new URL("../../dist/headless.js", import.meta.url),
    );
    const script = `
      import { registerHooks } from "node:module";
      import { pathToFileURL } from "node:url";
      const seen = [];
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const result = nextResolve(specifier, context);
          seen.push(result.url);
          return result;
        },
      });
      const loaded = await import(pathToFileURL(process.argv[1]).href);
      process.stdout.write(JSON.stringify({
        exportsService: typeof loaded.createBlockNoteDocumentService === "function",
        browserGlobals: ["window", "document", "HTMLElement"].filter(
          (name) => name in globalThis,
        ),
        seen,
      }));
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, entry],
      {
        encoding: "utf8",
      },
    );

    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout) as {
      readonly exportsService: boolean;
      readonly browserGlobals: readonly string[];
      readonly seen: readonly string[];
    };
    expect(result.exportsService).toBe(true);
    expect(result.browserGlobals).toEqual([]);
    expect(result.seen).not.toEqual([]);
    expect(
      result.seen.filter((value) =>
        /(?:jsdom|react-dom|ServerBlockNoteEditor|\.css(?:$|\?))/.test(value),
      ),
    ).toEqual([]);
    expect(
      result.seen.every(
        (value) => value.startsWith("file:") || value.startsWith("node:"),
      ),
    ).toBe(true);
    expect(pathToFileURL(entry).protocol).toBe("file:");
  });
});
