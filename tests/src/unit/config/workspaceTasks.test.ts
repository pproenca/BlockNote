import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

const blockNoteRoot = path.resolve(import.meta.dirname, "../../../..");
const buildPackages = [
  "core",
  "collaboration",
  "collaboration-server",
  "react",
  "server-util",
  "test-utils",
];

describe("workspace task ownership", () => {
  it.each(buildPackages)("lets package.json own %s#build", (packageName) => {
    const packageRoot = path.join(blockNoteRoot, "packages", packageName);
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const viteConfig = readFileSync(
      path.join(packageRoot, "vite.config.ts"),
      "utf8",
    );

    expect(manifest.scripts?.build).toBe("tsgo && vp build");
    expect(viteConfig).not.toMatch(/tasks:\s*\{\s*build:/s);
  });

  it("lets the tests package own its test task", () => {
    const packageRoot = path.join(blockNoteRoot, "tests");
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const viteConfig = readFileSync(
      path.join(packageRoot, "vite.config.ts"),
      "utf8",
    );

    expect(manifest.scripts?.test).toContain("vp test");
    expect(viteConfig).not.toContain('command: "vp test --run"');
  });
});
