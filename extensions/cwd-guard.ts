/**
 * Per-value `cwd` evaluation and aggregation.
 *
 * A non-empty string `cwd` is allowed only when the raw value is strictly
 * equal (`===`) to the current event cwd; anything else is `ask`. Neither
 * side is preprocessed: strict string equality is the only rule. There is no
 * resolve, realpath, containment, case folding, separator conversion, trim, or
 * other preprocessing. Empty/missing values are allowed, other types are
 * `ask`. A scan error or an evaluation failure short-circuits into a hard
 * `deny` outcome with a generic error message. String equality does not prove
 * that the path resolves to the same real directory.
 */

import {
  collectCwdOccurrences,
  type CwdOccurrence,
} from "./cwd-inspection.ts";
import { describeError, describeUnknown } from "./diagnostics.ts";

export type PermissionState = "allow" | "ask" | "deny";

/**
 * Per-value evaluation state. Only allow/ask can come from per-value
 * evaluation; `deny` only ever appears in the merged aggregate as a
 * fail-closed short circuit for scan/evaluation failures.
 */
export type EvaluationState = Exclude<PermissionState, "deny">;

/** One evaluated `cwd` occurrence with its state and short English reason. */
export interface CwdEvaluation {
  path: string;
  value: unknown;
  state: EvaluationState;
  reason: string;
}

/** Complete evaluation of one tool call's input. */
export interface CwdEvaluationOutcome {
  /** In traversal order; every occurrence appears exactly once. */
  evaluations: CwdEvaluation[];
  /** Strict merge of all evaluations; an empty set is `allow`. */
  aggregate: PermissionState;
  /**
   * Present when the input could not be scanned or evaluated safely; callers
   * must block. Covers both scan failures and the defensive evaluation
   * fallback, and is safe to display (never a stack trace).
   */
  error?: string;
}

/** Whether the value is a string that must be compared against the current cwd. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Evaluate one non-empty string against the current cwd by strict equality. */
function evaluateNonEmptyString(path: string, value: string, currentCwd: string): CwdEvaluation {
  return value === currentCwd
    ? { path, value, state: "allow", reason: "matches current directory" }
    : { path, value, state: "ask", reason: "differs from current directory" };
}

/**
 * Evaluate every `cwd` occurrence of one tool call and merge the states.
 *
 * - Every non-empty string is compared with the raw current cwd by strict
 *   equality (`===`): equal means allow, different means ask. Both sides are
 *   used exactly as given, never trimmed, normalized, or rewritten, and no
 *   comparison result is cached across tool calls.
 * - `undefined`, `null`, and `""` are allowed.
 * - Any other type is `ask`.
 * - Per-item evaluation is not expected to throw, so no per-item guard is
 *   needed. As a defensive fallback, any throw discards per-item results and
 *   fails the whole call closed to a hard `deny` (never allow, and no stack
 *   trace escapes the guard; the thrown message is passed through as the
 *   outcome error).
 * - A scan error short-circuits: an incompletely scanned input is hard-denied
 *   without evaluating the collected occurrences.
 */
export function evaluateCwdOccurrences(input: unknown, currentCwd: string): CwdEvaluationOutcome {
  const scan = collectCwdOccurrences(input);

  // Fail-closed short circuit: an incompletely scanned input can never be
  // evaluated, so hard-deny before any per-item evaluation happens.
  if (scan.error) {
    return { evaluations: [], aggregate: "deny", error: scan.error.message };
  }

  // Defensive fail-closed net: strict string comparison does not throw, but an
  // unexpected evaluation failure must not escape the guard.
  let evaluations: CwdEvaluation[];
  try {
    evaluations = scan.occurrences.map((occurrence: CwdOccurrence) => {
      const { path, value } = occurrence;
      if (isNonEmptyString(value)) {
        return evaluateNonEmptyString(path, value, currentCwd);
      }
      if (value === undefined || value === null || value === "") {
        return { path, value, state: "allow", reason: "empty or missing cwd" };
      }
      return { path, value, state: "ask", reason: `invalid cwd type: ${describeUnknown(value)}` };
    });
  } catch (error) {
    // Fail-closed fallback: an unknown evaluation outcome is a hard deny; the
    // thrown message is passed through for display (never a stack trace).
    return { evaluations: [], aggregate: "deny", error: describeError(error) };
  }

  // Per-value evaluation only produces allow/ask; any ask makes the merged outcome ask.
  const aggregate: PermissionState = evaluations.every((e) => e.state === "allow") ? "allow" : "ask";
  return { evaluations, aggregate };
}
