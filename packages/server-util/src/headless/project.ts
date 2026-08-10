import type {
  AnyBlockNoteDocumentDefinition,
  BlockNoteRevision,
  BlockNoteSuggestion,
} from "@blocknote/core";
import { BlockNoteError } from "@blocknote/core/persistence";
import { getBlockNoteDocumentInternals } from "@blocknote/core/runtime";
import type * as Y from "@y/y";

export type BlockNoteProjection<
  TBlock = unknown,
  TExtensionProjection extends object = Record<never, never>,
> = Readonly<
  {
    readonly blocks: readonly TBlock[];
    readonly markdown: string;
    readonly suggestions: readonly BlockNoteSuggestion[];
    readonly definitionVersion: string;
    readonly revision: BlockNoteRevision;
  } & TExtensionProjection
>;

type DeltaNode = {
  readonly name: string | null;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly children: readonly DeltaOperation[];
};

type DeltaOperation = {
  readonly insert?: unknown;
  readonly format?: Readonly<Record<string, unknown>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deltaNode(value: unknown): DeltaNode | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = value.name ?? null;
  const rawAttrs = value.attrs ?? {};
  const children = value.children ?? [];
  if (
    value.type !== "delta" ||
    (name !== null && typeof name !== "string") ||
    !isRecord(rawAttrs) ||
    !Array.isArray(children)
  ) {
    return null;
  }
  const attrs: Record<string, unknown> = {};
  for (const [key, attribute] of Object.entries(rawAttrs)) {
    attrs[key] =
      isRecord(attribute) && attribute.type === "insert"
        ? attribute.value
        : attribute;
  }
  return { name, attrs, children: children as readonly DeltaOperation[] };
}

function nestedNodes(node: DeltaNode) {
  const result: DeltaNode[] = [];
  for (const operation of node.children) {
    const inserted = operation.insert;
    if (!Array.isArray(inserted)) {
      continue;
    }
    for (const value of inserted) {
      const nested = deltaNode(value);
      if (nested) {
        result.push(nested);
      }
    }
  }
  return result;
}

function styles(format: unknown) {
  if (!isRecord(format)) {
    return Object.freeze({});
  }
  const result: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(format)) {
    if (key === "link") {
      continue;
    }
    if (value === true || typeof value === "string") {
      result[key] = value;
    } else if (isRecord(value)) {
      result[key] = true;
    }
  }
  return Object.freeze(result);
}

function textFromNode(node: DeltaNode): string {
  let result = "";
  for (const operation of node.children) {
    if (typeof operation.insert === "string") {
      result += operation.insert;
    } else if (Array.isArray(operation.insert)) {
      for (const value of operation.insert) {
        const nested = deltaNode(value);
        if (nested) {
          result += textFromNode(nested);
        }
      }
    }
  }
  return result;
}

function inlineContent(node: DeltaNode): readonly unknown[] {
  const result: unknown[] = [];
  for (const operation of node.children) {
    if (typeof operation.insert === "string") {
      const text = operation.insert;
      const format = isRecord(operation.format) ? operation.format : {};
      const link = format.link;
      if (typeof link === "string" || isRecord(link)) {
        const href =
          typeof link === "string"
            ? link
            : typeof link.href === "string"
              ? link.href
              : "";
        result.push(
          Object.freeze({
            type: "link",
            href,
            content: Object.freeze([
              Object.freeze({ type: "text", text, styles: styles(format) }),
            ]),
          }),
        );
      } else {
        result.push(
          Object.freeze({ type: "text", text, styles: styles(format) }),
        );
      }
      continue;
    }
    if (Array.isArray(operation.insert)) {
      for (const value of operation.insert) {
        const nested = deltaNode(value);
        if (!nested) {
          continue;
        }
        if (nested.name === "link") {
          result.push(
            Object.freeze({
              type: "link",
              href:
                typeof nested.attrs.href === "string" ? nested.attrs.href : "",
              content: inlineContent(nested),
            }),
          );
        } else {
          result.push(
            Object.freeze({
              type: nested.name ?? "text",
              props: Object.freeze({ ...nested.attrs }),
              content: textFromNode(nested),
            }),
          );
        }
      }
    }
  }
  return Object.freeze(result);
}

