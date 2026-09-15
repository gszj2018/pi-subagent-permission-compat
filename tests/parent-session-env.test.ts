import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PARENT_SESSION_ENV_VAR,
  ParentSessionEnvController,
  SUBAGENT_PARENT_SESSION_ENV_CANDIDATES,
  THIRD_PARTY_SUBAGENT_ENV_HINTS,
  decidePublication,
  envHasAny,
  isValidSessionId,
  type SubagentEnv,
} from "../extensions/parent-session-env.ts";

const ROOT_SESSION_ID = "sess-root-0001";
const OTHER_SESSION_ID = "sess-root-0002";

function freshEnv(entries: Record<string, string | undefined> = {}): SubagentEnv {
  return { ...entries };
}

describe("env list contracts", () => {
  it("keeps the two lists disjoint", () => {
    for (const name of THIRD_PARTY_SUBAGENT_ENV_HINTS) {
      assert.ok(
        !SUBAGENT_PARENT_SESSION_ENV_CANDIDATES.includes(name),
        `unexpected overlap: ${name}`,
      );
    }
  });

  it("exposes the shared convention variable as the owned publication target", () => {
    assert.equal(PARENT_SESSION_ENV_VAR, "PI_SUBAGENT_PARENT_SESSION");
    assert.ok(SUBAGENT_PARENT_SESSION_ENV_CANDIDATES.includes(PARENT_SESSION_ENV_VAR));
  });

  it("treats any present value as set", () => {
    const env: SubagentEnv = { PI_IS_SUBAGENT: "" };
    assert.equal(envHasAny(env, ["PI_IS_SUBAGENT"]), true);
    assert.equal(envHasAny(env, ["MISSING_VAR"]), false);
  });
});

describe("decidePublication", () => {
  it("publishes when no hint or candidate variable exists", () => {
    const decision = decidePublication(freshEnv(), ROOT_SESSION_ID);
    assert.deepEqual(decision, { published: true });
  });

  it("skips with child-hint for every third-party hint, including falsy-looking values", () => {
    for (const name of THIRD_PARTY_SUBAGENT_ENV_HINTS) {
      for (const value of ["", " ", "0", "false"]) {
        const decision = decidePublication(freshEnv({ [name]: value }), ROOT_SESSION_ID);
        assert.deepEqual(
          decision,
          { published: false, skipReason: "child-hint" },
          `${name}=${JSON.stringify(value)}`,
        );
      }
    }
  });

  it("skips with parent-session-present for every candidate variable", () => {
    for (const name of SUBAGENT_PARENT_SESSION_ENV_CANDIDATES) {
      for (const value of ["", " ", "0", "false", "sess-external"]) {
        const decision = decidePublication(freshEnv({ [name]: value }), ROOT_SESSION_ID);
        assert.deepEqual(
          decision,
          { published: false, skipReason: "parent-session-present" },
          `${name}=${JSON.stringify(value)}`,
        );
      }
    }
  });

  it("gives child hints precedence over existing parent-session declarations", () => {
    const env = freshEnv({
      PI_IS_SUBAGENT: "1",
      PI_AGENT_ROUTER_PARENT_SESSION_ID: "sess-parent",
    });
    const decision = decidePublication(env, ROOT_SESSION_ID);
    assert.deepEqual(decision, { published: false, skipReason: "child-hint" });
  });

  it("does not inject for invalid session IDs", () => {
    for (const invalid of [undefined, null, "", "   ", 42, {}]) {
      const decision = decidePublication(freshEnv(), invalid);
      assert.deepEqual(
        decision,
        { published: false, skipReason: "invalid-session-id" },
        `invalid id: ${JSON.stringify(invalid)}`,
      );
    }
  });

  it("never mutates the environment record", () => {
    const env = freshEnv({ KEEP_ME: "value" });
    const snapshot = structuredClone(env);
    decidePublication(env, ROOT_SESSION_ID);
    decidePublication(freshEnv({ PI_IS_SUBAGENT: "1" }), ROOT_SESSION_ID);
    assert.deepEqual(env, snapshot);
  });

  it("accepts session IDs that contain surrounding whitespace", () => {
    const decision = decidePublication(freshEnv(), "  sess-root-0003  ");
    assert.deepEqual(decision, { published: true });
  });
});

