import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectCwdOccurrences,
  isShallowJsonObject,
  MAX_SCAN_DEPTH,
} from "../extensions/cwd-inspection.ts";

function nestValue(value: Record<string, unknown>, levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = value;
  for (let i = 0; i < levels; i++) {
    node = { child: node };
  }
  return node;
}

/** Attaches a non-index own key to an array, the way a rogue tool input could. */
function attachArrayKey(list: unknown[], key: string, value: unknown): void {
  Object.defineProperty(list, key, { value, enumerable: true, writable: true, configurable: true });
}

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

  it("reports an error for array keys that are not canonical array indices", () => {
    const list: unknown[] = [{ cwd: "../a" }];
    attachArrayKey(list, "extra", "../extra");
    const result = collectCwdOccurrences({ before: { cwd: "../ok" }, list });
    assert.ok(result.error, "a scan error must be reported");
    assert.match(result.error.message, /invalid array index key at \$\["list"]/);
    assert.deepEqual(result.occurrences.map((o) => o.value), ["../ok", "../a"]);
  });

  it("rejects a cwd key attached to an array instead of collecting it", () => {
    const list: unknown[] = [{ cwd: "../a" }];
    attachArrayKey(list, "cwd", "../array-level");
    const result = collectCwdOccurrences({ list });
    assert.ok(result.error, "a scan error must be reported");
    assert.match(result.error.message, /invalid array index key at \$\["list"]: "cwd"/);
    assert.deepEqual(result.occurrences.map((o) => o.value), ["../a"]);
  });

  it("rejects non-canonical and out-of-range numeric array keys", () => {
    for (const key of ["01", "-1", "1.5", "4294967295"]) {
      const list: unknown[] = [];
      attachArrayKey(list, key, "../x");
      const result = collectCwdOccurrences({ list });
      assert.ok(result.error, `a scan error must be reported for key ${key}`);
      assert.match(result.error.message, /invalid array index key/, key);
    }
  });

  it("rejects non-JSON containers nested in the tree and keeps earlier occurrences", () => {
    const withProxy = { before: { cwd: "../ok" }, danger: new Proxy({}, {}) };
    const proxyResult = collectCwdOccurrences(withProxy);
    assert.ok(proxyResult.error, "a scan error must be reported");
    assert.match(proxyResult.error.message, /\$\["danger"]/);
    assert.deepEqual(proxyResult.occurrences.map((o) => o.value), ["../ok"]);

    const withDate = { danger: new Date() };
    const dateResult = collectCwdOccurrences(withDate);
    assert.ok(dateResult.error, "a scan error must be reported");
    assert.match(dateResult.error.message, /\$\["danger"]/);
  });

  it("records non-JSON cwd values as unvalidated leaves", () => {
    const mapCwd = new Map<string, string>([["a", "b"]]);
    const proxyCwd = new Proxy({}, {});
    const result = collectCwdOccurrences({ cwd: mapCwd, other: { cwd: proxyCwd } });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.occurrences.map((o) => o.path), [`$["cwd"]`, `$["other"]["cwd"]`]);
    assert.equal(result.occurrences[0]?.value, mapCwd);
    assert.equal(result.occurrences[1]?.value, proxyCwd);
  });

  it("never enters function, symbol, or bigint leaf values", () => {
    const result = collectCwdOccurrences({
      fn: () => "../fn",
      symbol: Symbol("../symbol"),
      bigint: 1n,
      nested: { cwd: "../ok" },
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.occurrences.map((o) => o.value), ["../ok"]);
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

  it("rejects a container with a non-trivial prototype instead of reading inherited keys", () => {
    const parent = { inherited: "../inherited" };
    const child = Object.create(parent) as Record<string, unknown>;
    child.cwd = "../own";

    const rootResult = collectCwdOccurrences(child);
    assert.ok(rootResult.error, "a scan error must be reported");
    assert.match(rootResult.error.message, /not a plain JSON object or array/);
    assert.deepEqual(rootResult.occurrences, []);

    const nestedResult = collectCwdOccurrences({ before: { cwd: "../ok" }, wrapped: child });
    assert.ok(nestedResult.error, "a scan error must be reported");
    assert.match(nestedResult.error.message, /\$\["wrapped"]/);
    assert.deepEqual(nestedResult.occurrences.map((o) => o.value), ["../ok"]);
  });

  it("rejects a container with a non-enumerable own key", () => {
    const input: Record<string, unknown> = { cwd: "../own" };
    Object.defineProperty(input, "hidden", {
      value: "../hidden",
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const result = collectCwdOccurrences(input);
    assert.ok(result.error, "a scan error must be reported");
    assert.match(result.error.message, /not a plain JSON object or array/);
    assert.deepEqual(result.occurrences, []);
  });

  it("rejects a container with an accessor property without invoking it (hostile getter)", () => {
    let getterCalls = 0;
    const input: Record<string, unknown> = { cwd: "../own" };
    Object.defineProperty(input, "danger", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter exploded");
      },
    });
    const result = collectCwdOccurrences(input);
    assert.ok(result.error, "a scan error must be reported");
    assert.match(result.error.message, /not a plain JSON object or array/);
    assert.equal(getterCalls, 0, "the descriptor check must never invoke accessors");
    assert.deepEqual(result.occurrences, []);
  });

  it("reports the path of a nested accessor container and keeps earlier occurrences", () => {
    const input: Record<string, unknown> = { before: { cwd: "../ok" } };
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, "danger", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    input["nested"] = nested;

    const result = collectCwdOccurrences(input);
    assert.ok(result.error, "a scan error must be reported");
    assert.match(result.error.message, /\$\["nested"]/);
    // Items collected before the failure are still reported, but the caller
    // must block on scanError; nothing is silently allowed.
    assert.deepEqual(result.occurrences.map((o) => o.value), ["../ok"]);
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
});

describe("shallow JSON container validation", () => {
  it("accepts plain objects and arrays, including null-prototype and frozen containers", () => {
    const nullPrototypeObject: Record<string, unknown> = Object.create(null);
    nullPrototypeObject["cwd"] = "../a";
    const nullPrototypeArray = Object.setPrototypeOf([1, 2], null);
    const sparseArray: unknown[] = [];
    sparseArray.length = 3;

    const accepted: [string, unknown][] = [
      ["plain object", {}],
      ["object with cwd", { cwd: "../a" }],
      ["empty array", []],
      ["array with values", [1, 2]],
      ["sparse array", sparseArray],
      ["null-prototype object", nullPrototypeObject],
      ["null-prototype array", nullPrototypeArray],
      ["frozen object", Object.freeze({ cwd: "../a" })],
      ["frozen array", Object.freeze([{ cwd: "../a" }])],
      ["sealed object", Object.seal({ cwd: "../a" })],
    ];

    for (const [label, value] of accepted) {
      assert.equal(isShallowJsonObject(value), true, label);
    }
  });

  it("rejects null, primitives, and non-object values", () => {
    const rejected: [string, unknown][] = [
      ["undefined", undefined],
      ["null", null],
      ["string", "text"],
      ["number", 42],
      ["boolean", true],
      ["symbol", Symbol("s")],
      ["bigint", 1n],
      ["function", () => "x"],
    ];

    for (const [label, value] of rejected) {
      assert.equal(isShallowJsonObject(value), false, label);
    }
  });

  it("rejects proxies, including revoked ones", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    assert.equal(isShallowJsonObject(new Proxy({}, {})), false);
    assert.equal(isShallowJsonObject(new Proxy([], {})), false);
    assert.equal(isShallowJsonObject(revocable.proxy), false);
  });

  it("rejects non-trivial prototypes", () => {
    class Custom {
      value = "../a";
    }

    for (const value of [
      Object.create({ inherited: true }),
      new Custom(),
      new Date(),
      new Map(),
      new Set(),
      Object.setPrototypeOf({}, Array.prototype),
      Object.setPrototypeOf([], Object.prototype),
    ]) {
      assert.equal(isShallowJsonObject(value), false);
    }
  });

  it("rejects symbol keys", () => {
    const withSymbol: Record<string | symbol, unknown> = { cwd: "../a" };
    withSymbol[Symbol("hidden")] = "../b";
    assert.equal(isShallowJsonObject(withSymbol), false);
  });

  it("rejects accessor and non-enumerable own properties", () => {
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "cwd", {
      enumerable: true,
      configurable: true,
      get() {
        return "../a";
      },
    });
    const nonEnumerable: Record<string, unknown> = { cwd: "../a" };
    Object.defineProperty(nonEnumerable, "hidden", {
      value: "../b",
      enumerable: false,
      writable: true,
      configurable: true,
    });
    assert.equal(isShallowJsonObject(accessor), false);
    assert.equal(isShallowJsonObject(nonEnumerable), false);
  });
});
