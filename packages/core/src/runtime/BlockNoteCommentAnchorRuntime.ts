import type { BlockNoteCommentAnchor } from "../comments/external/BlockNoteCommentAnchor.js";
import type { BlockNoteCommentAnchorCapture } from "../comments/external/BlockNoteCommentAnchorCapture.js";
import type { BlockNoteCommentAnchorVerificationBundle } from "../comments/external/BlockNoteCommentAnchorVerificationBundle.js";
import {
  decodeAnchorFrame,
  decodeCaptureFrame,
  decodeVerificationBundleFrame,
} from "../comments/external/comment-anchor-frame.js";
import { BlockNoteError } from "../platform/BlockNoteError.js";
import type { BlockNoteDocumentBinding } from "../persistence/BlockNoteDocumentBinding.js";

type AnchorValueKind = "capture" | "anchor" | "verification";
type AnchorValue =
  | BlockNoteCommentAnchorCapture
  | BlockNoteCommentAnchor
  | BlockNoteCommentAnchorVerificationBundle;

export type BlockNoteCommentAnchorMappingResult =
  | {
      readonly status: "attached";
      readonly range: { readonly from: number; readonly to: number };
    }
  | { readonly status: "detached" }
  | { readonly status: "unknown" };

export interface BlockNoteCommentAnchorMapping {
  capture(range: {
    readonly from: number;
    readonly to: number;
  }): BlockNoteCommentAnchorCapture;
  mapCapture(
    value: BlockNoteCommentAnchorCapture,
  ): BlockNoteCommentAnchorMappingResult;
  mapAnchor(value: BlockNoteCommentAnchor): BlockNoteCommentAnchorMappingResult;
}

export interface BlockNoteCommentAnchorRuntime {
  readonly definitionFingerprint: string;
  readonly documentBinding: BlockNoteDocumentBinding;
  capture(range: {
    readonly from: number;
    readonly to: number;
  }): BlockNoteCommentAnchorCapture;
  mapCapture(
    value: BlockNoteCommentAnchorCapture,
  ): BlockNoteCommentAnchorMappingResult;
  mapAnchor(value: BlockNoteCommentAnchor): BlockNoteCommentAnchorMappingResult;
}

export interface BlockNoteCommentAnchorProtocol {
  readonly version: 1;
  createValue(kind: AnchorValueKind, frame: Uint8Array): AnchorValue;
  readValue(
    value: AnchorValue,
    expectedKind: AnchorValueKind,
  ): Uint8Array | null;
  createBinding(bytes: Uint8Array): BlockNoteDocumentBinding;
  readBinding(value: BlockNoteDocumentBinding): Uint8Array | null;
  inspectCapture(value: BlockNoteCommentAnchorCapture): {
    readonly from: Uint8Array;
    readonly to: Uint8Array;
  };
  inspectAnchor(value: BlockNoteCommentAnchor): {
    readonly documentBinding: BlockNoteDocumentBinding;
    readonly definitionFingerprint: string;
    readonly from: Uint8Array;
    readonly to: Uint8Array;
    readonly keyId: string;
    readonly payload: Uint8Array;
    readonly signature: Uint8Array;
  };
  inspectVerificationBundle(value: BlockNoteCommentAnchorVerificationBundle): {
    readonly revision: number;
    readonly keys: readonly {
      readonly keyId: string;
      readonly publicKey: Uint8Array;
    }[];
  };
}

const protocolKey = Symbol.for("@blocknote/core/comment-anchor-runtime/v1");
const valueKinds = {
  capture: "blocknote-comment-anchor-capture",
  anchor: "blocknote-comment-anchor",
  verification: "blocknote-comment-anchor-verification",
} as const;

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function validProtocol(
  value: unknown,
): value is BlockNoteCommentAnchorProtocol {
  if (!value || typeof value !== "object" || !Object.isFrozen(value)) {
    return false;
  }
  const candidate = value as Partial<BlockNoteCommentAnchorProtocol>;
  return (
    candidate.version === 1 &&
    typeof candidate.createValue === "function" &&
    typeof candidate.readValue === "function" &&
    typeof candidate.createBinding === "function" &&
    typeof candidate.readBinding === "function" &&
    typeof candidate.inspectCapture === "function" &&
    typeof candidate.inspectAnchor === "function" &&
    typeof candidate.inspectVerificationBundle === "function"
  );
}

