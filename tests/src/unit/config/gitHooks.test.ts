import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

const blockNoteRoot = path.resolve(import.meta.dirname, "../../../..");
const repoRoot = path.resolve(blockNoteRoot, "../..");
const productManifest = path.join(repoRoot, "package.json");
const makerkitGenerator = path.join(
  repoRoot,
  "turbo/generators/templates/setup/generator.ts",
);

const readJson = (file: string) =>
  JSON.parse(readFileSync(file, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    packageManager?: string;
    scripts?: Record<string, string>;
  };

describe("Product Factory Git hook boundary", () => {
  it("prevents BlockNote prepare from replacing the repository hook", () => {
    const manifest = readJson(path.join(blockNoteRoot, "package.json"));

    expect(manifest.scripts?.prepare).toBe("VITE_GIT_HOOKS=0 vp config");
    if (existsSync(productManifest)) {
      expect(manifest.packageManager).toBe(
        readJson(productManifest).packageManager,
      );
    }
  });

  it("keeps collaboration core as a peer and development dependency", () => {
    const manifest = readJson(
      path.join(blockNoteRoot, "packages/collaboration/package.json"),
    );

    expect(manifest.dependencies?.["@blocknote/core"]).toBeUndefined();
    expect(manifest.devDependencies?.["@blocknote/core"]).toBe("workspace:^");
    expect(manifest.peerDependencies?.["@blocknote/core"]).toBe("^0.52.1");
  });

  it("keeps nested ProseMirror resolution compatible with Makerkit", () => {
    const workspace = readFileSync(
      path.join(blockNoteRoot, "pnpm-workspace.yaml"),
      "utf8",
    );

    expect(workspace).toContain('  "prosemirror-model": "1.25.9"');
    expect(workspace).toContain('  "prosemirror-view": "1.41.9"');
    expect(workspace).toContain('  "yjs": "13.6.31"');
  });

  it.runIf(existsSync(makerkitGenerator))(
    "preserves Makerkit's full-health pre-commit generator",
    () => {
      const generator = readFileSync(makerkitGenerator, "utf8");

      expect(generator).toContain("pnpm run lint:fix\\npnpm run typecheck\\n");
      expect(generator).toContain("pnpm run --filter scripts license");
    },
  );
});
