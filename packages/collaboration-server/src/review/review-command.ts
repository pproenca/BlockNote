export interface BlockNoteReviewCommand {
  readonly id: string;
  readonly action: "accept" | "reject";
  readonly suggestionIds: readonly string[];
}

export function validateBlockNoteReviewCommand(
  value: BlockNoteReviewCommand,
): BlockNoteReviewCommand {
  if (
    !value.id ||
    (value.action !== "accept" && value.action !== "reject") ||
    value.suggestionIds.length === 0 ||
    value.suggestionIds.some((id) => !id) ||
    new Set(value.suggestionIds).size !== value.suggestionIds.length
  ) {
    throw new Error("BlockNote review command is invalid.");
  }
  return Object.freeze({
    id: value.id,
    action: value.action,
    suggestionIds: Object.freeze([...value.suggestionIds]),
  });
}
