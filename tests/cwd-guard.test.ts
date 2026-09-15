import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultCwdGuardDeps,
  evaluateCwdOccurrences,
  type CwdGuardDeps,
} from "../extensions/cwd-guard.ts";
import {
  defaultPermissionModuleImporter,
  type ExternalDirectoryCheck,
  type PermissionsService,
  type ServiceResolution,
} from "../extensions/permissions-client.ts";

const SESSION_ID = "sess-guard-0001";

const allowAllService = {
  checkPermission: () => ({ state: "allow" }),
} as unknown as PermissionsService;

/** Recording dependency stubs: counts resolutions and per-item queries. */
function createDepsStub(options: {
  resolution?: ServiceResolution;
  check?: (rawCwd: string, index: number) => ExternalDirectoryCheck;
} = {}): CwdGuardDeps & { resolveCalls: string[]; checkCalls: string[] } {
  const resolveCalls: string[] = [];
  const checkCalls: string[] = [];
  let checkIndex = 0;
  return {
    resolveCalls,
    checkCalls,
    resolveService: async (sessionId) => {
      resolveCalls.push(sessionId);
      return options.resolution ?? { ok: true, service: allowAllService };
    },
    checkService: (service, rawCwd) => {
      checkCalls.push(rawCwd);
      const result: ExternalDirectoryCheck = options.check
        ? options.check(rawCwd, checkIndex++)
        : { ok: true, state: "allow" };
      return result;
    },
  };
}

describe("per-value classification (plan §4.3)", () => {
  it("queries every non-empty string raw, including whitespace and dot paths", async () => {
    const deps = createDepsStub();
    const input = { cwd: "  ", other: { cwd: "." }, list: [{ cwd: "C:\\outside" }] };

    const outcome = await evaluateCwdOccurrences(input, SESSION_ID, deps);

    // Raw values passed untouched: no trim, no rewrite.
    assert.deepEqual(deps.checkCalls, ["  ", ".", "C:\\outside"]);
    assert.deepEqual(
      outcome.evaluations.map((e) => ({ state: e.state, reason: e.reason })),
      [
        { state: "allow", reason: "policy" },
        { state: "allow", reason: "policy" },
        { state: "allow", reason: "policy" },
      ],
    );
    assert.equal(outcome.aggregate, "allow");
    assert.equal(outcome.scanError, undefined);
  });

  it("allows undefined, null, and empty-string without any query or import", async () => {
    const deps = createDepsStub();
    const input = { cwd: undefined, a: { cwd: null }, b: { cwd: "" } };

    const outcome = await evaluateCwdOccurrences(input, SESSION_ID, deps);

    assert.deepEqual(deps.resolveCalls, []);
    assert.deepEqual(deps.checkCalls, []);
    assert.deepEqual(
      outcome.evaluations.map((e) => ({ state: e.state, reason: e.reason })),
      [
        { state: "allow", reason: "empty or missing cwd" },
        { state: "allow", reason: "empty or missing cwd" },
        { state: "allow", reason: "empty or missing cwd" },
      ],
    );
    assert.equal(outcome.aggregate, "allow");
  });

  it("asks for non-string types without querying and without importing", async () => {
    const deps = createDepsStub();
    const input = { cwd: 42, a: { cwd: true }, b: { cwd: { path: "../o" } }, c: { cwd: ["../a"] } };

    const outcome = await evaluateCwdOccurrences(input, SESSION_ID, deps);

    assert.deepEqual(deps.resolveCalls, []);
    assert.deepEqual(deps.checkCalls, []);
    assert.ok(outcome.evaluations.every((e) => e.state === "ask"));
    assert.match(outcome.evaluations[0]?.reason ?? "", /invalid cwd type: 42/);
    assert.match(outcome.evaluations[2]?.reason ?? "", /invalid cwd type/);
    assert.equal(outcome.aggregate, "ask");
  });

  it("does not query the inside of a cwd object or array", async () => {
    const deps = createDepsStub();
    const input = { cwd: { cwd: "../inner" }, list: { cwd: [{ cwd: "../also" }] } };

    const outcome = await evaluateCwdOccurrences(input, SESSION_ID, deps);

    // The object/array cwd values are non-string types: ask, no inner query.
    assert.deepEqual(deps.resolveCalls, []);
    assert.deepEqual(deps.checkCalls, []);
    assert.equal(outcome.evaluations.length, 2);
    assert.ok(outcome.evaluations.every((e) => e.state === "ask"));
  });

  it("does not import the module when no non-empty string cwd exists", async () => {
    const deps = createDepsStub();
    await evaluateCwdOccurrences({ cwd: "", note: "nothing to check" }, SESSION_ID, deps);
    assert.deepEqual(deps.resolveCalls, []);
  });
});

