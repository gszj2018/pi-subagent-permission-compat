import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkExternalDirectory,
  defaultPermissionModuleImporter,
  describeError,
  describeUnknown,
  EXTERNAL_DIRECTORY_SURFACE,
  resolvePermissionsService,
  type PermissionModuleImporter,
  type PermissionsService,
} from "../extensions/permissions-client.ts";

const SESSION_ID = "sess-permissions-0001";

function serviceStub(
  overrides: Partial<{ checkPermission: () => unknown }> = {},
): PermissionsService {
  return {
    checkPermission: overrides.checkPermission ?? (() => ({ state: "allow" })),
  } as unknown as PermissionsService;
}

/** Builds an importer returning an arbitrary module shape (cast for hostile cases). */
function importerStub(implementation: () => unknown): {
  importer: PermissionModuleImporter;
} {
  return {
    importer: (async () => implementation()) as unknown as PermissionModuleImporter,
  };
}

describe("resolvePermissionsService", () => {
  it("resolves the service through the accessor with the current session ID", async () => {
    const seen: string[] = [];
    const service = serviceStub();
    const { importer } = importerStub(() => ({
      getPermissionsService: (sessionId: string) => {
        seen.push(sessionId);
        return service;
      },
    }));

    const resolution = await resolvePermissionsService(importer, SESSION_ID);

    assert.deepEqual(seen, [SESSION_ID]);
    assert.equal(resolution.ok, true);
    if (resolution.ok) {
      assert.equal(resolution.service, service);
    }
  });

  it("fails closed when the importer throws (module missing)", async () => {
    const { importer } = importerStub(() => {
      throw new Error("Cannot find package '@gotgenes/pi-permission-system'");
    });

    const resolution = await resolvePermissionsService(importer, SESSION_ID);

    assert.equal(resolution.ok, false);
    if (!resolution.ok) {
      assert.match(resolution.reason, /unavailable/);
      assert.match(resolution.reason, /Cannot find package/);
    }
  });

  it("treats a missing accessor as an unpublished service (graceful degradation)", async () => {
    for (const module of [undefined, null, {}]) {
      const { importer } = importerStub(() => module);
      const resolution = await resolvePermissionsService(importer, SESSION_ID);
      assert.equal(resolution.ok, false);
      if (!resolution.ok) {
        assert.match(resolution.reason, /not published/);
      }
    }
  });

  it("fails closed when the accessor is not callable", async () => {
    const { importer } = importerStub(() => ({ getPermissionsService: "nope" }));
    const resolution = await resolvePermissionsService(importer, SESSION_ID);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) {
      assert.match(resolution.reason, /unavailable/);
    }
  });

  it("fails closed when the accessor throws", async () => {
    const { importer } = importerStub(() => {
      throw new Error("slot broken");
    });
    const resolution = await resolvePermissionsService(importer, SESSION_ID);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) {
      assert.match(resolution.reason, /unavailable/);
      assert.match(resolution.reason, /slot broken/);
    }
  });

  it("treats undefined and null as an unpublished service", async () => {
    for (const service of [undefined, null]) {
      const { importer } = importerStub(() => ({
        getPermissionsService: () => service,
      }));
      const resolution = await resolvePermissionsService(importer, SESSION_ID);
      assert.equal(resolution.ok, false);
      if (!resolution.ok) {
        assert.match(resolution.reason, /not published/);
      }
    }
  });

  it("resolves any non-falsy service value; malformed ones fail per-item at query time", async () => {
    // Upstream guarantees a published service is a valid PermissionsService;
    // this documents that the resolver no longer shape-checks deeper and
    // relies on per-item query guards for fail-closed behavior.
    for (const service of [{}, 42, "garbage"]) {
      const { importer } = importerStub(() => ({
        getPermissionsService: () => service,
      }));
      const resolution = await resolvePermissionsService(importer, SESSION_ID);
      assert.equal(resolution.ok, true);
      if (resolution.ok) {
        assert.equal(resolution.service, service);
      }
    }
  });
});

