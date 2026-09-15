/**
 * Permission-system client.
 *
 * The only module that performs the dynamic import of
 * `@gotgenes/pi-permission-system` and resolves the session service. The
 * importer is injectable so tests can simulate a missing package, a missing
 * service, or failing queries without touching `node_modules`.
 *
 * Service acquisition follows the upstream documented graceful-degradation
 * pattern (cross-extension-api.md): a single guard around the `import()` and
 * the accessor call — the package missing makes the import throw, and the
 * extension not loaded makes the accessor answer falsy; both degrade to a
 * structured "unavailable" result. Anything else surfaces per-item at query
 * time and degrades to `ask`.
 *
 * All lookups are fail-closed and never cached across tool calls: an
 * unavailable service makes the current call's string `cwd` items `ask`, and
 * later calls retry from scratch.
 */

import type {
  PermissionCheckResult,
  PermissionState,
  PermissionsService,
} from "@gotgenes/pi-permission-system";

export type { PermissionCheckResult, PermissionState, PermissionsService };

/** The single policy surface queried by this extension. */
export const EXTERNAL_DIRECTORY_SURFACE = "external_directory";

/**
 * Expected shape of the dynamically imported permission-system module,
 * typed against the public upstream declaration.
 */
export interface PermissionSystemModule {
  /** Keyed service accessor; answers `undefined` when the node has none. */
  getPermissionsService?(sessionId: string): PermissionsService | undefined;
}

/** Loads the permission-system module; may fail or resolve to garbage. */
export type PermissionModuleImporter = () => Promise<PermissionSystemModule | null | undefined>;

/** Default importer for production. Never caches the module. */
export const defaultPermissionModuleImporter: PermissionModuleImporter =
  async () => await import("@gotgenes/pi-permission-system");

/** Outcome of resolving the service for one tool call. */
export type ServiceResolution =
  | { ok: true; service: PermissionsService }
  | { ok: false; reason: string };

/** Outcome of one guarded `checkPermission` query. */
export type ExternalDirectoryCheck =
  | { ok: true; state: PermissionState }
  | { ok: false; reason: string };

/** Safe, single-line description of an unknown value for diagnostics. */
export function describeUnknown(value: unknown): string {
  try {
    // Strings stay JSON-quoted so control characters cannot forge prompt
    // lines; undefined/symbol/function fall back via `??`.
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable value]";
  }
}

/** Safe description of a thrown value; never a stack trace. */
export function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "[unprintable thrown value]";
  }
}

/**
 * Resolve the permission service of the node owning `sessionId`.
 *
 * Mirrors the upstream documented pattern (cross-extension-api.md
 * "Graceful Degradation"): one guard around the import and the accessor
 * call, and the accessor answering falsy means the extension has not loaded
 * into this node. Both failures degrade to a structured "unavailable"
 * result; malformed services fail per-item at query time instead.
 *
 * Never cached: every tool call resolves fresh.
 */
export async function resolvePermissionsService(
  importer: PermissionModuleImporter,
  sessionId: string,
): Promise<ServiceResolution> {
  try {
    const module = await importer();
    const service = module?.getPermissionsService?.(sessionId);
    if (!service) {
      return { ok: false, reason: "permissions service is not published for the current session" };
    }
    return { ok: true, service };
  } catch (error) {
    // Covers a missing package (import throws) and a broken accessor alike.
    return { ok: false, reason: `permissions service unavailable: ${describeError(error)}` };
  }
}

/**
 * Query the `external_directory` policy for one raw `cwd` value.
 *
 * - The raw string is passed through untouched (no trim, no rewriting).
 * - Only the bare flat surface is queried; no direction plane is passed and
 *   no `agentName` is inferred from third-party input.
 * - A missing result, an unusable `state`, or a throwing query degrades to a
 *   structured failure that callers translate into `ask`.
 */
export function checkExternalDirectory(service: PermissionsService, rawCwd: string): ExternalDirectoryCheck {
  let result: unknown;
  try {
    result = service.checkPermission(EXTERNAL_DIRECTORY_SURFACE, rawCwd);
  } catch (error) {
    return { ok: false, reason: `permission query failed: ${describeError(error)}` };
  }

  const state = (result as PermissionCheckResult | null | undefined)?.state;
  if (state !== "allow" && state !== "ask" && state !== "deny") {
    return { ok: false, reason: `invalid permission state: ${describeUnknown(state)}` };
  }
  return { ok: true, state };
}
