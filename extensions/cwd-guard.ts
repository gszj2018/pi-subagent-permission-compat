/**
 * Per-value `cwd` evaluation, aggregation, and blocking decisions.
 *
 * Implements the value table from plan §4.3 and the strict merge order from
 * §4.5 (`deny > ask > allow`). Every occurrence is evaluated; evaluation never
 * short-circuits, even after a `deny`, so later items still surface. This
 * module dispatches queries through an injectable permission client and does
 * not implement any path-policy engine; interactive approval lives in the
 * prompt/UI layer (Phase 3).
 */

import {
  collectCwdOccurrences,
  type CwdOccurrence,
  type CwdScanError,
} from "./cwd-inspection.ts";
import {
  checkExternalDirectory,
  describeUnknown,
  resolvePermissionsService,
  type ExternalDirectoryCheck,
  type PermissionModuleImporter,
  type PermissionState,
  type PermissionsService,
  type ServiceResolution,
} from "./permissions-client.ts";

export type { PermissionState };

/** One evaluated `cwd` occurrence with its state and short English reason. */
export interface CwdEvaluation {
  path: string;
  value: unknown;
  state: PermissionState;
  reason: string;
}

/** Complete evaluation of one tool call's input. */
export interface CwdEvaluationOutcome {
  /** In traversal order; every occurrence appears exactly once. */
  evaluations: CwdEvaluation[];
  /** Strict merge of all evaluations; an empty set is `allow`. */
  aggregate: PermissionState;
  /** Present when the input tree could not be scanned safely; callers must block. */
  scanError?: CwdScanError;
}

/** Injectable permission dependencies of the guard. */
export interface CwdGuardDeps {
  resolveService(sessionId: string): Promise<ServiceResolution>;
  checkService(service: PermissionsService, rawCwd: string): ExternalDirectoryCheck;
}

/** Dependency set backed by an explicitly provided permission-system importer. */
export function createDefaultCwdGuardDeps(importer: PermissionModuleImporter): CwdGuardDeps {
  return {
    resolveService: (sessionId) => resolvePermissionsService(importer, sessionId),
    checkService: checkExternalDirectory,
  };
}

/** Whether the value must be sent to the permission service untouched. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Evaluate every `cwd` occurrence of one tool call and merge the states.
 *
 * - Every non-empty string is queried against `external_directory`, even for
 *   `.` or directories inside the current working directory; there is no
 *   implicit inside-cwd bypass (plan §4.3).
 * - `undefined`, `null`, and `""` are allowed without a query.
 * - Any other type is `ask` without a query.
 * - The service is resolved lazily: only when at least one non-empty string
 *   exists, once per tool call, keyed by the current session ID.
 * - Each query failure degrades that item to `ask`; remaining items still run.
 * - A `deny` never short-circuits: remaining items are still evaluated.
 */
export async function evaluateCwdOccurrences(
  input: unknown,
  sessionId: string,
  deps: CwdGuardDeps,
): Promise<CwdEvaluationOutcome> {
  const scan = collectCwdOccurrences(input);

  let service: PermissionsService | undefined;
  let serviceUnavailableReason: string | undefined;
  const hasQueryableValue = scan.occurrences.some((o) => isNonEmptyString(o.value));
  if (hasQueryableValue) {
    const resolution = await deps.resolveService(sessionId);
    if (resolution.ok) {
      service = resolution.service;
    } else {
      serviceUnavailableReason = resolution.reason;
    }
  }

  const evaluations: CwdEvaluation[] = scan.occurrences.map((occurrence: CwdOccurrence) => {
    const { path, value } = occurrence;
    if (isNonEmptyString(value)) {
      if (service === undefined) {
        return { path, value, state: "ask", reason: `service unavailable: ${serviceUnavailableReason ?? "unknown"}` };
      }
      const check = deps.checkService(service, value);
      return check.ok
        ? { path, value, state: check.state, reason: "policy" }
        : { path, value, state: "ask", reason: check.reason };
    }
    if (value === undefined || value === null || value === "") {
      return { path, value, state: "allow", reason: "empty or missing cwd" };
    }
    return { path, value, state: "ask", reason: `invalid cwd type: ${describeUnknown(value)}` };
  });

  let aggregate: PermissionState = "allow";
  for (const evaluation of evaluations) {
    if (evaluation.state === "deny") {
      aggregate = "deny";
      break;
    }
    if (evaluation.state === "ask") {
      aggregate = "ask";
    }
  }

  return { evaluations, aggregate, scanError: scan.error };
}
