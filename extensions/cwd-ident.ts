/**
 * Subagent tool-name identification.
 *
 * Keeps the matching rule deliberately small and dependency-free: tool names are
 * inspected when they contain one of the broad subagent/delegation keywords,
 * case-insensitively. The pattern is intentionally loose so this compatibility
 * extension can recognize third-party subagent tools without depending on a
 * fixed registry or schema.
 */

/**
 * Tool-name pattern for the calls this extension inspects. Intentionally
 * loose: no word boundaries, no `g` flag, no dependency on third-party
 * schemas or fixed tool lists.
 */
export const INSPECTED_TOOL_NAME_PATTERN = /(subagent|delegate|spawn|agent)/i;

/** Whether a `tool_call` with this tool name should be inspected. */
export function matchesInspectedToolName(toolName: unknown): boolean {
  return typeof toolName === "string" && INSPECTED_TOOL_NAME_PATTERN.test(toolName);
}
