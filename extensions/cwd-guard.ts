/**
 * Per-value `cwd` evaluation and aggregation.
 *
 * A non-empty string `cwd` is allowed only when `normalize(inputCwd) ===
 * normalize(currentCwd)` under an injected `path.normalize`-shaped function;
 * anything else is `ask`. The comparison is purely lexical string equality
 * after Node's lexical normalization: there is no resolve, realpath,
 * containment, case folding, or filesystem access. Empty/missing values are
 * allowed without a call, other types are `ask`. Evaluation never
 * short-circuits, and a scan error makes the aggregate a hard `deny`.
 */

import {
  collectCwdOccurrences,
  type CwdOccurrence,
  type CwdScanError,
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
  /** Present when the input tree could not be scanned safely; callers must block. */
  scanError?: CwdScanError;
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
  let normalizedInput: string;
  try {
    normalizedInput = normalizePath(value);
  } catch (error) {
    return { path, value, state: "ask", reason: `path normalization failed: ${describeError(error)}` };
  }
  let normalizedCurrent: string;
  try {
    normalizedCurrent = normalizePath(currentCwd);
  } catch (error) {
    return { path, value, state: "ask", reason: `path normalization failed: ${describeError(error)}` };
  }
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
 * - A normalization failure degrades that item to `ask`; remaining items are
 *   still evaluated, and a failure is never turned into an allow.
 * - A `deny` never short-circuits: remaining items are still evaluated.
 * - A scan error forces the aggregate to `deny`: an incompletely scanned call
 *   is hard-blocked and cannot be approved by the user.
 */
export function evaluateCwdOccurrences(
  input: unknown,
  currentCwd: string,
  normalizePath: NormalizePath,
): CwdEvaluationOutcome {
  const scan = collectCwdOccurrences(input);

  const evaluations: CwdEvaluation[] = scan.occurrences.map((occurrence: CwdOccurrence) => {
    const { path, value } = occurrence;
    if (isNonEmptyString(value)) {
      return evaluateNonEmptyString(path, value, currentCwd, normalizePath);
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
  // Fail-closed hard refusal: an incomplete scan can never read as approvable.
  if (scan.error !== undefined) {
    aggregate = "deny";
  }

  return { evaluations, aggregate, scanError: scan.error };
}
