import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { getPort } from "get-port-please";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  buildAndPackPackages,
  assertExactPackedArtifactSet,
  packedPackageCases,
  prepareNextConsumer,
  removeNextConsumer,
  removePackedArtifacts,
  runPublicConsumerProbe,
  type PackedArtifactSet,
} from "./packedConsumer.js";

const requestedMode = process.env.NEXTJS_TEST_MODE || "dev";
if (requestedMode !== "dev" && requestedMode !== "build") {
  throw new Error(`Unknown NEXTJS_TEST_MODE: ${requestedMode}`);
}
const mode: "dev" | "build" = requestedMode;

let packedArtifacts: PackedArtifactSet | undefined;

beforeAll(() => {
  packedArtifacts = buildAndPackPackages();
}, 240_000);

afterAll(() => {
  removePackedArtifacts(packedArtifacts);
});

const getPackedArtifacts = () => {
  if (!packedArtifacts) {
    throw new Error("Packed BlockNote artifacts are unavailable");
  }

  return packedArtifacts;
};

describe("built BlockNote package contracts", () => {
  it("installs tarballs and resolves public runtime and declaration imports", () => {
    const proof = runPublicConsumerProbe(getPackedArtifacts());
    const expectedImports = packedPackageCases.flatMap(
      ({ packageName, publicImports }) =>
        publicImports.map((publicImport) => ({
          packageName,
          ...publicImport,
        })),
    );

    expect(
      proof.installedPackages.map(({ packageName, version }) => ({
        packageName,
        version,
      })),
    ).toEqual(
      packedPackageCases.map(({ packageName }) => ({
        packageName,
        version: getPackedArtifacts().artifacts.find(
          (artifact) => artifact.packageCase.packageName === packageName,
        )?.version,
      })),
    );
    expect(
      proof.publicImports.map(
        ({ packageName, specifier, exportName, resolvedPath }) => ({
          packageName,
          specifier,
          exportName,
          isBuiltOutput: resolvedPath.includes(`${path.sep}dist${path.sep}`),
        }),
      ),
    ).toEqual(
      expectedImports.map((entry) => ({ ...entry, isBuiltOutput: true })),
    );
  }, 180_000);

  it("rejects missing and mixed artifact sets before installation", () => {
    const artifacts = getPackedArtifacts();
    expect(() =>
      assertExactPackedArtifactSet({
        ...artifacts,
        artifacts: artifacts.artifacts.slice(1),
      }),
    ).toThrow("exactly one packed artifact");
    expect(() =>
      assertExactPackedArtifactSet({
        ...artifacts,
        artifacts: artifacts.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, version: "0.0.0-mixed" } : artifact,
        ),
      }),
    ).toThrow("versions must match");
  });
});

