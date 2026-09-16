/**
 * Generic, safe diagnostic helpers.
 *
 * These helpers only turn arbitrary runtime values into single-line, safe
 * strings for prompts and blocking reasons: control characters cannot forge
 * prompt lines, cyclic values degrade to a placeholder, and thrown values
 * never leak stack traces. They carry no permission-system knowledge.
 */

/** Safe, single-line description of an unknown value for diagnostics. */
export function describeUnknown(value: unknown): string {
  try {
    // Strings stay JSON-quoted so control characters cannot forge prompt
    // lines; undefined/symbol/function fall back via `??`.
    return JSON.stringify(value) ?? `[${typeof value}]`;
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
