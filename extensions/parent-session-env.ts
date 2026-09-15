/**
 * Parent-session environment compatibility.
 *
 * Detects whether the current Pi process is a root session or a third-party
 * subagent process, and publishes `PI_SUBAGENT_PARENT_SESSION` so that
 * permission-system asks can be forwarded to the parent session by child
 * processes that inherit this environment.
 *
 * The environment object is injectable so tests can use in-memory records
 * instead of mutating the host `process.env`.
 */

/**
 * Environment variables set by third-party subagent extensions inside child
 * (subagent) processes. Any of these marks the current process as a subagent
 * child; publication must be skipped in that case.
 */
export const THIRD_PARTY_SUBAGENT_ENV_HINTS: readonly string[] = [
  // pi-agent-router (original)
  "PI_IS_SUBAGENT",
  "PI_SUBAGENT_SESSION_ID",
  "PI_AGENT_ROUTER_SUBAGENT",
  // nicobailon/pi-subagents
  "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_RUN_ID",
  "PI_SUBAGENT_CHILD_AGENT",
  "PI_SUBAGENT_DEPTH",
  // HazAT/pi-interactive-subagents
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ACTIVITY_FILE",
];

/**
 * Environment variables that already carry a parent-session declaration for
 * the current process. Any of these means some other component has already
 * published a parent session; the shared convention variable must not be
 * overwritten or duplicated.
 */
export const SUBAGENT_PARENT_SESSION_ENV_CANDIDATES: readonly string[] = [
  // pi-agent-router (original)
  "PI_AGENT_ROUTER_PARENT_SESSION_ID",
  // Shared convention for CLI-based subagent extensions
  "PI_SUBAGENT_PARENT_SESSION",
];

/** The single environment variable this extension owns and may write. */
export const PARENT_SESSION_ENV_VAR = "PI_SUBAGENT_PARENT_SESSION";

/** Environment record shape. The host `process.env` satisfies this. */
export type SubagentEnv = Record<string, string | undefined>;

/** Why publication of the parent-session variable was skipped. */
export type PublicationSkipReason =
  /** A third-party child hint marks this process as a subagent child. */
  | "child-hint"
  /** A parent-session declaration is already present in the environment. */
  | "parent-session-present"
  /** The host provided no usable session ID. */
  | "invalid-session-id";

/** Outcome of a session-start environment publication attempt. */
export interface PublicationDecision {
  /** Whether `PARENT_SESSION_ENV_VAR` was written during this start. */
  published: boolean;
  /** Present only when `published` is false. */
  skipReason?: PublicationSkipReason;
}

/** Value published by this extension instance, kept for lifecycle cleanup. */
export interface OwnedPublication {
  /** Environment variable name that was written. */
  variable: string;
  /** Exact value that was written. */
  value: string;
}

/** Whether a session ID is usable as a parent-session declaration. */
export function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && sessionId.trim().length > 0;
}

/** Whether the environment contains a variable from the given list. */
export function envHasAny(env: SubagentEnv, names: readonly string[]): boolean {
  return names.some((name) => env[name] !== undefined);
}

/**
 * Pure detection algorithm for session start. Does not mutate `env`.
 *
 * Order matters: child hints take precedence over existing parent-session
 * declarations, and an existing declaration (including one written earlier by
 * this same instance) always wins over republishing.
 */
export function decidePublication(
  env: SubagentEnv,
  sessionId: unknown,
): PublicationDecision {
  if (envHasAny(env, THIRD_PARTY_SUBAGENT_ENV_HINTS)) {
    return { published: false, skipReason: "child-hint" };
  }
  if (envHasAny(env, SUBAGENT_PARENT_SESSION_ENV_CANDIDATES)) {
    return { published: false, skipReason: "parent-session-present" };
  }
  if (!isValidSessionId(sessionId)) {
    return { published: false, skipReason: "invalid-session-id" };
  }
  return { published: true };
}

/**
 * Lifecycle controller for the owned parent-session environment variable.
 *
 * - `handleSessionStart` implements the detection order and
 *   records a publication only when this instance actually wrote the value.
 * - `handleSessionShutdown` removes the value only when it is still owned
 *   (name and value both match) and is idempotent.
 *
 * A repeat session start without an intervening shutdown never overwrites the
 * owned value and never loses the existing ownership record.
 */
export class ParentSessionEnvController {
  private readonly env: SubagentEnv;
  private owned: OwnedPublication | undefined;

  constructor(env: SubagentEnv) {
    this.env = env;
  }

  /** The publication still owned by this instance, if any. */
  getOwnedPublication(): OwnedPublication | undefined {
    return this.owned;
  }

  /**
   * Handle `session_start`. Returns the publication decision for diagnostics.
   * Never overwrites an owned publication and never drops an ownership record.
   */
  handleSessionStart(sessionId: unknown): PublicationDecision {
    const decision = decidePublication(this.env, sessionId);
    if (decision.published) {
      const value = sessionId as string;
      this.env[PARENT_SESSION_ENV_VAR] = value;
      this.owned = { variable: PARENT_SESSION_ENV_VAR, value };
    }
    return decision;
  }

  /**
   * Handle `session_shutdown`. Deletes the owned value only when the current
   * environment still equals the recorded write; clears the ownership record
   * in every case where a record exists. Safe to call multiple times.
   */
  handleSessionShutdown(): void {
    const owned = this.owned;
    if (!owned) {
      return;
    }
    if (this.env[owned.variable] === owned.value) {
      delete this.env[owned.variable];
    }
    this.owned = undefined;
  }
}