describe("service resolution and fail-closed degradation (plan §4.4)", () => {
  it("degrades string items to ask when the service is unavailable", async () => {
    const deps = createDepsStub({
      resolution: { ok: false, reason: "permissions service accessor is unavailable" },
    });
    const input = { cwd: "../a", empty: { cwd: "" }, typed: { cwd: 7 } };

    const outcome = await evaluateCwdOccurrences(input, SESSION_ID, deps);

    assert.deepEqual(
      outcome.evaluations.map((e) => ({ state: e.state, reason: e.reason })),
      [
        { state: "ask", reason: "service unavailable: permissions service accessor is unavailable" },
        { state: "allow", reason: "empty or missing cwd" },
        { state: "ask", reason: expectInvalidTypeReason(7) },
      ],
    );
    assert.equal(outcome.aggregate, "ask");
    assert.deepEqual(deps.checkCalls, []);
  });

  it("degrades per-item when a query throws, and continues with the remaining items", async () => {
    const deps = createDepsStub({
      check: (_raw, index) =>
        index === 0
          ? { ok: false, reason: "permission query failed: boom" }
          : { ok: true, state: "allow" },
    });
    const input = { first: { cwd: "../a" }, second: { cwd: "../b" } };

    const outcome = await evaluateCwdOccurrences(input, SESSION_ID, deps);

    assert.deepEqual(deps.checkCalls, ["../a", "../b"]);
    assert.deepEqual(
      outcome.evaluations.map((e) => ({ state: e.state, reason: e.reason })),
      [
        { state: "ask", reason: "permission query failed: boom" },
        { state: "allow", reason: "policy" },
      ],
    );
    assert.equal(outcome.aggregate, "ask");
  });

  it("degrades to ask when the returned state is invalid", async () => {
    const deps = createDepsStub({
      check: () => ({ ok: false, reason: 'invalid permission state: "ALLOW"' }),
    });
    const outcome = await evaluateCwdOccurrences({ cwd: "../a" }, SESSION_ID, deps);
    assert.equal(outcome.evaluations[0]?.state, "ask");
    assert.match(outcome.evaluations[0]?.reason ?? "", /invalid permission state/);
  });

  it("resolves the service once per tool call and again on the next call", async () => {
    const deps = createDepsStub();
    const input = { cwd: "../a", second: { cwd: "../b" } };

    await evaluateCwdOccurrences(input, SESSION_ID, deps);
    assert.deepEqual(deps.resolveCalls, [SESSION_ID]);

    await evaluateCwdOccurrences(input, "sess-guard-0002", deps);
    assert.deepEqual(deps.resolveCalls, [SESSION_ID, "sess-guard-0002"]);
  });

  it("retries resolution on later calls after an unavailable service", async () => {
    const failing = createDepsStub({
      resolution: { ok: false, reason: "not published" },
    });
    const input = { cwd: "../a" };
    const failing1 = await evaluateCwdOccurrences(input, SESSION_ID, failing);
    assert.equal(failing1.evaluations[0]?.state, "ask");

    const succeeding = createDepsStub({
      check: () => ({ ok: true, state: "allow" }),
    });
    const outcome = await evaluateCwdOccurrences(input, SESSION_ID, succeeding);
    assert.equal(outcome.evaluations[0]?.state, "allow");
  });
});

