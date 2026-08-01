import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDownstreamConsumer,
  downstreamPackages,
  getPackedArtifactIntegrity,
  parseDownstreamReleaseTag,
  prepareDownstreamManifests,
  validateDownstreamManifests,
  validatePackedArtifacts,
} from "./downstream-release.mjs";

const release = parseDownstreamReleaseTag("pf-v0.52.1.7");

async function createPackageTree() {
  const root = await mkdtemp(path.join(os.tmpdir(), "blocknote-release-"));

  for (const packageDefinition of downstreamPackages) {
    const directory = path.join(root, packageDefinition.directory);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify(
        {
          name: packageDefinition.upstreamName,
          version: release.upstreamVersion,
          private: false,
          repository: {
            type: "git",
            url: "git+https://github.com/TypeCellOS/BlockNote.git",
          },
          peerDependencies:
            packageDefinition.upstreamName === "@blocknote/react"
              ? { "@blocknote/core": "^0.52.1" }
              : undefined,
        },
        null,
        2,
      )}\n`,
    );
  }

  return root;
}

await test("parses a strict downstream release tag", () => {
  assert.deepEqual(release, {
    upstreamVersion: "0.52.1",
    downstreamRevision: "7",
    downstreamVersion: "0.52.1-pf.7",
  });
});

await test("rejects ambiguous or unsafe release tags", () => {
  for (const value of [
    "v0.52.1.7",
    "pf-v0.52.1",
    "pf-v0.52.1.07",
    "pf-v0.52.1.7-next",
    "pf-v0.52.1.7;echo unsafe",
  ]) {
    assert.throws(() => parseDownstreamReleaseTag(value));
  }
});

await test("prepares one exact downstream manifest set", async () => {
  const root = await createPackageTree();

  await prepareDownstreamManifests({ root, release });
  await validateDownstreamManifests({ root, release, prepared: true });

  const react = JSON.parse(
    await readFile(path.join(root, "packages/react/package.json"), "utf8"),
  );

  assert.equal(react.name, "@pproenca/blocknote-react");
  assert.equal(react.version, "0.52.1-pf.7");
  assert.equal(
    react.peerDependencies["@blocknote/core"],
    "npm:@pproenca/blocknote-core@0.52.1-pf.7",
  );
});

await test("rejects a mixed source version before writing", async () => {
  const root = await createPackageTree();
  const file = path.join(root, "packages/react/package.json");
  const react = JSON.parse(await readFile(file, "utf8"));
  react.version = "0.52.0";
  await writeFile(file, `${JSON.stringify(react, null, 2)}\n`);

  await assert.rejects(prepareDownstreamManifests({ root, release }));

  const core = JSON.parse(
    await readFile(path.join(root, "packages/core/package.json"), "utf8"),
  );
  assert.equal(core.name, "@blocknote/core");
});

await test("requires exactly six expected tarballs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blocknote-artifacts-"));

  for (const packageDefinition of downstreamPackages) {
    const name = `${packageDefinition.upstreamName
      .slice(1)
      .replace("/", "-")}-${release.upstreamVersion}.tgz`;
    await writeFile(path.join(root, name), "test");
  }

  await validatePackedArtifacts({
    artifactDirectory: root,
    release,
    prepared: false,
  });

  await writeFile(path.join(root, "unexpected.tgz"), "test");
  await assert.rejects(
    validatePackedArtifacts({
      artifactDirectory: root,
      release,
      prepared: false,
    }),
  );
});

await test("computes registry-compatible artifact integrity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blocknote-integrity-"));
  const file = path.join(root, "package.tgz");
  await writeFile(file, "blocknote");

  assert.equal(
    await getPackedArtifactIntegrity(file),
    "sha512-EoxPQvCnCVJLtPTEUzi9LaOzt3M9JXtm1b+P0oijnMYwaQHm43eymAzaZNyCQ8csYNEBryxaopG+duqfLlrDTQ==",
  );
});

await test("creates one hermetic Product-style downstream consumer", async () => {
  const root = await createPackageTree();
  const artifactDirectory = await mkdtemp(
    path.join(os.tmpdir(), "blocknote-downstream-artifacts-"),
  );
  const consumerDirectory = await mkdtemp(
    path.join(os.tmpdir(), "blocknote-downstream-consumer-"),
  );

  await prepareDownstreamManifests({ root, release });

  for (const packageDefinition of downstreamPackages) {
    const name = `${packageDefinition.downstreamName
      .slice(1)
      .replace("/", "-")}-${release.downstreamVersion}.tgz`;
    await writeFile(path.join(artifactDirectory, name), "test");
  }

  await createDownstreamConsumer({
    root,
    artifactDirectory,
    consumerDirectory,
    release,
  });

  const manifest = JSON.parse(
    await readFile(path.join(consumerDirectory, "package.json"), "utf8"),
  );

  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    "@blocknote/collaboration",
    "@blocknote/collaboration-server",
    "@blocknote/core",
    "@blocknote/react",
    "@blocknote/server-util",
    "@blocknote/test-utils",
  ]);
  assert.match(
    manifest.dependencies["@blocknote/core"],
    /pproenca-blocknote-core-0\.52\.1-pf\.7\.tgz$/,
  );
  assert.equal(
    manifest.pnpm.overrides["@blocknote/core"],
    manifest.dependencies["@blocknote/core"],
  );
});
