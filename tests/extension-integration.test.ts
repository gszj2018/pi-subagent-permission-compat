import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import createExtension, {
  createCwdGuardFeature,
  createParentSessionEnvFeature,
  createSubagentPermissionCompatExtension,
  type ExtensionOptions,
  type SelectResolver,
} from "../extensions/index.ts";
import {
  PARENT_SESSION_ENV_VAR,
  type SubagentEnv,
} from "../extensions/parent-session-env.ts";
import {
  ALLOW_ONCE_OPTION,
  DENY_OPTION,
} from "../extensions/cwd-prompt.ts";
import type { NormalizePath } from "../extensions/cwd-guard.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface StubPi {
  api: ExtensionAPI;
  handlers: Map<string, Handler>;
}

/** In-memory event host recording handler registrations; never touches process.env. */
function createStubPi(): StubPi {
  const handlers = new Map<string, Handler>();
  const api = {
    on: (name: string, handler: Handler) => {
      assert.ok(!handlers.has(name), `duplicate registration for ${name}`);
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

/** Standard production-style resolver: use the event context's own select. */
const contextSelect: SelectResolver = (ctx) => ctx.ui.select;

const posixNormalize: NormalizePath = (value) => path.posix.normalize(value);
const win32Normalize: NormalizePath = (value) => path.win32.normalize(value);

/** Base options with an in-memory env and an explicit normalizer. */
function baseOptions(normalizePath: NormalizePath = posixNormalize): Pick<ExtensionOptions, "normalizePath" | "select"> {
  return { normalizePath, select: contextSelect };
}

interface SessionStub {
  ctx: ExtensionContext;
  notifications: { message: string; type: string | undefined }[];
}

function createSessionContext(sessionId: string): SessionStub {
  const notifications: { message: string; type: string | undefined }[] = [];
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications };
}

function fireSessionStart(pi: StubPi, ctx: ExtensionContext, reason: SessionStartEvent["reason"] = "startup"): void {
  const handler = pi.handlers.get("session_start");
  assert.ok(handler, "session_start handler must be registered");
  handler({ type: "session_start", reason }, ctx);
}

function fireSessionShutdown(pi: StubPi, reason: "quit" | "reload" | "new" | "resume" | "fork" = "quit"): void {
  const handler = pi.handlers.get("session_shutdown");
  assert.ok(handler, "session_shutdown handler must be registered");
  handler({ type: "session_shutdown", reason }, {} as ExtensionContext);
}

interface ToolCallStub {
  ctx: ExtensionContext;
  selectCalls: { title: string; options: string[] }[];
}

/**
 * Tool-call context whose session ID getter is intentionally not callable:
 * the tool_call handler must decide from the event cwd, never the session ID.
 */
function createToolCallContext(options: {
  hasUI?: boolean;
  cwd?: string;
  select?: (title: string, options: string[]) => Promise<string | undefined> | string | undefined;
  selectThrows?: Error;
} = {}): ToolCallStub {
  const selectCalls: { title: string; options: string[] }[] = [];
  const ctx = {
    sessionManager: {
      getSessionId: () => {
        throw new Error("session ID must not be read during tool_call");
      },
    },
    hasUI: options.hasUI ?? true,
    cwd: options.cwd ?? "/workspace/project",
    signal: undefined,
    ui: {
      select: async (title: string, optionList: string[]) => {
        selectCalls.push({ title, options: optionList });
        if (options.selectThrows) {
          throw options.selectThrows;
        }
        return options.select?.(title, optionList);
      },
      notify: () => undefined,
    } as unknown as ExtensionContext["ui"],
  } as unknown as ExtensionContext;
  return { ctx, selectCalls };
}

function fireToolCall(pi: StubPi, ctx: ExtensionContext, event: Partial<ToolCallEvent> & { toolName: string; input: unknown }): ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined> {
  const handler = pi.handlers.get("tool_call");
  assert.ok(handler, "tool_call handler must be registered");
  return handler(
    { type: "tool_call", toolCallId: "call-1", toolName: event.toolName, input: event.input },
    ctx,
  ) as ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>;
}

describe("extension registration", () => {
  it("default export is loadable and registers exactly the lifecycle and tool_call handlers", () => {
    const pi = createStubPi();
    createExtension(pi.api);

    assert.deepEqual([...pi.handlers.keys()].sort(), ["session_shutdown", "session_start", "tool_call"]);
  });

  it("injectable factory registers exactly the lifecycle and tool_call handlers", () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });

    assert.deepEqual([...pi.handlers.keys()].sort(), ["session_shutdown", "session_start", "tool_call"]);
  });

  it("registers the two capabilities independently", () => {
    const envPi = createStubPi();
    createParentSessionEnvFeature(envPi.api, { env: {} });
    assert.deepEqual([...envPi.handlers.keys()].sort(), ["session_shutdown", "session_start"]);

    const guardPi = createStubPi();
    createCwdGuardFeature(guardPi.api, { normalizePath: posixNormalize, select: contextSelect });
    assert.deepEqual([...guardPi.handlers.keys()], ["tool_call"]);
  });

  it("importing and registering never mutates the host environment", () => {
    const before: SubagentEnv = { ...process.env };
    const injected: SubagentEnv = {};

    createExtension(createStubPi().api);
    createSubagentPermissionCompatExtension(createStubPi().api, { env: injected, ...baseOptions() });

    assert.deepEqual({ ...process.env }, before);
    assert.deepEqual(injected, {});
  });
});

