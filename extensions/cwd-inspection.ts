/**
 * Complete `cwd` collection from subagent tool calls.
 *
 * This module only reads tool-call input; it never touches the permission
 * system, the UI, or the environment. Collection is a bounded recursive
 * depth-first traversal over the raw input tree: recursion is capped at
 * `MAX_SCAN_DEPTH` container levels, and inputs deeper than that (or
 * containers that are not shallow JSON objects or arrays) yield a scan error
 * that callers must treat as a hard block instead of an implicit allow.
 */

import { types } from "node:util";

import { describeUnknown, describeError } from "./diagnostics.ts";

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

function isArrayIndexKey(key: string): boolean {
  const MAX_ARRAY_INDEX = 2 ** 32 - 1;
  const index = Number(key);

  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < MAX_ARRAY_INDEX &&
    String(index) === key
  );
}

/**
 * Shallow JSON-shape check for one container (object or array).
 *
 * Only the node itself is inspected: values are never validated because the
 * scan validates each nested container when it enters it. Accepted are plain
 * objects and arrays whose prototype is `Object.prototype`/`Array.prototype`
 * or `null`, carrying string-keyed enumerable data properties only. Rejected
 * are proxies, non-trivial prototypes (class instances, cross-realm objects,
 * `Date`, `Map`, ...), symbol keys, accessor properties, and non-enumerable
 * own keys. Writability and configurability are not checked, so frozen and
 * sealed containers stay scannable.
 */
export function isShallowJsonObject(value: unknown): boolean {
  try {
    if (value === null || typeof value !== "object") {
      return false;
    }
    if (types.isProxy(value)) {
      return false;
    }

    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    const expectedPrototype = isArray ? Array.prototype : Object.prototype;
    if (prototype !== expectedPrototype && prototype !== null) {
      return false;
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return false;
      }
      if (isArray && key === "length") {
        // Intrinsic array property: non-enumerable by specification.
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) || // Reject getters and setters.
        descriptor.enumerable !== true
      ) {
        return false;
      }
    }

    return true;
  } catch {
    // Revoked proxies and hostile traps must fail closed.
    return false;
  }
}

function nestError(path: string): CwdScanError {
  return {
    message: `Input nesting exceeds the maximum scan depth of ${MAX_SCAN_DEPTH} levels; the subtree at ${path} was not fully scanned.`,
  };
}

function nonJsonContainerError(path: string): CwdScanError {
  return {
    message: `Input tree could not be fully scanned; the container at ${path} is not a plain JSON object or array.`,
  };
}

function invalidArrayIndexKeyError(path: string, key: string): CwdScanError {
  return {
    message: `Input tree could not be fully scanned; invalid array index key at ${path}: ${describeUnknown(key)}`,
  };
}

/**
 * Collect every `cwd` occurrence from the input tree.
 *
 * Rules (simplified per staging decision):
 * - Own enumerable string keys only; prototype fields are never read.
 * - The key must be exactly lowercase `cwd`.
 * - A `cwd` value is a leaf: it is recorded and never entered, even when it
 *   is an object or array.
 * - Every non-`cwd` container is entered, at most `MAX_SCAN_DEPTH` levels.
 * - Duplicates keep every occurrence at its own position.
 * - Ancestor-chain cycle detection keeps cyclic inputs finite without
 *   globally deduplicating shared subobjects.
 * - Every entered container (including the root) must be a shallow JSON
 *   object or array (`isShallowJsonObject`); anything else yields an error.
 * - Arrays may only carry canonical array index keys besides the intrinsic
 *   `length`; other keys yield an error.
 * - Values are never validated: non-object leaves (functions, symbols,
 *   bigints) are not entered and `cwd` values are recorded without any
 *   container check.
 * - An invalid container or input nesting beyond the depth cap yields an
 *   error result together with the occurrences collected so far; callers
 *   must block on the error.
 */
export function collectCwdOccurrences(input: unknown): CwdScanResult {
  const occurrences: CwdOccurrence[] = [];
  if (input === null || typeof input !== "object") {
    return { occurrences };
  }
  try {
    const error = scanContainer(input as object, "$", 0, new Set<object>(), occurrences);
    return error === undefined ? { occurrences } : { occurrences, error };
  } catch (e) {
    return { occurrences, error: { message: `Input tree could not be fully scanned; Error: ${describeError(e)}` } };
  }
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
    return nestError(path);
  }
  if (ancestors.has(node)) {
    // Cycle back into the current chain: skip without aborting the scan; the
    // node was already validated when it was first entered.
    return undefined;
  }
  if (!isShallowJsonObject(node)) {
    return nonJsonContainerError(path);
  }
  ancestors.add(node);

  const isArray = Array.isArray(node);

  for (const key in node) {
    if (!Object.hasOwn(node, key)) {
      continue;
    }

    if (isArray && !isArrayIndexKey(key)) {
      return invalidArrayIndexKeyError(path, key);
    }

    const value = node[key as keyof typeof node];
    const childPath = isArray ? `${path}[${key}]` : `${path}[${describeUnknown(key)}]`;
    if (key === CWD_KEY) {
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