describe("isValidSessionId", () => {
  it("accepts non-empty strings and rejects empties and non-strings", () => {
    assert.equal(isValidSessionId("sess-1"), true);
    assert.equal(isValidSessionId("   x   "), true);
    assert.equal(isValidSessionId(""), false);
    assert.equal(isValidSessionId("   "), false);
    assert.equal(isValidSessionId(undefined), false);
    assert.equal(isValidSessionId(null), false);
    assert.equal(isValidSessionId(7), false);
  });
});

describe("ParentSessionEnvController.handleSessionStart", () => {
  it("publishes the current session ID and records ownership", () => {
    const env = freshEnv();
    const controller = new ParentSessionEnvController(env);

    const decision = controller.handleSessionStart(ROOT_SESSION_ID);

    assert.deepEqual(decision, { published: true });
    assert.equal(env[PARENT_SESSION_ENV_VAR], ROOT_SESSION_ID);
    assert.deepEqual(controller.getOwnedPublication(), {
      variable: PARENT_SESSION_ENV_VAR,
      value: ROOT_SESSION_ID,
    });
  });

  it("leaves unrelated environment entries untouched", () => {
    const env = freshEnv({ PATH: "/usr/bin", EMPTY: "", OTHER: "keep" });
    const controller = new ParentSessionEnvController(env);

    controller.handleSessionStart(ROOT_SESSION_ID);

    assert.equal(env["PATH"], "/usr/bin");
    assert.equal(env["EMPTY"], "");
    assert.equal(env["OTHER"], "keep");
  });

  it("does not publish or record ownership when a child hint exists", () => {
    const env = freshEnv({ PI_SUBAGENT_CHILD: "1" });
    const controller = new ParentSessionEnvController(env);

    const decision = controller.handleSessionStart(ROOT_SESSION_ID);

    assert.deepEqual(decision, { published: false, skipReason: "child-hint" });
    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
    assert.equal(controller.getOwnedPublication(), undefined);
  });

  it("does not publish when a parent-session declaration already exists", () => {
    const env = freshEnv({ PI_AGENT_ROUTER_PARENT_SESSION_ID: "sess-external" });
    const controller = new ParentSessionEnvController(env);

    const decision = controller.handleSessionStart(ROOT_SESSION_ID);

    assert.deepEqual(decision, { published: false, skipReason: "parent-session-present" });
    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
    assert.equal(controller.getOwnedPublication(), undefined);
  });

  it("does not copy an old-convention parent value into the shared variable", () => {
    const env = freshEnv({ PI_AGENT_ROUTER_PARENT_SESSION_ID: "sess-old-convention" });
    const controller = new ParentSessionEnvController(env);

    controller.handleSessionStart(ROOT_SESSION_ID);

    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
    assert.equal(env["PI_AGENT_ROUTER_PARENT_SESSION_ID"], "sess-old-convention");
  });

  it("does not publish when the session ID is invalid", () => {
    const env = freshEnv();
    const controller = new ParentSessionEnvController(env);

    const decision = controller.handleSessionStart("   ");

    assert.deepEqual(decision, { published: false, skipReason: "invalid-session-id" });
    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
    assert.equal(controller.getOwnedPublication(), undefined);
  });

  it("is idempotent across repeated starts without shutdown", () => {
    const env = freshEnv();
    const controller = new ParentSessionEnvController(env);

    controller.handleSessionStart(ROOT_SESSION_ID);
    const decision = controller.handleSessionStart(ROOT_SESSION_ID);

    assert.deepEqual(decision, { published: false, skipReason: "parent-session-present" });
    assert.equal(env[PARENT_SESSION_ENV_VAR], ROOT_SESSION_ID);
    assert.deepEqual(controller.getOwnedPublication(), {
      variable: PARENT_SESSION_ENV_VAR,
      value: ROOT_SESSION_ID,
    });
  });

  it("does not overwrite an owned value even if the session ID changed without shutdown", () => {
    const env = freshEnv();
    const controller = new ParentSessionEnvController(env);

    controller.handleSessionStart(ROOT_SESSION_ID);
    controller.handleSessionStart(OTHER_SESSION_ID);

    assert.equal(env[PARENT_SESSION_ENV_VAR], ROOT_SESSION_ID);
    assert.deepEqual(controller.getOwnedPublication(), {
      variable: PARENT_SESSION_ENV_VAR,
      value: ROOT_SESSION_ID,
    });
  });
});