function tableContent(node: DeltaNode) {
  const rows = nestedNodes(node)
    .filter((row) => row.name === "tableRow")
    .map((row) =>
      Object.freeze({
        cells: Object.freeze(
          nestedNodes(row)
            .filter((cell) => cell.name === "tableCell")
            .map((cell) => Object.freeze(inlineContent(cell))),
        ),
      }),
    );
  return Object.freeze({ type: "tableContent", rows: Object.freeze(rows) });
}

function publicBlock(container: DeltaNode): Readonly<Record<string, unknown>> {
  const nested = nestedNodes(container);
  const contentNode = nested.find((node) => node.name !== "blockGroup");
  if (!contentNode?.name) {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote block container has no representable content.",
    );
  }
  const childrenGroup = nested.find((node) => node.name === "blockGroup");
  const content =
    contentNode.name === "table"
      ? tableContent(contentNode)
      : inlineContent(contentNode);
  return Object.freeze({
    id: typeof container.attrs.id === "string" ? container.attrs.id : "",
    type: contentNode.name,
    props: Object.freeze({ ...contentNode.attrs }),
    content,
    children: Object.freeze(
      childrenGroup ? blockGroupBlocks(childrenGroup) : [],
    ),
  });
}

function blockGroupBlocks(group: DeltaNode) {
  return nestedNodes(group)
    .filter((node) => node.name === "blockContainer")
    .map(publicBlock);
}

function rootBlocks(root: DeltaNode) {
  const group =
    root.name === "blockGroup"
      ? root
      : nestedNodes(root).find((node) => node.name === "blockGroup");
  return Object.freeze(group ? blockGroupBlocks(group) : []);
}

function inlineText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((value) => {
      if (!isRecord(value)) {
        return "";
      }
      if (typeof value.text === "string") {
        return value.text;
      }
      if (Array.isArray(value.content)) {
        return inlineText(value.content);
      }
      return typeof value.content === "string" ? value.content : "";
    })
    .join("");
}

function markdownForBlock(
  block: Readonly<Record<string, unknown>>,
  depth = 0,
): string {
  const type = typeof block.type === "string" ? block.type : "paragraph";
  const text = inlineText(block.content);
  const props = isRecord(block.props) ? block.props : {};
  let line: string;
  switch (type) {
    case "heading": {
      const level =
        Number.isSafeInteger(props.level) &&
        (props.level as number) >= 1 &&
        (props.level as number) <= 6
          ? (props.level as number)
          : 1;
      line = `${"#".repeat(level)} ${text}`;
      break;
    }
    case "bulletListItem":
      line = `- ${text}`;
      break;
    case "numberedListItem":
      line = `1. ${text}`;
      break;
    case "checkListItem":
      line = `- [${props.checked === true ? "x" : " "}] ${text}`;
      break;
    case "quote":
      line = `> ${text}`;
      break;
    case "codeBlock":
      line = `\`\`\`${typeof props.language === "string" ? props.language : ""}\n${text}\n\`\`\``;
      break;
    case "divider":
      line = "---";
      break;
    case "image":
      line = `![${typeof props.caption === "string" ? props.caption : ""}](${typeof props.url === "string" ? props.url : ""})`;
      break;
    case "file":
    case "audio":
    case "video":
      line = `[${typeof props.name === "string" ? props.name : type}](${typeof props.url === "string" ? props.url : ""})`;
      break;
    default:
      line = text;
  }
  const children = Array.isArray(block.children)
    ? (block.children as readonly Readonly<Record<string, unknown>>[])
    : [];
  if (children.length === 0) {
    return `${"  ".repeat(depth)}${line}`;
  }
  return [
    `${"  ".repeat(depth)}${line}`,
    ...children.map((child) => markdownForBlock(child, depth + 1)),
  ].join("\n");
}

