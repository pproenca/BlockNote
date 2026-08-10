import type {
  AnyBlockNoteDocumentDefinition,
  BlockNoteBlockFromSchema,
  BlockNoteBootstrap,
  BlockNoteCommentAnchor,
  BlockNoteCommentAnchorCapture,
  BlockNoteCommentAnchorVerificationBundle,
  BlockNoteDocumentStore,
  BlockNoteRevision,
} from "@blocknote/core";
import {
  BlockNoteError,
  blockNoteDocumentBinding,
} from "@blocknote/core/persistence";
import { blockNoteBootstrapInternals } from "@blocknote/core/persistence/internal";
import { getBlockNoteDocumentInternals } from "@blocknote/core/runtime";
import * as Y from "@y/y";

import {
  createBlockNoteCommentAnchorAuthority,
  type BlockNoteCommentAnchorKeyRing,
} from "./comment-anchor-authority.js";
import {
  createEmptyCheckpoint,
  equalBlockNoteRevision,
  reconstructBlockNoteDocument,
  validateBlockNoteRevision,
  type ReconstructedBlockNoteDocument,
} from "./reconstruct.js";
import {
  projectBlockNoteDocument,
  type BlockNoteProjection,
} from "./project.js";

type BlockForDocument<Document extends AnyBlockNoteDocumentDefinition> =
  BlockNoteBlockFromSchema<Document["schema"]>;

type ProjectionForDocument<Document extends AnyBlockNoteDocumentDefinition> =
  Document["~types"]["projection"];

export interface BlockNoteDocumentService<
  TKey,
  Document extends AnyBlockNoteDocumentDefinition =
    AnyBlockNoteDocumentDefinition,
> {
  initialize(key: TKey): Promise<BlockNoteRevision>;
  createBootstrap(key: TKey): Promise<BlockNoteBootstrap>;
  project(
    key: TKey,
  ): Promise<
    BlockNoteProjection<
      BlockForDocument<Document>,
      ProjectionForDocument<Document>
    >
  >;
  createCommentAnchorVerificationBundle(): Promise<BlockNoteCommentAnchorVerificationBundle>;
  sealCommentAnchor(
    key: TKey,
    capture: BlockNoteCommentAnchorCapture,
    options?: { readonly signal?: AbortSignal },
  ): Promise<BlockNoteCommentAnchor>;
  validateCommentAnchor(
    key: TKey,
    anchor: BlockNoteCommentAnchor,
    options?: { readonly signal?: AbortSignal },
  ): Promise<boolean>;
}

export interface BlockNoteDocumentServiceOptions<
  TKey,
  Document extends AnyBlockNoteDocumentDefinition,
> {
  readonly document: Document;
  readonly store: BlockNoteDocumentStore<TKey>;
  readonly commentAnchorKeyRing?: BlockNoteCommentAnchorKeyRing;
}

const initialRevision = Object.freeze({ sequence: 0, token: "initial" });

function cleanupFailure(error: unknown) {
  return new BlockNoteError(
    "extension-cleanup-failed",
    "BlockNote headless runtime cleanup failed.",
    { cause: error },
  );
}

function attachCleanupFailure(primary: unknown, cleanup: BlockNoteError) {
  if (!(primary instanceof Error)) {
    return;
  }
  try {
    if (primary.cause === undefined) {
      Object.defineProperty(primary, "cause", {
        configurable: true,
        value: cleanup,
        writable: true,
      });
    } else {
      Object.defineProperty(primary, "suppressed", {
        configurable: true,
        value: Object.freeze([cleanup]),
        writable: true,
      });
    }
  } catch {
    // Cleanup remains secondary to the stable primary failure.
  }
}

function randomBinding() {
  const runtimeCrypto = globalThis.crypto;
  if (!runtimeCrypto?.getRandomValues) {
    throw new BlockNoteError(
      "incompatible-document",
      "Cryptographically secure document binding generation is unavailable.",
    );
  }
  const bytes = new Uint8Array(32);
  runtimeCrypto.getRandomValues(bytes);
  return blockNoteDocumentBinding.fromBytes(bytes);
}

