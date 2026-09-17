/**
 * Pi lifecycle adapter for parent-session environment compatibility.
 * Registering the feature only creates an instance-local controller and handlers;
 * environment publication and cleanup happen in the lifecycle handlers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EXTENSION_LABEL } from "./extension-meta.ts";
import {
  PARENT_SESSION_ENV_VAR,
  ParentSessionEnvController,
  type SubagentEnv,
} from "./parent-session-env.ts";

/** Options of `createParentSessionEnvFeature`. */
export interface ParentSessionEnvFeatureOptions {
  /**
   * Environment record to operate on. Production passes `process.env`; tests
   * must pass an in-memory record to avoid touching the host environment.
   */
  env: SubagentEnv;
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
        `${EXTENSION_LABEL} Received an invalid session ID; ` +
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
