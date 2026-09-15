import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectCwdOccurrences,
  INSPECTED_TOOL_NAME_PATTERN,
  MAX_SCAN_DEPTH,
  matchesInspectedToolName,
} from "../extensions/cwd-inspection.ts";

function nestValue(value: Record<string, unknown>, levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = value;
  for (let i = 0; i < levels; i++) {
    node = { child: node };
  }
  return node;
}

describe("tool-name matching", () => {
  it("matches subagent, delegate, spawn, and agent case-insensitively", () => {
    for (const name of ["subagent", "SubAgent", "delegate_task", "Delegate", "spawn", "SPAWN", "agent", "AGENT", "my-agents:run", "SubagentTool"]) {
      assert.equal(matchesInspectedToolName(name), true, name);
    }
  });

  it("matches compound names containing the keywords", () => {
    for (const name of ["dispatch_subagent_now", "agentRouter_spawn"]) {
      assert.equal(matchesInspectedToolName(name), true, name);
    }
  });

  it("has no word boundaries and matches beyond them", () => {
    assert.equal(matchesInspectedToolName("subagents"), true);
    assert.equal(matchesInspectedToolName("agentsmith"), true);
  });

  it("rejects tools without the keywords and non-string names", () => {
    for (const name of ["read", "bash", "edit", "grep", "find", "ls", "write", "powershell", "subwork", "dispatch", undefined, null, 42]) {
      assert.equal(matchesInspectedToolName(name), false, String(name));
    }
  });

  it("pattern is case-insensitive without the g flag", () => {
    assert.equal(INSPECTED_TOOL_NAME_PATTERN.global, false);
    assert.equal(INSPECTED_TOOL_NAME_PATTERN.ignoreCase, true);
    // Repeated tests must not be affected by lastIndex state.
    assert.equal(matchesInspectedToolName("subagent"), true);
    assert.equal(matchesInspectedToolName("subagent"), true);
  });
});

