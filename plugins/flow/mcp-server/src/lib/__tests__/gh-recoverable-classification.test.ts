/**
 * Tests for the recoverable-vs-fatal classifier running on the REAL failure
 * path in `gh.ts` — not just via stubs that return non-throwing results.
 *
 * Prior to this story the execa call was awaited directly; when the process
 * exits non-zero execa THROWS an ExecaError before the classification block
 * could run. These tests verify that:
 *
 * AC1 — A transient, mapped GitHub failure (e.g. rate-limit) is recognised and
 *        raises `GhRecoverableError` in real operation, not a raw crash.
 * AC2 — A fatal (unmapped) GitHub failure surfaces with a clear reason (the raw
 *        result) rather than an opaque throw.
 *
 * The `execaImpl` seam is used to inject a stub that THROWS an ExecaError-shaped
 * object (what real execa would throw on a non-zero exit). This is the exact
 * scenario that was broken before the fix: the throw happened before the
 * classification block ran.
 *
 * Story native:01KTSR1HYG02PDVGGM7382ZSR6
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../managed-fs.js";
import { __resetGhErrorMapCacheForTests } from "../gh-error-map.js";
import { GhRecoverableError } from "../../errors.js";
import { gh } from "../gh.js";
import type { RolePermissions } from "../../schemas/role-permissions.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakePluginRoot: string;

const PERMISSIONS: RolePermissions = {
  role: "generalist-dev",
  tools_allow: ["runDevTerminalAction"],
  gh_allow: ["pr-create", "pr-view", "pr-merge"],
  gh_allow_args: {},
  sourcePath: "/fake/permissions/generalist-dev.yaml",
};

/** Fixture error map with three mapped entries. */
const FIXTURE_ERROR_MAP = `\
entries:
  - exit_code: 4
    stderr_regex: "API rate limit exceeded|secondary rate limit"
    class: defer
  - exit_code: 4
    stderr_regex: "requires authentication|gh auth login"
    class: needs-human
  - exit_code: 1
    stderr_regex: "dial tcp|connection reset|could not resolve host|i/o timeout|network is unreachable"
    class: retry
`;

beforeEach(async () => {
  __resetGhErrorMapCacheForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-gh-classify-real-"));
  fakePluginRoot = path.join(tmpDir, "plugin");
  await fs.mkdir(path.join(fakePluginRoot, "permissions"), { recursive: true });
  await atomicWriteFile(
    path.join(fakePluginRoot, "permissions", "gh-error-map.yaml"),
    FIXTURE_ERROR_MAP,
  );
});

afterEach(async () => {
  __resetGhErrorMapCacheForTests();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: make an execaImpl stub that THROWS like real execa does on non-zero
// exit (ExecaError has exitCode + stderr on the thrown object).
// ---------------------------------------------------------------------------

function makeThrowingStub(exitCode: number, stderr: string, stdout = "") {
  return async () => {
    const err = Object.assign(new Error(`Command failed with exit code ${exitCode}`), {
      exitCode,
      stderr,
      stdout,
    });
    throw err;
  };
}

// ---------------------------------------------------------------------------
// AC1 — Mapped failure (transient) raises GhRecoverableError on the real path
// ---------------------------------------------------------------------------

describe("AC1 — recoverable failure recovered on the real throw path", () => {
  it("rate-limit (exit=4, mapped defer): throwing execa stub → GhRecoverableError class=defer", async () => {
    const stub = makeThrowingStub(4, "API rate limit exceeded");

    const err = await gh({
      role: "generalist-dev",
      permissions: PERMISSIONS,
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
  });

  it("auth failure (exit=4, mapped needs-human): throwing execa stub → GhRecoverableError class=needs-human", async () => {
    const stub = makeThrowingStub(4, "requires authentication");

    const err = await gh({
      role: "generalist-dev",
      permissions: PERMISSIONS,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GhRecoverableError);
    expect((err as GhRecoverableError).class).toBe("needs-human");
  });

  it("transient network (exit=1, mapped retry): throwing execa stub → GhRecoverableError class=retry", async () => {
    const stub = makeThrowingStub(1, "dial tcp: lookup api.github.com: i/o timeout");

    const err = await gh({
      role: "generalist-dev",
      permissions: PERMISSIONS,
      subcommand: "pr-view",
      args: ["1"],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GhRecoverableError);
    expect((err as GhRecoverableError).class).toBe("retry");
  });

  it("secondary rate limit (exit=4, mapped defer via regex alternation): throwing stub → GhRecoverableError", async () => {
    const stub = makeThrowingStub(4, "You have exceeded a secondary rate limit");

    const err = await gh({
      role: "generalist-dev",
      permissions: PERMISSIONS,
      subcommand: "pr-merge",
      args: ["1", "--squash"],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GhRecoverableError);
    expect((err as GhRecoverableError).class).toBe("defer");
  });
});

// ---------------------------------------------------------------------------
// AC2 — Unmapped (fatal) failure surfaces with a clear reason
// ---------------------------------------------------------------------------

describe("AC2 — fatal (unmapped) failure returns raw result with clear reason", () => {
  it("unmapped failure (exit=1, stderr not matched): returns raw result, NOT GhRecoverableError", async () => {
    // Before the fix: execa threw before the classifier ran, so both mapped and
    // unmapped failures propagated as raw ExecaErrors with no typed structure.
    // After the fix: unmapped failures return the raw result (same contract as
    // the happy path for non-zero unmapped exits) so callers like
    // runDevTerminalAction can raise their own typed errors.
    const stub = makeThrowingStub(1, "pull request already exists for branch");

    const result = await gh({
      role: "generalist-dev",
      permissions: PERMISSIONS,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    });

    // NOT a GhRecoverableError — the classifier returned null (unmapped).
    // The raw result is returned so the caller can handle it with its own error.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("pull request already exists for branch");
  });

  it("unmapped exit code (exit=127): returns raw result with the exit code intact", async () => {
    const stub = makeThrowingStub(127, "gh: command not found");

    const result = await gh({
      role: "generalist-dev",
      permissions: PERMISSIONS,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    });

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("gh: command not found");
  });

  it("a truly fatal env error (no exitCode on thrown error) re-throws as-is without wrapping", async () => {
    // ENOENT (gh binary missing) — execa throws but the error has no exitCode.
    // The wrapper must re-throw it unchanged so callers see the real cause.
    const fatalErr = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const stub = async () => { throw fatalErr; };

    const err = await gh({
      role: "generalist-dev",
      permissions: PERMISSIONS,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    }).catch((e) => e);

    // Should be re-thrown as-is — NOT wrapped in GhRecoverableError
    expect(err).toBe(fatalErr);
    expect(err).not.toBeInstanceOf(GhRecoverableError);
  });
});

// ---------------------------------------------------------------------------
// Regression: happy path (exit=0) still bypasses classification
// ---------------------------------------------------------------------------

describe("Regression — exit=0 happy path unchanged", () => {
  it("exit=0 returns the result without classification and without throwing", async () => {
    const stub = async () => ({
      stdout: "https://github.com/owner/repo/pull/1",
      stderr: "",
      exitCode: 0,
    });

    const result = await gh({
      role: "generalist-dev",
      permissions: PERMISSIONS,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: fakePluginRoot,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("https://github.com/owner/repo/pull/1");
  });
});