describe("minimal lifecycle through the event host (injected env)", () => {
  it("session_start publishes and session_shutdown cleans the owned value", () => {
    const env: SubagentEnv = {};
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env, ...baseOptions() });
    const { ctx } = createSessionContext("sess-root-integration");

    fireSessionStart(pi, ctx);
    assert.equal(env[PARENT_SESSION_ENV_VAR], "sess-root-integration");

    fireSessionShutdown(pi);
    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
  });

  it("repeat session_start without shutdown does not rewrite or lose ownership", () => {
    const env: SubagentEnv = {};
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env, ...baseOptions() });
    const { ctx } = createSessionContext("sess-root-integration");

    fireSessionStart(pi, ctx);
    fireSessionStart(pi, ctx, "resume");

    assert.equal(env[PARENT_SESSION_ENV_VAR], "sess-root-integration");
  });

  it("child-hint start skips publication silently and never owns a value", () => {
    const env: SubagentEnv = { PI_IS_SUBAGENT: "1" };
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env, ...baseOptions() });
    const { ctx, notifications } = createSessionContext("sess-child");

    fireSessionStart(pi, ctx);

    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
    assert.deepEqual(notifications, []);

    fireSessionShutdown(pi);
    assert.equal(env["PI_IS_SUBAGENT"], "1");
  });

  it("invalid session ID emits a non-stdout diagnostic and publishes nothing", () => {
    const env: SubagentEnv = {};
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env, ...baseOptions() });
    const { ctx, notifications } = createSessionContext("");

    fireSessionStart(pi, ctx);

    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.type, "warning");
    assert.match(notifications[0]?.message ?? "", /pi-subagent-permission-compat/);
    assert.match(notifications[0]?.message ?? "", /PI_SUBAGENT_PARENT_SESSION/);
  });
});

