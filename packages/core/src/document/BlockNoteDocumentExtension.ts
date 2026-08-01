export type BlockNoteEmptyContext = Record<never, never>;

export interface BlockNoteDocumentExtensionMetadata<
  Name extends string = string,
  Version extends string = string,
  Dependencies extends readonly string[] = readonly string[],
> {
  readonly name: Name;
  readonly version: Version;
  readonly dependencies?: Dependencies;
}

export interface BlockNoteDocumentExtensionTypes<
  Context extends object,
  ExtensionInstance,
  Projection extends object,
> {
  readonly context: Context;
  readonly extension: ExtensionInstance;
  readonly projection: Projection;
}

/**
 * Immutable semantic configuration for a native BlockNote extension.
 *
 * The runtime extension factory is deliberately opaque. Applications select
 * capabilities and provide BlockNote context; only BlockNote instantiates the
 * engine-facing extension.
 */
export interface BlockNoteDocumentExtension<
  Name extends string = string,
  Version extends string = string,
  Dependencies extends readonly string[] = readonly string[],
  Options = unknown,
  Context extends object = BlockNoteEmptyContext,
  ExtensionInstance = unknown,
  Projection extends object = BlockNoteEmptyContext,
> {
  readonly name: Name;
  readonly version: Version;
  readonly dependencies: Dependencies;
  readonly options: Options;
  readonly "~types": BlockNoteDocumentExtensionTypes<
    Context,
    ExtensionInstance,
    Projection
  >;
}

export type AnyBlockNoteDocumentExtension = BlockNoteDocumentExtension<
  string,
  string,
  readonly string[],
  any,
  any,
  any,
  any
>;
