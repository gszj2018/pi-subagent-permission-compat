import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCwdOccurrences,
  type CwdEvaluationOutcome,
  type EvaluationState,
} from "../extensions/cwd-guard.ts";

/** Expected per-entry payload for `assertOutcome`. */
type ExpectedEvaluation = { state: EvaluationState; reason: string };

const ALLOW_MATCHES: ExpectedEvaluation = { state: "allow", reason: "matches current directory" };
const ASK_DIFFERS: ExpectedEvaluation = { state: "ask", reason: "differs from current directory" };

/**
 * Assert the entry count, every entry's state/reason, and the merged aggregate;
 * `label` identifies the current case in loop-based tests.
 */
function assertOutcome(
  outcome: CwdEvaluationOutcome,
  expected: { evaluations: ExpectedEvaluation[]; aggregate: "allow" | "ask" },
  label?: string,
): void {
  assert.equal(outcome.evaluations.length, expected.evaluations.length, label);
  assert.deepEqual(
    outcome.evaluations.map((e) => ({ state: e.state, reason: e.reason })),
    expected.evaluations,
    label,
  );
  assert.equal(outcome.aggregate, expected.aggregate, label);
}

describe("strict raw string equality (POSIX-style samples)", () => {
  const cwd = "/work/project";

  it("allows only the exactly equal absolute path", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "/work/project" }, cwd);
    assertOutcome(outcome, { evaluations: [ALLOW_MATCHES], aggregate: "allow" });
  });

  it("asks for dot segments and duplicate separators that only normalize to the same path", () => {
    for (const input of [
      "/work/project/.",
      "/work/project/..",
      "/work/other/../project",
      "//work///project",
    ]) {
      const outcome = evaluateCwdOccurrences({ cwd: input }, cwd);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, input);
    }
  });

  it("does not fold a parent segment that follows a path component", () => {
    // The raw strings differ, so the call asks. This only proves the string is
    // not lexically folded, not that any real symlink target is verified.
    const outcome = evaluateCwdOccurrences({ cwd: "/work/project/link/.." }, cwd);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });

  it("does not preprocess the current directory either", () => {
    // Canonical input against a non-canonical current cwd: both sides stay raw.
    for (const current of [
      "/work/project/.",
      "/work/other/../project",
      "//work///project",
      "/work/project/",
    ]) {
      const outcome = evaluateCwdOccurrences({ cwd: "/work/project" }, current);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, current);
    }
  });

  it("asks for subdirectories, parent directories, and unrelated directories", () => {
    for (const input of ["/work/project/sub", "/work", "/other/place"]) {
      const outcome = evaluateCwdOccurrences({ cwd: input }, cwd);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, input);
    }
  });

  it("does not treat dot as the absolute current directory and does not align relative with absolute", () => {
    for (const input of [".", "sub"]) {
      const outcome = evaluateCwdOccurrences({ cwd: input }, cwd);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, input);
    }
  });

  it("asks when only the trailing slash differs", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "/work/project/" }, cwd);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });

  it("asks when only the letter case differs", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "/work/Project" }, cwd);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });

  it("treats backslashes as plain characters, not separators", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "/work\\project" }, cwd);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });

  it("allows identical non-canonical strings on both sides", () => {
    // Equality is the only rule here: no path validity requirement is added.
    for (const value of ["/work/project/../project", ".", "  ", "//work///project"]) {
      const outcome = evaluateCwdOccurrences({ cwd: value }, value);
      assertOutcome(outcome, { evaluations: [ALLOW_MATCHES], aggregate: "allow" }, value);
    }
  });
});

