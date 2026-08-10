/** @vitest-environment node */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

describe("server-util collaboration entrypoint isolation", () => {
  it.each(["collaboration", "node"] as const)(
    "imports %s without side effects",
    (entryName) => {
      const entry = fileURLToPath(
        new URL(`../../dist/${entryName}.js`, import.meta.url),
      );
      const script = `
        import { registerHooks } from "node:module";
        import { pathToFileURL } from "node:url";
        const seen = [];
        registerHooks({ resolve(specifier, context, nextResolve) {
          const result = nextResolve(specifier, context);
          seen.push(result.url);
          return result;
        }});
        const before = process.eventNames().map(String).sort();
        await import(pathToFileURL(process.argv[1]).href);
        const after = process.eventNames().map(String).sort();
        process.stdout.write(JSON.stringify({ before, after, seen }));
      `;
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script, entry],
        { encoding: "utf8" },
      );
      expect(child.stderr).toBe("");
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout) as {
        readonly before: readonly string[];
        readonly after: readonly string[];
        readonly seen: readonly string[];
      };
      expect(result.after).toEqual(result.before);
      expect(
        result.seen.filter((value) =>
          /(?:jsdom|react-dom|BlockNoteView|\.css(?:$|\?))/.test(value),
        ),
      ).toEqual([]);
    },
  );
});
