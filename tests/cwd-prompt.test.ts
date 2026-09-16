import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CwdEvaluation } from "../extensions/cwd-guard.ts";
import {
  ALLOW_ONCE_OPTION,
  buildCwdPromptTitle,
  DENY_OPTION,
  formatCwdEvaluation,
  formatCwdValue,
  promptCwdApproval,
  type CwdSelect,
} from "../extensions/cwd-prompt.ts";

function evaluation(overrides: Partial<CwdEvaluation> = {}): CwdEvaluation {
  return {
    path: `$["cwd"]`,
    value: "../outside",
    state: "ask",
    reason: "differs from current directory",
    ...overrides,
  };
}

function selectStub(
  implementation: (title: string, options: string[]) => Promise<string | undefined> | string | undefined,
): { select: CwdSelect; calls: { title: string; options: string[]; signal: AbortSignal | undefined }[] } {
  const calls: { title: string; options: string[]; signal: AbortSignal | undefined }[] = [];
  return {
    calls,
    select: async (title, options, opts) => {
      calls.push({ title, options, signal: opts?.signal });
      return implementation(title, options);
    },
  };
}

const CONTEXT_BASE = {
  toolName: "subagent",
  currentCwd: "/workspace/project",
  evaluations: [],
  signal: undefined,
};

describe("value and line formatting", () => {
  it("JSON-quotes strings, keeping whitespace and escaping control characters", () => {
    assert.equal(formatCwdValue("plain"), '"plain"');
    assert.equal(formatCwdValue("  padded  "), '"  padded  "');
    assert.equal(formatCwdValue("line1\n[allow]\nline2"), '"line1\\n[allow]\\nline2"');
    assert.equal(formatCwdValue("\u001b[31mred"), '"\\u001b[31mred"');
  });

  it("shows undefined verbatim and non-JSON types with type markers", () => {
    assert.equal(formatCwdValue(undefined), "undefined");
    assert.equal(formatCwdValue({ path: "../other" }), '{"path":"../other"}');
    assert.equal(formatCwdValue(["../a"]), '["../a"]');
    assert.equal(formatCwdValue(42), "42");
    assert.equal(formatCwdValue(Symbol("s")), "Symbol(s)");
  });

  it("renders evaluation lines with path, safe value, state, and non-empty reason", () => {
    assert.equal(
      formatCwdEvaluation(evaluation()),
      `$["cwd"] = "../outside" [ask: differs from current directory]`,
    );
    assert.equal(
      formatCwdEvaluation(evaluation({ state: "allow", reason: "empty or missing cwd" })),
      `$["cwd"] = "../outside" [allow: empty or missing cwd]`,
    );
    assert.equal(
      formatCwdEvaluation(evaluation({ value: { path: "../o" }, reason: "invalid cwd type: {\"path\":\"../o\"}" })),
      `$["cwd"] = {"path":"../o"} [ask: invalid cwd type: {"path":"../o"}]`,
    );
    // Multi-line reasons are flattened to one line.
    assert.equal(
      formatCwdEvaluation(evaluation({ reason: "differs from current\ndirectory next\tline" })),
      `$["cwd"] = "../outside" [ask: differs from current directory next line]`,
    );
    // An empty reason shows the bare state without a suffix.
    assert.equal(
      formatCwdEvaluation(evaluation({ reason: "" })),
      `$["cwd"] = "../outside" [ask]`,
    );
  });
});

describe("prompt title", () => {
  it("contains the label, tool name, current directory, and every evaluation line", () => {
    const title = buildCwdPromptTitle("subagent", "/workspace/project", [
      evaluation({ path: `$["cwd"]`, value: "", state: "allow", reason: "empty or missing cwd" }),
      evaluation({
        path: `$["tasks"][0]["cwd"]`,
        value: "../shared",
        state: "ask",
        reason: "differs from current directory",
      }),
      evaluation({
        path: `$["tasks"][1]["cwd"]`,
        value: { path: "../other" },
        state: "ask",
        reason: "invalid cwd type",
      }),
    ]);

    const lines = title.split("\n");
    assert.equal(lines[0], "[pi-subagent-permission-compat] Review subagent working directories");
    assert.equal(lines[1], "Tool: subagent");
    assert.equal(lines[2], "Current directory: /workspace/project");
    assert.equal(lines[3], `$["cwd"] = "" [allow: empty or missing cwd]`);
    assert.equal(lines[4], `$["tasks"][0]["cwd"] = "../shared" [ask: differs from current directory]`);
    assert.equal(lines[5], `$["tasks"][1]["cwd"] = {"path":"../other"} [ask: invalid cwd type]`);
    assert.equal(lines[6], "Allow this tool call once?");
  });

  it("displays the current directory verbatim without JSON quoting or escaping", () => {
    const currentCwd = 'C:\\workspace\\a "quoted" directory';
    const title = buildCwdPromptTitle("subagent", currentCwd, []);

    assert.equal(title.split("\n")[2], `Current directory: ${currentCwd}`);
  });

  it("does not omit any cwd item and never appends extra fragments via values", () => {
    const title = buildCwdPromptTitle("spawn", "/w", [
      evaluation({ value: "../x\n[deny]\nInject" }),
    ]);
    assert.ok(title.includes('"../x\\n[deny]\\nInject"'));
    assert.equal(title.split("\n").length, 5);
  });
});

