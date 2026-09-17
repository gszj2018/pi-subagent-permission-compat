/**
 * pi-subagent-permission-compat — the only Pi extension entry point.
 *
 * Composes the independent parent-session and cwd-guard features and supplies
 * their production dependencies. Event handlers live in the feature modules.
 * Importing this module or calling its factories never mutates the environment
 * and never touches a UI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createCwdGuardFeature,
  type CwdGuardFeatureOptions,
} from "./feature-cwd-guard.ts";
import {
  createParentSessionEnvFeature,
  type ParentSessionEnvFeatureOptions,
} from "./feature-parent-session.ts";

/** Combined feature dependencies. All fields remain explicit and required. */
export interface ExtensionOptions extends ParentSessionEnvFeatureOptions, CwdGuardFeatureOptions {}

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
  createCwdGuardFeature(pi, { select: options.select });
}

/** Default extension factory expected by the Pi extension loader. */
export default function createExtension(pi: ExtensionAPI): void {
  createSubagentPermissionCompatExtension(pi, {
    env: process.env,
    select: (ctx) => (title, options, opts) => ctx.ui.select(title, options, opts),
  });
}
