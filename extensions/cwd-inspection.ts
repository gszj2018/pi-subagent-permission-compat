/**
 * Subagent tool identification and complete `cwd` collection.
 *
 * This module only reads tool-call input; it never touches the permission
 * system, the UI, or the environment. Collection is a bounded recursive
 * depth-first traversal over the raw input tree: recursion is capped at
 * `MAX_SCAN_DEPTH` container levels, and inputs deeper than that (or members
 * that cannot be read safely) yield a scan error that callers must treat as a
 * hard block instead of an implicit allow.
 */

/**
 * Tool-name pattern for the calls this extension inspects. Intentionally
 * loose: no word boundaries, no `g` flag, no dependency on third-party
 * schemas or fixed tool lists.
 */
export const INSPECTED_TOOL_NAME_PATTERN = /(subagent|delegate|spawn|agent)/i;

/** Whether a `tool_call` with this tool name should be inspected. */
export function matchesInspectedToolName(toolName: unknown): boolean {
  return typeof toolName === "string" && INSPECTED_TOOL_NAME_PATTERN.test(toolName);
}

/** One discovered `cwd` field: unambiguous path plus the untouched raw value. */
export interface CwdOccurrence {
  /**
   * Deterministic field path with unambiguous escaping, e.g.
   * `$["tasks"][0]["cwd"]`. Object keys are JSON-stringified; array indices
   * are bare.
   */
  path: string;
  /** The raw value as found; never copied, trimmed, or normalized. */
  value: unknown;
}

/** Why the input tree could not be fully traversed. */
export interface CwdScanError {
  /** Human-readable, safe-to-display description; never a stack trace. */
  message: string;
}

export interface CwdScanResult {
  /** All occurrences in deterministic traversal order; duplicates preserved. */
  occurrences: CwdOccurrence[];
  /** Present when the scan could not safely complete; callers must block. */
  error?: CwdScanError;
}

/** Maximum number of container levels the recursive scan enters. */
export const MAX_SCAN_DEPTH = 10;

/** The exact key name that marks a working-directory field. */
const CWD_KEY = "cwd";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Collect every `cwd` occurrence from the input tree.
 *
 * Rules (plan §4.2, simplified per staging decision):
 * - Own enumerable string keys only; prototype fields are never read.
 * - The key must be exactly lowercase `cwd`.
 * - A `cwd` value is a leaf: it is recorded and never entered, even when it
 *   is an object or array.
 * - Every non-`cwd` container is entered, at most `MAX_SCAN_DEPTH` levels.
 * - Duplicates keep every occurrence at its own position.
 * - Ancestor-chain cycle detection keeps cyclic inputs finite without
 *   globally deduplicating shared subobjects.
 * - A member that cannot be read (throwing getter, hostile Proxy) or input
 *   nesting beyond the depth cap yields an error result together with the
 *   occurrences collected so far; callers must block on the error.
 */
export function collectCwdOccurrences(input: unknown): CwdScanResult {
  const occurrences: CwdOccurrence[] = [];
  if (input === null || typeof input !== "object") {
    return { occurrences };
  }
  const error = scanContainer(input as object, "$", 0, new Set<object>(), occurrences);
  return error === undefined ? { occurrences } : { occurrences, error };
}

/**
 * Scan one container level. Returns a scan error when the subtree cannot be
 * traversed safely; `undefined` on success.
 */
function scanContainer(
  node: object,
  path: string,
  depth: number,
  ancestors: Set<object>,
  occurrences: CwdOccurrence[],
): CwdScanError | undefined {
  if (depth >= MAX_SCAN_DEPTH) {
    return {
      message:
        `Input nesting exceeds the maximum scan depth of ${MAX_SCAN_DEPTH} levels; the subtree at ${path} was not fully scanned.`,
    };
  }
  if (ancestors.has(node)) {
    // Cycle back into the current chain: skip without aborting the scan.
    return undefined;
  }
  ancestors.add(node);

  const isArray = Array.isArray(node);
  let keys: string[];
  try {
    keys = isArray ? [] : Object.keys(node);
  } catch (error) {
    return {
      message: `Input tree could not be fully scanned; failed to list keys at ${path}: ${describeError(error)}`,
    };
  }
  const entryCount = isArray ? (node as unknown[]).length : keys.length;

  for (let index = 0; index < entryCount; index++) {
    const key = isArray ? index : (keys[index] as string);
    const childPath = isArray ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]`;

    let value: unknown;
    try {
      value = isArray ? (node as unknown[])[index] : (node as Record<string, unknown>)[key];
    } catch (error) {
      return {
        message: `Input tree could not be fully scanned; failed to read ${childPath}: ${describeError(error)}`,
      };
    }

    if (!isArray && key === CWD_KEY) {
      // The cwd value is a leaf; never descend into it.
      occurrences.push({ path: childPath, value });
      continue;
    }

    if (value !== null && typeof value === "object") {
      const subtreeError = scanContainer(value as object, childPath, depth + 1, ancestors, occurrences);
      if (subtreeError !== undefined) {
        return subtreeError;
      }
    }
  }

  ancestors.delete(node);
  return undefined;
}
