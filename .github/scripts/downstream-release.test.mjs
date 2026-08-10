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
  validateNpmProvenance,
  validatePackedArtifacts,
  validateReleaseEntrypoints,
} from "./downstream-release.mjs";

const release = parseDownstreamReleaseTag("pf-v0.52.1.7");

async function createPackageTree() {
  const root = await mkdtemp(path.join(os.tmpdir(), "blocknote-release-"));

  for (const packageDefinition of downstreamPackages) {
    const directory = path.join(root, packageDefinition.directory);
    await mkdir(path.join(directory, "src"), { recursive: true });
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
          dependencies:
            packageDefinition.upstreamName === "@blocknote/core"
              ? { "@y/y": "^14.0.0-0" }
              : undefined,
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(directory, "src/index.ts"),
      `export const packageName = ${JSON.stringify(packageDefinition.upstreamName)};\n`,
    );
  }

  return root;
}

await test("parses a strict downstream release tag", () => {
  assert.deepEqual(release, {
    upstreamVersion: "0.52.1",
    downstreamRevision: "7",
    downstreamVersion: "0.52.1-pf.7",
    distributionTag: "pf-0-52-1-7",
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

await test("validates the release candidate inside the privileged job", async () => {
  const workflow = await readFile(
    new URL("../workflows/downstream-release.yml", import.meta.url),
    "utf8",
  );
  const stepStart = workflow.indexOf(
    "      - name: Publish or resume exact package set",
  );
  const stepEnd = workflow.indexOf("\n  verify-published:", stepStart);
  assert.notEqual(stepStart, -1);
  assert.notEqual(stepEnd, -1);

  const publishStep = workflow.slice(stepStart, stepEnd);
  const registryStart = publishStep.indexOf("          npm_view() {");
  assert.notEqual(registryStart, -1);

  const validation = publishStep.slice(0, registryStart);
  for (const { downstreamName } of downstreamPackages) {
    assert.equal(
      validation.split(JSON.stringify(downstreamName)).length - 1,
      1,
      `${downstreamName} must appear once in the privileged allowlist`,
    );
  }
  assert.match(validation, /const match = \/\^pf-v/);
  assert.match(validation, /plan\.distributionTag !== distributionTag/);
  assert.match(validation, /record\.version !== version/);
  assert.match(validation, /record\.tarball !== tarball/);
  assert.match(validation, /record\.integrity !== integrity/);
  assert.match(validation, /manifest\.name !== name/);
  assert.match(validation, /manifest\.version !== version/);
  assert.match(validation, /Object\.hasOwn\(manifest, "publishConfig"\)/);
  assert.doesNotMatch(validation, /downstream-release\.mjs/);
  assert.match(publishStep, /done < "\$validated_release\/packages\.tsv"/);
  assert.match(
    publishStep,
    /npm publish "\$tarball_path" --registry=https:\/\/registry\.npmjs\.org /,
  );
  const nativeYPreflight = publishStep.indexOf(
    'npm view "@pproenca/y@14.0.0-rc.23-y001.0" version',
  );
  assert.ok(nativeYPreflight > registryStart);
  assert.ok(nativeYPreflight < publishStep.indexOf("while IFS="));
  assert.doesNotMatch(
    publishStep,
    /require\('\.\/artifacts\/release\.json'\)\.distributionTag/,
  );
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
  const core = JSON.parse(
    await readFile(path.join(root, "packages/core/package.json"), "utf8"),
  );
  assert.equal(
    core.dependencies["@y/y"],
    "npm:@pproenca/y@14.0.0-rc.23-y001.0",
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

await test("rejects manifest-defined publish behavior", async () => {
  const root = await createPackageTree();
  const file = path.join(root, "packages/core/package.json");
  const core = JSON.parse(await readFile(file, "utf8"));
  core.publishConfig = {};
  await writeFile(file, `${JSON.stringify(core, null, 2)}\n`);

  await assert.rejects(
    validateDownstreamManifests({ root, release, prepared: false }),
    /@blocknote\/core must not define publishConfig/,
  );
});

await test("requires a complete public import contract for all six packages", async () => {
  await validateReleaseEntrypoints({ packages: downstreamPackages });

  const broken = downstreamPackages.map((item, index) =>
    index === 2 ? { ...item, publicImports: [] } : item,
  );
  await assert.rejects(
    validateReleaseEntrypoints({ packages: broken }),
    /has no public import contract/,
  );
});

await test("rejects duplicate specifiers and blank export names", async () => {
  const [core, ...rest] = downstreamPackages;
  await assert.rejects(
    validateReleaseEntrypoints({
      packages: [
        {
          ...core,
          publicImports: [
            { specifier: "@blocknote/core", exports: ["BlockNoteSchema"] },
            { specifier: "@blocknote/core", exports: [""] },
          ],
        },
        ...rest,
      ],
    }),
    /invalid public import contract/,
  );
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

await test("requires provenance from the release workflow and commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blocknote-provenance-"));
  const auditFile = path.join(root, "audit.json");
  const commit = "a".repeat(40);
  const statement = {
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/pproenca/BlockNote",
            path: ".github/workflows/downstream-release.yml",
            ref: "refs/tags/pf-v0.52.1.7",
          },
        },
        resolvedDependencies: [{ digest: { gitCommit: commit } }],
      },
    },
  };
  await writeFile(
    auditFile,
    JSON.stringify({
      verified: [
        {
          name: "@pproenca/blocknote-core",
          version: release.downstreamVersion,
          attestationBundles: [
            {
              predicateType: "https://slsa.dev/provenance/v1",
              bundle: {
                dsseEnvelope: {
                  payload: Buffer.from(JSON.stringify(statement)).toString(
                    "base64",
                  ),
                },
              },
            },
          ],
        },
      ],
    }),
  );

  const policy = {
    auditFile,
    packageName: "@pproenca/blocknote-core",
    version: release.downstreamVersion,
    repository: "https://github.com/pproenca/BlockNote",
    workflowPath: ".github/workflows/downstream-release.yml",
    workflowRef: "refs/tags/pf-v0.52.1.7",
    commit,
  };
  await validateNpmProvenance(policy);
  await assert.rejects(
    validateNpmProvenance({ ...policy, commit: "b".repeat(40) }),
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
  const workspace = await readFile(
    path.join(consumerDirectory, "pnpm-workspace.yaml"),
    "utf8",
  );

  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    "@blocknote/collaboration",
    "@blocknote/collaboration-server",
    "@blocknote/core",
    "@blocknote/react",
    "@blocknote/server-util",
    "@blocknote/test-utils",
    "@y/y",
  ]);
  assert.equal(
    manifest.dependencies["@blocknote/core"],
    "npm:@pproenca/blocknote-core@0.52.1-pf.7",
  );
  assert.match(
    workspace,
    /"@blocknote\/core": "file:.*pproenca-blocknote-core-0\.52\.1-pf\.7\.tgz"/,
  );
  assert.equal(
    manifest.dependencies["@y/y"],
    "npm:@pproenca/y@14.0.0-rc.23-y001.0",
  );
  assert.match(
    workspace,
    /"@y\/y": "npm:@pproenca\/y@14\.0\.0-rc\.23-y001\.0"/,
  );

  const typeContract = await readFile(
    path.join(consumerDirectory, "contract.mts"),
    "utf8",
  );
  assert.match(typeContract, /from "@blocknote\/core\/persistence"/);
  assert.match(typeContract, /blockNotePersistence/);
  assert.match(typeContract, /from "@blocknote\/server-util\/node"/);
  assert.match(typeContract, /serveBlockNoteCollaboration/);
});
