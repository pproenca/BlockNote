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
      "@y/y": "14.0.0-rc.23",
      "y-prosemirror": "1.3.7",
      "y-protocols": "1.0.6",
      yjs: "13.6.27",
    },
    publicImports: [
      { specifier: "@blocknote/core", exportName: "BlockNoteSchema" },
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
    ],
  },
] as const satisfies readonly PackedPackageCase[];

const nextOnlyPackageCases = [
  {
    packageName: "@blocknote/mantine",
    workspaceDirectory: "mantine",
    publicImports: [],
  },
] as const satisfies readonly PackedPackageCase[];

export type PackedArtifact = {
  packageCase: PackedPackageCase;
  tarballPath: string;
  tarballName: string;
  version: string;
};

export type PackedArtifactSet = {
  directory: string;
  artifacts: readonly PackedArtifact[];
};

export type PublicImportProof = {
  packageName: string;
  specifier: string;
  exportName: string;
  resolvedPath: string;
};

const repoRoot = path.resolve(__dirname, "../../../..");
const packageRoot = path.join(repoRoot, "packages");
const vpBinary = path.join(repoRoot, "node_modules", ".bin", "vp");
const tscBinary = path.join(repoRoot, "node_modules", ".bin", "tsc");

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

  const allPackageCases = [...packedPackageCases, ...nextOnlyPackageCases];
  const directory = mkdtempSync(path.join(tmpdir(), "blocknote-packages-"));

  try {
    run(
      vpBinary,
      [
        "run",
        "--no-cache",
        ...allPackageCases.flatMap(({ packageName }) => [
          "--filter",
          packageName,
        ]),
        "build",
      ],
      repoRoot,
      { NODE_ENV: "production" },
    );

    const artifacts = allPackageCases.map((packageCase) => {
      const outputDirectory = path.join(
        directory,
        packageCase.workspaceDirectory,
      );
      mkdirSync(outputDirectory, { recursive: true });
      run(
        "pnpm",
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

    return { directory, artifacts };
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

const createConsumerManifest = (artifacts: PackedArtifactSet) => ({
  name: "blocknote-packed-consumer",
  private: true,
  type: "module",
  dependencies: Object.assign(
    {},
    ...packedPackageCases.map((packageCase) =>
      "consumerDependencies" in packageCase
        ? packageCase.consumerDependencies
        : {},
    ),
    Object.fromEntries(
      packedPackageCases.map(({ packageName }) => [
        packageName,
        `file:${artifactFor(artifacts, packageName).tarballPath}`,
      ]),
    ),
  ),
});

const installConsumer = (consumerDirectory: string) => {
  run(
    "pnpm",
    ["install", "--lockfile=false", "--ignore-scripts", "--prefer-offline"],
    consumerDirectory,
  );
};

export const inspectInstalledPackages = (
  consumerDirectory: string,
  artifacts: PackedArtifactSet,
  packageCases: readonly PackedPackageCase[] = packedPackageCases,
) =>
  packageCases.map(({ packageName }) => {
    const artifact = artifactFor(artifacts, packageName);
    const installedDirectory = path.join(
      consumerDirectory,
      "node_modules",
      ...packageName.split("/"),
    );

    if (!existsSync(installedDirectory)) {
      throw new Error(`Fresh consumer did not install ${packageName}`);
    }

    const installedPath = realpathSync(installedDirectory);
    const expectedRoot = `${realpathSync(consumerDirectory)}${path.sep}`;
    if (!installedPath.startsWith(expectedRoot)) {
      throw new Error(
        `${packageName} resolved outside the fresh consumer: ${installedPath}`,
      );
    }

    const manifest = JSON.parse(
      readFileSync(path.join(installedDirectory, "package.json"), "utf8"),
    ) as { version?: unknown };
    if (manifest.version !== artifact.version) {
      throw new Error(
        `${packageName} installed version ${String(manifest.version)}, expected packed ${artifact.version}`,
      );
    }

    return { packageName, version: artifact.version, installedPath };
  });

const createRuntimeProbe = () => {
  const entries = packedPackageCases.flatMap(({ packageName, publicImports }) =>
    publicImports.map((publicImport) => ({ packageName, ...publicImport })),
  );

  return `
import { fileURLToPath } from "node:url";
import path from "node:path";

if ("window" in globalThis || "document" in globalThis) {
  throw new Error("Runtime probe started with browser globals");
}

const entries = ${JSON.stringify(entries)};
const proof = [];

for (const entry of entries) {
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

  proof.push({ ...entry, resolvedPath });
}

process.stdout.write(JSON.stringify(proof));
`;
};

const createTypeProbe = () => {
  const imports = packedPackageCases.flatMap(
    ({ publicImports }, packageIndex) =>
      publicImports.map(
        ({ specifier, exportName }, importIndex) =>
          `import { ${exportName} as value_${packageIndex}_${importIndex} } from ${JSON.stringify(specifier)};`,
      ),
  );
  const values = packedPackageCases.flatMap(({ publicImports }, packageIndex) =>
    publicImports.map(
      (_, importIndex) => `value_${packageIndex}_${importIndex}`,
    ),
  );

  return `${imports.join("\n")}\n\nconst publicValues = [${values.join(", ")}] as const;\nvoid publicValues;\n`;
};

export const runPublicConsumerProbe = (artifacts: PackedArtifactSet) => {
  const consumerDirectory = mkdtempSync(
    path.join(tmpdir(), "blocknote-consumer-"),
  );

  try {
    writeFileSync(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify(createConsumerManifest(artifacts), null, 2)}\n`,
    );
    installConsumer(consumerDirectory);
    const installedPackages = inspectInstalledPackages(
      consumerDirectory,
      artifacts,
    );

    const runtimeProbePath = path.join(consumerDirectory, "runtime.mjs");
    writeFileSync(runtimeProbePath, createRuntimeProbe());
    const publicImports = JSON.parse(
      run(process.execPath, [runtimeProbePath], consumerDirectory, {
        NODE_ENV: "production",
      }),
    ) as PublicImportProof[];

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

    return { installedPackages, publicImports };
  } finally {
    rmSync(consumerDirectory, { recursive: true, force: true });
  }
};

export const prepareNextConsumer = (artifacts: PackedArtifactSet) => {
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

    const environment = Object.fromEntries(
      [
        ["BLOCKNOTE_CORE_TARBALL", "@blocknote/core"],
        ["BLOCKNOTE_REACT_TARBALL", "@blocknote/react"],
        ["BLOCKNOTE_SERVER_UTIL_TARBALL", "@blocknote/server-util"],
        ["BLOCKNOTE_MANTINE_TARBALL", "@blocknote/mantine"],
      ].map(([variable, packageName]) => [
        variable,
        artifactFor(artifacts, packageName).tarballPath,
      ]),
    );

    run("bash", ["setup.sh"], consumerDirectory, environment);
    inspectInstalledPackages(consumerDirectory, artifacts, [
      ...packedPackageCases,
      ...nextOnlyPackageCases,
    ]);

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
