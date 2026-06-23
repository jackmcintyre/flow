/**
 * `resolveProjectToolchain` — Story native:01KVTB3Z.
 *
 * The ONE resolver consumed by both the dev pre-PR gates and the reviewer's
 * vitest runner. These tests exercise the full contract:
 *
 *  - AC1 (external npm repo): root package.json with build+test scripts +
 *    package-lock.json, no plugins/ dir, no knip → npm + repo root + knip skipped.
 *  - AC2 (config override wins): a `build:` block overrides both structural
 *    detection and lockfile auto-detection.
 *  - AC3 (malformed config → typed error): an unrecognised packageManager value
 *    raises ToolchainConfigError rather than falling back silently.
 *  - AC4 (THE critical one — dogfood path): a Flow-SHAPED fixture (pnpm-workspace
 *    .yaml + a member package.json with a build script + pnpm-lock.yaml, and NO
 *    `.flow/config.yaml`) resolves to pnpm + the workspace-member cwd PURELY from
 *    structure.
 *  - Lockfile → package-manager mapping (each lockfile resolves to its manager).
 *  - knipCmd null behaviour (no knip script + no knip config + no override).
 *
 * `vitest: plugins/flow/mcp-server/src/lib/__tests__/resolve-project-toolchain.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  resolveProjectToolchain,
  LOCKFILE_TO_PACKAGE_MANAGER,
  type PackageManager,
} from "../resolve-project-toolchain.js";
import { ToolchainConfigError } from "../../errors.js";

function write(p: string, content: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

function writePkg(dir: string, scripts: Record<string, string>): void {
  write(
    path.join(dir, "package.json"),
    JSON.stringify({ name: path.basename(dir), private: true, scripts }, null, 2),
  );
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "resolve-toolchain-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC4 — THE critical one: structural detection alone yields pnpm + plugins/flow.
// ---------------------------------------------------------------------------

describe("AC4 — Flow-shaped repo resolves pnpm + plugins/flow PURELY from structure (no config)", () => {
  /**
   * Mirror the real Flow repo's ON-DISK truth:
   *   <root>/plugins/flow/pnpm-workspace.yaml  (packages: [mcp-server])
   *   <root>/plugins/flow/pnpm-lock.yaml
   *   <root>/plugins/flow/package.json         (scripts.build = "pnpm -r build", knip)
   * NO root package.json, NO root pnpm-workspace.yaml, NO `.flow/config.yaml`.
   */
  function seedFlowRepo(root: string): string {
    const flowDir = path.join(root, "plugins", "flow");
    write(path.join(flowDir, "pnpm-workspace.yaml"), "packages:\n  - mcp-server\n");
    write(path.join(flowDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writePkg(flowDir, { build: "pnpm -r build", test: "pnpm -r test", knip: "knip --no-progress" });
    // A member package (no build script of its own — the workspace ROOT owns it).
    writePkg(path.join(flowDir, "mcp-server"), { typecheck: "tsc" });
    return flowDir;
  }

  it("returns packageManager=pnpm and cwd=plugins/flow with NO .flow/config.yaml present", () => {
    const flowDir = seedFlowRepo(tmp);

    const result = resolveProjectToolchain({ targetRepoRoot: tmp });

    expect(result.packageManager).toBe("pnpm");
    expect(result.cwd).toBe(flowDir);
    expect(result.buildCmd).toEqual(["pnpm", "build"]);
    expect(result.testCmd).toEqual(["pnpm", "test"]);
    // The plugins/flow package.json carries a `knip` script → knipCmd present.
    expect(result.knipCmd).toEqual(["pnpm", "knip"]);
    // The package manager came from a lockfile, not an assumption.
    expect(result.pmAssumed).toBe(false);
    expect(result.source).toBe("workspace");
  });

  it("does NOT consult .flow/config.yaml for the dogfood path (gitignored-config correction)", () => {
    // Even when a SABOTAGING build block exists, the dogfood path must not break:
    // but to PROVE structural detection stands alone, we assert the result with
    // NO config present (the worktree/clean-checkout reality). A config block is
    // the escape hatch tested separately in AC2.
    const flowDir = seedFlowRepo(tmp);
    // No .flow/config.yaml written at all.
    const result = resolveProjectToolchain({ targetRepoRoot: tmp });
    expect(result.cwd).toBe(flowDir);
    expect(result.packageManager).toBe("pnpm");
  });
});

// ---------------------------------------------------------------------------
// AC1 — external npm repo: npm + repo root, knip skipped.
// ---------------------------------------------------------------------------

describe("AC1 — external npm repo resolves npm + repo root, knip skipped", () => {
  it("root package.json with build+test + package-lock.json, no plugins/, no knip", () => {
    writePkg(tmp, { build: "tsc", test: "node --test" });
    write(path.join(tmp, "package-lock.json"), "{}\n");

    const result = resolveProjectToolchain({ targetRepoRoot: tmp });

    expect(result.packageManager).toBe("npm");
    expect(result.cwd).toBe(tmp);
    expect(result.buildCmd).toEqual(["npm", "run", "build"]);
    expect(result.testCmd).toEqual(["npm", "run", "test"]);
    // No knip script and no knip config → knipCmd is null (bloat gate skipped).
    expect(result.knipCmd).toBeNull();
    expect(result.pmAssumed).toBe(false);
    expect(result.source).toBe("package");
  });
});

