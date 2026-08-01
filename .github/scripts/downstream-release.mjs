import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const downstreamPackages = Object.freeze([
  {
    directory: "packages/core",
    upstreamName: "@blocknote/core",
    downstreamName: "@pproenca/blocknote-core",
  },
  {
    directory: "packages/collaboration",
    upstreamName: "@blocknote/collaboration",
    downstreamName: "@pproenca/blocknote-collaboration",
  },
  {
    directory: "packages/collaboration-server",
    upstreamName: "@blocknote/collaboration-server",
    downstreamName: "@pproenca/blocknote-collaboration-server",
  },
  {
    directory: "packages/react",
    upstreamName: "@blocknote/react",
    downstreamName: "@pproenca/blocknote-react",
  },
  {
    directory: "packages/server-util",
    upstreamName: "@blocknote/server-util",
    downstreamName: "@pproenca/blocknote-server-util",
  },
  {
    directory: "packages/test-utils",
    upstreamName: "@blocknote/test-utils",
    downstreamName: "@pproenca/blocknote-test-utils",
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
  });
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
      `Unexpected packed artifacts: ${unexpectedTarballs.sort().join(", ")}`,
    );
  }
}

export async function getPackedArtifactIntegrity(file) {
  const contents = await readFile(file);
  const digest = createHash("sha512").update(contents).digest("base64");

  return `sha512-${digest}`;
}

async function main() {
  const [command, tag, ...arguments_] = process.argv.slice(2);
  const release = parseDownstreamReleaseTag(tag);
  const root = process.cwd();

  switch (command) {
    case "validate":
      await validateDownstreamManifests({ root, release, prepared: false });
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
    default:
      throw new Error(`Unknown downstream release command ${command}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