describe("cwd collection", () => {
  it("returns no occurrences for primitives and null", () => {
    for (const input of [undefined, null, "text", 42, true]) {
      const result = collectCwdOccurrences(input);
      assert.deepEqual(result, { occurrences: [] });
    }
  });

  it("finds a top-level cwd", () => {
    const result = collectCwdOccurrences({ cwd: "../outside" });
    assert.deepEqual(result, {
      occurrences: [{ path: `$["cwd"]`, value: "../outside" }],
    });
  });

  it("finds nested, array, and mixed occurrences with deterministic paths", () => {
    const input = {
      cwd: "./top",
      tasks: [
        { cwd: "../one" },
        { nested: { cwd: "../two" } },
      ],
      list: [{ deep: [{ cwd: "../three" }] }],
    };
    const result = collectCwdOccurrences(input);
    assert.deepEqual(
      result.occurrences.map((o) => o.path),
      [`$["cwd"]`, `$["tasks"][0]["cwd"]`, `$["tasks"][1]["nested"]["cwd"]`, `$["list"][0]["deep"][0]["cwd"]`],
    );
  });

  it("keeps duplicate values at their own positions", () => {
    const input = { a: { cwd: "../same" }, b: { cwd: "../same" } };
    const result = collectCwdOccurrences(input);
    assert.equal(result.occurrences.length, 2);
    assert.deepEqual(
      result.occurrences.map((o) => o.path),
      [`$["a"]["cwd"]`, `$["b"]["cwd"]`],
    );
    assert.equal(result.occurrences[0]?.value, "../same");
    assert.equal(result.occurrences[1]?.value, "../same");
  });

  it("records undefined, null, and empty-string cwd values", () => {
    const input = { cwd: undefined, other: { cwd: null }, third: { cwd: "" } };
    const result = collectCwdOccurrences(input);
    assert.deepEqual(
      result.occurrences.map((o) => o.value),
      [undefined, null, ""],
    );
  });

  it("matches the exact lowercase key only", () => {
    const input = { CWD: "../x", Cwd: "../y", workingDirectory: "../z", cwd: "../w" };
    const result = collectCwdOccurrences(input);
    assert.deepEqual(result.occurrences, [{ path: `$["cwd"]`, value: "../w" }]);
  });

  it("treats a cwd object or array as a leaf and never scans inside it", () => {
    const objectInput = { cwd: { cwd: "../inner" } };
    const objectResult = collectCwdOccurrences(objectInput);
    assert.deepEqual(objectResult.occurrences, [
      { path: `$["cwd"]`, value: { cwd: "../inner" } },
    ]);

    const arrayInput = { cwd: ["../a", { cwd: "../b" }] };
    const arrayResult = collectCwdOccurrences(arrayInput);
    assert.deepEqual(arrayResult.occurrences, [
      { path: `$["cwd"]`, value: ["../a", { cwd: "../b" }] },
    ]);
  });

  it("does not treat array elements named by index as cwd values", () => {
    const result = collectCwdOccurrences({ cwd: [{ cwd: "../a" }] });
    assert.deepEqual(result.occurrences, [
      { path: `$["cwd"]`, value: [{ cwd: "../a" }] },
    ]);
  });

  it("finds cwd values inside arrays of objects", () => {
    const result = collectCwdOccurrences([
      { cwd: "../a" },
      { nested: [{ cwd: "../b" }] },
    ]);
    assert.deepEqual(
      result.occurrences.map((o) => ({ path: o.path, value: o.value })),
      [
        { path: `$[0]["cwd"]`, value: "../a" },
        { path: `$[1]["nested"][0]["cwd"]`, value: "../b" },
      ],
    );
  });

  it("reads only own enumerable string keys", () => {
    const parent = { inherited: "../inherited" };
    const child = Object.create(parent) as Record<string, unknown>;
    child.cwd = "../own";
    Object.defineProperty(child, "hidden", {
      value: "../hidden",
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const result = collectCwdOccurrences(child);
    assert.deepEqual(result.occurrences, [{ path: `$["cwd"]`, value: "../own" }]);
  });

  it("handles shared subobjects at different positions without global deduplication", () => {
    const shared = { cwd: "../shared" };
    const input = { first: shared, second: shared };
    const result = collectCwdOccurrences(input);
    assert.deepEqual(
      result.occurrences.map((o) => o.path),
      [`$["first"]["cwd"]`, `$["second"]["cwd"]`],
    );
  });

  it("does not modify frozen input", () => {
    const input = Object.freeze({
      cwd: "../a",
      tasks: Object.freeze([{ cwd: Object.freeze("../b") }]),
    });
    const result = collectCwdOccurrences(input);
    assert.deepEqual(
      result.occurrences.map((o) => o.value),
      ["../a", "../b"],
    );
    assert.ok(Object.isFrozen(input));
  });

  it("survives cyclic input without error via ancestor-chain detection", () => {
    const root: Record<string, unknown> = { name: "root" };
    root["self"] = root;
    root["tasks"] = [root, { cwd: "../leaf" }];
    const result = collectCwdOccurrences(root);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.occurrences, [{ path: `$["tasks"][1]["cwd"]`, value: "../leaf" }]);
  });

  it("survives a cwd value that participates in a cycle (leaf, never entered)", () => {
    const root: Record<string, unknown> = {};
    root["cwd"] = { back: root };
    const result = collectCwdOccurrences(root);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.occurrences, [{ path: `$["cwd"]`, value: { back: root } }]);
  });

  it("scans inputs nested exactly at the depth cap", () => {
    // The cwd container itself is one level; 9 wrappers make 10 levels total.
    const input = nestValue({ cwd: "../bottom" }, MAX_SCAN_DEPTH - 1);
    const result = collectCwdOccurrences(input);
    assert.equal(result.error, undefined);
    assert.equal(result.occurrences.length, 1);
    assert.equal(result.occurrences[0]?.value, "../bottom");
  });

  it("fails closed when input nesting exceeds the depth cap", () => {
    const input = nestValue({ cwd: "../too-deep" }, MAX_SCAN_DEPTH);
    const result = collectCwdOccurrences(input);
    assert.ok(result.error, "a scan error must be reported");
    assert.match(result.error.message, /maximum scan depth of 10/);
    assert.deepEqual(result.occurrences, []);
  });

  it("recursion depth is bounded, so hostile deep inputs cannot overflow the stack", () => {
    let node: Record<string, unknown> = {};
    for (let i = 0; i < 1_000_000; i++) {
      node = { child: node };
    }
    const result = collectCwdOccurrences(node);
    assert.ok(result.error, "a scan error must be reported");
    assert.match(result.error.message, /maximum scan depth/);
  });

  it("reports an error when a member cannot be read (hostile getter)", () => {
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "danger", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    input["before"] = { cwd: "../ok" };
    const result = collectCwdOccurrences(input);
    assert.ok(result.error, "a scan error must be reported");
    assert.match(result.error.message, /danger/);
    assert.match(result.error.message, /getter exploded/);
    // Items collected before the failure are still reported, but the caller
    // must block on scanError; nothing is silently allowed.
    assert.deepEqual(result.occurrences.map((o) => o.value), ["../ok"]);
  });

  it("reports an error when the cwd value itself has a hostile getter sibling path", () => {
    const cwdHolder: Record<string, unknown> = {};
    Object.defineProperty(cwdHolder, "cwd", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("cwd getter exploded");
      },
    });
    const result = collectCwdOccurrences(cwdHolder);
    assert.ok(result.error);
    assert.match(result.error.message, /cwd/);
    assert.deepEqual(result.occurrences, []);
  });
});
