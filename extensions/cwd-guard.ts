/**
 * Per-value `cwd` evaluation and aggregation.
 *
 * A non-empty string `cwd` is allowed only when `normalize(inputCwd) ===
 * normalize(currentCwd)` under an injected `path.normalize`-shaped function;
 * anything else is `ask`. The comparison is purely lexical string equality
 * after Node's lexical normalization: there is no resolve, realpath,
 * containment, case folding, or filesystem access. Empty/missing values are
 * allowed without a call, other types are `ask`. A scan error or an
 * evaluation failure short-circuits into a hard `deny` outcome with a
 * generic error message.
 */

import {
  collectCwdOccurrences,
  type CwdOccurrence,
} from "./cwd-inspection.ts";
import { describeError, describeUnknown } from "./diagnostics.ts";

export type PermissionState = "allow" | "ask" | "deny";

/**
 * Synchronous, pure path normalizer, e.g. `path.normalize` for the current
 * platform; tests inject `path.posix.normalize` or `path.win32.normalize`.
 */
export type NormalizePath = (path: string) => string;

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

/** Evaluate one non-empty string against the current cwd via normalization. */
function evaluateNonEmptyString(
  path: string,
  value: string,
  currentCwd: string,
  normalizePath: NormalizePath,
): CwdEvaluation {
  const normalizedInput = normalizePath(value);
  const normalizedCurrent = normalizePath(currentCwd);
  return normalizedInput === normalizedCurrent
    ? { path, value, state: "allow", reason: "matches current directory" }
    : { path, value, state: "ask", reason: "differs from current directory" };
}

/**
 * Evaluate every `cwd` occurrence of one tool call and merge the states.
 *
 * - Every non-empty string is compared after normalizing both sides with the
 *   same injected function: equal means allow, different means ask. The raw
 *   values are never trimmed or rewritten, and normalization is not cached
 *   across tool calls.
 * - `undefined`, `null`, and `""` are allowed without calling the normalizer.
 * - Any other type is `ask` without calling the normalizer.
 * - A conforming normalizer never throws for string input, so no per-item
 *   guard is needed. As a defensive fallback, any throw from the injected
 *   function discards per-item results and fails the whole call closed to a
 *   hard `deny` (never allow, and no stack trace escapes the guard; the
 *   thrown message is passed through as the outcome error).
 * - A scan error short-circuits: an incompletely scanned input is hard-denied
 *   without evaluating the collected occurrences.
 */
export function evaluateCwdOccurrences(
  input: unknown,
  currentCwd: string,
  normalizePath: NormalizePath,
): CwdEvaluationOutcome {
  const scan = collectCwdOccurrences(input);

  // Fail-closed short circuit: an incompletely scanned input can never be
  // evaluated, so hard-deny before any per-item evaluation happens.
  if (scan.error) {
    return { evaluations: [], aggregate: "deny", error: scan.error.message };
  }

  // Defensive fail-closed net: a conforming `path.normalize` never throws for
  // string input, but a broken injection must not escape the guard.
  let evaluations: CwdEvaluation[];
  try {
    evaluations = scan.occurrences.map((occurrence: CwdOccurrence) => {
      const { path, value } = occurrence;
      if (isNonEmptyString(value)) {
        return evaluateNonEmptyString(path, value, currentCwd, normalizePath);
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

  // Per-value evaluation only produces allow/ask; any ask makes the merged
  // outcome ask, everything else allows.
  const aggregate: PermissionState = evaluations.some((e) => e.state === "ask") ? "ask" : "allow";
  return { evaluations, aggregate };
}