describe("service shape failures degrade per-item at query time", () => {
  it("fails closed when checkPermission is missing or not callable", () => {
    for (const brokenService of [{}, { checkPermission: "nope" }, 42, null, undefined]) {
      const check = checkExternalDirectory(
        brokenService as unknown as PermissionsService,
        "../x",
      );
      assert.equal(check.ok, false);
      if (!check.ok) {
        assert.match(check.reason, /query failed/);
      }
    }
  });
});

describe("checkExternalDirectory", () => {
  it("queries the bare external_directory surface with the raw value and reads state", () => {
    const seen: { surface: string; value: string; args: unknown[] }[] = [];
    const service = {
      checkPermission: (...args: unknown[]) => {
        seen.push({ surface: args[0] as string, value: args[1] as string, args });
        return { state: "allow" };
      },
    } as unknown as PermissionsService;

    const check = checkExternalDirectory(service, "  ../padded path  ");

    assert.deepEqual(seen, [
      {
        surface: "external_directory",
        value: "  ../padded path  ",
        args: [EXTERNAL_DIRECTORY_SURFACE, "  ../padded path  "],
      },
    ]);
    // Exactly two arguments: no direction plane, no inferred agentName.
    assert.equal(seen[0]?.args.length, 2);
    assert.equal(check.ok, true);
    if (check.ok) {
      assert.equal(check.state, "allow");
    }
  });

  it("accepts every legal state", () => {
    for (const state of ["allow", "ask", "deny"] as const) {
      const service = serviceStub({ checkPermission: () => ({ state }) });
      const check = checkExternalDirectory(service, "../x");
      assert.deepEqual(check, { ok: true, state });
    }
  });

  it("fails closed when the query throws", () => {
    const service = serviceStub({
      checkPermission: () => {
        throw new Error("policy engine exploded");
      },
    });
    const check = checkExternalDirectory(service, "../x");
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.match(check.reason, /query failed/);
      assert.match(check.reason, /policy engine exploded/);
    }
  });

  it("fails closed on a missing result or an invalid state", () => {
    for (const result of [undefined, null, {}, { state: "ALLOW" }, { state: 7 }, { state: undefined }]) {
      const service = serviceStub({ checkPermission: () => result });
      const check = checkExternalDirectory(service, "../x");
      assert.equal(check.ok, false, JSON.stringify(result));
      if (!check.ok) {
        assert.match(check.reason, /invalid permission state/);
      }
    }
  });

  it("passes Windows paths, whitespace, and dot paths through untouched", () => {
    const seen: string[] = [];
    const service = {
      checkPermission: (_surface: string, value?: string) => {
        seen.push(value as string);
        return { state: "ask" };
      },
    } as unknown as PermissionsService;
    for (const raw of ["C:\\Users\\outside", ".", " ", "\n../newline", "../with spaces"]) {
      checkExternalDirectory(service, raw);
    }
    assert.deepEqual(seen, ["C:\\Users\\outside", ".", " ", "\n../newline", "../with spaces"]);
  });
});

describe("default importer", () => {
  it("imports the real permission-system module in the development environment", async () => {
    const module = await defaultPermissionModuleImporter();
    assert.ok(module);
    assert.equal(typeof module.getPermissionsService, "function");
  });
});

describe("diagnostic helpers", () => {
  it("describeUnknown uses safe JSON display and never throws", () => {
    assert.equal(describeUnknown("plain"), '"plain"');
    assert.equal(describeUnknown(42), "42");
    assert.equal(describeUnknown(undefined), "undefined");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    assert.equal(describeUnknown(cyclic), "[unserializable value]");
  });

  it("describeError extracts the message from Error instances", () => {
    assert.equal(describeError(new Error("boom")), "boom");
    assert.equal(describeError("plain rejection"), "plain rejection");
    assert.equal(describeError(42), "42");
  });
});
