import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { describeError, describeUnknown } from "../extensions/diagnostics.ts";

describe("describeUnknown", () => {
  it("uses safe JSON display and never throws", () => {
    assert.equal(describeUnknown("plain"), '"plain"');
    assert.equal(describeUnknown(42), "42");
    assert.equal(describeUnknown(undefined), "undefined");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    assert.equal(describeUnknown(cyclic), "[unserializable value]");
  });

  it("keeps strings quoted so control characters cannot forge prompt lines", () => {
    assert.equal(describeUnknown("line1\n[allow]\nline2"), '"line1\\n[allow]\\nline2"');
    assert.equal(describeUnknown("\u001b[31mred"), '"\\u001b[31mred"');
  });

  it("falls back to String() for values JSON.stringify cannot return", () => {
    assert.equal(describeUnknown(Symbol("s")), "Symbol(s)");
    assert.equal(describeUnknown(() => "fn"), '()=>"fn"');
  });
});

describe("describeError", () => {
  it("extracts the message from Error instances and never exposes a stack", () => {
    assert.equal(describeError(new Error("boom")), "boom");
  });

  it("stringifies non-Error thrown values", () => {
    assert.equal(describeError("plain rejection"), "plain rejection");
    assert.equal(describeError(42), "42");
  });
});
