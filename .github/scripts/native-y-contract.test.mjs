import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const pinPath = path.join(root, ".github/native-y.json");
const actionPath = path.join(
  root,
  ".github/actions/checkout-native-y/action.yml",
);
const installWorkflows = [
  ".github/workflows/build.yml",
  ".github/workflows/fresh-install-tests.yml",
  ".github/workflows/publish.yaml",
  ".github/workflows/downstream-release.yml",
];

test("pins the exact native Y mirror artifact", async () => {
  const pin = JSON.parse(await readFile(pinPath, "utf8"));
  assert.deepEqual(Object.keys(pin).sort(), [
    "branch",
    "commit",
    "packageName",
    "repository",
    "schemaVersion",
    "version",
  ]);
  assert.equal(pin.schemaVersion, 1);
  assert.equal(pin.repository, "https://github.com/pproenca/yjs.git");
  assert.equal(pin.branch, "master");
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.equal(pin.packageName, "@pproenca/y");
  assert.equal(pin.version, "14.0.0-rc.23-y001.0");
});

test("checks out and validates an empty sibling target", async () => {
  const action = await readFile(actionPath, "utf8");
  assert.match(action, /test ! -e "\$target"/);
  assert.match(action, /git -C "\$target" fetch --depth=1 origin "\$revision"/);
  assert.match(
    action,
    /test "\$\(git -C "\$target" rev-parse HEAD\)" = "\$revision"/,
  );
  assert.match(action, /actual_name/);
  assert.match(action, /actual_version/);
  assert.match(action, /test "\$actual_name" = "\$expected_name"/);
  assert.match(action, /test "\$actual_version" = "\$expected_version"/);
});

test("fetches native Y before every standalone install", async () => {
  for (const workflow of installWorkflows) {
    const source = await readFile(path.join(root, workflow), "utf8");
    const lines = source.split("\n");
    const installs = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*(?:-\s*)?run: vp install(?:\s|$)/.test(line));
    assert.ok(installs.length > 0, `${workflow} must contain an install`);
    for (const install of installs) {
      const checkout = lines.findLastIndex(
        (line, index) =>
          index < install.index && /uses: actions\/checkout@/.test(line),
      );
      const nativeY = lines.findLastIndex(
        (line, index) =>
          index < install.index &&
          /uses: \.\/\.github\/actions\/checkout-native-y/.test(line),
      );
      assert.ok(
        nativeY > checkout,
        `${workflow}:${install.index + 1} must fetch native Y after checkout and before install`,
      );
    }
  }
});

test("uses the workspace pnpm version in release and browser environments", async () => {
  const packageManager = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ).packageManager;
  const version = packageManager.replace("pnpm@", "");
  const workflow = await readFile(
    path.join(root, ".github/workflows/downstream-release.yml"),
    "utf8",
  );
  const dockerfile = await readFile(
    path.join(root, "tests/Dockerfile"),
    "utf8",
  );

  for (const match of workflow.matchAll(/^\s*version: (\d+\.\d+\.\d+)$/gm)) {
    assert.equal(match[1], version);
  }
  assert.match(
    dockerfile,
    new RegExp(`pnpm@${version.replaceAll(".", "\\.")}`),
  );
});

test("builds native Y before standalone package builds and typechecks", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  assert.equal(
    manifest.scripts["build:native-y"],
    "pnpm --filter @pproenca/y run build",
  );
  assert.equal(
    manifest.scripts.build,
    "pnpm run build:native-y && vp run --filter './packages/core' build && vp run --filter './shared' build && vp run --filter './packages/*' --filter '!@blocknote/core' build",
  );

  const orchestratedBuilds = [
    ".github/workflows/build.yml",
    ".github/workflows/fresh-install-tests.yml",
    ".github/workflows/publish.yaml",
  ];
  for (const workflow of orchestratedBuilds) {
    const source = await readFile(path.join(root, workflow), "utf8");
    const install = source.indexOf("vp install");
    const build = source.indexOf("run: vp run build\n", install);

    assert.ok(install >= 0, `${workflow} must install dependencies`);
    assert.ok(build > install, `${workflow} must use the sequenced root build`);
    assert.doesNotMatch(source, /run: vp run -r build/);
  }

  const downstreamWorkflow = ".github/workflows/downstream-release.yml";
  const downstream = await readFile(
    path.join(root, downstreamWorkflow),
    "utf8",
  );
  const install = downstream.indexOf("vp install");
  const nativeBuild = downstream.indexOf(
    "run: pnpm run build:native-y\n",
    install,
  );
  const typecheck = downstream.indexOf("run: pnpm typecheck\n", install);
  assert.ok(nativeBuild > install, `${downstreamWorkflow} must build native Y`);
  assert.ok(
    typecheck > nativeBuild,
    `${downstreamWorkflow} must build native Y before typecheck`,
  );
});

test("runs the Gate 1 collaboration browser contract on Chromium", async () => {
  const workflow = await readFile(
    path.join(root, ".github/workflows/build.yml"),
    "utf8",
  );
  assert.match(workflow, /browser: \[chromium\]/);
  assert.match(workflow, /shardIndex: \[1\]/);
  assert.match(workflow, /shardTotal: \[1\]/);
  assert.match(
    workflow,
    /--run src\/end-to-end\/comments src\/end-to-end\/y-prosemirror src\/end-to-end\/collaboration/,
  );
  assert.doesNotMatch(workflow, /SKIP_COLLAB_E2E/);
});

test("installs Chromium before the production Next.js browser check", async () => {
  const workflow = await readFile(
    path.join(root, ".github/workflows/build.yml"),
    "utf8",
  );
  const dependencies = workflow.indexOf("run: vp install");
  const chromium = workflow.indexOf(
    "run: pnpm exec playwright install --with-deps chromium",
    dependencies,
  );
  const nextIntegration = workflow.indexOf(
    "run: NEXTJS_TEST_MODE=build vp test run src/unit/nextjs/serverUtil.test.ts",
    dependencies,
  );

  assert.ok(chromium > dependencies, "Chromium must install after dependencies");
  assert.ok(
    nextIntegration > chromium,
    "Chromium must install before the Next.js integration test",
  );
});