describe("promptCwdApproval", () => {
  it("offers Deny first and Allow once second, passing the signal through", async () => {
    const stub = selectStub(() => ALLOW_ONCE_OPTION);
    const controller = new AbortController();

    const outcome = await promptCwdApproval(
      { select: stub.select },
      { ...CONTEXT_BASE, signal: controller.signal },
    );

    assert.deepEqual(stub.calls[0]?.options, [DENY_OPTION, ALLOW_ONCE_OPTION]);
    assert.equal(stub.calls[0]?.signal, controller.signal);
    assert.deepEqual(outcome, { approved: true });
  });

  it("approves only for the exact Allow once response", async () => {
    // Near-misses are unknown responses, not user denials; both block.
    for (const response of ["Allow once ", " allow once", "ALLOW ONCE", "yes", "", "Allow"]) {
      const stub = selectStub(() => response);
      const outcome = await promptCwdApproval({ select: stub.select }, { ...CONTEXT_BASE, signal: undefined });
      assert.deepEqual(
        outcome,
        { approved: false, reason: "unknown-response", detail: JSON.stringify(response) },
        JSON.stringify(response),
      );
    }

    const stub = selectStub(() => DENY_OPTION);
    const outcome = await promptCwdApproval({ select: stub.select }, { ...CONTEXT_BASE, signal: undefined });
    assert.deepEqual(outcome, { approved: false, reason: "denied" });
  });

  it("treats undefined (cancel) and unknown responses as blocking", async () => {
    const cancelled = selectStub(() => undefined);
    assert.deepEqual(
      await promptCwdApproval({ select: cancelled.select }, { ...CONTEXT_BASE, signal: undefined }),
      { approved: false, reason: "cancelled" },
    );

    const unknown = selectStub(() => "allow_once");
    assert.deepEqual(
      await promptCwdApproval({ select: unknown.select }, { ...CONTEXT_BASE, signal: undefined }),
      { approved: false, reason: "unknown-response", detail: '"allow_once"' },
    );
  });

  it("blocks when the UI throws and when the signal is already aborted (no prompt shown)", async () => {
    const throwing = selectStub(() => {
      throw new Error("dialog crashed");
    });
    const uiError = await promptCwdApproval({ select: throwing.select }, { ...CONTEXT_BASE, signal: undefined });
    assert.deepEqual(uiError.approved, false);
    assert.equal((uiError as { reason: string }).reason, "ui-error");
    assert.match((uiError as { detail?: string }).detail ?? "", /dialog crashed/);

    const silent = selectStub(() => ALLOW_ONCE_OPTION);
    const controller = new AbortController();
    controller.abort();
    const outcome = await promptCwdApproval(
      { select: silent.select },
      { ...CONTEXT_BASE, signal: controller.signal },
    );
    assert.deepEqual(outcome, { approved: false, reason: "cancelled" });
    assert.equal(silent.calls.length, 0, "an already-cancelled call must not show a prompt");
  });

  it("ignores a late approval that arrives after the signal aborted", async () => {
    const stub = selectStub(() => ALLOW_ONCE_OPTION);
    const controller = new AbortController();
    const promise = promptCwdApproval({ select: stub.select }, { ...CONTEXT_BASE, signal: controller.signal });
    controller.abort();

    const outcome = await promise;
    assert.deepEqual(outcome, { approved: false, reason: "cancelled" });
  });

  it("shows the full multi-cwd title in a single select call", async () => {
    const stub = selectStub(() => ALLOW_ONCE_OPTION);
    // Normal evaluations are only allow/ask; a deny never reaches the prompt.
    const evaluations = [
      evaluation({ path: `$["cwd"]`, value: "/w", state: "allow", reason: "matches current directory" }),
      evaluation({
        path: `$["tasks"][0]["cwd"]`,
        value: "../b",
        state: "ask",
        reason: "differs from current directory",
      }),
      evaluation({ path: `$["tasks"][1]["cwd"]`, value: "", state: "allow", reason: "empty or missing cwd" }),
    ];

    const outcome = await promptCwdApproval(
      { select: stub.select },
      { ...CONTEXT_BASE, evaluations, signal: undefined },
    );

    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0]?.title.includes(`$["tasks"][0]["cwd"] = "../b" [ask: differs from current directory]`));
    assert.deepEqual(outcome, { approved: true });
  });
});
