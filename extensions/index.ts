/**
 * pi-subagent-permission-compat — the only Pi extension entry point.
 *
 * Phase 1 scope: parent-session environment compatibility. On session start
 * the extension detects whether this process is a root session and publishes
 * `PI_SUBAGENT_PARENT_SESSION`; on shutdown it cleans up the value it owns.
 *
 * The extension factory only registers handlers and assembles dependencies;
 * importing this module or calling the factory never mutates the environment.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PARENT_SESSION_ENV_VAR,
  ParentSessionEnvController,
  type SubagentEnv,
} from "./parent-session-env.ts";

export interface ExtensionOptions {
  /**
   * Environment record to operate on. Production passes `process.env`; tests
   * must pass an in-memory record to avoid touching the host environment.
   */
  env: SubagentEnv;
}

const EXTENSION_LABEL = "[pi-subagent-permission-compat]";

/**
 * Registerable core of the extension. Exposed as a factory so integration
 * tests can inject a synthetic environment; this is not a public API promise.
 */
export function createSubagentPermissionCompatExtension(
  pi: ExtensionAPI,
  options: ExtensionOptions,
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
          "Subagent cwd permission checks remain active.",
        "warning",
      );
    }
  });

  pi.on("session_shutdown", () => {
    controller.handleSessionShutdown();
  });
}

/** Default extension factory expected by the Pi extension loader. */
export default function createExtension(pi: ExtensionAPI): void {
  createSubagentPermissionCompatExtension(pi, { env: process.env });
}
