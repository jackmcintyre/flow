/**
 * Unit tests for gh.ts — Story 4.4 (negative-capability refusal) +
 * Story 4.5 (post-result recoverable-error classification).
 *
 * Story 4.4 coverage:
 *   - Negative-capability refusal for --no-verify, --force, --force-with-lease.
 * Story 4.5 coverage (Task 3.4):
 *   - Each mapped class raises GhRecoverableError with right fields.
 *   - Unmapped non-zero exit still returns the existing result shape.
 *   - Classification runs AFTER spawn, not before (execaImpl spy confirms).
 *   - Pre-spawn checks (gh_allow, assertNoNegativeFlags) remain unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../managed-fs.js";
import { __resetGhErrorMapCacheForTests } from "../gh-error-map.js";
import { GhRecoverableError } from "../../errors.js";
import { gh } from "../gh.js";
import { NegativeCapabilityDeniedError, GhSubcommandDeniedError } from "../../errors.js";
import type { RolePermissions } from "../../schemas/role-permissions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePermissions(overrides?: Partial<RolePermissions>): RolePermissions {
  return {
    role: "generalist-dev",
    tools_allow: ["runDevTerminalAction"],
    gh_allow: ["pr-create", "pr-view"],
    gh_allow_args: {},
    sourcePath: "/fake/permissions/generalist-dev.yaml",
    ...overrides,
  };
}

function makeOkStub(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    stdout: "https://github.com/owner/repo/pull/1",
    stderr: "",
    exitCode: 0,
  }));
}

// ---------------------------------------------------------------------------
// Story 4.5: fixture plugin root with a gh-error-map.yaml
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakePluginRoot: string;

beforeEach(async () => {
  __resetGhErrorMapCacheForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-gh-wrapper-test-"));
  fakePluginRoot = path.join(tmpDir, "plugin");
  await fs.mkdir(path.join(fakePluginRoot, "permissions"), { recursive: true });
});

afterEach(async () => {
  __resetGhErrorMapCacheForTests();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFixtureMap(yaml: string): Promise<void> {
  await atomicWriteFile(
    path.join(fakePluginRoot, "permissions", "gh-error-map.yaml"),
    yaml,
  );
}

async function writeV1Map(): Promise<void> {
  await writeFixtureMap(`
entries:
  - exit_code: 4
    stderr_regex: "requires authentication|gh auth login"
    class: needs-human
  - exit_code: 4
    stderr_regex: "API rate limit exceeded|secondary rate limit"
    class: defer
  - exit_code: 1
    stderr_regex: "dial tcp|connection reset|could not resolve host|i/o timeout|network is unreachable"
    class: retry
`);
}

// ---------------------------------------------------------------------------
// Negative-capability refusal (Task 1.2 / Task 1.4 / AC2)
// ---------------------------------------------------------------------------

describe("gh wrapper — negative-capability refusal (Task 1.2 / AC2)", () => {
  const permissions = makePermissions();

  it("Task 1.4: refuses --no-verify BEFORE spawn and throws NegativeCapabilityDeniedError", async () => {
    const spy = vi.fn();
    await expect(
      gh({
        role: "generalist-dev",
        permissions,
        subcommand: "pr-create",
        args: ["--no-verify", "--title", "foo", "--body", "bar"],
        execaImpl: spy as unknown as Parameters<typeof gh>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(NegativeCapabilityDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("Task 1.4: refuses --force BEFORE spawn", async () => {
    const spy = vi.fn();
    await expect(
      gh({
        role: "generalist-dev",
        permissions,
        subcommand: "pr-create",
        args: ["--force"],
        execaImpl: spy as unknown as Parameters<typeof gh>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(NegativeCapabilityDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("Task 1.4: refuses --force-with-lease BEFORE spawn", async () => {
    const spy = vi.fn();
    await expect(
      gh({
        role: "generalist-dev",
        permissions,
        subcommand: "pr-create",
        args: ["--force-with-lease"],
        execaImpl: spy as unknown as Parameters<typeof gh>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(NegativeCapabilityDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("Task 1.4: refuses --force-with-lease=refs/heads/main BEFORE spawn", async () => {
    const spy = vi.fn();
    await expect(
      gh({
        role: "generalist-dev",
        permissions,
        subcommand: "pr-create",
        args: ["--force-with-lease=refs/heads/main"],
        execaImpl: spy as unknown as Parameters<typeof gh>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(NegativeCapabilityDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("negative-capability check runs AFTER gh_allow (denied subcommand still surfaces as GhSubcommandDeniedError)", async () => {
    const spy = vi.fn();
    // "push" is not in gh_allow → GhSubcommandDeniedError
    await expect(
      gh({
        role: "generalist-dev",
        permissions,
        subcommand: "push",
        args: ["--no-verify"],
        execaImpl: spy as unknown as Parameters<typeof gh>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(GhSubcommandDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("happy path: allowed subcommand with clean args proceeds to spawn", async () => {
    const spy = makeOkStub();
    const result = await gh({
      role: "generalist-dev",
      permissions,
      subcommand: "pr-create",
      args: ["--title", "My PR", "--body", "body text"],
      execaImpl: spy as unknown as Parameters<typeof gh>[0]["execaImpl"],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Story 4.5: post-result classification (Task 3.4)
// ---------------------------------------------------------------------------

describe("gh wrapper — post-result recoverable-error classification (Story 4.5 Task 3.4)", () => {
  const permissions = makePermissions();

  it("maps exit=4 stderr='API rate limit exceeded' → GhRecoverableError class=defer", async () => {
    await writeV1Map();
    const stub = vi.fn(async () => ({
      stdout: "",
      stderr: "API rate limit exceeded",
      exitCode: 4,
    }));

    const err = await gh({
      role: "generalist-dev",
      permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GhRecoverableError);
    const recErr = err as GhRecoverableError;
    expect(recErr.class).toBe("defer");
    expect(recErr.exitCode).toBe(4);
    expect(recErr.stderr).toBe("API rate limit exceeded");
    expect(recErr.subcommand).toBe("pr-create");
    // Classification runs AFTER spawn
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("maps exit=4 stderr='requires authentication' → GhRecoverableError class=needs-human", async () => {
    await writeV1Map();
    const stub = vi.fn(async () => ({
      stdout: "",
      stderr: "requires authentication",
      exitCode: 4,
    }));

    const err = await gh({
      role: "generalist-dev",
      permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GhRecoverableError);
    expect((err as GhRecoverableError).class).toBe("needs-human");
  });

  it("maps exit=1 stderr='dial tcp: lookup ...: i/o timeout' → GhRecoverableError class=retry", async () => {
    await writeV1Map();
    const stub = vi.fn(async () => ({
      stdout: "",
      stderr: "dial tcp: lookup api.github.com: i/o timeout",
      exitCode: 1,
    }));

    const err = await gh({
      role: "generalist-dev",
      permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GhRecoverableError);
    expect((err as GhRecoverableError).class).toBe("retry");
  });

  it("unmapped non-zero exit returns the raw result (existing terminal path)", async () => {
    await writeV1Map();
    const stub = vi.fn(async () => ({
      stdout: "",
      stderr: "pull request already exists for branch",
      exitCode: 1,
    }));

    const result = await gh({
      role: "generalist-dev",
      permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    });

    // Should NOT throw GhRecoverableError — returns the raw result
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("pull request already exists for branch");
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("exitCode=0 bypasses classification entirely", async () => {
    await writeV1Map();
    const stub = makeOkStub();

    const result = await gh({
      role: "generalist-dev",
      permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    });

    expect(result.exitCode).toBe(0);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("pre-spawn checks (gh_allow, assertNoNegativeFlags) remain unchanged by classification", async () => {
    await writeV1Map();
    const spy = vi.fn();

    // gh_allow refusal (before spawn)
    await expect(
      gh({
        role: "generalist-dev",
        permissions,
        subcommand: "push",
        args: [],
        execaImpl: spy as unknown as Parameters<typeof gh>[0]["execaImpl"],
        pluginRootOverride: fakePluginRoot,
      }),
    ).rejects.toBeInstanceOf(GhSubcommandDeniedError);
    expect(spy).not.toHaveBeenCalled();

    // negative flag refusal (before spawn)
    await expect(
      gh({
        role: "generalist-dev",
        permissions,
        subcommand: "pr-create",
        args: ["--no-verify"],
        execaImpl: spy as unknown as Parameters<typeof gh>[0]["execaImpl"],
        pluginRootOverride: fakePluginRoot,
      }),
    ).rejects.toBeInstanceOf(NegativeCapabilityDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 4a.2–4a.3: input field forwarding (Story 4.6b)
// ---------------------------------------------------------------------------

describe("gh() input field — Story 4.6b Task 4a", () => {
  const permissions: RolePermissions = {
    role: "generalist-reviewer",
    tools_allow: [],
    gh_allow: ["api"],
    gh_allow_args: {},
    sourcePath: "/fake/permissions/generalist-reviewer.yaml",
  };

  it("4a.2 — NOT passing input does not break existing path (stub called without 3rd arg)", async () => {
    await writeV1Map();
    const stub = vi.fn(async () => ({
      stdout: '{"id":1}',
      stderr: "",
      exitCode: 0,
    }));

    const result = await gh({
      role: "generalist-reviewer",
      permissions,
      subcommand: "api",
      args: ["/repos/owner/repo/pulls/1/reviews", "--method", "POST"],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
      // No input
    });

    expect(result.exitCode).toBe(0);
    // Called with exactly 2 positional args (no 3rd options object)
    expect(stub).toHaveBeenCalledWith(
      "gh",
      ["api", "/repos/owner/repo/pulls/1/reviews", "--method", "POST"],
    );
  });

  it("4a.3 — passing input forwards it as the { input } option to execaImpl", async () => {
    await writeV1Map();
    const capturedOpts: unknown[] = [];
    const stub = vi.fn(async (_cmd: string, _args: string[], opts?: unknown) => {
      capturedOpts.push(opts);
      return { stdout: '{"id":99}', stderr: "", exitCode: 0 };
    });

    const jsonBody = '{"event":"COMMENT","body":"test","comments":[]}';

    await gh({
      role: "generalist-reviewer",
      permissions,
      subcommand: "api",
      args: ["/repos/owner/repo/pulls/1/reviews", "--method", "POST", "--input", "-"],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
      input: jsonBody,
    });

    expect(capturedOpts[0]).toEqual({ input: jsonBody });
  });
});
