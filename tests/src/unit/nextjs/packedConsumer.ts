import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type PublicImport = {
  specifier: string;
  exportName: string;
};

export type PackedPackageCase = {
  packageName: string;
  workspaceDirectory: string;
  publicImports: readonly PublicImport[];
  consumerDependencies?: Readonly<Record<string, string>>;
};

export const packedPackageCases = [
  {
    packageName: "@blocknote/core",
    workspaceDirectory: "core",
    consumerDependencies: {
      "@y/prosemirror": "2.0.0-6",
      "@y/protocols": "1.0.6-rc.1",
      "@y/websocket": "4.0.0-rc.2",
      "y-prosemirror": "1.3.7",
      "y-protocols": "1.0.6",
      yjs: "13.6.27",
    },
    publicImports: [
      { specifier: "@blocknote/core", exportName: "BlockNoteSchema" },
      {
        specifier: "@blocknote/core",
        exportName: "createBlockNoteDocument",
      },
      {
        specifier: "@blocknote/core",
        exportName: "createBlockNoteAccess",
      },
      { specifier: "@blocknote/core", exportName: "BlockNoteError" },
      {
        specifier: "@blocknote/core",
        exportName: "createBlockNoteStore",
      },
      {
        specifier: "@blocknote/core/detect-markdown",
        exportName: "isMarkdown",
      },
      {
        specifier: "@blocknote/core/comments",
        exportName: "CommentsExtension",
      },
      {
        specifier: "@blocknote/core/blocks",
        exportName: "defaultBlockSpecs",
      },
      { specifier: "@blocknote/core/locales", exportName: "en" },
      {
        specifier: "@blocknote/core/extensions",
        exportName: "SuggestionMenu",
      },
      {
        specifier: "@blocknote/core/yjs",
        exportName: "blocksToYDoc",
      },
      { specifier: "@blocknote/core/y", exportName: "blocksToYDoc" },
    ],
  },
  {
    packageName: "@blocknote/react",
    workspaceDirectory: "react",
    consumerDependencies: {
      "@types/react": "19.2.3",
      "@types/react-dom": "19.2.3",
      react: "19.2.5",
      "react-dom": "19.2.5",
    },
    publicImports: [
      {
        specifier: "@blocknote/react",
        exportName: "createReactBlockSpec",
      },
      { specifier: "@blocknote/react", exportName: "BlockNoteViewRaw" },
      {
        specifier: "@blocknote/react",
        exportName: "useCreateBlockNoteSession",
      },
      {
        specifier: "@blocknote/react",
        exportName: "BlockNoteSessionProvider",
      },
      {
        specifier: "@blocknote/react",
        exportName: "createBlockNoteCommentsController",
      },
    ],
  },
  {
    packageName: "@blocknote/server-util",
    workspaceDirectory: "server-util",
    publicImports: [
      {
        specifier: "@blocknote/server-util",
        exportName: "ServerBlockNoteEditor",
      },
      {
        specifier: "@blocknote/server-util/headless",
        exportName: "createBlockNoteDocumentService",
      },
      {
        specifier: "@blocknote/server-util/collaboration",
        exportName: "createBlockNoteCollaboration",
      },
      {
        specifier: "@blocknote/server-util/node",
        exportName: "serveBlockNoteCollaboration",
      },
    ],
  },
  {
    packageName: "@blocknote/collaboration",
    workspaceDirectory: "collaboration",
    publicImports: [
      {
        specifier: "@blocknote/collaboration",
        exportName: "createBlockNoteSession",
      },
    ],
  },
  {
    packageName: "@blocknote/collaboration-server",
    workspaceDirectory: "collaboration-server",
    publicImports: [
      {
        specifier: "@blocknote/collaboration-server",
        exportName: "createBlockNoteCollaboration",
      },
      {
        specifier: "@blocknote/collaboration-server",
        exportName: "createInMemoryDocumentStore",
      },
    ],
  },
  {
    packageName: "@blocknote/test-utils",
    workspaceDirectory: "test-utils",
    publicImports: [
      {
        specifier: "@blocknote/test-utils",
        exportName: "defineBlockNoteDocumentStoreContract",
      },
      {
        specifier: "@blocknote/test-utils",
        exportName: "defineBlockNoteCommentsBehaviorFixtures",
      },
      {
        specifier: "@blocknote/test-utils",
        exportName: "createBlockNoteCommentAnchorTestKeyRings",
      },
    ],
  },
] as const satisfies readonly PackedPackageCase[];

