import {
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const downstreamPackages = Object.freeze([
  {
    directory: "packages/core",
    upstreamName: "@blocknote/core",
    downstreamName: "@pproenca/blocknote-core",
    requiredRuntimeExports: ["BlockNoteSchema", "createBlockNoteDocument"],
  },
  {
    directory: "packages/collaboration",
    upstreamName: "@blocknote/collaboration",
    downstreamName: "@pproenca/blocknote-collaboration",
    requiredRuntimeExports: [],
  },
  {
    directory: "packages/collaboration-server",
    upstreamName: "@blocknote/collaboration-server",
    downstreamName: "@pproenca/blocknote-collaboration-server",
    requiredRuntimeExports: [],
  },
  {
    directory: "packages/react",
    upstreamName: "@blocknote/react",
    downstreamName: "@pproenca/blocknote-react",
    requiredRuntimeExports: ["createReactBlockSpec"],
  },
  {
    directory: "packages/server-util",
    upstreamName: "@blocknote/server-util",
    downstreamName: "@pproenca/blocknote-server-util",
    requiredRuntimeExports: ["ServerBlockNoteEditor"],
  },
  {
    directory: "packages/test-utils",
    upstreamName: "@blocknote/test-utils",
    downstreamName: "@pproenca/blocknote-test-utils",
    requiredRuntimeExports: [],
  },
]);

const dependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

export function parseDownstreamReleaseTag(tag) {
  const match = /^pf-v(\d+\.\d+\.\d+)\.(0|[1-9]\d*)$/.exec(tag);

  if (!match) {
    throw new Error(
      `Invalid downstream release tag ${JSON.stringify(tag)}; expected pf-vX.Y.Z.N`,
    );
  }

  const [, upstreamVersion, downstreamRevision] = match;

  return Object.freeze({
    upstreamVersion,
    downstreamRevision,
    downstreamVersion: `${upstreamVersion}-pf.${downstreamRevision}`,
    distributionTag: `pf-${upstreamVersion.replaceAll(".", "-")}-${downstreamRevision}`,
  });
}

export async function validateReleaseEntrypoints({
  packages = downstreamPackages,
} = {}) {
  for (const packageDefinition of packages) {
    const requiredExports = packageDefinition.requiredRuntimeExports;

    if (!Array.isArray(requiredExports) || requiredExports.length === 0) {
      throw new Error(
        `${packageDefinition.upstreamName} has no required runtime export contract`,
      );
    }

    if (
      requiredExports.some(
        (exportName) =>
          typeof exportName !== "string" || exportName.trim() === "",
      ) ||
      new Set(requiredExports).size !== requiredExports.length
    ) {
      throw new Error(
        `${packageDefinition.upstreamName} has an invalid required runtime export contract`,
      );
    }
  }
}

function manifestPath(root, packageDefinition) {
  return path.join(root, packageDefinition.directory, "package.json");
}

async function readManifest(root, packageDefinition) {
  const file = manifestPath(root, packageDefinition);
  const manifest = JSON.parse(await readFile(file, "utf8"));

  return { file, manifest, packageDefinition };
}

function expectedDependencyValue(packageDefinition, release) {
  return `npm:${packageDefinition.downstreamName}@${release.downstreamVersion}`;
}

function validateInternalDependencies(
  manifest,
  release,
  packageByUpstreamName,
) {
  for (const field of dependencyFields) {
    for (const [dependencyName, value] of Object.entries(
      manifest[field] ?? {},
    )) {
      const dependencyPackage = packageByUpstreamName.get(dependencyName);

      if (!dependencyPackage) {
        continue;
      }

      const expected = expectedDependencyValue(dependencyPackage, release);

      if (value !== expected) {
        throw new Error(
          `${manifest.name} ${field}.${dependencyName} must be ${expected}; received ${value}`,
        );
      }
    }
  }
}

export async function validateDownstreamManifests({ root, release, prepared }) {
  const packageByUpstreamName = new Map(
    downstreamPackages.map((item) => [item.upstreamName, item]),
  );
  const records = await Promise.all(
    downstreamPackages.map((item) => readManifest(root, item)),
  );

  for (const { manifest, packageDefinition } of records) {
    const expectedName = prepared
      ? packageDefinition.downstreamName
      : packageDefinition.upstreamName;
    const expectedVersion = prepared
      ? release.downstreamVersion
      : release.upstreamVersion;

    if (manifest.name !== expectedName) {
      throw new Error(
        `${packageDefinition.directory} must be named ${expectedName}; received ${manifest.name}`,
      );
    }

    if (manifest.version !== expectedVersion) {
      throw new Error(
        `${manifest.name} must be version ${expectedVersion}; received ${manifest.version}`,
      );
    }

    if (manifest.private === true) {
      throw new Error(`${manifest.name} must be publishable`);
    }

    if (Object.hasOwn(manifest, "publishConfig")) {
      throw new Error(`${manifest.name} must not define publishConfig`);
    }

    if (prepared) {
      validateInternalDependencies(manifest, release, packageByUpstreamName);
    }
  }

  return records;
}

export async function prepareDownstreamManifests({ root, release }) {
  const records = await validateDownstreamManifests({
    root,
    release,
    prepared: false,
  });
  const packageByUpstreamName = new Map(
    downstreamPackages.map((item) => [item.upstreamName, item]),
  );

  const preparedRecords = records.map(
    ({ file, manifest, packageDefinition }) => {
      const next = structuredClone(manifest);

      next.name = packageDefinition.downstreamName;
      next.version = release.downstreamVersion;
      next.homepage = "https://github.com/pproenca/BlockNote";
      next.repository = {
        ...next.repository,
        url: "git+https://github.com/pproenca/BlockNote.git",
      };
      delete next.gitHead;

      for (const field of dependencyFields) {
        for (const dependencyName of Object.keys(next[field] ?? {})) {
          const dependencyPackage = packageByUpstreamName.get(dependencyName);

          if (dependencyPackage) {
            next[field][dependencyName] = expectedDependencyValue(
              dependencyPackage,
              release,
            );
          }
        }
      }

      return { file, manifest: next };
    },
  );

  await Promise.all(
    preparedRecords.map(({ file, manifest }) =>
      writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`),
    ),
  );

  await validateDownstreamManifests({ root, release, prepared: true });
}

function tarballName(packageName, version) {
  return `${packageName.slice(1).replace("/", "-")}-${version}.tgz`;
}

export async function validatePackedArtifacts({
  artifactDirectory,
  release,
  prepared,
}) {
  const files = new Set(await readdir(artifactDirectory));
  const expected = downstreamPackages.map((packageDefinition) =>
    tarballName(
      prepared
        ? packageDefinition.downstreamName
        : packageDefinition.upstreamName,
      prepared ? release.downstreamVersion : release.upstreamVersion,
    ),
  );

  for (const file of expected) {
    if (!files.delete(file)) {
      throw new Error(`Missing packed artifact ${file}`);
    }
  }

  const unexpectedTarballs = [...files].filter((file) => file.endsWith(".tgz"));

  if (unexpectedTarballs.length > 0) {
    throw new Error(
      `Unexpected packed artifacts: ${unexpectedTarballs
        .sort((left, right) => left.localeCompare(right))
        .join(", ")}`,
    );
  }
}

export async function getPackedArtifactIntegrity(file) {
  const contents = await readFile(file);
  const digest = createHash("sha512").update(contents).digest("base64");

  return `sha512-${digest}`;
}

function decodeAttestationStatement(attestation) {
  const payload = attestation?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string") {
    return undefined;
  }

  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

export async function validateNpmProvenance({
  auditFile,
  packageName,
  version,
  repository,
  workflowPath,
  workflowRef,
  commit,
}) {
  const audit = JSON.parse(await readFile(auditFile, "utf8"));
  const record = audit.verified?.find(
    (candidate) =>
      candidate.name === packageName && candidate.version === version,
  );

  if (!record) {
    throw new Error(
      `No verified npm attestation for ${packageName}@${version}`,
    );
  }

  for (const attestation of record.attestationBundles ?? []) {
    if (attestation.predicateType !== "https://slsa.dev/provenance/v1") {
      continue;
    }

    const statement = decodeAttestationStatement(attestation);
    const definition = statement?.predicate?.buildDefinition;
    const workflow = definition?.externalParameters?.workflow;
    const source = definition?.resolvedDependencies?.find(
      (dependency) => dependency?.digest?.gitCommit === commit,
    );

    if (
      workflow?.repository === repository &&
      workflow?.path === workflowPath &&
      workflow?.ref === workflowRef &&
      source
    ) {
      return;
    }
  }

  throw new Error(
    `${packageName}@${version} has no provenance from ${repository}/${workflowPath}@${workflowRef} (${commit})`,
  );
}

function consumerTarballPath(artifactDirectory, packageDefinition, release) {
  return path.resolve(
    artifactDirectory,
    tarballName(packageDefinition.downstreamName, release.downstreamVersion),
  );
}

function createConsumerRuntimeProbe(release) {
  const expectedExports = Object.fromEntries(
    downstreamPackages.map(({ upstreamName, requiredRuntimeExports }) => [
      upstreamName,
      requiredRuntimeExports,
    ]),
  );

  return `
import { fileURLToPath } from "node:url";
import path from "node:path";

if ("window" in globalThis || "document" in globalThis) {
  throw new Error("Downstream consumer started with browser globals");
}

const packages = ${JSON.stringify(
    downstreamPackages.map(({ upstreamName, downstreamName }) => ({
      upstreamName,
      downstreamName,
      version: release.downstreamVersion,
    })),
  )};
const expectedExports = ${JSON.stringify(expectedExports)};

for (const packageDefinition of packages) {
  const resolvedPath = fileURLToPath(import.meta.resolve(packageDefinition.upstreamName));
  const parts = resolvedPath.split(path.sep);

  if (!parts.includes("node_modules") || parts.includes("packages")) {
    throw new Error(packageDefinition.upstreamName + " resolved outside the installed consumer: " + resolvedPath);
  }

  const imported = await import(packageDefinition.upstreamName);
  for (const exportName of expectedExports[packageDefinition.upstreamName] ?? []) {
    if (!(exportName in imported)) {
      throw new Error(packageDefinition.upstreamName + " is missing export " + exportName);
    }
  }
}

if ("window" in globalThis || "document" in globalThis) {
  throw new Error("Downstream imports created browser globals");
}
`;
}

function createConsumerTypeProbe() {
  return `${downstreamPackages
    .map(
      ({ upstreamName }, index) =>
        `import * as package_${index} from ${JSON.stringify(upstreamName)};`,
    )
    .join("\n")}\n\nvoid [${downstreamPackages
    .map((_, index) => `package_${index}`)
    .join(", ")}];\n`;
}

export async function createDownstreamConsumer({
  root,
  artifactDirectory,
  consumerDirectory,
  release,
}) {
  await validatePackedArtifacts({
    artifactDirectory,
    release,
    prepared: true,
  });
  const records = await validateDownstreamManifests({
    root,
    release,
    prepared: true,
  });
  const internalNames = new Set(
    downstreamPackages.flatMap(({ upstreamName, downstreamName }) => [
      upstreamName,
      downstreamName,
    ]),
  );
  const dependencies = {};
  const overrides = {};

  for (const { manifest, packageDefinition } of records) {
    const tarball = consumerTarballPath(
      artifactDirectory,
      packageDefinition,
      release,
    );
    const fileDependency = `file:${tarball}`;
    dependencies[packageDefinition.upstreamName] = expectedDependencyValue(
      packageDefinition,
      release,
    );
    overrides[packageDefinition.upstreamName] = fileDependency;

    for (const [peerName, peerVersion] of Object.entries(
      manifest.peerDependencies ?? {},
    )) {
      if (!internalNames.has(peerName) && !(peerName in dependencies)) {
        dependencies[peerName] = peerVersion;
      }
    }
  }

  await mkdir(consumerDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "blocknote-downstream-consumer",
          private: true,
          type: "module",
          dependencies,
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      path.join(consumerDirectory, "pnpm-workspace.yaml"),
      `packages: []\noverrides:\n${Object.entries(overrides)
        .map(
          ([name, value]) =>
            `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`,
        )
        .join("\n")}\n`,
    ),
    writeFile(
      path.join(consumerDirectory, "runtime.mjs"),
      createConsumerRuntimeProbe(release),
    ),
    writeFile(
      path.join(consumerDirectory, "contract.mts"),
      createConsumerTypeProbe(),
    ),
    writeFile(
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
    ),
  ]);
}

async function collectInstalledBlockNotePackages(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin") {
      continue;
    }

    const child = path.join(directory, entry.name);
    const manifestFile = path.join(child, "package.json");

    try {
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      if (
        typeof manifest.name === "string" &&
        (manifest.name.startsWith("@blocknote/") ||
          manifest.name.startsWith("@pproenca/blocknote-"))
      ) {
        result.push({
          directory: await realpath(child),
          name: manifest.name,
          version: manifest.version,
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    await collectInstalledBlockNotePackages(child, result);
  }

  return result;
}

export async function validateDownstreamConsumer({
  consumerDirectory,
  release,
}) {
  const nodeModules = path.join(consumerDirectory, "node_modules");
  const consumerRoot = `${await realpath(consumerDirectory)}${path.sep}`;
  const installed = await collectInstalledBlockNotePackages(nodeModules);

  for (const packageDefinition of downstreamPackages) {
    const aliasDirectory = path.join(
      nodeModules,
      ...packageDefinition.upstreamName.split("/"),
    );
    const resolvedAlias = await realpath(aliasDirectory);
    const manifest = JSON.parse(
      await readFile(path.join(aliasDirectory, "package.json"), "utf8"),
    );

    if (!resolvedAlias.startsWith(consumerRoot)) {
      throw new Error(
        `${packageDefinition.upstreamName} resolved outside the consumer: ${resolvedAlias}`,
      );
    }
    if (
      manifest.name !== packageDefinition.downstreamName ||
      manifest.version !== release.downstreamVersion
    ) {
      throw new Error(
        `${packageDefinition.upstreamName} must alias ${packageDefinition.downstreamName}@${release.downstreamVersion}`,
      );
    }

    const physicalCopies = new Set(
      installed
        .filter(({ name }) => name === packageDefinition.downstreamName)
        .map(({ directory }) => directory),
    );
    if (physicalCopies.size !== 1 || !physicalCopies.has(resolvedAlias)) {
      throw new Error(
        `${packageDefinition.downstreamName} must have one installed copy; found ${physicalCopies.size}`,
      );
    }
  }

  const upstreamCopies = installed.filter(({ name }) =>
    downstreamPackages.some(({ upstreamName }) => upstreamName === name),
  );
  if (upstreamCopies.length > 0) {
    throw new Error(
      `Consumer installed upstream BlockNote packages: ${upstreamCopies
        .map(({ name, version }) => `${name}@${version}`)
        .join(", ")}`,
    );
  }
}

async function main() {
  const [command, tag, ...arguments_] = process.argv.slice(2);
  const release = parseDownstreamReleaseTag(tag);
  const root = process.cwd();

  switch (command) {
    case "validate":
      await validateDownstreamManifests({ root, release, prepared: false });
      return;
    case "release-ready":
      await validateReleaseEntrypoints({ root });
      return;
    case "dist-tag":
      process.stdout.write(release.distributionTag);
      return;
    case "prepare":
      await prepareDownstreamManifests({ root, release });
      return;
    case "verify":
      await validateDownstreamManifests({ root, release, prepared: true });
      return;
    case "verify-artifacts": {
      const [artifactDirectory, state] = arguments_;

      if (!artifactDirectory || !["upstream", "downstream"].includes(state)) {
        throw new Error(
          "verify-artifacts requires a directory and upstream|downstream",
        );
      }

      await validatePackedArtifacts({
        artifactDirectory: path.resolve(root, artifactDirectory),
        release,
        prepared: state === "downstream",
      });
      return;
    }
    case "integrity": {
      const [file] = arguments_;

      if (!file) {
        throw new Error("integrity requires a packed artifact path");
      }

      process.stdout.write(
        await getPackedArtifactIntegrity(path.resolve(root, file)),
      );
      return;
    }
    case "verify-provenance": {
      const [auditFile, packageName, version, commit] = arguments_;

      if (!auditFile || !packageName || !version || !commit) {
        throw new Error(
          "verify-provenance requires audit JSON, package, version, and commit",
        );
      }

      await validateNpmProvenance({
        auditFile: path.resolve(root, auditFile),
        packageName,
        version,
        repository: "https://github.com/pproenca/BlockNote",
        workflowPath: ".github/workflows/downstream-release.yml",
        workflowRef: `refs/tags/${tag}`,
        commit,
      });
      return;
    }
    case "create-consumer": {
      const [artifactDirectory, consumerDirectory] = arguments_;

      if (!artifactDirectory || !consumerDirectory) {
        throw new Error(
          "create-consumer requires artifact and consumer directories",
        );
      }

      await createDownstreamConsumer({
        root,
        artifactDirectory: path.resolve(root, artifactDirectory),
        consumerDirectory: path.resolve(root, consumerDirectory),
        release,
      });
      return;
    }
    case "verify-consumer": {
      const [consumerDirectory] = arguments_;

      if (!consumerDirectory) {
        throw new Error("verify-consumer requires a consumer directory");
      }

      await validateDownstreamConsumer({
        consumerDirectory: path.resolve(root, consumerDirectory),
        release,
      });
      return;
    }
    default:
      throw new Error(`Unknown downstream release command ${command}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