describe("strict raw string equality (Windows-style samples)", () => {
  const cwd = "C:\\work\\project";

  it("allows the identical drive-absolute path", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "C:\\work\\project" }, cwd);
    assertOutcome(outcome, { evaluations: [ALLOW_MATCHES], aggregate: "allow" });
  });

  it("asks when only forward and back slashes differ", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "C:/work/project" }, cwd);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });

  it("asks for dot segments and duplicate separators that only normalize to the same path", () => {
    for (const input of [
      "C:\\work\\project\\.",
      "C:\\work\\other\\..\\project",
      "C:\\\\work\\\\\\project",
    ]) {
      const outcome = evaluateCwdOccurrences({ cwd: input }, cwd);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, input);
    }
  });

  it("asks for a different drive, a subdirectory, and dot against an absolute cwd", () => {
    for (const input of ["D:\\work\\project", "C:\\work\\project\\sub", "."]) {
      const outcome = evaluateCwdOccurrences({ cwd: input }, cwd);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, input);
    }
  });

  it("does not align a drive-relative path with a drive-absolute path", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "C:project" }, cwd);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });

  it("asks when the drive letter or a directory name differs only in case", () => {
    for (const input of ["c:\\work\\project", "C:\\Work\\project"]) {
      const outcome = evaluateCwdOccurrences({ cwd: input }, cwd);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, input);
    }
  });

  it("asks when only the trailing backslash differs", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "C:\\work\\project\\" }, cwd);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });

  it("handles UNC paths by strict equality only", () => {
    const uncCwd = "\\\\server\\share\\dir";
    assertOutcome(
      evaluateCwdOccurrences({ cwd: "\\\\server\\share\\dir" }, uncCwd),
      { evaluations: [ALLOW_MATCHES], aggregate: "allow" },
    );
    assertOutcome(
      evaluateCwdOccurrences({ cwd: "\\\\server\\share\\other" }, uncCwd),
      { evaluations: [ASK_DIFFERS], aggregate: "ask" },
    );
    assertOutcome(
      evaluateCwdOccurrences({ cwd: "//server/share/dir" }, uncCwd),
      { evaluations: [ASK_DIFFERS], aggregate: "ask" },
    );
  });
});

describe("platform-independent value handling", () => {
  const cwd = "/work/project";

  it("does not trim or rewrite raw strings: whitespace-only values differ", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "  " }, cwd);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
    assert.equal(outcome.evaluations[0]?.value, "  ");
  });

  it("allows only the exactly equal raw string", () => {
    for (const nearMiss of ["/work/projects", "/work/project/", " /work/project", "/work/project "]) {
      const outcome = evaluateCwdOccurrences({ cwd: nearMiss }, cwd);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, nearMiss);
    }
  });

  it("preserves original values and field paths in the evaluations", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "  ", tasks: [{ cwd: "/other" }] }, cwd);
    assert.equal(outcome.evaluations.length, 2);
    assert.deepEqual(
      outcome.evaluations.map((e) => ({ path: e.path, value: e.value, state: e.state, reason: e.reason })),
      [
        { path: `$["cwd"]`, value: "  ", state: "ask", reason: "differs from current directory" },
        { path: `$["tasks"][0]["cwd"]`, value: "/other", state: "ask", reason: "differs from current directory" },
      ],
    );
    assert.equal(outcome.aggregate, "ask");
  });
});

describe("empty, missing, and non-string values", () => {
  it("allows undefined, null, and empty-string", () => {
    const outcome = evaluateCwdOccurrences(
      { cwd: undefined, a: { cwd: null }, b: { cwd: "" } },
      "/w",
    );
    assert.equal(outcome.evaluations.length, 3);
    assert.deepEqual(
      outcome.evaluations.map((e) => ({ path: e.path, value: e.value, state: e.state, reason: e.reason })),
      [
        { path: `$["cwd"]`, value: undefined, state: "allow", reason: "empty or missing cwd" },
        { path: `$["a"]["cwd"]`, value: null, state: "allow", reason: "empty or missing cwd" },
        { path: `$["b"]["cwd"]`, value: "", state: "allow", reason: "empty or missing cwd" },
      ],
    );
    assert.equal(outcome.aggregate, "allow");
  });

  it("allows a call with no cwd occurrences at all", () => {
    const outcome = evaluateCwdOccurrences({ prompt: "no cwd here" }, "/w");
    assert.deepEqual(outcome.evaluations, []);
    assert.equal(outcome.aggregate, "allow");
  });

  it("asks for non-string types; cwd objects and arrays stay leaves", () => {
    const input = { cwd: 42, a: { cwd: true }, b: { cwd: { cwd: "../inner" } }, c: { cwd: ["../a"] } };
    const outcome = evaluateCwdOccurrences(input, "/w");

    assert.equal(outcome.evaluations.length, 4);
    // No occurrence from inside the cwd object or array: leaf handling kept.
    assert.deepEqual(
      outcome.evaluations.map((e) => ({ path: e.path, value: e.value, state: e.state, reason: e.reason })),
      [
        { path: `$["cwd"]`, value: 42, state: "ask", reason: "invalid cwd type: 42" },
        { path: `$["a"]["cwd"]`, value: true, state: "ask", reason: "invalid cwd type: true" },
        {
          path: `$["b"]["cwd"]`,
          value: { cwd: "../inner" },
          state: "ask",
          reason: `invalid cwd type: {"cwd":"../inner"}`,
        },
        { path: `$["c"]["cwd"]`, value: ["../a"], state: "ask", reason: `invalid cwd type: ["../a"]` },
      ],
    );
    assert.equal(outcome.aggregate, "ask");
  });
});