describe("tool_call cwd protection (injected normalizePath and select)", () => {
  it("ignores tools that do not match the pattern without any evaluation", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });
    const { ctx, selectCalls } = createToolCallContext({ select: () => ALLOW_ONCE_OPTION });

    const result = await fireToolCall(pi, ctx, {
      toolName: "read",
      input: { cwd: "../outside" },
    });

    assert.equal(result, undefined);
    assert.deepEqual(selectCalls, []);
  });

  it("returns undefined for an all-allow call without prompting (posix)", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions(posixNormalize) });
    const { ctx, selectCalls } = createToolCallContext({ select: () => ALLOW_ONCE_OPTION });

    const result = await fireToolCall(pi, ctx, {
      toolName: "subagent",
      input: { cwd: "/workspace/project" },
    });

    assert.equal(result, undefined);
    assert.deepEqual(selectCalls, []);
  });

  it("normalizes win32 paths through the injected normalizer (win32)", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions(win32Normalize) });
    // Forward slashes fold to backslashes: the same directory, so allow.
    const allowed = createToolCallContext({
      cwd: "C:\\workspace\\project",
      select: () => ALLOW_ONCE_OPTION,
    });
    assert.equal(
      await fireToolCall(pi, allowed.ctx, { toolName: "subagent", input: { cwd: "C:/workspace/project" } }),
      undefined,
    );
    assert.deepEqual(allowed.selectCalls, []);

    // A different drive stays ask and prompts.
    const asking = createToolCallContext({ cwd: "C:\\workspace\\project", select: () => DENY_OPTION });
    const result = (await fireToolCall(pi, asking.ctx, {
      toolName: "subagent",
      input: { cwd: "D:\\workspace\\project" },
    })) as ToolCallEventResult;
    assert.equal(result.block, true);
    assert.equal(asking.selectCalls.length, 1);
  });

  it("asks once with all cwd lines in the title and approves on Allow once", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });
    const { ctx, selectCalls } = createToolCallContext({ select: () => ALLOW_ONCE_OPTION });

    const result = await fireToolCall(pi, ctx, {
      toolName: "subagent",
      input: { cwd: "../shared", tasks: [{ cwd: "/workspace/project" }] },
    });

    assert.equal(result, undefined);
    assert.equal(selectCalls.length, 1, "multi-cwd calls must prompt exactly once");
    assert.ok(selectCalls[0]?.title.includes(`$["cwd"] = "../shared" [ask: differs from current directory]`));
    assert.ok(selectCalls[0]?.title.includes(`$["tasks"][0]["cwd"] = "/workspace/project" [allow: matches current directory]`));
    assert.ok(selectCalls[0]?.title.includes('Current directory: "/workspace/project"'));
    assert.deepEqual(selectCalls[0]?.options, [DENY_OPTION, ALLOW_ONCE_OPTION]);
  });

  it("blocks on Deny, cancellation, and unknown responses", async () => {
    for (const [name, response, expectedFragment] of [
      ["Deny", DENY_OPTION, /not approved/],
      ["cancel", undefined, /cancelled/],
      ["unknown", "sure thing", /unexpected approval response/],
    ] as const) {
      const pi = createStubPi();
      createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });
      const { ctx } = createToolCallContext({ select: () => response });

      const result = (await fireToolCall(pi, ctx, {
        toolName: "subagent",
        input: { cwd: "../outside" },
      })) as ToolCallEventResult;

      assert.equal(result.block, true, name);
      assert.match(result.reason ?? "", expectedFragment);
      assert.match(result.reason ?? "", /^\[pi-subagent-permission-compat]/);
    }
  });

  it("blocks when the select prompt throws", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });
    const { ctx } = createToolCallContext({
      selectThrows: new Error("dialog crashed"),
    });

    const result = (await fireToolCall(pi, ctx, {
      toolName: "subagent",
      input: { cwd: "../outside" },
    })) as ToolCallEventResult;

    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /approval prompt failed/);
  });

  it("blocks an ask without interactive UI (print/JSON modes) and never prompts", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });
    const { ctx, selectCalls } = createToolCallContext({ hasUI: false, select: () => ALLOW_ONCE_OPTION });

    const result = (await fireToolCall(pi, ctx, {
      toolName: "subagent",
      input: { cwd: "../outside" },
    })) as ToolCallEventResult;

    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /no interactive UI/);
    assert.deepEqual(selectCalls, []);
  });

  it("hard-blocks when the scan fails, regardless of collected items and UI", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });
    const input: Record<string, unknown> = {};
    input["before"] = { cwd: "/workspace/project" };
    Object.defineProperty(input, "danger", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("scan exploded");
      },
    });
    const { ctx, selectCalls } = createToolCallContext({ select: () => ALLOW_ONCE_OPTION });

    const result = (await fireToolCall(pi, ctx, {
      toolName: "subagent",
      input,
    })) as ToolCallEventResult;

    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /could not be safely scanned/);
    assert.deepEqual(selectCalls, [], "a scan failure must not reach the user prompt");
  });

  it("asks again for a repeated ask call without reusing a previous approval", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });
    const { ctx, selectCalls } = createToolCallContext({ select: () => ALLOW_ONCE_OPTION });

    const first = await fireToolCall(pi, ctx, { toolName: "subagent", input: { cwd: "../a" } });
    const second = await fireToolCall(pi, ctx, { toolName: "subagent", input: { cwd: "../a" } });

    assert.equal(first, undefined);
    assert.equal(second, undefined);
    assert.equal(selectCalls.length, 2, "each ask must prompt again");
  });

  it("reads the event cwd, not the session ID: equal input allows, differing asks", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });

    const matching = createToolCallContext({ cwd: "/workspace/project", select: () => ALLOW_ONCE_OPTION });
    assert.equal(
      await fireToolCall(pi, matching.ctx, { toolName: "subagent", input: { cwd: "/workspace/project" } }),
      undefined,
    );
    assert.deepEqual(matching.selectCalls, []);

    const differing = createToolCallContext({ cwd: "/elsewhere", select: () => DENY_OPTION });
    const result = (await fireToolCall(pi, differing.ctx, {
      toolName: "subagent",
      input: { cwd: "/workspace/project" },
    })) as ToolCallEventResult;
    assert.equal(result.block, true, "the same input must ask against a different cwd");
    assert.equal(differing.selectCalls.length, 1);
  });

  it("changing ctx.cwd between calls flips the same input from allow to ask (no stale cache)", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });
    const event = { toolName: "subagent", input: { cwd: "/work" } };

    const before = createToolCallContext({ cwd: "/work", select: () => ALLOW_ONCE_OPTION });
    assert.equal(await fireToolCall(pi, before.ctx, event), undefined);

    const after = createToolCallContext({ cwd: "/other", select: () => DENY_OPTION });
    const result = (await fireToolCall(pi, after.ctx, event)) as ToolCallEventResult;
    assert.equal(result.block, true);
  });

  it("never modifies the tool-call input (frozen input passes through)", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });
    const { ctx } = createToolCallContext();
    const input = Object.freeze({ cwd: "../outside" });

    const result = await fireToolCall(pi, ctx, { toolName: "subagent", input });

    assert.ok(Object.isFrozen(input));
    assert.equal((result as ToolCallEventResult).block, true);
  });

  it("blocking a batch call keeps every subtask from running (atomic refusal)", async () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {}, ...baseOptions() });
    const { ctx } = createToolCallContext({ select: () => DENY_OPTION });
    const executedTasks: string[] = [];
    const fakeExecutor = (task: string, event?: ToolCallEvent): void => {
      // The host runs tools only when no handler blocked the call.
      if (event) {
        executedTasks.push(task);
      }
    };

    const event = { type: "tool_call" as const, toolCallId: "call-1", toolName: "delegate", input: { tasks: [{ cwd: "../denied" }, { cwd: "/workspace/project" }] } };
    const result = (await fireToolCall(pi, ctx, event)) as ToolCallEventResult;

    // A blocked call never reaches the executor: no subtask runs at all.
    assert.equal(result.block, true);
    if (!result.block) {
      fakeExecutor("task0", event);
      fakeExecutor("task1", event);
    }
    assert.deepEqual(executedTasks, []);
  });
});

