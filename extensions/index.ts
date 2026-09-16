/**
 * pi-subagent-permission-compat — the only Pi extension entry point.
 *
 * Two independent capabilities, each with its own create function and its own
 * registered handlers:
 *
 * 1. Parent-session environment compatibility: on session start the extension
 *    detects whether this process is a root session and publishes
 *    `PI_SUBAGENT_PARENT_SESSION`; on shutdown it cleans up the value it owns.
 * 2. Subagent tool-call cwd protection: `tool_call` events for subagent-ish
 *    tools are scanned for every `cwd` field; each non-empty string is
 *    compared with the event context's cwd after lexical normalization, and
 *    the merged result allows, asks once via `ctx.ui.select`, or blocks the
 *    whole call.
 *
 * The factories only register handlers and assemble dependencies; importing
 * these modules or calling the factories never mutates the environment and
 * never touches a UI.
 */

import { normalize } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
  evaluateCwdOccurrences,
  type NormalizePath,
} from "./cwd-guard.ts";
import {
  EXTENSION_PROMPT_LABEL,
  promptCwdApproval,
  type CwdSelect,
} from "./cwd-prompt.ts";
import { matchesInspectedToolName } from "./cwd-inspection.ts";
import {
  PARENT_SESSION_ENV_VAR,
  ParentSessionEnvController,
  type SubagentEnv,
} from "./parent-session-env.ts";

/** Resolves the select implementation for the current event context. */
export type SelectResolver = (ctx: ExtensionContext) => CwdSelect;

/** Options of `createParentSessionEnvFeature`. */
export interface ParentSessionEnvFeatureOptions {
  /**
   * Environment record to operate on. Production passes `process.env`; tests
   * must pass an in-memory record to avoid touching the host environment.
   */
  env: SubagentEnv;
}

/** Options of `createCwdGuardFeature`. Always explicit, no defaults. */
export interface CwdGuardFeatureOptions {
  /** Path normalizer used for both sides of the cwd comparison. */
  normalizePath: NormalizePath;
  /** Resolves the approval selector for the current event context. */
  select: SelectResolver;
}

export interface ExtensionOptions {
  /**
   * Environment record to operate on. Production passes `process.env`; tests
   * must pass an in-memory record to avoid touching the host environment.
   */
  env: SubagentEnv;
  /** Path normalizer used for both sides of the cwd comparison. Always explicit. */
  normalizePath: NormalizePath;
  /** Resolves the approval selector for the current event context. Always explicit. */
  select: SelectResolver;
}

/**
 * Capability 1: parent-session environment compatibility.
 *
 * Registers `session_start` (publish the parent-session variable for root
 * sessions) and `session_shutdown` (owned-value cleanup).
 */
export function createParentSessionEnvFeature(
  pi: ExtensionAPI,
  options: ParentSessionEnvFeatureOptions,
): void {
  const controller = new ParentSessionEnvController(options.env);

  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const decision = controller.handleSessionStart(sessionId);
    if (decision.skipReason === "invalid-session-id") {
      // Diagnostics must not corrupt RPC stdout; ctx.ui.notify goes through
      // the sanctioned extension UI channel in every mode.
      ctx.ui.notify(
        `${EXTENSION_PROMPT_LABEL} Received an invalid session ID; ` +
          `${PARENT_SESSION_ENV_VAR} was not published. ` +
          "Subagent cwd checks remain active.",
        "warning",
      );
    }
  });

  pi.on("session_shutdown", () => {
    controller.handleSessionShutdown();
  });
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
          ? `${EXTENSION_PROMPT_LABEL} Subagent tool call blocked: the tool input could not be safely evaluated; the call is denied. ${outcome.error}`
          : `${EXTENSION_PROMPT_LABEL} Subagent tool call blocked: the working directories could not be approved; the call is denied.`,
      };
    }

    // ask: interactive approval in TUI/RPC, hard block without UI.
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${EXTENSION_PROMPT_LABEL} Subagent working directories need approval, but no interactive UI is available in this mode; the call is blocked.`,
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
          reason: `${EXTENSION_PROMPT_LABEL} Subagent tool call denied: working directories were not approved.`,
        };
      case "cancelled":
        return {
          block: true,
          reason: `${EXTENSION_PROMPT_LABEL} Subagent tool call blocked: the approval prompt was cancelled.`,
        };
      case "ui-error":
        return {
          block: true,
          reason: `${EXTENSION_PROMPT_LABEL} Subagent tool call blocked: the approval prompt failed. ${promptOutcome.detail ?? ""}`,
        };
      default:
        return {
          block: true,
          reason: `${EXTENSION_PROMPT_LABEL} Subagent tool call blocked: unexpected approval response. ${promptOutcome.detail ?? ""}`,
        };
    }
  });
}

/**
 * Registerable core of the extension: both capabilities, registered
 * independently. Exposed as a factory so integration tests can inject
 * dependencies; this is not a public API promise.
 */
export function createSubagentPermissionCompatExtension(
  pi: ExtensionAPI,
  options: ExtensionOptions,
): void {
  createParentSessionEnvFeature(pi, { env: options.env });
  createCwdGuardFeature(pi, { normalizePath: options.normalizePath, select: options.select });
}

/** Default extension factory expected by the Pi extension loader. */
export default function createExtension(pi: ExtensionAPI): void {
  createSubagentPermissionCompatExtension(pi, {
    env: process.env,
    normalizePath: normalize,
    select: (ctx) => (title, options, opts) => ctx.ui.select(title, options, opts),
  });
}
