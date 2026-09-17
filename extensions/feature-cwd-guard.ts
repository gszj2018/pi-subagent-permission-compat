/**
 * Pi tool-call adapter for subagent cwd protection.
 * Registers the evaluation and one-shot approval flow without touching the UI
 * during module loading or feature registration.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
  evaluateCwdOccurrences,
  type NormalizePath,
} from "./cwd-guard.ts";
import { matchesInspectedToolName } from "./cwd-ident.ts";
import {
  promptCwdApproval,
  type CwdSelect,
} from "./cwd-prompt.ts";
import { EXTENSION_LABEL } from "./extension-meta.ts";

/** Resolves the select implementation for the current event context. */
export type SelectResolver = (ctx: ExtensionContext) => CwdSelect;

/** Options of `createCwdGuardFeature`. Always explicit, no defaults. */
export interface CwdGuardFeatureOptions {
  /** Path normalizer used for both sides of the cwd comparison. */
  normalizePath: NormalizePath;
  /** Resolves the approval selector for the current event context. */
  select: SelectResolver;
}

/**
 * Capability 2: subagent tool-call cwd protection.
 *
 * Registers the `tool_call` handler that scans, compares each value with the
 * current event cwd, merges, and (for asks with UI) prompts for one-shot
 * approval.
 */
export function createCwdGuardFeature(
  pi: ExtensionAPI,
  options: CwdGuardFeatureOptions,
): void {
  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    if (!matchesInspectedToolName(event.toolName)) {
      return undefined;
    }

    const outcome = evaluateCwdOccurrences(event.input, ctx.cwd, options.normalizePath);

    if (outcome.aggregate === "allow") {
      return undefined;
    }

    if (outcome.aggregate === "deny") {
      // A deny is a hard block that the user cannot override. With an error
      // message the input could not be scanned or evaluated safely; without
      // one this is the defensive hard refusal for an impossible deny.
      return {
        block: true,
        reason: outcome.error !== undefined
          ? `${EXTENSION_LABEL} Subagent tool call blocked: the tool input could not be safely evaluated; the call is denied. ${outcome.error}`
          : `${EXTENSION_LABEL} Subagent tool call blocked: the working directories could not be approved; the call is denied.`,
      };
    }

    // ask: interactive approval in TUI/RPC, hard block without UI.
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${EXTENSION_LABEL} Subagent working directories need approval, but no interactive UI is available in this mode; the call is blocked.`,
      };
    }

    const promptOutcome = await promptCwdApproval(
      { select: options.select(ctx) },
      {
        toolName: event.toolName,
        currentCwd: ctx.cwd,
        evaluations: outcome.evaluations,
        signal: ctx.signal,
      },
    );
    if (promptOutcome.approved) {
      return undefined;
    }
    switch (promptOutcome.reason) {
      case "denied":
        return {
          block: true,
          reason: `${EXTENSION_LABEL} Subagent tool call denied: working directories were not approved.`,
        };
      case "cancelled":
        return {
          block: true,
          reason: `${EXTENSION_LABEL} Subagent tool call blocked: the approval prompt was cancelled.`,
        };
      case "ui-error":
        return {
          block: true,
          reason: `${EXTENSION_LABEL} Subagent tool call blocked: the approval prompt failed. ${promptOutcome.detail ?? ""}`,
        };
      default:
        return {
          block: true,
          reason: `${EXTENSION_LABEL} Subagent tool call blocked: unexpected approval response. ${promptOutcome.detail ?? ""}`,
        };
    }
  });
}
