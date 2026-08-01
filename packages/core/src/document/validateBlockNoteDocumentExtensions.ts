import type { AnyBlockNoteDocumentExtension } from "./BlockNoteDocumentExtension.js";
import { BlockNoteError } from "../platform/BlockNoteError.js";

function configurationError(message: string) {
  return new BlockNoteError("incompatible-document", message);
}

export function assertBlockNoteIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configurationError(`${label} must be a non-empty string.`);
  }
}

export function isBlockNoteDocumentExtension(
  value: unknown,
): value is AnyBlockNoteDocumentExtension {
  const extension = value as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly dependencies?: unknown;
    readonly options?: unknown;
  };

  return (
    typeof value === "function" &&
    typeof extension.name === "string" &&
    typeof extension.version === "string" &&
    Array.isArray(extension.dependencies) &&
    "options" in extension
  );
}

export function validateBlockNoteDocumentExtensions(
  extensions: readonly AnyBlockNoteDocumentExtension[],
) {
  const byName = new Map<string, AnyBlockNoteDocumentExtension>();

  for (const extension of extensions) {
    if (!isBlockNoteDocumentExtension(extension)) {
      throw configurationError(
        "Document extensions must be configured semantic BlockNote extensions.",
      );
    }

    assertBlockNoteIdentifier(extension.name, "Extension name");
    assertBlockNoteIdentifier(
      extension.version,
      `Version for BlockNote extension "${extension.name}"`,
    );

    if (byName.has(extension.name)) {
      throw configurationError(
        `Duplicate BlockNote extension "${extension.name}".`,
      );
    }

    byName.set(extension.name, extension);
  }

  for (const extension of extensions) {
    const dependencyNames = new Set<string>();
    for (const dependency of extension.dependencies) {
      assertBlockNoteIdentifier(
        dependency,
        `Dependency for BlockNote extension "${extension.name}"`,
      );

      if (dependencyNames.has(dependency)) {
        throw configurationError(
          `BlockNote extension "${extension.name}" declares dependency "${dependency}" more than once.`,
        );
      }
      dependencyNames.add(dependency);

      if (!byName.has(dependency)) {
        throw configurationError(
          `BlockNote extension "${extension.name}" depends on missing extension "${dependency}".`,
        );
      }
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const path: string[] = [];
  const ordered: AnyBlockNoteDocumentExtension[] = [];

  const visit = (name: string): void => {
    if (state.get(name) === "visited") {
      return;
    }

    if (state.get(name) === "visiting") {
      const cycleStart = path.indexOf(name);
      const cycle = [...path.slice(cycleStart), name];
      throw configurationError(
        `Cyclic BlockNote extension dependencies: ${cycle.join(" -> ")}.`,
      );
    }

    state.set(name, "visiting");
    path.push(name);
    for (const dependency of byName.get(name)!.dependencies) {
      visit(dependency);
    }
    path.pop();
    state.set(name, "visited");
    ordered.push(byName.get(name)!);
  };

  for (const extension of extensions) {
    visit(extension.name);
  }

  return new Map(ordered.map((extension) => [extension.name, extension]));
}
