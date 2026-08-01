import type {
  AnyBlockNoteDocumentExtension,
  BlockNoteDocumentExtension,
  BlockNoteEmptyContext,
} from "./BlockNoteDocumentExtension.js";
import type {
  BlockNoDefaults,
  BlockSchema,
  CustomBlockNoteSchema,
  InlineContentSchema,
  StyleSchema,
} from "../schema/index.js";
import {
  assertBlockNoteIdentifier,
  validateBlockNoteDocumentExtensions,
} from "./validateBlockNoteDocumentExtensions.js";
import { registerBlockNoteDocumentInternals } from "./BlockNoteDocumentInternals.js";

export interface BlockNoteDocumentLimits {
  readonly documentBytes?: number;
  readonly blocks?: number;
  readonly depth?: number;
  readonly textCharacters?: number;
}

type AnyBlockNoteSchema = CustomBlockNoteSchema<any, any, any>;

type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

type ExtensionContext<Extension> =
  Extension extends BlockNoteDocumentExtension<
    any,
    any,
    any,
    any,
    infer Context,
    any,
    any
  >
    ? Context
    : never;

type ExtensionProjection<Extension> =
  Extension extends BlockNoteDocumentExtension<
    any,
    any,
    any,
    any,
    any,
    any,
    infer Projection
  >
    ? Projection
    : never;

type NormalizeComposition<Composition> = Composition extends object
  ? Composition
  : BlockNoteEmptyContext;

export type BlockNoteDocumentContext<
  Extensions extends readonly AnyBlockNoteDocumentExtension[],
> = [Extensions[number]] extends [never]
  ? BlockNoteEmptyContext
  : NormalizeComposition<
      UnionToIntersection<ExtensionContext<Extensions[number]>>
    >;

export type BlockNoteDocumentExtensionProjection<
  Extensions extends readonly AnyBlockNoteDocumentExtension[],
> = [Extensions[number]] extends [never]
  ? BlockNoteEmptyContext
  : NormalizeComposition<
      UnionToIntersection<ExtensionProjection<Extensions[number]>>
    >;

export type BlockNoteBlockFromSchema<Schema> =
  Schema extends CustomBlockNoteSchema<
    infer BSchema extends BlockSchema,
    infer ISchema extends InlineContentSchema,
    infer SSchema extends StyleSchema
  >
    ? BlockNoDefaults<BSchema, ISchema, SSchema>
    : never;

export interface BlockNoteDocumentDefinitionTypes<
  Schema extends AnyBlockNoteSchema,
  Context extends object,
  Projection extends object,
  Metadata,
> {
  readonly blocks: BlockNoteBlockFromSchema<Schema>;
  readonly context: Context;
  readonly projection: Projection;
  readonly metadata: Metadata;
}

export interface BlockNoteDocumentDefinition<
  Schema extends AnyBlockNoteSchema = AnyBlockNoteSchema,
  Extensions extends readonly AnyBlockNoteDocumentExtension[] =
    readonly AnyBlockNoteDocumentExtension[],
  Context extends object = BlockNoteDocumentContext<Extensions>,
  Id extends string = string,
  Version extends string = string,
  Metadata = undefined,
  Limits extends BlockNoteDocumentLimits | undefined =
    | BlockNoteDocumentLimits
    | undefined,
> {
  readonly id: Id;
  readonly version: Version;
  readonly schema: Schema;
  readonly extensions: ReadonlyArray<Extensions[number]>;
  readonly metadata: Metadata;
  readonly limits: Limits;
  readonly "~types": BlockNoteDocumentDefinitionTypes<
    Schema,
    Context,
    BlockNoteDocumentExtensionProjection<Extensions>,
    Metadata
  >;
}

export type AnyBlockNoteDocumentDefinition = BlockNoteDocumentDefinition<
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

export type BlockNoteRuntimeContext<
  Document extends AnyBlockNoteDocumentDefinition,
> = Document["~types"]["context"];

export interface Register {}

export type RegisteredBlockNoteDocument<Registration = Register> =
  Registration extends {
    readonly document: infer Document extends AnyBlockNoteDocumentDefinition;
  }
    ? Document
    : AnyBlockNoteDocumentDefinition;

function immutableConfigurationValue<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return Object.freeze([...value]) as Value;
  }

  if (
    value &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return Object.freeze({ ...value }) as Value;
  }

  return value;
}

export function defineBlockNoteDocument<
  const Id extends string,
  const Version extends string,
  const Schema extends AnyBlockNoteSchema,
  const Extensions extends readonly AnyBlockNoteDocumentExtension[] =
    readonly [],
  const Metadata = undefined,
  const Limits extends BlockNoteDocumentLimits | undefined = undefined,
>(options: {
  readonly id: Id;
  readonly version: Version;
  readonly schema: Schema;
  readonly extensions?: Extensions;
  readonly metadata?: Metadata;
  readonly limits?: Limits;
}): BlockNoteDocumentDefinition<
  Schema,
  Extensions,
  BlockNoteDocumentContext<Extensions>,
  Id,
  Version,
  Metadata,
  Limits
> {
  assertBlockNoteIdentifier(options.id, "Document id");
  assertBlockNoteIdentifier(options.version, "Document version");

  const configuredExtensions = (options.extensions ?? []) as Extensions;
  const extensions = [
    ...validateBlockNoteDocumentExtensions(configuredExtensions).values(),
  ] as Array<Extensions[number]>;

  const document = Object.freeze({
    id: options.id,
    version: options.version,
    schema: options.schema,
    extensions: Object.freeze([...extensions]),
    metadata: immutableConfigurationValue(options.metadata),
    limits: immutableConfigurationValue(options.limits),
  }) as BlockNoteDocumentDefinition<
    Schema,
    Extensions,
    BlockNoteDocumentContext<Extensions>,
    Id,
    Version,
    Metadata,
    Limits
  >;

  registerBlockNoteDocumentInternals(document, {
    formatFingerprint: JSON.stringify([
      document.id,
      document.version,
      document.extensions.map((extension) => [
        extension.name,
        extension.version,
      ]),
    ]),
  });

  return document;
}

export const createBlockNoteDocument = defineBlockNoteDocument;
