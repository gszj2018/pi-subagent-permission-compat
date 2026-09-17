/**
 * Display and select-based approval for subagent `cwd` asks.
 *
 * A non-empty cwd string without whitespace or ASCII control characters is
 * displayed verbatim. Every other value falls back to the single-line JSON
 * display of `describeUnknown`, so the common whitespace and control characters
 * cannot forge prompt lines; that fallback does not turn every whitespace or
 * DEL character into a visible escape. The empty string keeps its `""` quoting
 * so the value position is never blank. The current directory from the host
 * context is always displayed verbatim. Approval is granted only for the exact
 * `Allow once` response and only for the current tool call; nothing is persisted
 * into the permission system.
 */

import type { CwdEvaluation } from "./cwd-guard.ts";
import { describeError, describeUnknown } from "./diagnostics.ts";
import { EXTENSION_LABEL } from "./extension-meta.ts";

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

/**
 * Display one raw `cwd` value: a non-empty string without whitespace (`\s`),
 * U+0085, ASCII control characters (U+0000-U+001F) or DEL (U+007F) is shown
 * verbatim; everything else - including the empty string - uses the safe
 * single-line JSON display of `describeUnknown`.
 */
export function formatCwdValue(value: unknown): string {
  if (typeof value === "string" && value !== "" && !/[\s\u0085\x00-\x1F\x7F]/.test(value)) {
    return value;
  }
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
    `${EXTENSION_LABEL} Review subagent working directories`,
    `Tool: ${toolName}`,
    `Current directory: ${currentCwd}`,
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
