/**
 * `resolveProjectToolchain` — Story native:01KVTB3Z.
 *
 * ONE resolver that discovers a target repo's OWN build toolchain — its package
 * manager, the directory that owns the build script (the "build home"), and the
 * build / test / dead-code commands. Consumed by BOTH the dev pre-PR build/test/
 * bloat gates (`run-project-build.ts` via `run-dev-terminal-action.ts`) AND the
 * reviewer's vitest runner (`run-reviewer-session.ts`), so the gate and the
 * reviewer always agree on where and how to build/test a target repo.
 *
 * WHY THIS EXISTS — the dogfood-on-a-clean-worktree hole:
 *   Flow's pre-PR gates and reviewer used to HARDCODE the target as "a pnpm
 *   monorepo rooted at plugins/flow". That assumption is true for the Flow repo
 *   itself, but:
 *     (a) it breaks Flow run against ANY external repo (an npm project with no
 *         plugins/ dir): the build gate runs `pnpm build` at a non-existent
 *         `plugins/flow`, fails before a PR can open, and the dev's only escape
 *         is fabricating a fake plugins/flow/ package — contaminating the target;
 *     (b) even for the Flow repo, the hardcode was DRESSED UP via `.flow/config.
 *         yaml`, which is GITIGNORED. A per-story git worktree (cut clean from a
 *         branch) and a clean checkout do NOT carry `.flow/config.yaml`, so the
 *         dogfood path cannot lean on it. STRUCTURAL detection ALONE must yield
 *         the right answer (pnpm + plugins/flow) for the Flow repo.
 *
 * RESOLUTION ORDER (Story native:01KVTB3Z):
 *   1. CONFIG OVERRIDE (optional escape hatch — NEVER the dogfood mechanism):
 *      if `.flow/config.yaml` has a `build:` block, zod-validate it. Its
 *      packageManager / cwd / buildCmd / testCmd / knipCmd win over BOTH
 *      structural detection and lockfile auto-detection. An unrecognised
 *      packageManager (or other malformed field) raises a TYPED
 *      `ToolchainConfigError` rather than silently falling back.
 *   2. STRUCTURAL build-home detection (no config consulted): locate the dir that
 *      OWNS the build script — prefer a `pnpm-workspace.yaml` member whose
 *      package.json defines a `build` script; else the nearest package.json
 *      (searched from the repo root downward) with a `build` script; else the
 *      repo root (a plain single-package repo). For the Flow repo this lands on
 *      `plugins/flow`; for an external npm repo (root package.json with a build
 *      script, no workspace) it lands on the repo root — unchanged behaviour.
 *   3. PACKAGE-MANAGER detection at the resolved cwd, by lockfile:
 *      pnpm-lock.yaml→pnpm, package-lock.json→npm, yarn.lock→yarn, bun.lockb→bun,
 *      default npm (the assumption is logged via the returned `pmAssumed` flag).
 *
 * The returned `buildCmd` / `testCmd` / `knipCmd` are the FULL argv the caller
 * spawns. Script invocation per manager: `npm run <script>` / `pnpm <script>` /
 * `yarn <script>` / `bun run <script>`; or a full command string verbatim when
 * config provides one. `knipCmd` is `null` when no dead-code check applies (no
 * `build.knipCmd` config, no `knip` script in the resolved package.json, and no
 * knip config in the cwd) — the bloat gate becomes a no-op in that case.
 */

import * as path from "node:path";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ToolchainConfigError } from "../errors.js";

// ---------------------------------------------------------------------------
// Package managers + lockfile constants
// ---------------------------------------------------------------------------

const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/**
 * Lockfile name → package manager. The detection order is fixed so a repo that
 * happens to carry more than one lockfile resolves deterministically (pnpm wins,
 * then npm, then yarn, then bun). Exported so tests and any future caller share
 * the SAME mapping rather than re-deriving it.
 */
export const LOCKFILE_TO_PACKAGE_MANAGER: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
] as const;

/** Knip config filenames (any of these in the cwd means a dead-code check applies). */
const KNIP_CONFIG_FILENAMES = [
  "knip.json",
  "knip.jsonc",
  "knip.ts",
  "knip.js",
  "knip.config.ts",
  "knip.config.js",
] as const;

// ---------------------------------------------------------------------------
// Config `build:` block schema (escape hatch)
// ---------------------------------------------------------------------------

/**
 * Zod schema for the optional `.flow/config.yaml` `build:` block. Every field is
 * optional — a caller can override just the package manager, or just the cwd, etc.
 * `packageManager` is constrained to the recognised set; an unrecognised value
 * produces a typed `ToolchainConfigError` (AC3) rather than a silent fallback.
 *
 * `cwd` is repo-relative (resolved against the target repo root by the resolver).
 * `buildCmd` / `testCmd` / `knipCmd` are full command strings spawned verbatim.
 */
