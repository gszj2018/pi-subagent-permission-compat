/**
 * Safe display and select-based approval for subagent `cwd` asks.
 *
 * The title is assembled from sanitized fragments only: field paths plus
 * JSON-quoted / single-line JSON values, so control characters in tool input
 * cannot forge prompt lines. Approval is granted only for the
 * exact `Allow once` response and only for the current tool call; nothing is
 * persisted into the permission system.
 */

import type { CwdEvaluation } from "./cwd-guard.ts";
import { describeError, describeUnknown } from "./diagnostics.ts";

/** Label prefixed to prompts and blocking reasons. */
export const EXTENSION_PROMPT_LABEL = "[pi-subagent-permission-compat]";

/** Options are English; the denying option comes first. */
export const DENY_OPTION = "Deny";
export const ALLOW_ONCE_OPTION = "Allow once";

/** `ctx.ui.select`-compatible selector surface. */
export type CwdSelect = (
  title: string,
  options: string[],
  opts?: { signal?: AbortSignal },
) => Promise<string | undefined>;

export interface CwdPromptDeps {
  select: CwdSelect;
}

export interface CwdPromptContext {
  toolName: string;
  currentCwd: string;
  evaluations: CwdEvaluation[];
  signal: AbortSignal | undefined;
}

export type CwdPromptOutcome =
  | { approved: true }
  | {
      approved: false;
      reason: "denied" | "cancelled" | "ui-error" | "unknown-response";
      detail?: string;
    };

/** Safe single-line display of one raw `cwd` value. */
export function formatCwdValue(value: unknown): string {
  return describeUnknown(value);
}

/** One `path = value [state(: reason)]` line for the prompt title. */
export function formatCwdEvaluation(evaluation: CwdEvaluation): string {
  const reason = evaluation.reason.replace(/\s+/g, " ");
  const suffix = reason !== "" ? `: ${reason}` : "";
  return `${evaluation.path} = ${formatCwdValue(evaluation.value)} [${evaluation.state}${suffix}]`;
}

/** Build the multi-line select title. */
export function buildCwdPromptTitle(
  toolName: string,
  currentCwd: string,
  evaluations: CwdEvaluation[],
): string {
  const lines = [
    `${EXTENSION_PROMPT_LABEL} Review subagent working directories`,
    `Tool: ${toolName}`,
    `Current directory: ${JSON.stringify(currentCwd)}`,
    ...evaluations.map(formatCwdEvaluation),
    "Allow this tool call once?",
  ];
  return lines.join("\n");
}

/**
 * Show the approval prompt once and interpret the answer.
 *
 * - Only the exact `Allow once` string approves.
 * - `Deny`, cancellation (`undefined`), unknown responses, UI errors, and a
 *   signal already aborted before or after the prompt all block.
 * - A late approval that arrives after the signal aborted never takes effect.
 */
export async function promptCwdApproval(
  deps: CwdPromptDeps,
  context: CwdPromptContext,
): Promise<CwdPromptOutcome> {
  if (context.signal?.aborted) {
    return { approved: false, reason: "cancelled" };
  }

  const title = buildCwdPromptTitle(context.toolName, context.currentCwd, context.evaluations);
  let response: string | undefined;
  try {
    response = await deps.select(title, [DENY_OPTION, ALLOW_ONCE_OPTION], {
      signal: context.signal,
    });
  } catch (error) {
    return { approved: false, reason: "ui-error", detail: describeError(error) };
  }

  if (context.signal?.aborted) {
    return { approved: false, reason: "cancelled" };
  }
  if (response === ALLOW_ONCE_OPTION) {
    return { approved: true };
  }
  if (response === undefined) {
    return { approved: false, reason: "cancelled" };
  }
  if (response === DENY_OPTION) {
    return { approved: false, reason: "denied" };
  }
  return { approved: false, reason: "unknown-response", detail: describeUnknown(response) };
}
