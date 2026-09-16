import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  evaluateCwdOccurrences,
  type CwdEvaluationOutcome,
  type EvaluationState,
  type NormalizePath,
} from "../extensions/cwd-guard.ts";

const posixNormalize: NormalizePath = (value) => path.posix.normalize(value);

/** A normalizer that throws for one target value; otherwise an identity function. */
function throwingNormalize(target: string): NormalizePath {
  return (value) => {
    if (value === target) {
      throw new Error("normalizer exploded");
    }
    return value;
  };
}

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

describe("posix per-value normalization (injected path.posix.normalize)", () => {
  const cwd = "/work/project";

  it("allows the same absolute path", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "/work/project" }, cwd, posixNormalize);
    assertOutcome(outcome, { evaluations: [ALLOW_MATCHES], aggregate: "allow" });
  });

  it("allows both sides with collapsible dot segments and duplicate separators", () => {
    // Both sides fold to "/work/project" under posix normalization.
    const outcome = evaluateCwdOccurrences(
      { cwd: "/work/other/../project", tasks: [{ cwd: "//work///project" }] },
      "/work/./project",
      posixNormalize,
    );
    assertOutcome(outcome, { evaluations: [ALLOW_MATCHES, ALLOW_MATCHES], aggregate: "allow" });
  });

  it("asks for subdirectories, parent directories, and unrelated directories", () => {
    for (const input of ["/work/project/sub", "/work", "/other/place"]) {
      const outcome = evaluateCwdOccurrences({ cwd: input }, cwd, posixNormalize);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, input);
    }
  });

  it("does not treat dot as the absolute current directory and does not align relative with absolute", () => {
    for (const input of [".", "sub"]) {
      const outcome = evaluateCwdOccurrences({ cwd: input }, cwd, posixNormalize);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, input);
    }
  });

  it("asks when only the trailing slash differs", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "/work/project/" }, cwd, posixNormalize);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });

  it("asks when only the letter case differs", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "/work/Project" }, cwd, posixNormalize);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });

  it("treats backslashes as plain characters, not separators", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "/work\\project" }, cwd, posixNormalize);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });
});

describe("win32 per-value normalization (injected path.win32.normalize)", () => {
  const normalize: NormalizePath = (value) => path.win32.normalize(value);
  const cwd = "C:\\work\\project";

  it("allows the same drive-absolute path", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "C:\\work\\project" }, cwd, normalize);
    assertOutcome(outcome, { evaluations: [ALLOW_MATCHES], aggregate: "allow" });
  });

  it("allows mixed slashes and folded dot segments on both sides", () => {
    // Forward slashes fold to backslashes; dot segments collapse on both sides.
    const outcome = evaluateCwdOccurrences(
      { cwd: "C:/work/project", tasks: [{ cwd: "C:\\work\\other\\..\\project\\." }] },
      "C:\\work\\project\\.",
      normalize,
    );
    assertOutcome(outcome, { evaluations: [ALLOW_MATCHES, ALLOW_MATCHES], aggregate: "allow" });
  });

  it("asks for a different drive, a subdirectory, and dot against an absolute cwd", () => {
    for (const input of ["D:\\work\\project", "C:\\work\\project\\sub", "."]) {
      const outcome = evaluateCwdOccurrences({ cwd: input }, cwd, normalize);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, input);
    }
  });

  it("does not align a drive-relative path with a drive-absolute path", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "C:project" }, cwd, normalize);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });

  it("asks when the drive letter or a directory name differs only in case", () => {
    for (const input of ["c:\\work\\project", "C:\\Work\\project"]) {
      const outcome = evaluateCwdOccurrences({ cwd: input }, cwd, normalize);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, input);
    }
  });

  it("asks when only the trailing backslash differs", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "C:\\work\\project\\" }, cwd, normalize);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });

  it("handles UNC paths by normalized equality only", () => {
    const uncCwd = "\\\\server\\share\\dir";
    assertOutcome(
      evaluateCwdOccurrences({ cwd: "\\\\server\\share\\dir" }, uncCwd, normalize),
      { evaluations: [ALLOW_MATCHES], aggregate: "allow" },
    );
    assertOutcome(
      evaluateCwdOccurrences({ cwd: "\\\\server\\share\\other" }, uncCwd, normalize),
      { evaluations: [ASK_DIFFERS], aggregate: "ask" },
    );
  });
});