const BuildConfigSchema = z
  .object({
    packageManager: z.enum(PACKAGE_MANAGERS).optional(),
    cwd: z.string().min(1).optional(),
    buildCmd: z.string().min(1).optional(),
    testCmd: z.string().min(1).optional(),
    knipCmd: z.string().min(1).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ResolvedToolchain {
  /** The package manager that drives the resolved cwd. */
  packageManager: PackageManager;
  /** Absolute path to the build home — the directory the build/test/knip run in. */
  cwd: string;
  /** Full argv for the build command (e.g. `["pnpm", "build"]` or a verbatim split). */
  buildCmd: string[];
  /** Full argv for the test command (e.g. `["pnpm", "test"]`). */
  testCmd: string[];
  /**
   * Full argv for the dead-code (knip) command, or `null` when no dead-code
   * check applies (no config knipCmd, no `knip` script, no knip config file).
   * A null `knipCmd` makes the dev pre-PR bloat gate a no-op.
   */
  knipCmd: string[] | null;
  /**
   * `true` when the package manager was ASSUMED (no lockfile present at the
   * resolved cwd and no config override), so the caller can log the assumption.
   * `false` when the manager came from a lockfile or an explicit config override.
   */
  pmAssumed: boolean;
  /**
   * How the toolchain was resolved, for diagnostics/tests:
   *  - "config"     — a `build:` block override supplied the values
   *  - "workspace"  — a pnpm-workspace member owning a build script
   *  - "package"    — a package.json (root or downward) owning a build script
   *  - "repo-root"  — fell back to the repo root (plain single-package / no build script)
   */
  source: "config" | "workspace" | "package" | "repo-root";
}

export interface ResolveProjectToolchainOptions {
  /** Absolute path to the target repo root. */
  targetRepoRoot: string;
  /**
   * Pre-loaded `build:` block. Test seam AND the production override channel —
   * normally the resolver reads `.flow/config.yaml` itself, but a caller that has
   * already parsed config may pass the raw block here. When provided, it is
   * zod-validated exactly as a file-loaded block would be.
   *
   * NOTE: this is the ESCAPE HATCH. The dogfood path passes NO build config (it
   * cannot — the file is gitignored), so structural detection alone must work.
   */
  buildConfigOverride?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PackageJsonShape {
  scripts?: Record<string, unknown>;
}

/** Read + parse a package.json; returns null on any read/parse error. */
function readPackageJson(dir: string): PackageJsonShape | null {
  try {
    const raw = readFileSync(path.join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as PackageJsonShape;
    return null;
  } catch {
    return null;
  }
}

/** Does the package.json in `dir` define a script named `script`? */
function hasScript(dir: string, script: string): boolean {
  const pkg = readPackageJson(dir);
  const value = pkg?.scripts?.[script];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Build the per-manager argv that runs a named package.json script.
 *   pnpm → `pnpm <script>` | npm → `npm run <script>`
 *   yarn → `yarn <script>` | bun → `bun run <script>`
 */
function scriptInvocation(pm: PackageManager, script: string): string[] {
  switch (pm) {
    case "npm":
      return ["npm", "run", script];
    case "bun":
      return ["bun", "run", script];
    case "pnpm":
      return ["pnpm", script];
    case "yarn":
      return ["yarn", script];
  }
}

/**
 * Split a verbatim command string (from a config override) into argv. A minimal
 * whitespace split — config commands are simple `<bin> <args...>` strings, not
 * shell pipelines. Throws via the caller's typed error if the string is empty.
 */
function splitCommand(cmd: string): string[] {
  return cmd.trim().split(/\s+/);
}

/**
 * Detect the package manager at `cwd` from its lockfile. Returns the manager and
 * whether it was assumed (no lockfile → npm, assumed).
 */
function detectPackageManagerAt(cwd: string): { pm: PackageManager; assumed: boolean } {
  for (const [lockfile, pm] of LOCKFILE_TO_PACKAGE_MANAGER) {
    if (existsSync(path.join(cwd, lockfile))) {
      return { pm, assumed: false };
    }
  }
  // No lockfile — default to npm and flag the assumption for the caller to log.
  return { pm: "npm", assumed: true };
}

/** Does `cwd` carry a knip config file? */
function hasKnipConfig(cwd: string): boolean {
  return KNIP_CONFIG_FILENAMES.some((name) => existsSync(path.join(cwd, name)));
}

/**
 * Parse a pnpm-workspace.yaml at `workspaceDir` and return the first member dir
 * (resolved) whose package.json defines a `build` script. Single-level globs
 * (`packages/*`) and direct members (`mcp-server`) are supported; deep globs are
 * skipped. Returns null when no such member is found.
 */
function findWorkspaceMemberWithBuild(workspaceDir: string): string | null {
  let packages: unknown;
  try {
    const raw = readFileSync(path.join(workspaceDir, "pnpm-workspace.yaml"), "utf8");
    const parsed = parseYaml(raw) as { packages?: unknown };
    packages = parsed?.packages;
  } catch {
    return null;
  }
  if (!Array.isArray(packages)) return null;

  const candidates: string[] = [];
  for (const pattern of packages) {
    if (typeof pattern !== "string") continue;
    const segments = pattern.split("/");
    const globIdx = segments.findIndex((s) => s === "*" || s === "**");
    if (globIdx === -1) {
      candidates.push(path.join(workspaceDir, pattern));
    } else if (segments[globIdx] === "*") {
      // Single-level glob: enumerate the parent directory's children.
      const parentDir = path.join(workspaceDir, ...segments.slice(0, globIdx));
      try {
        for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
          if (entry.isDirectory()) candidates.push(path.join(parentDir, entry.name));
        }
      } catch {
        // parent not readable — skip this pattern.
      }
    }
    // Deep globs (`**`) are not supported; skip.
  }

  for (const member of candidates) {
    if (hasScript(member, "build")) return member;
  }
  return null;
}

/**
 * Bounded downward search from `root` for the nearest package.json that defines a
 * `build` script. Breadth-first by depth so the shallowest match wins. Skips
 * `node_modules` and `.git`. Returns the directory, or null.
 */
function findNearestPackageWithBuild(root: string, maxDepth: number): string | null {
  // BFS so shallower matches are preferred.
  let frontier: string[] = [root];
  for (let depth = 0; depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (hasScript(dir, "build")) return dir;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (name === "node_modules" || name === ".git") continue;
        next.push(path.join(dir, name));
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Locate a pnpm-workspace.yaml in the subtree rooted at `root` (bounded by
 * `maxDepth`). Returns the directory holding it, or null. Prefers the shallowest.
 * Skips node_modules and .git.
 */
function findWorkspaceYamlDir(root: string, maxDepth: number): string | null {
  let frontier: string[] = [root];
  for (let depth = 0; depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (name === "node_modules" || name === ".git") continue;
        next.push(path.join(dir, name));
      }
    }
    frontier = next;
  }
  return null;
}

const STRUCTURAL_SEARCH_MAX_DEPTH = 4;

/**
 * Load the `build:` block from `<targetRepoRoot>/.flow/config.yaml` if present.
 * Returns the raw (unvalidated) block, or `undefined` when there is no config
 * file or no `build:` key. Read errors are swallowed (a malformed YAML file is
 * the workspace resolver's concern; here a missing/unreadable file simply means
 * "no override").
 */
function loadBuildConfigBlock(targetRepoRoot: string): unknown {
  const configPath = path.join(targetRepoRoot, ".flow", "config.yaml");
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw) as { build?: unknown } | null | undefined;
    if (parsed && typeof parsed === "object" && "build" in parsed) {
      return (parsed as { build?: unknown }).build;
    }
  } catch {
    // No config file / unreadable — no override.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the target repo's build toolchain (see file header for the full
 * contract and the resolution order).
 */
export function resolveProjectToolchain(
  opts: ResolveProjectToolchainOptions,
): ResolvedToolchain {
  const targetRepoRoot = path.resolve(opts.targetRepoRoot);
  const configPath = path.join(targetRepoRoot, ".flow", "config.yaml");

  // -------------------------------------------------------------------------
  // (1) CONFIG OVERRIDE — escape hatch only. NEVER the dogfood mechanism.
  // -------------------------------------------------------------------------
  const rawBuildBlock =
    opts.buildConfigOverride !== undefined
      ? opts.buildConfigOverride
      : loadBuildConfigBlock(targetRepoRoot);

  if (rawBuildBlock !== undefined && rawBuildBlock !== null) {
    const parsed = BuildConfigSchema.safeParse(rawBuildBlock);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new ToolchainConfigError({
        configPath,
        yamlPath: issue.path.length === 0 ? "build" : `build.${issue.path.join(".")}`,
        detail: issue.message,
      });
    }
    const cfg = parsed.data;

    // Resolve the cwd: configured (repo-relative) or, when absent, still derive
    // the structural build-home so a config that only overrides packageManager
    // (or commands) lands in the right directory.
    const structural = detectStructuralBuildHome(targetRepoRoot);
    const cwd = cfg.cwd
      ? path.resolve(targetRepoRoot, cfg.cwd)
      : structural.cwd;

    // Package manager: configured wins; else detect at the resolved cwd.
    const pmDetection = detectPackageManagerAt(cwd);
    const pm = cfg.packageManager ?? pmDetection.pm;
    const pmAssumed = cfg.packageManager ? false : pmDetection.assumed;

    const buildCmd = cfg.buildCmd ? splitCommand(cfg.buildCmd) : scriptInvocation(pm, "build");
    const testCmd = cfg.testCmd ? splitCommand(cfg.testCmd) : scriptInvocation(pm, "test");

    // knipCmd: explicit config wins; else fall back to structural knip detection
    // at the resolved cwd (a `knip` script or a knip config file present).
    let knipCmd: string[] | null;
    if (cfg.knipCmd) {
      knipCmd = splitCommand(cfg.knipCmd);
    } else {
      knipCmd = resolveKnipCmd(cwd, pm);
    }

    return { packageManager: pm, cwd, buildCmd, testCmd, knipCmd, pmAssumed, source: "config" };
  }

  // -------------------------------------------------------------------------
  // (2) STRUCTURAL build-home detection (no config consulted).
  // -------------------------------------------------------------------------
  const structural = detectStructuralBuildHome(targetRepoRoot);
  const cwd = structural.cwd;

  // -------------------------------------------------------------------------
  // (3) Package-manager detection at the resolved cwd.
  // -------------------------------------------------------------------------
  const { pm, assumed } = detectPackageManagerAt(cwd);

  const buildCmd = scriptInvocation(pm, "build");
  const testCmd = scriptInvocation(pm, "test");
  const knipCmd = resolveKnipCmd(cwd, pm);

  return {
    packageManager: pm,
    cwd,
    buildCmd,
    testCmd,
    knipCmd,
    pmAssumed: assumed,
    source: structural.source,
  };
}

/**
 * Structural build-home detection (resolution-order step 2), factored out so the
 * config-override path can reuse it for cwd derivation when a `build:` block
 * overrides only the package manager / commands.
 */
function detectStructuralBuildHome(
  targetRepoRoot: string,
): { cwd: string; source: "workspace" | "package" | "repo-root" } {
  // (2a) pnpm-workspace member owning a build script.
  const workspaceDir = findWorkspaceYamlDir(targetRepoRoot, STRUCTURAL_SEARCH_MAX_DEPTH);
  if (workspaceDir !== null) {
    const member = findWorkspaceMemberWithBuild(workspaceDir);
    if (member !== null) {
      // The build HOME is the directory whose package.json owns the build script.
      // For the Flow repo that is `plugins/flow` (its package.json's build script
      // fans out via `pnpm -r build`), which is the workspaceDir itself — so when
      // the workspace ROOT package.json owns the build script, prefer the root.
      if (hasScript(workspaceDir, "build")) {
        return { cwd: workspaceDir, source: "workspace" };
      }
      return { cwd: member, source: "workspace" };
    }
    // Workspace yaml present but no member (or root) owns a build script — if the
    // workspace root package.json itself has a build script, use it.
    if (hasScript(workspaceDir, "build")) {
      return { cwd: workspaceDir, source: "workspace" };
    }
  }

  // (2b) Nearest package.json (root downward) with a build script.
  const pkgDir = findNearestPackageWithBuild(targetRepoRoot, STRUCTURAL_SEARCH_MAX_DEPTH);
  if (pkgDir !== null) {
    return { cwd: pkgDir, source: "package" };
  }

  // (2c) Fall back to the repo root (a plain single-package repo, or no build script).
  return { cwd: targetRepoRoot, source: "repo-root" };
}

/**
 * Resolve the dead-code (knip) command for a resolved cwd + package manager, or
 * `null` when no dead-code check applies. A check applies when the cwd's
 * package.json defines a `knip` script (run via the manager) OR a knip config
 * file is present (run via `knip --no-progress` through the manager's exec).
 */
function resolveKnipCmd(cwd: string, pm: PackageManager): string[] | null {
  if (hasScript(cwd, "knip")) {
    return scriptInvocation(pm, "knip");
  }
  if (hasKnipConfig(cwd)) {
    // No script, but a knip config exists — invoke knip directly via the manager's
    // package runner so the locally-installed knip binary resolves.
    switch (pm) {
      case "pnpm":
        return ["pnpm", "knip", "--no-progress"];
      case "yarn":
        return ["yarn", "knip", "--no-progress"];
      case "bun":
        return ["bun", "run", "knip", "--no-progress"];
      case "npm":
        return ["npx", "knip", "--no-progress"];
    }
  }
  return null;
}
