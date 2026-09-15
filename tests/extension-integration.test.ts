import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";

import createExtension, {
  createSubagentPermissionCompatExtension,
} from "../extensions/index.ts";
import { PARENT_SESSION_ENV_VAR, type SubagentEnv } from "../extensions/parent-session-env.ts";

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

interface StubContext {
  ctx: ExtensionContext;
  notifications: { message: string; type: string | undefined }[];
}

function createStubContext(sessionId: string): StubContext {
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

describe("extension registration", () => {
  it("default export is loadable and registers exactly the lifecycle handlers", () => {
    const pi = createStubPi();
    createExtension(pi.api);

    assert.deepEqual([...pi.handlers.keys()].sort(), ["session_shutdown", "session_start"]);
  });

  it("injectable factory registers exactly the lifecycle handlers", () => {
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env: {} });

    assert.deepEqual([...pi.handlers.keys()].sort(), ["session_shutdown", "session_start"]);
  });

  it("importing and registering never mutates the host environment", () => {
    const before: SubagentEnv = { ...process.env };
    const injected: SubagentEnv = {};

    createExtension(createStubPi().api);
    createSubagentPermissionCompatExtension(createStubPi().api, { env: injected });

    assert.deepEqual({ ...process.env }, before);
    assert.deepEqual(injected, {});
  });
});

describe("minimal lifecycle through the event host (injected env)", () => {
  it("session_start publishes and session_shutdown cleans the owned value", () => {
    const env: SubagentEnv = {};
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env });
    const { ctx } = createStubContext("sess-root-integration");

    fireSessionStart(pi, ctx);
    assert.equal(env[PARENT_SESSION_ENV_VAR], "sess-root-integration");

    fireSessionShutdown(pi);
    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
  });

  it("repeat session_start without shutdown does not rewrite or lose ownership", () => {
    const env: SubagentEnv = {};
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env });
    const { ctx } = createStubContext("sess-root-integration");

    fireSessionStart(pi, ctx);
    fireSessionStart(pi, ctx, "resume");

    assert.equal(env[PARENT_SESSION_ENV_VAR], "sess-root-integration");
  });

  it("child-hint start skips publication silently and never owns a value", () => {
    const env: SubagentEnv = { PI_IS_SUBAGENT: "1" };
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env });
    const { ctx, notifications } = createStubContext("sess-child");

    fireSessionStart(pi, ctx);

    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
    assert.deepEqual(notifications, []);

    fireSessionShutdown(pi);
    assert.equal(env["PI_IS_SUBAGENT"], "1");
  });

  it("invalid session ID emits a non-stdout diagnostic and publishes nothing", () => {
    const env: SubagentEnv = {};
    const pi = createStubPi();
    createSubagentPermissionCompatExtension(pi.api, { env });
    const { ctx, notifications } = createStubContext("");

    fireSessionStart(pi, ctx);

    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.type, "warning");
    assert.match(notifications[0]?.message ?? "", /pi-subagent-permission-compat/);
    assert.match(notifications[0]?.message ?? "", /PI_SUBAGENT_PARENT_SESSION/);
  });
});
