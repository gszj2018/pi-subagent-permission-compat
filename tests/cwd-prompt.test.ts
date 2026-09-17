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

/** Every character that must never be displayed verbatim. */
const WHITESPACE_CASES: readonly (readonly [string, string])[] = [
  ["space", " "],
  ["tab", "\t"],
  ["line feed", "\n"],
  ["vertical tab", "\v"],
  ["form feed", "\f"],
  ["carriage return", "\r"],
  ["NEXT LINE (U+0085)", "\u0085"],
  ["NO-BREAK SPACE (U+00A0)", "\u00A0"],
  ["OGHAM SPACE MARK (U+1680)", "\u1680"],
  ["EN QUAD (U+2000)", "\u2000"],
  ["EM QUAD (U+2001)", "\u2001"],
  ["EN SPACE (U+2002)", "\u2002"],
  ["EM SPACE (U+2003)", "\u2003"],
  ["THREE-PER-EM SPACE (U+2004)", "\u2004"],
  ["FOUR-PER-EM SPACE (U+2005)", "\u2005"],
  ["SIX-PER-EM SPACE (U+2006)", "\u2006"],
  ["FIGURE SPACE (U+2007)", "\u2007"],
  ["PUNCTUATION SPACE (U+2008)", "\u2008"],
  ["THIN SPACE (U+2009)", "\u2009"],
  ["HAIR SPACE (U+200A)", "\u200A"],
  ["LINE SEPARATOR (U+2028)", "\u2028"],
  ["PARAGRAPH SEPARATOR (U+2029)", "\u2029"],
  ["NARROW NO-BREAK SPACE (U+202F)", "\u202F"],
  ["MEDIUM MATHEMATICAL SPACE (U+205F)", "\u205F"],
  ["IDEOGRAPHIC SPACE (U+3000)", "\u3000"],
  ["ZERO WIDTH NO-BREAK SPACE (U+FEFF)", "\uFEFF"],
];

