import { validateBlockNoteDocumentExtensions } from "../../../document/validateBlockNoteDocumentExtensions.js";
import type { AnyBlockNoteDocumentExtension } from "../../../document/BlockNoteDocumentExtension.js";
import type { Extension } from "../../BlockNoteExtension.js";

export class SemanticExtensionRegistry {
  private readonly configurations = new Map<
    Extension,
    AnyBlockNoteDocumentExtension
  >();

  private readonly dependents = new Map<string, Set<string>>();

  public add(
    extension: Extension,
    configuration: AnyBlockNoteDocumentExtension,
  ) {
    this.configurations.set(extension, configuration);
  }

  public get(extension: Extension) {
    return this.configurations.get(extension);
  }

  public getDependents(runtimeKey: string) {
    return this.dependents.get(runtimeKey);
  }

  public validate() {
    const configurations = [...this.configurations.values()];
    const byName = validateBlockNoteDocumentExtensions(configurations);
    const extensionByName = new Map(
      [...this.configurations].map(([extension, configuration]) => [
        configuration.name,
        extension,
      ]),
    );

    for (const configuration of byName.values()) {
      const extension = extensionByName.get(configuration.name)!;
      for (const dependency of configuration.dependencies) {
        const dependencyKey = extensionByName.get(dependency)!.key;
        let dependents = this.dependents.get(dependencyKey);
        if (!dependents) {
          dependents = new Set();
          this.dependents.set(dependencyKey, dependents);
        }
        dependents.add(extension.key);
      }
    }
  }

  public clear() {
    this.configurations.clear();
    this.dependents.clear();
  }
}