export type PackedArtifact = {
  readonly packageCase: PackedPackageCase;
  readonly tarballPath: string;
  readonly tarballName: string;
  readonly version: string;
};

export type PackedEngineArtifact = {
  readonly alias: "@y/y";
  readonly packageName: "@pproenca/y";
  readonly tarballName: string;
  readonly tarballPath: string;
  readonly version: string;
};

export type PackedArtifactSet = {
  readonly directory: string;
  readonly artifacts: readonly PackedArtifact[];
  readonly engine: PackedEngineArtifact;
};

export type PublicImportProof = {
  packageName: string;
  specifier: string;
  exportName: string;
  resolvedPath: string;
};

export type PackedEngineProof = {
  readonly alias: "@y/y";
  readonly manifestName: "@pproenca/y";
  readonly version: string;
  readonly resolvedRealPaths: readonly string[];
  readonly runtimeIdentity: Readonly<
    Record<
      "ContentDeleted" | "Doc" | "Item" | "createContentIdsFromUpdate",
      boolean
    >
  >;
  readonly upstreamCopies: readonly string[];
};

const repoRoot = path.resolve(__dirname, "../../../..");
const packageRoot = path.join(repoRoot, "packages");
const nativeYRoot = path.resolve(repoRoot, "../yjs");
const vpBinary = path.join(repoRoot, "node_modules", ".bin", "vp");
const tscBinary = path.join(repoRoot, "node_modules", ".bin", "tsc");
const tsgoBinary = path.join(repoRoot, "node_modules", ".bin", "tsgo");
const pnpmCli = process.env.BLOCKNOTE_TEST_PNPM_CLI ?? process.env.npm_execpath;

const commandOptions = (
  cwd: string,
): ExecFileSyncOptionsWithStringEncoding => ({
  cwd,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 240_000,
});