describe("value and line formatting", () => {
  it("shows directly readable strings verbatim without JSON quoting or escaping", () => {
    const verbatimValues = [
      "plain",
      "/workspace/project",
      "../shared",
      "./here",
      "C:\\workspace\\project",
      "\\\\server\\share\\project",
      "中文目录/子目录",
      'a"b',
      "C:\\dir\\a\"b",
      "\\n",
      ".",
      "-",
    ];

    for (const value of verbatimValues) {
      const formatted = formatCwdValue(value);
      assert.equal(formatted, value, `verbatim display: ${value}`);
      assert.ok(!formatted.startsWith('"'), `no JSON outer quote: ${value}`);
      assert.ok(!formatted.endsWith('"'), `no JSON outer quote: ${value}`);
      assert.equal(formatCwdValue(value), formatted, `repeated calls are stable: ${value}`);
    }
  });

  it("distinguishes a literal backslash-n from a real line feed", () => {
    assert.equal(formatCwdValue("\\n"), "\\n", "a literal backslash-n is readable verbatim");
    assert.equal(formatCwdValue("\n"), '"\\n"', "a real line feed stays JSON-escaped");
  });

  it("keeps the empty string quoted and falls back to JSON for whitespace values", () => {
    assert.equal(formatCwdValue(""), '""');
    assert.equal(formatCwdValue("  padded  "), '"  padded  "');
    assert.equal(formatCwdValue(" leading"), '" leading"');
    assert.equal(formatCwdValue("trailing "), '"trailing "');
    assert.equal(formatCwdValue("inner space"), '"inner space"');
  });

  it("falls back to JSON display for every whitespace character and U+0085", () => {
    for (const [name, whitespace] of WHITESPACE_CASES) {
      // Expectations come from JSON.stringify, never from the pattern under test.
      const value = `before${whitespace}after`;
      assert.equal(formatCwdValue(value), JSON.stringify(value), name);
      assert.equal(formatCwdValue(whitespace), JSON.stringify(whitespace), name);
      assert.notEqual(formatCwdValue(whitespace), whitespace, name);
    }

    // Representative fixed expectations, independent of JSON.stringify choices.
    assert.equal(formatCwdValue("line\nfeed"), '"line\\nfeed"');
    assert.equal(formatCwdValue("tab\there"), '"tab\\there"');
    assert.equal(formatCwdValue("nbsp\u00A0here"), '"nbsp\u00A0here"');
  });

  it("falls back to JSON display for every C0 control character and DEL", () => {
    for (let code = 0x00; code <= 0x1f; code += 1) {
      const control = String.fromCharCode(code);
      const value = `a${control}b`;
      const label = `U+${code.toString(16).padStart(4, "0").toUpperCase()}`;
      assert.equal(formatCwdValue(value), JSON.stringify(value), label);
      assert.notEqual(formatCwdValue(value), value, label);
    }

    // JSON.stringify does not escape DEL: the output is quoted but still holds
    // the raw character, which this contract accepts.
    assert.equal(formatCwdValue("a\u007Fb"), '"a\u007Fb"');
    assert.ok(formatCwdValue("a\u007Fb").includes("\u007F"), "the raw DEL character stays inside the quotes");
  });

  it("cannot forge prompt lines with ANSI escapes or line feeds", () => {
    assert.equal(formatCwdValue("\u001b[31mred"), '"\\u001b[31mred"');
    const forged = formatCwdValue("line1\n[allow] line2");
    assert.equal(forged, '"line1\\n[allow] line2"');
    assert.equal(forged.split("\n").length, 1);
  });

  it("keeps JSON, type-marker, and placeholder display for non-string values", () => {
    assert.equal(formatCwdValue(undefined), "[undefined]");
    assert.equal(formatCwdValue(null), "null");
    assert.equal(formatCwdValue(42), "42");
    assert.equal(formatCwdValue(true), "true");
    assert.equal(formatCwdValue({ path: "../other" }), '{"path":"../other"}');
    assert.equal(formatCwdValue(["../a"]), '["../a"]');
    assert.equal(formatCwdValue(Symbol("s")), "[symbol]");
    assert.equal(formatCwdValue(() => undefined), "[function]");
    assert.equal(formatCwdValue(10n), "[unserializable value]");
  });

  it("keeps JSON quoting for plain strings nested in objects and arrays", () => {
    assert.equal(formatCwdValue({ cwd: "plain" }), '{"cwd":"plain"}');
    assert.equal(formatCwdValue(["plain"]), '["plain"]');
  });

  it("degrades circular values to a placeholder instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    assert.equal(formatCwdValue(circular), "[unserializable value]");
  });

  it("renders evaluation lines with path, safe value, state, and non-empty reason", () => {
    assert.equal(
      formatCwdEvaluation(evaluation()),
      `$["cwd"] = ../outside [ask: differs from current directory]`,
    );
    assert.equal(
      formatCwdEvaluation(evaluation({ state: "allow", reason: "empty or missing cwd" })),
      `$["cwd"] = ../outside [allow: empty or missing cwd]`,
    );
    assert.equal(
      formatCwdEvaluation(evaluation({ value: "", state: "allow", reason: "empty or missing cwd" })),
      `$["cwd"] = "" [allow: empty or missing cwd]`,
    );
    assert.equal(
      formatCwdEvaluation(evaluation({ value: "../padded value" })),
      `$["cwd"] = "../padded value" [ask: differs from current directory]`,
    );
    assert.equal(
      formatCwdEvaluation(evaluation({ value: { path: "../o" }, reason: "invalid cwd type: {\"path\":\"../o\"}" })),
      `$["cwd"] = {"path":"../o"} [ask: invalid cwd type: {"path":"../o"}]`,
    );
    // Multi-line reasons are flattened to one line.
    assert.equal(
      formatCwdEvaluation(evaluation({ reason: "differs from current\ndirectory next\tline" })),
      `$["cwd"] = ../outside [ask: differs from current directory next line]`,
    );
    // An empty reason shows the bare state without a suffix.
    assert.equal(
      formatCwdEvaluation(evaluation({ reason: "" })),
      `$["cwd"] = ../outside [ask]`,
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
        value: " /shared ",
        state: "ask",
        reason: "differs from current directory",
      }),
      evaluation({
        path: `$["tasks"][2]["cwd"]`,
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
    assert.equal(lines[4], `$["tasks"][0]["cwd"] = ../shared [ask: differs from current directory]`);
    assert.equal(lines[5], `$["tasks"][1]["cwd"] = " /shared " [ask: differs from current directory]`);
    assert.equal(lines[6], `$["tasks"][2]["cwd"] = {"path":"../other"} [ask: invalid cwd type]`);
    assert.equal(lines[7], "Allow this tool call once?");
  });

  it("displays the current directory verbatim without JSON quoting or escaping", () => {
    const currentCwd = 'C:\\workspace\\a "quoted" directory';
    const title = buildCwdPromptTitle("subagent", currentCwd, []);

    assert.equal(title.split("\n")[2], `Current directory: ${currentCwd}`);
  });

  it("does not omit any cwd item and never appends extra fragments via values", () => {
    const title = buildCwdPromptTitle("spawn", "/w", [
      evaluation({ value: "../x\n[deny]\nInject" }),
      evaluation({ path: `$["tasks"][0]["cwd"]`, value: "../plain" }),
    ]);
    assert.ok(title.includes('"../x\\n[deny]\\nInject"'));
    assert.ok(title.includes(`$["tasks"][0]["cwd"] = ../plain [ask: differs from current directory]`));
    assert.equal(title.split("\n").length, 6);
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
      evaluation({
        path: `$["tasks"][1]["cwd"]`,
        value: " /w ",
        state: "ask",
        reason: "differs from current directory",
      }),
      evaluation({ path: `$["tasks"][2]["cwd"]`, value: "", state: "allow", reason: "empty or missing cwd" }),
    ];

    const outcome = await promptCwdApproval(
      { select: stub.select },
      { ...CONTEXT_BASE, evaluations, signal: undefined },
    );

    assert.equal(stub.calls.length, 1);
    const title = stub.calls[0]?.title ?? "";
    assert.ok(title.includes(`$["cwd"] = /w [allow: matches current directory]`));
    assert.ok(title.includes(`$["tasks"][0]["cwd"] = ../b [ask: differs from current directory]`));
    assert.ok(title.includes(`$["tasks"][1]["cwd"] = " /w " [ask: differs from current directory]`));
    assert.ok(title.includes(`$["tasks"][2]["cwd"] = "" [allow: empty or missing cwd]`));
    assert.deepEqual(outcome, { approved: true });
  });
});