describe("strict merge (plan §4.5)", () => {
  const matrixCases: {
    name: string;
    states: Array<"allow" | "ask" | "deny">;
    expected: "allow" | "ask" | "deny";
  }[] = [
    { name: "all allow", states: ["allow", "allow", "allow"], expected: "allow" },
    { name: "single ask", states: ["allow", "ask"], expected: "ask" },
    { name: "single deny", states: ["allow", "deny", "allow"], expected: "deny" },
    { name: "deny dominates ask", states: ["ask", "ask", "deny"], expected: "deny" },
    { name: "deny first", states: ["deny", "ask", "allow"], expected: "deny" },
    { name: "ask first then allow", states: ["ask", "allow"], expected: "ask" },
  ];

  for (const testCase of matrixCases) {
    it(`merges ${testCase.states.join("/")} into ${testCase.expected} (${testCase.name})`, async () => {
      const deps = createDepsStub({
        check: (_raw, index) => {
          const state = testCase.states[index];
          return state === undefined ? { ok: true, state: "allow" } : { ok: true, state };
        },
      });
      const input: Record<string, unknown> = {};
      testCase.states.forEach((_state, index) => {
        input[`item${index}`] = { cwd: `../dir${index}` };
      });

      const outcome = await evaluateCwdOccurrences(input, SESSION_ID, deps);

      assert.equal(outcome.aggregate, testCase.expected);
      // Every item was queried: no short-circuit even after deny.
      assert.equal(deps.checkCalls.length, testCase.states.length);
    });
  }

  it("returns allow for an empty occurrence set", async () => {
    const deps = createDepsStub();
    const outcome = await evaluateCwdOccurrences({ prompt: "no cwd here" }, SESSION_ID, deps);
    assert.deepEqual(outcome.evaluations, []);
    assert.equal(outcome.aggregate, "allow");
    assert.deepEqual(deps.resolveCalls, []);
  });
});

describe("safety invariants", () => {
  it("does not modify the original input (frozen)", async () => {
    const deps = createDepsStub();
    const input = Object.freeze({
      cwd: Object.freeze("../a"),
      tasks: Object.freeze([Object.freeze({ cwd: "../b" })]),
    });

    const outcome = await evaluateCwdOccurrences(input, SESSION_ID, deps);

    assert.ok(Object.isFrozen(input));
    assert.ok(Object.isFrozen(input.tasks));
    assert.equal(outcome.aggregate, "allow");
    assert.deepEqual(deps.checkCalls, ["../a", "../b"]);
  });

  it("blocks on scan errors: outcome carries scanError while safe parts still evaluate", async () => {
    // The safe branch is inserted first so it is collected before the hostile
    // getter aborts the traversal (Object.keys order = insertion).
    const deps = createDepsStub();
    const input: Record<string, unknown> = {};
    input["before"] = { cwd: "../ok" };
    Object.defineProperty(input, "danger", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("scan exploded");
      },
    });

    const outcome = await evaluateCwdOccurrences(input, SESSION_ID, deps);

    assert.ok(outcome.scanError);
    assert.match(outcome.scanError.message, /scan exploded/);
    assert.equal(outcome.evaluations.length, 1);
    assert.equal(outcome.evaluations[0]?.state, "allow");
    // Fail-closed floor: the incompletely scanned call is at least ask.
    assert.equal(outcome.aggregate, "ask");
  });

  it("keeps the default dependency set functional", async () => {
    const deps = createDefaultCwdGuardDeps(defaultPermissionModuleImporter);
    assert.equal(typeof deps.resolveService, "function");
    assert.equal(typeof deps.checkService, "function");
  });
});

function expectInvalidTypeReason(value: number): string {
  return `invalid cwd type: ${JSON.stringify(value)}`;
}