describe("platform-independent value handling", () => {
  const cwd = "/work/project";

  it("does not trim or rewrite raw strings: whitespace-only values differ", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "  " }, cwd, posixNormalize);
    assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
    assert.equal(outcome.evaluations[0]?.value, "  ");
  });

  it("allows only values that are truly equal after normalization", () => {
    // "/work/project" is the only raw value that stays equal after normalize.
    for (const nearMiss of ["/work/projects", "/work/project/", " /work/project"]) {
      const outcome = evaluateCwdOccurrences({ cwd: nearMiss }, cwd, posixNormalize);
      assertOutcome(outcome, { evaluations: [ASK_DIFFERS], aggregate: "ask" }, nearMiss);
    }
  });

  it("preserves original values and field paths in the evaluations", () => {
    const outcome = evaluateCwdOccurrences({ cwd: "  ", tasks: [{ cwd: "/other" }] }, cwd, posixNormalize);
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
      posixNormalize,
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
    const outcome = evaluateCwdOccurrences({ prompt: "no cwd here" }, "/w", posixNormalize);
    assert.deepEqual(outcome.evaluations, []);
    assert.equal(outcome.aggregate, "allow");
  });

  it("asks for non-string types; cwd objects and arrays stay leaves", () => {
    const input = { cwd: 42, a: { cwd: true }, b: { cwd: { cwd: "../inner" } }, c: { cwd: ["../a"] } };
    const outcome = evaluateCwdOccurrences(input, "/w", posixNormalize);

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

    const withSame = evaluateCwdOccurrences(input, "/work/project", posixNormalize);
    assertOutcome(withSame, { evaluations: [ALLOW_MATCHES], aggregate: "allow" });

    const withChanged = evaluateCwdOccurrences(input, "/elsewhere", posixNormalize);
    assertOutcome(withChanged, { evaluations: [ASK_DIFFERS], aggregate: "ask" });
  });
});

describe("defensive failure handling", () => {
  it("fails closed to deny when the normalizer throws for the input value", () => {
    const outcome = evaluateCwdOccurrences(
      { first: { cwd: "../throw" }, second: { cwd: "../b" }, empty: { cwd: "" } },
      "/w",
      throwingNormalize("../throw"),
    );

    // Per-item results are discarded; the failure is a hard deny.
    assert.deepEqual(outcome.evaluations, []);
    assert.equal(outcome.aggregate, "deny");
    assert.match(outcome.error ?? "", /normalizer exploded/);
  });

  it("fails closed to deny when the normalizer throws for the current cwd", () => {
    const outcome = evaluateCwdOccurrences(
      { first: { cwd: "../a" } },
      "/hostile-cwd",
      throwingNormalize("/hostile-cwd"),
    );

    assert.deepEqual(outcome.evaluations, []);
    assert.equal(outcome.aggregate, "deny");
    assert.match(outcome.error ?? "", /normalizer exploded/);
  });
});

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
      const outcome = evaluateCwdOccurrences(input, cwd, posixNormalize);
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
    const outcome = evaluateCwdOccurrences({ prompt: "no cwd here" }, cwd, posixNormalize);
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
    const outcome = evaluateCwdOccurrences(hostileInput(), cwd, posixNormalize);
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
    const outcome = evaluateCwdOccurrences(input, cwd, posixNormalize);
    assert.ok(outcome.error);
    assert.deepEqual(outcome.evaluations, []);
    assert.equal(outcome.aggregate, "deny");
  });

  it("blocks on depth-limited inputs", () => {
    let deep: unknown = { cwd: cwd };
    for (let index = 0; index < 12; index++) {
      deep = { nested: deep };
    }
    const outcome = evaluateCwdOccurrences(deep, cwd, posixNormalize);
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

    const outcome = evaluateCwdOccurrences(input, "/work/project", posixNormalize);

    assert.ok(Object.isFrozen(input));
    assert.ok(Object.isFrozen(input.tasks));
    assertOutcome(outcome, { evaluations: [ALLOW_MATCHES, ASK_DIFFERS], aggregate: "ask" });
  });
});