const run = (
  command: string,
  args: readonly string[],
  cwd: string,
  additionalEnvironment: Record<string, string> = {},
) => {
  try {
    return execFileSync(command, [...args], {
      ...commandOptions(cwd),
      env: { ...process.env, CI: "1", ...additionalEnvironment },
    });
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string };
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`,
      { cause: error },
    );
  }
};

const runPnpm = (args: readonly string[], cwd: string) => {
  const stableArgs = ["--pm-on-fail=ignore", ...args];
  if (pnpmCli?.endsWith(".cjs") || pnpmCli?.endsWith(".js")) {
    return run(process.execPath, [pnpmCli, ...stableArgs], cwd);
  }
  return run(pnpmCli || "pnpm", stableArgs, cwd);
};

const readPackageVersion = (packageCase: PackedPackageCase) => {
  const manifest = JSON.parse(
    readFileSync(
      path.join(packageRoot, packageCase.workspaceDirectory, "package.json"),
      "utf8",
    ),
  ) as { version?: unknown };

  if (typeof manifest.version !== "string") {
    throw new Error(`${packageCase.packageName} has no package version`);
  }

  return manifest.version;
};

const readNativeYManifest = () => {
  const manifest = JSON.parse(
    readFileSync(path.join(nativeYRoot, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown };

  if (manifest.name !== "@pproenca/y") {
    throw new Error(
      `Native Y package must be named @pproenca/y, received ${String(manifest.name)}`,
    );
  }
  if (manifest.version !== "14.0.0-rc.23-y001.0") {
    throw new Error(
      `Native Y package must be version 14.0.0-rc.23-y001.0, received ${String(manifest.version)}`,
    );
  }

  return { packageName: manifest.name, version: manifest.version } as const;
};

const findOnlyTarball = (directory: string, packageName: string) => {
  const tarballs = readdirSync(directory).filter((entry) =>
    entry.endsWith(".tgz"),
  );

  if (tarballs.length !== 1) {
    throw new Error(
      `Expected one tarball for ${packageName}, found ${tarballs.length}: ${tarballs.join(", ") || "none"}`,
    );
  }

  return tarballs[0]!;
};

export const buildAndPackPackages = (): PackedArtifactSet => {
  if (!existsSync(vpBinary)) {
    throw new Error(`Missing Vite Plus binary at ${vpBinary}`);
  }

  const allPackageCases = packedPackageCases;
  const directory = mkdtempSync(path.join(tmpdir(), "blocknote-packages-"));

  try {
    const buildOrder = [
      "@blocknote/core",
      "@blocknote/collaboration",
      "@blocknote/collaboration-server",
      "@blocknote/react",
      "@blocknote/server-util",
      "@blocknote/test-utils",
    ];
    for (const packageName of buildOrder) {
      const packageCase = allPackageCases.find(
        (candidate) => candidate.packageName === packageName,
      )!;
      const cwd = path.join(packageRoot, packageCase.workspaceDirectory);
      run(tsgoBinary, ["-p", "tsconfig.json"], cwd, {
        NODE_ENV: "production",
      });
      run(vpBinary, ["build"], cwd, { NODE_ENV: "production" });
    }

    const artifacts = allPackageCases.map((packageCase) => {
      const outputDirectory = path.join(
        directory,
        packageCase.workspaceDirectory,
      );
      mkdirSync(outputDirectory, { recursive: true });
      runPnpm(
        ["pack", "--pack-destination", outputDirectory],
        path.join(packageRoot, packageCase.workspaceDirectory),
      );

      const tarballName = findOnlyTarball(
        outputDirectory,
        packageCase.packageName,
      );

      return {
        packageCase,
        tarballName,
        tarballPath: path.join(outputDirectory, tarballName),
        version: readPackageVersion(packageCase),
      };
    });

    runPnpm(["run", "dist"], nativeYRoot);
    runPnpm(["run", "verify:pack"], nativeYRoot);
    const engineDirectory = path.join(directory, "native-y");
    mkdirSync(engineDirectory, { recursive: true });
    runPnpm(["pack", "--pack-destination", engineDirectory], nativeYRoot);
    const nativeYManifest = readNativeYManifest();
    const engineTarballName = findOnlyTarball(engineDirectory, "@pproenca/y");
    const engine: PackedEngineArtifact = {
      alias: "@y/y",
      packageName: nativeYManifest.packageName,
      tarballName: engineTarballName,
      tarballPath: path.join(engineDirectory, engineTarballName),
      version: nativeYManifest.version,
    };

    return { directory, artifacts, engine };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
};

export const removePackedArtifacts = (artifacts?: PackedArtifactSet) => {
  if (artifacts) {
    rmSync(artifacts.directory, { recursive: true, force: true });
  }
};

const artifactFor = (artifacts: PackedArtifactSet, packageName: string) => {
  const artifact = artifacts.artifacts.find(
    (candidate) => candidate.packageCase.packageName === packageName,
  );

  if (!artifact) {
    throw new Error(`Missing built tarball for ${packageName}`);
  }

  return artifact;
};

export const assertExactPackedArtifactSet = (artifacts: {
  readonly directory: string;
  readonly artifacts: readonly PackedArtifact[];
  readonly engine?: PackedEngineArtifact;
}) => {
  const expected = new Set<string>(
    packedPackageCases.map(({ packageName }) => packageName),
  );
  const counts = new Map<string, number>();
  for (const artifact of artifacts.artifacts) {
    counts.set(
      artifact.packageCase.packageName,
      (counts.get(artifact.packageCase.packageName) ?? 0) + 1,
    );
  }
  for (const packageName of expected) {
    if (counts.get(packageName) !== 1) {
      throw new Error(
        `Expected exactly one packed artifact for ${packageName}.`,
      );
    }
  }
  const unexpected = [...counts.keys()].filter((name) => !expected.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected packed BlockNote artifacts: ${unexpected.join(", ")}`,
    );
  }
  const versions = new Set(artifacts.artifacts.map(({ version }) => version));
  if (versions.size !== 1) {
    throw new Error(
      `Packed BlockNote versions must match: ${[...versions].join(", ")}`,
    );
  }
  if (
    artifacts.engine?.alias !== "@y/y" ||
    artifacts.engine.packageName !== "@pproenca/y" ||
    artifacts.engine.version !== "14.0.0-rc.23-y001.0"
  ) {
    throw new Error(
      "Packed set must contain one exact native Y artifact for @pproenca/y@14.0.0-rc.23-y001.0.",
    );
  }
};

