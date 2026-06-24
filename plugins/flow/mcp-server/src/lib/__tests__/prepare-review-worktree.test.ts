/**
 * Unit tests for `prepare-review-worktree` (Story native:01KVWMCK).
 *
 * Covers the install-plan resolution (lockfile-root walk, per-manager frozen
 * invocation, skip-when-no-lockfile) and the install runner (skip / success /
 * failure / timeout), all through real temp dirs + an injected execa stub.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../managed-fs.js";
import {
  resolveWorktreeInstallPlan,
  installWorktreeDependencies,
} from "../prepare-review-worktree.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "flow-prep-wt-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function writePkg(dir: string, pkg: Record<string, unknown>): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

describe("resolveWorktreeInstallPlan", () => {
  it("returns a pnpm frozen install at the build home when the lockfile lives there", async () => {
    // Single-package repo: root owns the build script + the pnpm lockfile.
    await writePkg(root, { name: "r", version: "0.0.0", scripts: { build: "tsc" } });
    await atomicWriteFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const plan = resolveWorktreeInstallPlan(root);
    expect(plan).not.toBeNull();
    expect(plan!.packageManager).toBe("pnpm");
    expect(plan!.installRoot).toBe(root);
    expect(plan!.command).toBe("pnpm");
    expect(plan!.args).toEqual(["install", "--frozen-lockfile", "--prefer-offline"]);
  });

  it("walks UP from a sub-package build home to the repo-root lockfile (monorepo)", async () => {
    // Build home is a sub-package (it owns the build script); the lockfile sits at
    // the repo root. The plan must install at the lockfile root, not the build home.
    await writePkg(root, { name: "r", version: "0.0.0" }); // no build script at root
    const pkg = path.join(root, "packages", "app");
    await writePkg(pkg, { name: "app", version: "0.0.0", scripts: { build: "tsc" } });
    await atomicWriteFile(path.join(root, "package-lock.json"), "{}\n");

    const plan = resolveWorktreeInstallPlan(root);
    expect(plan).not.toBeNull();
    expect(plan!.installRoot).toBe(root);
    expect(plan!.packageManager).toBe("npm");
    expect(plan!.command).toBe("npm");
    expect(plan!.args).toEqual(["ci", "--prefer-offline"]);
  });

  it("returns null when no lockfile is present anywhere (nothing to install)", async () => {
    await writePkg(root, { name: "r", version: "0.0.0", scripts: { build: "tsc" } });
    const plan = resolveWorktreeInstallPlan(root);
    expect(plan).toBeNull();
  });

  it("derives the yarn immutable install from yarn.lock", async () => {
    await writePkg(root, { name: "r", version: "0.0.0", scripts: { build: "tsc" } });
    await atomicWriteFile(path.join(root, "yarn.lock"), "# yarn lockfile v1\n");
    const plan = resolveWorktreeInstallPlan(root);
    expect(plan!.packageManager).toBe("yarn");
    expect(plan!.command).toBe("yarn");
    expect(plan!.args).toEqual(["install", "--immutable"]);
  });

  it("derives the bun frozen install from bun.lockb", async () => {
    await writePkg(root, { name: "r", version: "0.0.0", scripts: { build: "tsc" } });
    await atomicWriteFile(path.join(root, "bun.lockb"), "");
    const plan = resolveWorktreeInstallPlan(root);
    expect(plan!.packageManager).toBe("bun");
    expect(plan!.command).toBe("bun");
    expect(plan!.args).toEqual(["install", "--frozen-lockfile"]);
  });
});

describe("installWorktreeDependencies", () => {
  it("skips (ran:false, ok:true) when there is no lockfile", async () => {
    await writePkg(root, { name: "r", version: "0.0.0", scripts: { build: "tsc" } });
    const execa = vi.fn();
    const res = await installWorktreeDependencies({
      worktreeRoot: root,
      execaImpl: execa as unknown as typeof import("execa").execa,
    });
    expect(res.ran).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.skippedReason).toContain("no lockfile");
    expect(execa).not.toHaveBeenCalled();
  });

  it("runs the frozen install and reports ok on exit 0", async () => {
    await writePkg(root, { name: "r", version: "0.0.0", scripts: { build: "tsc" } });
    await atomicWriteFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const execa = vi.fn().mockResolvedValue({ stdout: "done", stderr: "", exitCode: 0, timedOut: false });

    const res = await installWorktreeDependencies({
      worktreeRoot: root,
      execaImpl: execa as unknown as typeof import("execa").execa,
    });

    expect(res.ran).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.installRoot).toBe(root);
    expect(res.commandLine).toBe("pnpm install --frozen-lockfile --prefer-offline");
    // The install ran at the lockfile root via the injected execa.
    expect(execa).toHaveBeenCalledTimes(1);
    const [cmd, args, callOpts] = execa.mock.calls[0]!;
    expect(cmd).toBe("pnpm");
    expect(args).toEqual(["install", "--frozen-lockfile", "--prefer-offline"]);
    expect((callOpts as { cwd?: string }).cwd).toBe(root);
  });

  it("reports ran:true ok:false on a non-zero install exit (never throws)", async () => {
    await writePkg(root, { name: "r", version: "0.0.0", scripts: { build: "tsc" } });
    await atomicWriteFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const execa = vi.fn().mockResolvedValue({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false });

    const res = await installWorktreeDependencies({
      worktreeRoot: root,
      execaImpl: execa as unknown as typeof import("execa").execa,
    });

    expect(res.ran).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe("boom");
  });

  it("reports ok:false and timedOut when the install times out", async () => {
    await writePkg(root, { name: "r", version: "0.0.0", scripts: { build: "tsc" } });
    await atomicWriteFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const execa = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: undefined, timedOut: true });

    const res = await installWorktreeDependencies({
      worktreeRoot: root,
      execaImpl: execa as unknown as typeof import("execa").execa,
      timeoutMs: 5,
    });

    expect(res.ran).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(-1);
  });
});