describe(`server-util in a fresh Next.js App Router consumer (#942) [${mode}]`, () => {
  let port = 0;
  let baseUrl = "";
  let consumerDirectory: string | undefined;
  let nextProcess: ChildProcess | undefined;
  let processError: Error | undefined;
  let serverOutput = "";
  let serverErrors = "";

  const recentServerOutput = () =>
    `Server stdout:\n${serverOutput.slice(-2_000)}\n\nServer stderr:\n${serverErrors.slice(-2_000)}`;

  const signalProcess = (signal: NodeJS.Signals) => {
    if (!nextProcess?.pid) {
      return;
    }

    try {
      if (process.platform === "win32") {
        nextProcess.kill(signal);
      } else {
        process.kill(-nextProcess.pid, signal);
      }
    } catch {
      // The process already exited.
    }
  };

  const waitForExit = (timeout: number) =>
    new Promise<boolean>((resolve) => {
      if (
        !nextProcess ||
        nextProcess.exitCode !== null ||
        nextProcess.signalCode !== null
      ) {
        resolve(true);
        return;
      }

      const timer = setTimeout(() => {
        nextProcess?.off("exit", onExit);
        resolve(false);
      }, timeout);
      timer.unref();

      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      nextProcess.once("exit", onExit);
    });

  const stopServer = async () => {
    if (!nextProcess) {
      return;
    }
    if (nextProcess.exitCode !== null || nextProcess.signalCode !== null) {
      nextProcess = undefined;
      return;
    }

    signalProcess("SIGTERM");
    if (!(await waitForExit(5_000))) {
      signalProcess("SIGKILL");
      if (!(await waitForExit(2_000))) {
        throw new Error("Next.js process did not exit after SIGKILL");
      }
    }
    nextProcess = undefined;
  };

  const waitForServer = async () => {
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      if (processError) {
        throw processError;
      }
      if (
        nextProcess?.exitCode !== null &&
        nextProcess?.exitCode !== undefined
      ) {
        throw new Error(
          `Next.js exited with code ${nextProcess.exitCode}\n\n${recentServerOutput()}`,
        );
      }

      try {
        await fetch(`${baseUrl}/editor`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    throw new Error(
      `Next.js ${mode} server did not start within 60s\n\n${recentServerOutput()}`,
    );
  };

  beforeAll(async () => {
    consumerDirectory = prepareNextConsumer(getPackedArtifacts());
    port = await getPort({ portRange: [3900, 4100] });
    baseUrl = `http://localhost:${port}`;
    const nextBinary = path.join(
      consumerDirectory,
      "node_modules",
      ".bin",
      "next",
    );

    try {
      if (mode === "build") {
        execFileSync(nextBinary, ["build"], {
          cwd: consumerDirectory,
          env: { ...process.env, CI: "1", NODE_ENV: "production" },
          maxBuffer: 20 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 180_000,
        });
      }

      nextProcess = spawn(
        nextBinary,
        mode === "build"
          ? ["start", "--port", String(port)]
          : ["dev", "--turbopack", "--port", String(port)],
        {
          cwd: consumerDirectory,
          detached: process.platform !== "win32",
          env: {
            ...process.env,
            NODE_ENV: mode === "build" ? "production" : "development",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      nextProcess.stdout?.on("data", (data: Buffer) => {
        serverOutput += data.toString();
      });
      nextProcess.stderr?.on("data", (data: Buffer) => {
        serverErrors += data.toString();
      });
      nextProcess.once("error", (error) => {
        processError = error;
      });

      await waitForServer();
    } catch (error) {
      await stopServer();
      throw new Error(`${String(error)}\n\n${recentServerOutput()}`, {
        cause: error,
      });
    }
  }, 240_000);

  afterAll(async () => {
    await stopServer();
    removeNextConsumer(consumerDirectory);
  });

  it("runs ServerBlockNoteEditor in an API route", async () => {
    const response = await fetch(`${baseUrl}/api/server-util`);
    const text = await response.text();
    let body: {
      allPassed: boolean;
      results: Record<string, string>;
    };

    try {
      body = JSON.parse(text) as typeof body;
    } catch (error) {
      throw new Error(
        `Next.js returned non-JSON ${response.status}: ${text.slice(0, 500)}\n\n${recentServerOutput()}`,
        { cause: error },
      );
    }

    expect(response.status, JSON.stringify(body.results, null, 2)).toBe(200);
    expect(body.allPassed, JSON.stringify(body.results, null, 2)).toBe(true);
    expect(body.results.simpleReactBlock).toMatch(/^PASS:/);
    expect(body.results.reactContextBlock).toMatch(/^PASS:/);
    expect(body.results.blocksToHTMLLossy).toMatch(/^PASS:/);
    expect(body.results.yDocRoundtrip).toMatch(/^PASS:/);
  }, 30_000);

  it("renders the editor page from installed packages", async () => {
    const response = await fetch(`${baseUrl}/editor`);
    const html = await response.text();

    expect(
      response.status,
      `${html.slice(0, 500)}\n${recentServerOutput()}`,
    ).toBe(200);
    expect(html).toContain("BlockNote Editor Test");
    expect(html).toContain("editor-wrapper");
  }, 30_000);

  it("runs comment-only save and live access revocation in Chromium", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${baseUrl}/editor`);
      await page.getByTestId("comment-save").click();
      await expect
        .poll(() => page.getByTestId("comment-result").textContent())
        .toBe("saved-no-change");
      await page.getByTestId("revoke-edit").click();
      await expect
        .poll(() => page.getByTestId("edit-access").textContent())
        .toBe("false");
      await expect
        .poll(() => page.locator(".bn-editor").getAttribute("contenteditable"))
        .toBe("false");
    } finally {
      await browser.close();
    }
  }, 30_000);
});
