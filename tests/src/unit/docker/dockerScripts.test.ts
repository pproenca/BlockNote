import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const blockNoteRoot = path.resolve(import.meta.dirname, "../../../..");
const testsRoot = path.join(blockNoteRoot, "tests");
const temporaryDirectories: string[] = [];

const runWithFakeDocker = (script: "docker-build.sh" | "docker-run.sh") => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "blocknote-docker-scripts-"),
  );
  temporaryDirectories.push(temporaryDirectory);

  const logPath = path.join(temporaryDirectory, "docker.log");
  const dockerPath = path.join(temporaryDirectory, "docker");
  writeFileSync(
    dockerPath,
    `#!/usr/bin/env bash
printf 'cwd=%q ' "$PWD" >> "$DOCKER_LOG"
printf 'arg=%q ' "$@" >> "$DOCKER_LOG"
printf '\n' >> "$DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  exit 1
fi
`,
  );
  chmodSync(dockerPath, 0o755);

  const result = spawnSync("bash", [`tests/${script}`], {
    cwd: blockNoteRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKER_LOG: logPath,
      PATH: `${temporaryDirectory}:${process.env.PATH}`,
    },
  });

  return {
    result,
    invocations: readFileSync(logPath, "utf8").trim().split("\n"),
  };
};

afterEach(() => {
  for (const temporaryDirectory of temporaryDirectories.splice(0)) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

describe("Docker e2e scripts", () => {
  it("hashes every image input with a whitespace-safe shared helper", () => {
    const helperPath = path.join(testsRoot, "docker-deps-hash.sh");

    expect(existsSync(helperPath)).toBe(true);

    const helper = readFileSync(helperPath, "utf8");
    for (const input of [
      ".dockerignore",
      "tests/Dockerfile",
      "tests/docker-build.sh",
      "tests/docker-run.sh",
      "tests/docker-deps-hash.sh",
      "../yjs/package.json",
    ]) {
      expect(helper).toContain(input);
    }
    expect(helper).not.toContain(
      "../../patches/@hocuspocus__provider@4.4.0.patch",
    );
    expect(helper).not.toContain(
      "../../patches/@hocuspocus__server@4.4.0.patch",
    );
    expect(helper).toContain("while IFS= read -r file");
  });

  it("pins the external inputs to their monorepo workspace paths", () => {
    const dockerfile = readFileSync(path.join(testsRoot, "Dockerfile"), "utf8");

    expect(dockerfile).toContain("WORKDIR /repo/platform/blocknote");
    expect(dockerfile).toContain(
      "platform/yjs/package.json /repo/platform/yjs/package.json",
    );
    expect(dockerfile).toContain("COPY patches ./patches");
    expect(dockerfile).not.toContain(
      "COPY --from=monorepo patches/@hocuspocus__provider@4.4.0.patch",
    );
    expect(dockerfile).not.toContain(
      "COPY --from=monorepo patches/@hocuspocus__server@4.4.0.patch",
    );

    const workspace = readFileSync(
      path.join(blockNoteRoot, "pnpm-workspace.yaml"),
      "utf8",
    );
    expect(workspace).toContain(
      '"@hocuspocus/server@4.4.0": patches/@hocuspocus__server@4.4.0.patch',
    );
  });

  it("runs the Docker contract in the standalone test gate", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(testsRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.test).toContain("src/unit/docker");
  });

  it.each(["docker-build.sh", "docker-run.sh"] as const)(
    "%s exposes the monorepo patch context to the image build",
    (script) => {
      const { result, invocations } = runWithFakeDocker(script);
      const buildInvocation = invocations.find((line) =>
        line.includes("arg=build "),
      );

      expect(result.status).toBe(0);
      expect(buildInvocation).toContain(
        `cwd=${blockNoteRoot.replaceAll(" ", "\\ ")} `,
      );
      expect(buildInvocation).toContain(
        "arg=--build-context arg=monorepo=../.. ",
      );
      expect(buildInvocation).toContain("arg=-f arg=tests/Dockerfile ");
      expect(buildInvocation).toMatch(/arg=\.\s*$/);
    },
  );

  it("docker-run.sh mounts the native Y workspace source at its linked path", () => {
    const { result, invocations } = runWithFakeDocker("docker-run.sh");
    const runInvocation = invocations.find((line) => line.includes("arg=run "));

    expect(result.status).toBe(0);
    expect(runInvocation).toMatch(
      /arg=\S*yjs\/src:\/repo\/platform\/yjs\/src /,
    );
  });
});
