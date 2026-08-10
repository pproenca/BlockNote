/**
 * @vitest-environment jsdom
 */
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { BlockNoteSchema } from "../blocks/BlockNoteSchema.js";
import type { BlockNoteAccessStore } from "../access/BlockNoteAccess.js";
import {
  createExtension,
  type ExtensionOptions,
} from "../editor/BlockNoteExtension.js";
import { BlockNoteEditor } from "../editor/BlockNoteEditor.js";
import { isBlockNoteError } from "../platform/BlockNoteError.js";
import {
  createBlockNoteDocument,
  defineBlockNoteDocument,
  type BlockNoteBlockFromSchema,
  type BlockNoteRuntimeContext,
  type RegisteredBlockNoteDocument,
} from "./BlockNoteDocument.js";
import {
  getBlockNoteDocumentInternals,
  registerBlockNoteExtensionHeadlessProjection,
} from "./BlockNoteDocumentInternals.js";

interface AccessContext {
  readonly access: BlockNoteAccessStore;
}

interface CommentsContext {
  readonly comments: {
    readonly load: () => Promise<void>;
  };
}

const AccessExtension = createExtension(
  ({ context }: ExtensionOptions<undefined, AccessContext>) => ({
    key: "document-access",
    access: context.access,
  }),
  { name: "access", version: "1" },
);

const CommentsExtension = createExtension(
  ({ context }: ExtensionOptions<undefined, CommentsContext>) => ({
    key: "document-comments",
    load: context.comments.load,
  }),
  { name: "comments", version: "2", dependencies: ["access"] as const },
);

const schema = BlockNoteSchema.create();
const document = defineBlockNoteDocument({
  id: "requirements",
  version: "3",
  schema,
  extensions: [AccessExtension(), CommentsExtension()],
  metadata: { product: "factory" as const },
});

describe("defineBlockNoteDocument", () => {
  it("preserves configuration and composed context types", () => {
    type Context = BlockNoteRuntimeContext<typeof document>;
    type Registered = RegisteredBlockNoteDocument<{
      document: typeof document;
    }>;

    expectTypeOf(document.id).toEqualTypeOf<"requirements">();
    expectTypeOf(document.version).toEqualTypeOf<"3">();
    expectTypeOf(document.metadata).toEqualTypeOf<{
      readonly product: "factory";
    }>();
    expectTypeOf<Context>().toEqualTypeOf<AccessContext & CommentsContext>();
    expectTypeOf<Registered>().toEqualTypeOf<typeof document>();
    expectTypeOf<BlockNoteBlockFromSchema<typeof schema>>().toEqualTypeOf<
      typeof schema.Block
    >();

    const checkContextRequirements = () => {
      // @ts-expect-error both extension contexts are required
      BlockNoteEditor.create({ document, context: {} });
      // @ts-expect-error a document with required context cannot omit it
      BlockNoteEditor.create({ document });
    };
    expectTypeOf(checkContextRequirements).toBeFunction();

    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.extensions)).toBe(true);
    expect(document.extensions.map((extension) => extension.name)).toEqual([
      "access",
      "comments",
    ]);
    expect(getBlockNoteDocumentInternals(document).formatFingerprint).toBe(
      '["requirements","3",[["access","1"],["comments","2"]]]',
    );
  });

  it("provides createBlockNoteDocument as the factory spelling", () => {
    const created = createBlockNoteDocument({
      id: "notes",
      version: "1",
      schema,
    });

    expect(created.id).toBe("notes");
    expect(created.extensions).toEqual([]);
  });

  it("freezes private headless projection contributions off-definition", () => {
    const extension = AccessExtension();
    const contribution = (input: { readonly markdown: string }) => ({
      searchText: input.markdown,
    });
    registerBlockNoteExtensionHeadlessProjection(extension, contribution);
    const created = defineBlockNoteDocument({
      id: "headless",
      version: "1",
      schema,
      extensions: [extension],
    });
    const registered = getBlockNoteDocumentInternals(created);

    expect(Object.keys(created)).not.toContain(
      "headlessProjectionContributions",
    );
    expect(Object.isFrozen(registered.headlessProjectionContributions)).toBe(
      true,
    );
    expect(registered.headlessProjectionContributions).toEqual([contribution]);
  });

  it("rejects duplicate extension names", () => {
    const DuplicateAccess = createExtension(
      () => ({ key: "duplicate-access" }),
      { name: "access", version: "2" },
    );

    expect(() =>
      defineBlockNoteDocument({
        id: "duplicate",
        version: "1",
        schema,
        extensions: [AccessExtension(), DuplicateAccess()],
      }),
    ).toThrowError('Duplicate BlockNote extension "access".');
  });

  it("rejects missing dependencies and canonicalizes dependency order", () => {
    expect(() =>
      defineBlockNoteDocument({
        id: "missing",
        version: "1",
        schema,
        extensions: [CommentsExtension()],
      }),
    ).toThrowError(
      'BlockNote extension "comments" depends on missing extension "access".',
    );

    const reversedExtensions = [
      CommentsExtension(),
      AccessExtension(),
    ] as const;
    const reordered = defineBlockNoteDocument({
      id: "order",
      version: "1",
      schema,
      extensions: reversedExtensions,
    });

    expectTypeOf(reordered.extensions).toEqualTypeOf<
      ReadonlyArray<(typeof reversedExtensions)[number]>
    >();
    expect(reordered.extensions.map((extension) => extension.name)).toEqual([
      "access",
      "comments",
    ]);
    expect(getBlockNoteDocumentInternals(reordered).formatFingerprint).toBe(
      '["order","1",[["access","1"],["comments","2"]]]',
    );
  });

  it("reports dependency cycles deterministically", () => {
    const First = createExtension(() => ({ key: "first" }), {
      name: "first",
      version: "1",
      dependencies: ["second"] as const,
    });
    const Second = createExtension(() => ({ key: "second" }), {
      name: "second",
      version: "1",
      dependencies: ["first"] as const,
    });

    let failure: unknown;
    try {
      defineBlockNoteDocument({
        id: "cycle",
        version: "1",
        schema,
        extensions: [First(), Second()],
      });
    } catch (error) {
      failure = error;
    }

    expect(isBlockNoteError(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: "incompatible-document",
      retryable: false,
      message:
        "Cyclic BlockNote extension dependencies: first -> second -> first.",
    });
  });
});
