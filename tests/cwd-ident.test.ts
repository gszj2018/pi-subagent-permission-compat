import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  matchesInspectedToolName,
  INSPECTED_TOOL_NAME_PATTERN
} from "../extensions/cwd-ident.ts";

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