describe("cross-phase regression (capabilities compose)", () => {
  it("session publication and current-cwd comparison work together in one host", async () => {
    const env: SubagentEnv = {};
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env, ...baseOptions() });
    const sessionCtx = createSessionContext("sess-regression-1");
    const { ctx, selectCalls } = createToolCallContext({ cwd: "/workspace/project", select: () => ALLOW_ONCE_OPTION });

    // Session publication is unchanged and independent of cwd evaluation.
    fireSessionStart(pi, sessionCtx.ctx);
    assert.equal(env[PARENT_SESSION_ENV_VAR], "sess-regression-1");

    // The tool_call handler compares against the event cwd, not the session ID.
    await fireToolCall(pi, ctx, { toolName: "subagent", input: { cwd: "/workspace/project" } });
    assert.deepEqual(selectCalls, [], "a matching cwd allows without prompting");
  });

  it("after shutdown and a new session, the env is re-published and cwd evaluation follows each call's cwd", async () => {
    const env: SubagentEnv = {};
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env, ...baseOptions() });
    const firstSession = createSessionContext("sess-before-reload");
    const secondSession = createSessionContext("sess-after-reload");
    const before = createToolCallContext({ cwd: "/old", select: () => ALLOW_ONCE_OPTION });
    const after = createToolCallContext({ cwd: "/new", select: () => ALLOW_ONCE_OPTION });

    fireSessionStart(pi, firstSession.ctx);
    await fireToolCall(pi, before.ctx, { toolName: "subagent", input: { cwd: "/old" } });
    assert.deepEqual(before.selectCalls, []);

    fireSessionShutdown(pi, "reload");
    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);

    fireSessionStart(pi, secondSession.ctx);
    assert.equal(env[PARENT_SESSION_ENV_VAR], "sess-after-reload");
    // Same input now compares against the new cwd and asks; the user denies it.
    const denying = createToolCallContext({ cwd: "/new", select: () => DENY_OPTION });
    const result = (await fireToolCall(pi, denying.ctx, {
      toolName: "subagent",
      input: { cwd: "/old" },
    })) as ToolCallEventResult;
    assert.equal(result.block, true);
  });

  it("an ask that the user rejects blocks the call with the approval-denied reason", async () => {
    const env: SubagentEnv = {};
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env, ...baseOptions() });
    const { ctx, selectCalls } = createToolCallContext({ cwd: "/workspace/project", select: () => DENY_OPTION });

    const sessionCtx = createSessionContext("sess-regression-deny");
    fireSessionStart(pi, sessionCtx.ctx);
    assert.equal(env[PARENT_SESSION_ENV_VAR], "sess-regression-deny");

    const result = (await fireToolCall(pi, ctx, {
      toolName: "subagent",
      input: { cwd: "../outside" },
    })) as ToolCallEventResult;

    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /not approved/);
    assert.equal(selectCalls.length, 1, "the ask must prompt once");
  });
});