describe("parent-to-child inheritance semantics", () => {
  it("child processes inheriting the published value are not overwritten", () => {
    // Parent side
    const parentEnv = freshEnv();
    const parentController = new ParentSessionEnvController(parentEnv);
    parentController.handleSessionStart(ROOT_SESSION_ID);

    // Child inherits an independent snapshot of the parent environment.
    const childEnv = freshEnv(parentEnv);
    const childController = new ParentSessionEnvController(childEnv);

    const decision = childController.handleSessionStart("sess-child-0001");

    assert.deepEqual(decision, { published: false, skipReason: "parent-session-present" });
    assert.equal(childEnv[PARENT_SESSION_ENV_VAR], ROOT_SESSION_ID);
    assert.equal(childController.getOwnedPublication(), undefined);
  });

  it("child hint without a parent ID still skips publication", () => {
    const childEnv = freshEnv({ PI_SUBAGENT_NAME: "worker" });
    const childController = new ParentSessionEnvController(childEnv);

    const decision = childController.handleSessionStart("sess-child-0002");

    assert.deepEqual(decision, { published: false, skipReason: "child-hint" });
    assert.equal(childEnv[PARENT_SESSION_ENV_VAR], undefined);
  });
});

describe("ParentSessionEnvController.handleSessionShutdown", () => {
  it("removes the still-owned value and is idempotent", () => {
    const env = freshEnv();
    const controller = new ParentSessionEnvController(env);
    controller.handleSessionStart(ROOT_SESSION_ID);

    controller.handleSessionShutdown();
    controller.handleSessionShutdown();

    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
    assert.equal(controller.getOwnedPublication(), undefined);
  });

  it("keeps an externally replaced value but clears ownership", () => {
    const env = freshEnv();
    const controller = new ParentSessionEnvController(env);
    controller.handleSessionStart(ROOT_SESSION_ID);
    env[PARENT_SESSION_ENV_VAR] = "sess-foreign";

    controller.handleSessionShutdown();

    assert.equal(env[PARENT_SESSION_ENV_VAR], "sess-foreign");
    assert.equal(controller.getOwnedPublication(), undefined);
  });

  it("does not delete external preset values it never published", () => {
    const env = freshEnv({ PI_AGENT_ROUTER_PARENT_SESSION_ID: "sess-external" });
    const controller = new ParentSessionEnvController(env);
    controller.handleSessionStart(ROOT_SESSION_ID);

    controller.handleSessionShutdown();

    assert.equal(env["PI_AGENT_ROUTER_PARENT_SESSION_ID"], "sess-external");
    assert.equal(controller.getOwnedPublication(), undefined);
  });

  it("is a no-op when nothing was ever published", () => {
    const env = freshEnv();
    const controller = new ParentSessionEnvController(env);

    controller.handleSessionShutdown();

    assert.equal(env[PARENT_SESSION_ENV_VAR], undefined);
    assert.equal(controller.getOwnedPublication(), undefined);
  });
});

describe("lifecycle transitions", () => {
  it("old shutdown -> new start publishes the new session ID without stale residue", () => {
    const env = freshEnv();
    const oldController = new ParentSessionEnvController(env);
    oldController.handleSessionStart(ROOT_SESSION_ID);
    oldController.handleSessionShutdown();

    const newController = new ParentSessionEnvController(env);
    const decision = newController.handleSessionStart(OTHER_SESSION_ID);

    assert.deepEqual(decision, { published: true });
    assert.equal(env[PARENT_SESSION_ENV_VAR], OTHER_SESSION_ID);
    assert.deepEqual(newController.getOwnedPublication(), {
      variable: PARENT_SESSION_ENV_VAR,
      value: OTHER_SESSION_ID,
    });
  });

  it("simulates reload: publish, shutdown, re-publish with a new session ID", () => {
    const env = freshEnv();
    const controller = new ParentSessionEnvController(env);

    controller.handleSessionStart(ROOT_SESSION_ID);
    controller.handleSessionShutdown();
    controller.handleSessionStart(OTHER_SESSION_ID);

    assert.equal(env[PARENT_SESSION_ENV_VAR], OTHER_SESSION_ID);
    assert.deepEqual(controller.getOwnedPublication(), {
      variable: PARENT_SESSION_ENV_VAR,
      value: OTHER_SESSION_ID,
    });
  });

  it("does not delete a later external value after its own shutdown", () => {
    const env = freshEnv();
    const controller = new ParentSessionEnvController(env);
    controller.handleSessionStart(ROOT_SESSION_ID);
    controller.handleSessionShutdown();

    // Another component re-declares the variable after cleanup.
    env[PARENT_SESSION_ENV_VAR] = "sess-reintroduced";
    controller.handleSessionShutdown();

    assert.equal(env[PARENT_SESSION_ENV_VAR], "sess-reintroduced");
  });
});