function projectSuggestions(doc: Y.Doc): readonly BlockNoteSuggestion[] {
  const headers = doc.get("__blocknote_suggestions_v2_headers");
  const ranges = doc.get("__blocknote_suggestions_v2_ranges");
  const dispositions = doc.get("__blocknote_suggestions_v2_dispositions");
  const receipts = doc.get("__blocknote_suggestions_v2_receipts");
  const result: BlockNoteSuggestion[] = [];
  headers.forEachAttr((header: unknown, id) => {
    if (typeof id !== "string" || !isRecord(header)) {
      return;
    }
    const receipt = [...receipts.attrEntries()]
      .filter(([key]) => String(key).startsWith(`${id}/`))
      .map(([, value]) => value)
      .find(isRecord);
    const disposition = [...dispositions.attrEntries()]
      .filter(([key]) => String(key).startsWith(`${id}/`))
      .map(([, value]) => value)
      .find(isRecord);
    let hasInsert = false;
    let hasDelete = false;
    ranges.forEachAttr((claim: unknown) => {
      if (isRecord(claim) && claim.suggestionId === id) {
        hasInsert ||= claim.role === "insert";
        hasDelete ||= claim.role === "delete";
      }
    });
    const kind =
      receipt?.kind === "insertion" ||
      receipt?.kind === "deletion" ||
      receipt?.kind === "replacement"
        ? receipt.kind
        : hasInsert && hasDelete
          ? "replacement"
          : hasDelete
            ? "deletion"
            : "insertion";
    const status =
      receipt?.status === "accepted" || receipt?.status === "rejected"
        ? receipt.status
        : disposition?.status === "accepted" ||
            disposition?.status === "rejected"
          ? disposition.status
          : "pending";
    result.push(
      Object.freeze({
        id,
        authorId: typeof header.authorId === "string" ? header.authorId : null,
        kind,
        preview: typeof receipt?.preview === "string" ? receipt.preview : "",
        status,
      }),
    );
  });
  return Object.freeze(
    result.sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
  );
}

function countProjection(blocks: readonly Readonly<Record<string, unknown>>[]) {
  let count = 0;
  let maximumDepth = 0;
  let textCharacters = 0;
  const visit = (
    values: readonly Readonly<Record<string, unknown>>[],
    depth: number,
  ) => {
    maximumDepth = Math.max(maximumDepth, depth);
    for (const block of values) {
      count += 1;
      textCharacters += inlineText(block.content).length;
      if (Array.isArray(block.children)) {
        visit(
          block.children as readonly Readonly<Record<string, unknown>>[],
          depth + 1,
        );
      }
    }
  };
  visit(blocks, blocks.length === 0 ? 0 : 1);
  return { count, maximumDepth, textCharacters };
}

function assertProjectionLimits(
  document: AnyBlockNoteDocumentDefinition,
  blocks: readonly Readonly<Record<string, unknown>>[],
) {
  const measured = countProjection(blocks);
  const limits = document.limits;
  if (
    (limits?.blocks !== undefined && measured.count > limits.blocks) ||
    (limits?.depth !== undefined && measured.maximumDepth > limits.depth) ||
    (limits?.textCharacters !== undefined &&
      measured.textCharacters > limits.textCharacters)
  ) {
    throw new BlockNoteError(
      "document-too-large",
      "BlockNote document exceeds its configured semantic limits.",
    );
  }
}

export function projectBlockNoteDocument(input: {
  readonly document: AnyBlockNoteDocumentDefinition;
  readonly doc: unknown;
  readonly content: unknown;
  readonly revision: BlockNoteRevision;
}): BlockNoteProjection<Readonly<Record<string, unknown>>> {
  const doc = input.doc as Y.Doc;
  const content = input.content as Y.Type;
  const rendered = deltaNode(content.toDeltaDeep().toJSON());
  if (!rendered) {
    throw new BlockNoteError(
      "invalid-document",
      "BlockNote document cannot be represented as public blocks.",
    );
  }
  const blocks = rootBlocks(rendered);
  assertProjectionLimits(input.document, blocks);
  const markdown = blocks.map((block) => markdownForBlock(block)).join("\n\n");
  const suggestions = projectSuggestions(doc);
  const projectionInput = Object.freeze({ blocks, markdown, suggestions });
  const extensionProjection: Record<string, unknown> = {};
  for (const contribution of getBlockNoteDocumentInternals(input.document)
    .headlessProjectionContributions) {
    const fields = contribution(projectionInput);
    for (const key of Object.keys(fields)) {
      if (
        key === "blocks" ||
        key === "markdown" ||
        key === "suggestions" ||
        key === "definitionVersion" ||
        key === "revision" ||
        Object.hasOwn(extensionProjection, key)
      ) {
        throw new BlockNoteError(
          "incompatible-document",
          "BlockNote headless projection fields conflict.",
        );
      }
    }
    Object.assign(extensionProjection, fields);
  }
  return Object.freeze({
    ...extensionProjection,
    blocks,
    markdown,
    suggestions,
    definitionVersion: input.document.version,
    revision: Object.freeze({ ...input.revision }),
  });
}