function createProtocol(): BlockNoteCommentAnchorProtocol {
  const values = new WeakMap<
    object,
    { kind: AnchorValueKind; frame: Uint8Array }
  >();
  const bindings = new WeakMap<object, Uint8Array>();

  const protocol: BlockNoteCommentAnchorProtocol = {
    version: 1,
    createValue(kind, input) {
      const frame = Uint8Array.from(input);
      if (kind === "capture") {
        decodeCaptureFrame(frame);
      } else if (kind === "anchor") {
        decodeAnchorFrame(frame);
      } else if (kind === "verification") {
        decodeVerificationBundleFrame(frame);
      } else {
        throw new BlockNoteError(
          "invalid-anchor",
          "BlockNote anchor kind is invalid.",
        );
      }
      const value = Object.freeze({
        kind: valueKinds[kind],
        byteLength: frame.byteLength,
      }) as AnchorValue;
      values.set(value, { kind, frame });
      return value;
    },
    readValue(value, expectedKind) {
      if (
        !value ||
        (typeof value !== "object" && typeof value !== "function")
      ) {
        return null;
      }
      const stored = values.get(value);
      return stored?.kind === expectedKind
        ? Uint8Array.from(stored.frame)
        : null;
    },
    createBinding(input) {
      if (!(input instanceof Uint8Array) || input.byteLength !== 32) {
        throw new BlockNoteError(
          "invalid-document",
          "BlockNote document binding must contain exactly 32 bytes.",
        );
      }
      const bytes = Uint8Array.from(input);
      const value = Object.freeze({
        kind: "blocknote-document-binding",
        byteLength: 32,
      }) as BlockNoteDocumentBinding;
      bindings.set(value, bytes);
      return value;
    },
    readBinding(value) {
      if (
        !value ||
        (typeof value !== "object" && typeof value !== "function")
      ) {
        return null;
      }
      const bytes = bindings.get(value);
      return bytes ? Uint8Array.from(bytes) : null;
    },
    inspectCapture(value) {
      const frame = protocol.readValue(value, "capture");
      if (!frame) {
        throw new BlockNoteError(
          "invalid-anchor",
          "BlockNote comment anchor capture is invalid.",
        );
      }
      return decodeCaptureFrame(frame);
    },
    inspectAnchor(value) {
      const frame = protocol.readValue(value, "anchor");
      if (!frame) {
        throw new BlockNoteError(
          "invalid-anchor",
          "BlockNote comment anchor is invalid.",
        );
      }
      const inspected = decodeAnchorFrame(frame);
      return {
        ...inspected,
        documentBinding: protocol.createBinding(inspected.documentBinding),
      };
    },
    inspectVerificationBundle(value) {
      const frame = protocol.readValue(value, "verification");
      if (!frame) {
        throw new BlockNoteError(
          "invalid-anchor",
          "BlockNote verification bundle is invalid.",
        );
      }
      return decodeVerificationBundleFrame(frame);
    },
  };
  for (const key of Object.keys(
    protocol,
  ) as (keyof BlockNoteCommentAnchorProtocol)[]) {
    if (typeof protocol[key] === "function") {
      Object.freeze(protocol[key]);
    }
  }
  return Object.freeze(protocol);
}

export function installBlockNoteCommentAnchorProtocol(
  target: object = globalThis,
) {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, protocolKey);
  } catch {
    throw new BlockNoteError(
      "incompatible-document",
      "BlockNote comment anchor runtime registry is incompatible.",
    );
  }
  if (descriptor) {
    if (
      descriptor.configurable === false &&
      descriptor.enumerable === false &&
      descriptor.writable === false &&
      validProtocol(descriptor.value)
    ) {
      return descriptor.value;
    }
    throw new BlockNoteError(
      "incompatible-document",
      "BlockNote comment anchor runtime registry is incompatible.",
    );
  }
  const protocol = createProtocol();
  try {
    Object.defineProperty(target, protocolKey, {
      configurable: false,
      enumerable: false,
      value: protocol,
      writable: false,
    });
  } catch {
    throw new BlockNoteError(
      "incompatible-document",
      "BlockNote comment anchor runtime registry is incompatible.",
    );
  }
  return protocol;
}

export const blockNoteCommentAnchorProtocol =
  installBlockNoteCommentAnchorProtocol();

export function createBlockNoteCommentAnchorRuntime(options: {
  readonly definitionFingerprint: string;
  readonly documentBinding: BlockNoteDocumentBinding;
  readonly mapping: BlockNoteCommentAnchorMapping;
}): BlockNoteCommentAnchorRuntime {
  const expectedBinding = blockNoteCommentAnchorProtocol.readBinding(
    options.documentBinding,
  );
  if (!expectedBinding || !options.definitionFingerprint) {
    throw new BlockNoteError(
      "incompatible-document",
      "BlockNote comment anchor runtime identity is invalid.",
    );
  }
  return Object.freeze({
    definitionFingerprint: options.definitionFingerprint,
    documentBinding: options.documentBinding,
    capture(range: { readonly from: number; readonly to: number }) {
      return options.mapping.capture(range);
    },
    mapCapture(value: BlockNoteCommentAnchorCapture) {
      return options.mapping.mapCapture(value);
    },
    mapAnchor(value: BlockNoteCommentAnchor) {
      const inspected = blockNoteCommentAnchorProtocol.inspectAnchor(value);
      const actualBinding = blockNoteCommentAnchorProtocol.readBinding(
        inspected.documentBinding,
      );
      if (
        !actualBinding ||
        !equalBytes(actualBinding, expectedBinding) ||
        inspected.definitionFingerprint !== options.definitionFingerprint
      ) {
        throw new BlockNoteError(
          "invalid-anchor",
          "BlockNote comment anchor belongs to another document.",
        );
      }
      return options.mapping.mapAnchor(value);
    },
  });
}