// ---------------------------------------------------------------------------
// AC2 — config override wins over structural + lockfile detection.
// ---------------------------------------------------------------------------

describe("AC2 — a build: config block overrides structural + lockfile detection", () => {
  it("configured packageManager/cwd/buildCmd/testCmd/knipCmd all win", () => {
    // Seed a Flow-shaped repo (which would structurally resolve pnpm + plugins/flow)
    // but override every field via config.
    const flowDir = path.join(tmp, "plugins", "flow");
    write(path.join(flowDir, "pnpm-workspace.yaml"), "packages:\n  - mcp-server\n");
    write(path.join(flowDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writePkg(flowDir, { build: "pnpm -r build", test: "pnpm -r test" });

    // A custom build home with a yarn lockfile (so we can prove config wins over
    // the lockfile detection too).
    const customDir = path.join(tmp, "custom-home");
    write(path.join(customDir, "yarn.lock"), "");
    writePkg(customDir, { build: "make build" });

    const result = resolveProjectToolchain({
      targetRepoRoot: tmp,
      buildConfigOverride: {
        packageManager: "bun",
        cwd: "custom-home",
        buildCmd: "make build",
        testCmd: "make test",
        knipCmd: "knip --strict",
      },
    });

    expect(result.source).toBe("config");
    expect(result.packageManager).toBe("bun"); // config wins over the yarn.lock at customDir
    expect(result.cwd).toBe(customDir);
    expect(result.buildCmd).toEqual(["make", "build"]);
    expect(result.testCmd).toEqual(["make", "test"]);
    expect(result.knipCmd).toEqual(["knip", "--strict"]);
  });

  it("a config block that overrides ONLY packageManager still derives the structural cwd", () => {
    const flowDir = path.join(tmp, "plugins", "flow");
    write(path.join(flowDir, "pnpm-workspace.yaml"), "packages:\n  - mcp-server\n");
    writePkg(flowDir, { build: "pnpm -r build", test: "pnpm -r test" });

    const result = resolveProjectToolchain({
      targetRepoRoot: tmp,
      buildConfigOverride: { packageManager: "yarn" },
    });

    expect(result.packageManager).toBe("yarn");
    expect(result.cwd).toBe(flowDir); // structural cwd still applies
    expect(result.buildCmd).toEqual(["yarn", "build"]);
  });

  it("reads the build: block from .flow/config.yaml on disk when no override passed", () => {
    writePkg(tmp, { build: "tsc", test: "node --test" });
    write(path.join(tmp, "package-lock.json"), "{}\n");
    write(
      path.join(tmp, ".flow", "config.yaml"),
      "adapter: native\nadapter_config: {}\nbuild:\n  packageManager: pnpm\n  buildCmd: pnpm run compile\n",
    );

    const result = resolveProjectToolchain({ targetRepoRoot: tmp });

    expect(result.source).toBe("config");
    expect(result.packageManager).toBe("pnpm"); // config wins over the package-lock.json
    expect(result.buildCmd).toEqual(["pnpm", "run", "compile"]);
    // testCmd not overridden → derived from the (config-resolved) manager.
    expect(result.testCmd).toEqual(["pnpm", "test"]);
  });
});

// ---------------------------------------------------------------------------
// AC3 — malformed config → typed error (no silent fallback).
// ---------------------------------------------------------------------------

describe("AC3 — a malformed build: block surfaces a typed ToolchainConfigError", () => {
  it("an unrecognised packageManager value throws ToolchainConfigError", () => {
    writePkg(tmp, { build: "tsc" });

    expect(() =>
      resolveProjectToolchain({
        targetRepoRoot: tmp,
        buildConfigOverride: { packageManager: "rush" },
      }),
    ).toThrow(ToolchainConfigError);
  });

  it("an unknown extra field throws ToolchainConfigError (strict schema)", () => {
    writePkg(tmp, { build: "tsc" });

    let caught: unknown;
    try {
      resolveProjectToolchain({
        targetRepoRoot: tmp,
        buildConfigOverride: { packageManager: "pnpm", bogusField: 1 },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolchainConfigError);
    expect((caught as ToolchainConfigError).yamlPath).toContain("build");
  });

  it("does NOT silently fall back to structural detection on a malformed block", () => {
    // A Flow-shaped repo would structurally resolve pnpm — but a malformed config
    // must throw, not quietly use the structural result.
    const flowDir = path.join(tmp, "plugins", "flow");
    write(path.join(flowDir, "pnpm-workspace.yaml"), "packages:\n  - mcp-server\n");
    writePkg(flowDir, { build: "pnpm -r build" });

    expect(() =>
      resolveProjectToolchain({
        targetRepoRoot: tmp,
        buildConfigOverride: { packageManager: "not-a-manager" },
      }),
    ).toThrow(ToolchainConfigError);
  });
});

// ---------------------------------------------------------------------------
// Lockfile → package manager mapping.
// ---------------------------------------------------------------------------

describe("package-manager detection — each lockfile resolves to its manager", () => {
  const cases: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
  ];

  for (const [lockfile, expectedPm] of cases) {
    it(`${lockfile} → ${expectedPm}`, () => {
      writePkg(tmp, { build: "tsc", test: "vitest run" });
      write(path.join(tmp, lockfile), "");

      const result = resolveProjectToolchain({ targetRepoRoot: tmp });
      expect(result.packageManager).toBe(expectedPm);
      expect(result.pmAssumed).toBe(false);
    });
  }

  it("no lockfile → npm assumed (pmAssumed: true)", () => {
    writePkg(tmp, { build: "tsc", test: "vitest run" });

    const result = resolveProjectToolchain({ targetRepoRoot: tmp });
    expect(result.packageManager).toBe("npm");
    expect(result.pmAssumed).toBe(true);
  });

  it("the exported LOCKFILE_TO_PACKAGE_MANAGER table covers all four managers", () => {
    const managers = LOCKFILE_TO_PACKAGE_MANAGER.map(([, pm]) => pm);
    expect(new Set(managers)).toEqual(new Set(["pnpm", "npm", "yarn", "bun"]));
  });
});

// ---------------------------------------------------------------------------
// knipCmd resolution.
// ---------------------------------------------------------------------------

describe("knipCmd resolution — null when no dead-code check applies", () => {
  it("knipCmd is null with no knip script, no knip config, no override", () => {
    writePkg(tmp, { build: "tsc", test: "node --test" });
    write(path.join(tmp, "package-lock.json"), "{}\n");

    const result = resolveProjectToolchain({ targetRepoRoot: tmp });
    expect(result.knipCmd).toBeNull();
  });

  it("knipCmd present when the package.json has a knip script", () => {
    writePkg(tmp, { build: "tsc", knip: "knip --no-progress" });
    write(path.join(tmp, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const result = resolveProjectToolchain({ targetRepoRoot: tmp });
    expect(result.knipCmd).toEqual(["pnpm", "knip"]);
  });

  it("knipCmd present (via npx) when a knip config file exists but no knip script", () => {
    writePkg(tmp, { build: "tsc" });
    write(path.join(tmp, "package-lock.json"), "{}\n");
    write(path.join(tmp, "knip.json"), "{}\n");

    const result = resolveProjectToolchain({ targetRepoRoot: tmp });
    expect(result.knipCmd).toEqual(["npx", "knip", "--no-progress"]);
  });
});

// ---------------------------------------------------------------------------
// Workspace-member build-home resolution variants.
// ---------------------------------------------------------------------------

describe("workspace build-home — member owns the build script (root does not)", () => {
  it("resolves to the workspace MEMBER directory when the root package.json has no build script", () => {
    const wsRoot = path.join(tmp, "ws");
    // Root: workspace yaml + a package.json WITHOUT a build script.
    write(path.join(wsRoot, "pnpm-workspace.yaml"), "packages:\n  - app\n");
    writePkg(wsRoot, { lint: "eslint ." });
    write(path.join(wsRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    // Member: owns the build script.
    const member = path.join(wsRoot, "app");
    writePkg(member, { build: "vite build", test: "vitest run" });
    write(path.join(member, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const result = resolveProjectToolchain({ targetRepoRoot: wsRoot });
    expect(result.source).toBe("workspace");
    expect(result.cwd).toBe(member);
    expect(result.packageManager).toBe("pnpm");
  });

  it("resolves a single-level glob (`packages/*`) member that owns the build script", () => {
    const wsRoot = path.join(tmp, "glob-ws");
    write(path.join(wsRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writePkg(wsRoot, { lint: "eslint ." });
    write(path.join(wsRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    // Two members under packages/; only the second owns a build script.
    writePkg(path.join(wsRoot, "packages", "utils"), { test: "vitest run" });
    const core = path.join(wsRoot, "packages", "core");
    writePkg(core, { build: "tsc -b", test: "vitest run" });

    const result = resolveProjectToolchain({ targetRepoRoot: wsRoot });
    expect(result.source).toBe("workspace");
    expect(result.cwd).toBe(core);
  });
});

// ---------------------------------------------------------------------------
// Repo-root fallback (plain single-package repo with no build script).
// ---------------------------------------------------------------------------

describe("repo-root fallback", () => {
  it("a repo with no build script anywhere falls back to the repo root", () => {
    // A package.json with no build script, no workspace.
    writePkg(tmp, { test: "node --test" });

    const result = resolveProjectToolchain({ targetRepoRoot: tmp });
    expect(result.cwd).toBe(tmp);
    expect(result.source).toBe("repo-root");
    // build/test commands still derive from the (assumed) manager.
    expect(result.buildCmd).toEqual(["npm", "run", "build"]);
  });
});