const createConsumerManifest = (artifacts: PackedArtifactSet) => {
  const engineSpecifier = `file:.tarballs/${artifacts.engine.tarballName}`;
  const dependencies = Object.assign(
    {},
    ...packedPackageCases.map((packageCase) =>
      "consumerDependencies" in packageCase
        ? packageCase.consumerDependencies
        : {},
    ),
    Object.fromEntries(
      packedPackageCases.map(({ packageName }) => [
        packageName,
        `file:.tarballs/${artifactFor(artifacts, packageName).tarballName}`,
      ]),
    ),
  );
  dependencies[artifacts.engine.alias] = engineSpecifier;

  return {
    name: "blocknote-packed-consumer",
    private: true,
    type: "module",
    dependencies,
    pnpm: { overrides: { [artifacts.engine.alias]: engineSpecifier } },
  };
};

const stagePackedArtifacts = (
  consumerDirectory: string,
  artifacts: PackedArtifactSet,
) => {
  const directory = path.join(consumerDirectory, ".tarballs");
  mkdirSync(directory, { recursive: true });
  for (const artifact of artifacts.artifacts) {
    cpSync(artifact.tarballPath, path.join(directory, artifact.tarballName));
  }
  cpSync(
    artifacts.engine.tarballPath,
    path.join(directory, artifacts.engine.tarballName),
  );
};

const installConsumer = (consumerDirectory: string) => {
  runPnpm(
    ["install", "--lockfile=false", "--ignore-scripts", "--prefer-offline"],
    consumerDirectory,
  );
};

type LocalPackageSource = {
  specifier: string;
  tarballPath: string;
};

const isInsideDirectory = (directory: string, candidate: string) => {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
};