function externalAnchorsEnabled(document: AnyBlockNoteDocumentDefinition) {
  return document.extensions.some((extension) => {
    if (extension.name !== "comments") {
      return false;
    }
    const options = extension.options;
    return (
      !!options &&
      typeof options === "object" &&
      "target" in options &&
      options.target === "external"
    );
  });
}

export function createBlockNoteDocumentService<
  TKey,
  const Document extends AnyBlockNoteDocumentDefinition,
>(
  options: BlockNoteDocumentServiceOptions<TKey, Document>,
): BlockNoteDocumentService<TKey, Document> {
  if (
    externalAnchorsEnabled(options.document) &&
    !options.commentAnchorKeyRing
  ) {
    throw new BlockNoteError(
      "incompatible-document",
      "External comment anchors require a server signing key ring.",
    );
  }
  const authority = options.commentAnchorKeyRing
    ? createBlockNoteCommentAnchorAuthority(options.commentAnchorKeyRing)
    : null;

  const requireAuthority = () => {
    if (!authority) {
      throw new BlockNoteError(
        "incompatible-document",
        "BlockNote comment anchor signing is not configured.",
      );
    }
    return authority;
  };

  const load = async (key: TKey) => {
    const stored = await options.store.load(key);
    if (!stored) {
      throw new BlockNoteError(
        "invalid-document",
        "BlockNote document is not initialized.",
      );
    }
    return stored;
  };

  const withRuntime = async <Result>(
    key: TKey,
    action: (
      runtime: ReconstructedBlockNoteDocument,
    ) => Promise<Result> | Result,
  ) => {
    const runtime = reconstructBlockNoteDocument(
      options.document,
      await load(key),
    );
    let primary: unknown;
    try {
      return await action(runtime);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      try {
        runtime.doc.destroy();
      } catch (error) {
        const cleanup = cleanupFailure(error);
        if (primary !== undefined) {
          attachCleanupFailure(primary, cleanup);
        } else {
          throw cleanup;
        }
      }
    }
  };

  return Object.freeze({
    async initialize(key: TKey) {
      const existing = await options.store.load(key);
      if (existing) {
        return withRuntime(key, (runtime) => runtime.revision);
      }
      const revision = initialRevision;
      const result = await options.store.initialize({
        key,
        binding: randomBinding(),
        checkpoint: createEmptyCheckpoint(options.document, revision),
        revision,
      });
      if (result.status === "committed") {
        const committed = validateBlockNoteRevision(result.revision);
        if (!equalBlockNoteRevision(committed, revision)) {
          throw new BlockNoteError(
            "incompatible-document",
            "BlockNote store returned an incompatible initialization revision.",
          );
        }
        return committed;
      }
      return withRuntime(key, (runtime) => runtime.revision);
    },
    async createBootstrap(key: TKey) {
      const verificationBundle = authority
        ? await authority.createVerificationBundle()
        : undefined;
      return withRuntime(key, (runtime) => {
        return blockNoteBootstrapInternals.create({
          binding: runtime.binding,
          documentId: options.document.id,
          definitionVersion: options.document.version,
          definitionFingerprint: getBlockNoteDocumentInternals(options.document)
            .formatFingerprint,
          verificationBundle,
          checkpoint: Y.encodeStateAsUpdate(runtime.doc as Y.Doc),
        });
      });
    },
    async project(key: TKey) {
      return withRuntime(key, (runtime) =>
        projectBlockNoteDocument({
          document: options.document,
          doc: runtime.doc,
          content: runtime.content,
          revision: runtime.revision,
        }),
      ) as Promise<
        BlockNoteProjection<
          BlockForDocument<Document>,
          ProjectionForDocument<Document>
        >
      >;
    },
    async createCommentAnchorVerificationBundle() {
      return requireAuthority().createVerificationBundle();
    },
    async sealCommentAnchor(
      key: TKey,
      capture: BlockNoteCommentAnchorCapture,
      sealOptions?: { readonly signal?: AbortSignal },
    ) {
      return withRuntime(key, (runtime) =>
        requireAuthority().seal(runtime, capture, sealOptions),
      );
    },
    async validateCommentAnchor(
      key: TKey,
      anchor: BlockNoteCommentAnchor,
      validationOptions?: { readonly signal?: AbortSignal },
    ) {
      return withRuntime(key, (runtime) =>
        requireAuthority().validate(runtime, anchor, validationOptions),
      );
    },
  });
}