describe("no caching across calls", () => {
  it("changing the current cwd between calls flips the same input from allow to ask", () => {
    const input = { cwd: "/work/project" };

    const withSame = evaluateCwdOccurrences(input, "/work/project");
    assertOutcome(withSame, { evaluations: [ALLOW_MATCHES], aggregate: "allow" });

    const withChanged = evaluateCwdOccurrences(input, "/elsewhere");
    assertOutcome(withChanged, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });
});

// The guard keeps a defensive fail-closed catch for unexpected evaluation
// failures. Strict string comparison cannot throw from the public contract, so
// the catch is intentionally not fault-injected or tested from here.

describe("strict merge", () => {
  const cwd = "/work/project";

  it("merges allow/ask combinations without short-circuiting", () => {
    const cases: { inputs: string[]; expectedStates: EvaluationState[]; expected: "allow" | "ask" }[] = [
      {
        inputs: ["/work/project", "/work/project", "/work/project"],
        expectedStates: ["allow", "allow", "allow"],
        expected: "allow",
      },
      { inputs: ["/work/project", "/other"], expectedStates: ["allow", "ask"], expected: "ask" },
      { inputs: ["/other", "/work/project"], expectedStates: ["ask", "allow"], expected: "ask" },
      { inputs: ["/other", "/another"], expectedStates: ["ask", "ask"], expected: "ask" },
    ];
    for (const testCase of cases) {
      const input: Record<string, unknown> = {};
      testCase.inputs.forEach((value, index) => {
        input[`item${index}`] = { cwd: value };
      });
      const outcome = evaluateCwdOccurrences(input, cwd);
      const expectedEvaluations = testCase.expectedStates.map((state) =>
        state === "allow" ? ALLOW_MATCHES : ASK_DIFFERS,
      );
      assertOutcome(
        outcome,
        { evaluations: expectedEvaluations, aggregate: testCase.expected },
        testCase.inputs.join("|"),
      );
    }
  });

  it("returns allow for an empty occurrence set", () => {
    const outcome = evaluateCwdOccurrences({ prompt: "no cwd here" }, cwd);
    assert.deepEqual(outcome.evaluations, []);
    assert.equal(outcome.aggregate, "allow");
  });
});

describe("scan errors short-circuit to a hard deny", () => {
  const cwd = "/work/project";

  function hostileInput(): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    input["before"] = { cwd: cwd };
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, "danger", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("scan exploded");
      },
    });
    input["nested"] = nested;
    return input;
  }

  it("denies without evaluating the collected occurrences", () => {
    const outcome = evaluateCwdOccurrences(hostileInput(), cwd);
    assert.ok(outcome.error);
    assert.match(outcome.error, /\$\["nested"]/);
    assert.match(outcome.error, /not a plain JSON object or array/);
    assert.deepEqual(outcome.evaluations, []);
    assert.equal(outcome.aggregate, "deny");
  });

  it("denies on a scan error even with an empty occurrence set", () => {
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "danger", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("scan exploded");
      },
    });
    const outcome = evaluateCwdOccurrences(input, cwd);
    assert.ok(outcome.error);
    assert.deepEqual(outcome.evaluations, []);
    assert.equal(outcome.aggregate, "deny");
  });

  it("blocks on depth-limited inputs", () => {
    let deep: unknown = { cwd: cwd };
    for (let index = 0; index < 12; index++) {
      deep = { nested: deep };
    }
    const outcome = evaluateCwdOccurrences(deep, cwd);
    assert.ok(outcome.error);
    assert.match(outcome.error, /maximum scan depth/);
    assert.deepEqual(outcome.evaluations, []);
    assert.equal(outcome.aggregate, "deny");
  });
});

describe("safety invariants", () => {
  it("does not modify the original input (frozen)", () => {
    const input = Object.freeze({
      cwd: Object.freeze("/work/project"),
      tasks: Object.freeze([Object.freeze({ cwd: "../b" })]),
    });

    const outcome = evaluateCwdOccurrences(input, "/work/project");

    assert.ok(Object.isFrozen(input));
    assert.ok(Object.isFrozen(input.tasks));
    assertOutcome(outcome, { evaluations: [ALLOW_MATCHES, ASK_DIFFERS], aggregate: "ask" });
  });
});