const readLocalPackageSources = (
  consumerDirectory: string,
  packageCases: readonly PackedPackageCase[],
) => {
  const manifest = JSON.parse(
    readFileSync(path.join(consumerDirectory, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, unknown> };

  return new Map(
    packageCases.map(({ packageName }) => {
      const specifier = manifest.dependencies?.[packageName];
      if (
        typeof specifier !== "string" ||
        !specifier.startsWith("file:") ||
        specifier === "file:"
      ) {
        throw new Error(
          `${packageName} must resolve from a local tarball, received ${String(specifier)}`,
        );
      }

      return [
        packageName,
        {
          specifier,
          tarballPath: path.resolve(
            consumerDirectory,
            specifier.slice("file:".length),
          ),
        },
      ] as const;
    }),
  );
};

const writeHermeticWorkspace = (
  consumerDirectory: string,
  packageCases: readonly PackedPackageCase[],
  engine?: PackedEngineArtifact,
) => {
  const sources = readLocalPackageSources(consumerDirectory, packageCases);
  for (const [packageName, source] of sources) {
    if (!isInsideDirectory(consumerDirectory, source.tarballPath)) {
      throw new Error(
        `${packageName} tarball is outside the fresh consumer: ${source.tarballPath}`,
      );
    }
  }

  const engineSpecifier = engine
    ? `file:.tarballs/${engine.tarballName}`
    : undefined;
  if (
    engineSpecifier &&
    !isInsideDirectory(
      consumerDirectory,
      path.resolve(consumerDirectory, engineSpecifier.slice("file:".length)),
    )
  ) {
    throw new Error(`Native Y tarball is outside the fresh consumer.`);
  }
  const overrides = Object.fromEntries(
    [...sources].map(([packageName, { specifier }]) => [
      packageName,
      specifier,
    ]),
  );
  if (engineSpecifier) {
    overrides["@y/y"] = engineSpecifier;
  }

  writeFileSync(
    path.join(consumerDirectory, "pnpm-workspace.yaml"),
    `${JSON.stringify(
      {
        packages: ["."],
        linkWorkspacePackages: false,
        preferWorkspacePackages: false,
        overrides,
      },
      null,
      2,
    )}\n`,
  );

  return sources;
};

const assertStagedTarballs = (
  consumerDirectory: string,
  sources: ReadonlyMap<string, LocalPackageSource>,
  artifacts: PackedArtifactSet,
) => {
  for (const [packageName, source] of sources) {
    if (!existsSync(source.tarballPath)) {
      throw new Error(
        `${packageName} local tarball is missing: ${source.tarballPath}`,
      );
    }

    const suppliedTarball = artifactFor(artifacts, packageName).tarballPath;
    if (
      !readFileSync(source.tarballPath).equals(readFileSync(suppliedTarball))
    ) {
      throw new Error(
        `${packageName} staged tarball does not match ${suppliedTarball}`,
      );
    }
  }
  const stagedEngine = path.join(
    consumerDirectory,
    ".tarballs",
    artifacts.engine.tarballName,
  );
  if (
    !existsSync(stagedEngine) ||
    !readFileSync(stagedEngine).equals(
      readFileSync(artifacts.engine.tarballPath),
    )
  ) {
    throw new Error(
      `Native Y staged tarball does not match ${artifacts.engine.tarballPath}`,
    );
  }
};

const findInstalledBlockNotePackages = (consumerDirectory: string) => {
  const nodeModules = path.join(consumerDirectory, "node_modules");
  const virtualStore = path.join(nodeModules, ".pnpm");
  const scopeDirectories = [
    path.join(nodeModules, "@blocknote"),
    path.join(virtualStore, "node_modules", "@blocknote"),
  ];

  if (existsSync(virtualStore)) {
    for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scopeDirectories.push(
          path.join(virtualStore, entry.name, "node_modules", "@blocknote"),
        );
      }
    }
  }

  const references = new Map<string, Set<string>>();
  for (const scopeDirectory of scopeDirectories) {
    if (!existsSync(scopeDirectory)) {
      continue;
    }

    for (const entry of readdirSync(scopeDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const packageName = `@blocknote/${entry.name}`;
      const packageReferences = references.get(packageName) ?? new Set();
      packageReferences.add(path.join(scopeDirectory, entry.name));
      references.set(packageName, packageReferences);
    }
  }

  return references;
};

export const inspectInstalledPackages = (
  consumerDirectory: string,
  artifacts: PackedArtifactSet,
  packageCases: readonly PackedPackageCase[] = packedPackageCases,
  sources?: ReadonlyMap<string, LocalPackageSource>,
) => {
  const installedPackages = findInstalledBlockNotePackages(consumerDirectory);
  const expectedPackageNames = new Set(
    packageCases.map(({ packageName }) => packageName),
  );
  const unexpectedPackages = [...installedPackages.keys()].filter(
    (packageName) => !expectedPackageNames.has(packageName),
  );
  if (unexpectedPackages.length > 0) {
    throw new Error(
      `Fresh consumer installed unexpected BlockNote packages: ${unexpectedPackages.join(", ")}`,
    );
  }

  const consumerPath = realpathSync(consumerDirectory);
  return packageCases.map(({ packageName }) => {
    const artifact = artifactFor(artifacts, packageName);
    const installedDirectory = path.join(
      consumerDirectory,
      "node_modules",
      ...packageName.split("/"),
    );

    if (!existsSync(installedDirectory)) {
      throw new Error(`Fresh consumer did not install ${packageName}`);
    }

    const references = installedPackages.get(packageName);
    if (!references || references.size === 0) {
      throw new Error(`Fresh consumer has no installation of ${packageName}`);
    }

    const realPaths = new Set(
      [...references].map((entry) => realpathSync(entry)),
    );
    if (realPaths.size !== 1) {
      throw new Error(
        `${packageName} has ${realPaths.size} installed instances:\n${[...realPaths].join("\n")}`,
      );
    }

    const installedPath = [...realPaths][0]!;
    if (!isInsideDirectory(consumerPath, installedPath)) {
      throw new Error(
        `${packageName} resolved outside the fresh consumer: ${installedPath}`,
      );
    }
    if (realpathSync(installedDirectory) !== installedPath) {
      throw new Error(
        `${packageName} top-level dependency does not use its only installed instance`,
      );
    }

    const manifest = JSON.parse(
      readFileSync(path.join(installedDirectory, "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (manifest.name !== packageName) {
      throw new Error(
        `${packageName} installed manifest is named ${String(manifest.name)}`,
      );
    }
    if (manifest.version !== artifact.version) {
      throw new Error(
        `${packageName} installed version ${String(manifest.version)}, expected packed ${artifact.version}`,
      );
    }

    const source = sources?.get(packageName);
    if (sources && !source) {
      throw new Error(`${packageName} has no expected local tarball source`);
    }
    if (source) {
      const tarballName = path.basename(source.tarballPath);
      const packageSlug = packageName.slice("@blocknote/".length);
      const localStoreEntry = installedPath
        .split(path.sep)
        .find(
          (entry) =>
            entry.includes("file+") &&
            (entry.includes(tarballName) || entry.includes(packageSlug)),
        );
      if (!localStoreEntry) {
        throw new Error(
          `${packageName} installed from a non-tarball path: ${installedPath}; expected ${source.tarballPath}`,
        );
      }
    }

    return { packageName, version: artifact.version, installedPath };
  });
};

const createRuntimeProbe = () => {
  const entries = packedPackageCases.flatMap(({ packageName, publicImports }) =>
    publicImports.map((publicImport) => ({ packageName, ...publicImport })),
  );

  return `
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

if ("window" in globalThis || "document" in globalThis) {
  throw new Error("Runtime probe started with browser globals");
}

const entries = ${JSON.stringify(entries)};
const proof = [];
const require = createRequire(import.meta.url);
const engineOnly = process.env.BLOCKNOTE_ENGINE_PROBE === "1";

for (const entry of engineOnly ? [] : entries) {
  const cacheBefore = new Set(Object.keys(require.cache));
  const resolvedUrl = import.meta.resolve(entry.specifier);
  const resolvedPath = fileURLToPath(resolvedUrl);

  const pathParts = resolvedPath.split(path.sep);
  if (!pathParts.includes("node_modules")) {
    throw new Error(entry.specifier + " resolved outside node_modules: " + resolvedPath);
  }
  if (pathParts.includes("packages") && pathParts.includes("src")) {
    throw new Error(entry.specifier + " resolved to workspace source: " + resolvedPath);
  }

  const imported = await import(entry.specifier);
  if (!(entry.exportName in imported)) {
    throw new Error(entry.specifier + " is missing export " + entry.exportName);
  }
  if ("window" in globalThis || "document" in globalThis) {
    throw new Error(entry.specifier + " created browser globals during import");
  }
  const required = require(entry.specifier);
  if (!(entry.exportName in required)) {
    throw new Error(entry.specifier + " CommonJS export is missing " + entry.exportName);
  }

  if (["@blocknote/server-util/headless", "@blocknote/server-util/collaboration", "@blocknote/collaboration-server"].includes(entry.specifier)) {
    const loaded = Object.keys(require.cache).filter((value) => !cacheBefore.has(value)).join("\\n");
    for (const forbidden of ["/jsdom/", "/react-dom/"]) {
      if (loaded.includes(forbidden)) {
        throw new Error(entry.specifier + " loaded forbidden module " + forbidden);
      }
    }
  }

  proof.push({ ...entry, resolvedPath });
}

if (!engineOnly) {
  process.stdout.write(JSON.stringify(proof));
} else {
const engineAnchors = [
  ["@blocknote/core", "@blocknote/core"],
  ["@blocknote/collaboration", "@blocknote/collaboration"],
  ["@blocknote/collaboration-server", "@blocknote/collaboration-server"],
  ["@blocknote/server-util", "@blocknote/server-util"],
  ["@y/prosemirror", "@y/prosemirror"],
  ["@y/protocols", "@y/protocols/sync"],
  ["@y/websocket", "@y/websocket"],
];
const engineExports = [
  "ContentDeleted",
  "Doc",
  "Item",
  "createContentIdsFromUpdate",
];
const engineResolutions = [];

for (const [anchor, entrySpecifier] of engineAnchors) {
  const anchorRequire = createRequire(require.resolve(entrySpecifier));
  const manifestPath = anchorRequire.resolve("@y/y/package.json");
  const resolvedRealPath = realpathSync(path.dirname(manifestPath));
  const entryPath = realpathSync(anchorRequire.resolve("@y/y"));
  const runtime = await import(pathToFileURL(entryPath).href);
  engineResolutions.push({ anchor, manifestPath, resolvedRealPath, runtime });
}

const canonicalRuntime = engineResolutions[0].runtime;
const runtimeIdentity = Object.fromEntries(
  engineExports.map((exportName) => [
    exportName,
    canonicalRuntime[exportName] !== undefined &&
      engineResolutions.every(
        ({ runtime }) => runtime[exportName] === canonicalRuntime[exportName],
      ),
  ]),
);
const manifest = JSON.parse(
  readFileSync(engineResolutions[0].manifestPath, "utf8"),
);
const nodeModules = path.join(process.cwd(), "node_modules");
const possibleEngineManifests = [path.join(nodeModules, "@y/y/package.json")];
const virtualStore = path.join(nodeModules, ".pnpm");
if (existsSync(virtualStore)) {
  for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      possibleEngineManifests.push(
        path.join(virtualStore, entry.name, "node_modules/@y/y/package.json"),
      );
    }
  }
}
const upstreamCopies = possibleEngineManifests.filter((manifestPath) => {
  if (!existsSync(manifestPath)) return false;
  return JSON.parse(readFileSync(manifestPath, "utf8")).name === "@y/y";
});

process.stdout.write(JSON.stringify({
  alias: "@y/y",
  manifestName: manifest.name,
  version: manifest.version,
  resolvedRealPaths: engineResolutions.map(({ resolvedRealPath }) => resolvedRealPath),
  runtimeIdentity,
  upstreamCopies,
}));
}
`;
};

export const assertEngineInstallation = (proof: PackedEngineProof) => {
  if (proof.alias !== "@y/y") {
    throw new Error(
      `Native Y must use the @y/y alias, received ${proof.alias}`,
    );
  }
  if (proof.manifestName !== "@pproenca/y") {
    throw new Error(
      `Native Y alias must install @pproenca/y, received ${proof.manifestName}`,
    );
  }
  if (proof.version !== "14.0.0-rc.23-y001.0") {
    throw new Error(
      `Native Y must install version 14.0.0-rc.23-y001.0, received ${proof.version}`,
    );
  }
  if (new Set(proof.resolvedRealPaths).size !== 1) {
    throw new Error("Native Y anchors must resolve one physical runtime.");
  }
  const missingRuntimeExports = Object.entries(proof.runtimeIdentity)
    .filter(([, matches]) => !matches)
    .map(([exportName]) => exportName);
  if (missingRuntimeExports.length > 0) {
    throw new Error(
      `Native Y runtime identity failed for: ${missingRuntimeExports.join(", ")}`,
    );
  }
  if (proof.upstreamCopies.length > 0) {
    throw new Error(
      `Fresh consumer installed upstream @y/y copies:\n${proof.upstreamCopies.join("\n")}`,
    );
  }
};

const createTypeProbe = () => {
  return readFileSync(
    path.join(
      repoRoot,
      "tests",
      "src",
      "unit",
      "nextjs",
      "public-contract.mts",
    ),
    "utf8",
  );
};

export const runPublicConsumerProbe = (artifacts: PackedArtifactSet) => {
  assertExactPackedArtifactSet(artifacts);
  const consumerDirectory = mkdtempSync(
    path.join(tmpdir(), "blocknote-consumer-"),
  );

  try {
    writeFileSync(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify(createConsumerManifest(artifacts), null, 2)}\n`,
    );
    stagePackedArtifacts(consumerDirectory, artifacts);
    const sources = writeHermeticWorkspace(
      consumerDirectory,
      packedPackageCases,
      artifacts.engine,
    );
    assertStagedTarballs(consumerDirectory, sources, artifacts);
    installConsumer(consumerDirectory);
    const installedPackages = inspectInstalledPackages(
      consumerDirectory,
      artifacts,
      packedPackageCases,
      sources,
    );

    const runtimeProbePath = path.join(consumerDirectory, "runtime.mjs");
    writeFileSync(runtimeProbePath, createRuntimeProbe());
    const publicImports = JSON.parse(
      run(process.execPath, [runtimeProbePath], consumerDirectory, {
        NODE_ENV: "production",
      }),
    ) as PublicImportProof[];
    const engine = JSON.parse(
      run(process.execPath, [runtimeProbePath], consumerDirectory, {
        BLOCKNOTE_ENGINE_PROBE: "1",
        NODE_ENV: "production",
      }),
    ) as PackedEngineProof;
    assertEngineInstallation(engine);

    if (!existsSync(tscBinary)) {
      throw new Error(`Missing TypeScript binary at ${tscBinary}`);
    }

    writeFileSync(
      path.join(consumerDirectory, "contract.mts"),
      createTypeProbe(),
    );
    writeFileSync(
      path.join(consumerDirectory, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            lib: ["ESNext", "DOM", "DOM.Iterable"],
            module: "ESNext",
            moduleResolution: "Bundler",
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: "ESNext",
          },
          include: ["contract.mts"],
        },
        null,
        2,
      )}\n`,
    );
    run(tscBinary, ["--project", "tsconfig.json"], consumerDirectory);

    return { installedPackages, publicImports, engine };
  } finally {
    rmSync(consumerDirectory, { recursive: true, force: true });
  }
};

export const prepareNextConsumer = (artifacts: PackedArtifactSet) => {
  assertExactPackedArtifactSet(artifacts);
  const sourceDirectory = path.join(repoRoot, "tests", "nextjs-test-app");
  const consumerDirectory = mkdtempSync(
    path.join(tmpdir(), "blocknote-next-consumer-"),
  );

  try {
    cpSync(sourceDirectory, consumerDirectory, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(sourceDirectory, source);
        return ![
          "node_modules",
          ".next",
          ".tarballs",
          "package-lock.json",
          "pnpm-lock.yaml",
        ].some(
          (excluded) =>
            relative === excluded ||
            relative.startsWith(`${excluded}${path.sep}`),
        );
      },
    });

    const packageCases = packedPackageCases;
    const manifestPath = path.join(consumerDirectory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    manifest.dependencies ??= {};
    for (const { packageName } of packageCases) {
      manifest.dependencies[packageName] =
        `file:.tarballs/${artifactFor(artifacts, packageName).tarballName}`;
    }
    manifest.dependencies[artifacts.engine.alias] =
      `file:.tarballs/${artifacts.engine.tarballName}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    stagePackedArtifacts(consumerDirectory, artifacts);
    const sources = writeHermeticWorkspace(
      consumerDirectory,
      packageCases,
      artifacts.engine,
    );
    assertStagedTarballs(consumerDirectory, sources, artifacts);
    installConsumer(consumerDirectory);
    inspectInstalledPackages(
      consumerDirectory,
      artifacts,
      packageCases,
      sources,
    );

    return consumerDirectory;
  } catch (error) {
    rmSync(consumerDirectory, { recursive: true, force: true });
    throw error;
  }
};

export const removeNextConsumer = (consumerDirectory?: string) => {
  if (consumerDirectory) {
    rmSync(consumerDirectory, { recursive: true, force: true });
  }
};
