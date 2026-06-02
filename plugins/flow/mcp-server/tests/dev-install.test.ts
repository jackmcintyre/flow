/**
 * Story 1.11 — Dev-install loop: make plugin changes visible without a daemon restart.
 * AC6 (content-anchor) + AC7 (integration scenario).
 *
 * See plugins/flow/docs/dev-loop.md for the operator-facing documentation of the
 * script this harness validates.
 *
 * AC6 — content-anchor test (hermetic file-existence + substring assertions):
 *   1. `plugins/flow/scripts/dev-install.sh` is executable.
 *   2. The script source contains the substring `$HOME/.claude/plugins/cache/crew/crew`
 *      proving it targets the right cache location.
 *   3. `plugins/flow/docs/dev-loop.md` exists and contains the substring
 *      `pnpm --dir plugins/flow dev:install` proving docs and reality stay in sync.
 *
 * AC7 — integration scenario (hermetic, temp dirs, simulated git repo):
 *   1. First run populates the cache (symlink created, resolves to source).
 *   2. Second run is a no-op (mtime of symlink unchanged).
 *   3. Edit propagation — changes in the source are immediately visible via the cache
 *      (because the cache IS a symlink to the source, not a copy).
 *   4. Error paths: exit 2 (no git repo / missing plugin.json), exit 3 (missing dist).
 *   5. Happy-path replacement: a real dir at $target is rm -rf'd and replaced with symlink.
 *   6. --kill-daemon flag: terminates a fake daemon process matching the pattern.
 *
 * The actual Claude Code daemon interaction is out of scope — verified by the story's
 * user-surface smoke gate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  statSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  realpathSync,
  existsSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync, spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/ -> mcp-server -> crew -> plugins -> repo root
const REPO_ROOT = resolve(HERE, "../../../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "plugins/flow/scripts/dev-install.sh");
const DEV_LOOP_DOC = resolve(REPO_ROOT, "plugins/flow/docs/dev-loop.md");

// ── AC6: content-anchor tests ────────────────────────────────────────────────

describe("dev-install.sh content-anchor (Story 1.11 AC6)", () => {
  it("script file exists and is executable", () => {
    const mode = statSync(SCRIPT_PATH).mode;
    // 0o111 = owner+group+other execute bits
    expect(mode & 0o111).toBeTruthy();
  });

  it("script contains the cache path substring targeting the right location", () => {
    const content = readFileSync(SCRIPT_PATH, "utf8");
    // The script uses $HOME/.claude/plugins/cache/crew/crew in its printed output
    // and variable assignments. This substring proves it targets the correct cache.
    expect(content).toContain("$HOME/.claude/plugins/cache/crew/crew");
  });

  it("dev-loop.md exists and contains the canonical pnpm dev:install command", () => {
    expect(existsSync(DEV_LOOP_DOC)).toBe(true);
    const content = readFileSync(DEV_LOOP_DOC, "utf8");
    // The canonical operator-typed command (Task 3.3 wired form).
    expect(content).toContain("pnpm --dir plugins/flow dev:install");
  });
});

// ── AC7: integration scenario ────────────────────────────────────────────────

/**
 * Creates a minimal git repo simulating `<worktree-root>/plugins/flow/`.
 * Returns { repoRoot, pluginsCrewDir, cacheParent }.
 */
function makeTempEnvironment(): {
  repoRoot: string;
  pluginsCrewDir: string;
  cacheParent: string;
  cleanup: () => Promise<void>;
} {
  const base = mkdtempSync(resolve(tmpdir(), "flow-dev-install-"));
  const repoRoot = resolve(base, "repo");
  const pluginsCrewDir = resolve(repoRoot, "plugins", "flow");
  const cacheParent = resolve(base, "home");

  // Create the source plugin tree.
  mkdirSync(resolve(pluginsCrewDir, ".claude-plugin"), { recursive: true });
  mkdirSync(resolve(pluginsCrewDir, "mcp-server", "dist"), { recursive: true });
  mkdirSync(resolve(pluginsCrewDir, "skills", "sentinel"), { recursive: true });

  writeFileSync(
    resolve(pluginsCrewDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "flow", version: "0.0.0-test", description: "test" }),
  );
  writeFileSync(
    resolve(pluginsCrewDir, "mcp-server", "dist", "index.js"),
    "// test stub\n",
  );
  writeFileSync(
    resolve(pluginsCrewDir, "skills", "sentinel", "SKILL.md"),
    "# Sentinel skill\nOriginal content.\n",
  );

  // Initialise as a git repo so `git rev-parse --show-toplevel` works.
  execFileSync("git", ["init", repoRoot], { stdio: "pipe" });
  execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@test.com"], {
    stdio: "pipe",
  });
  execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test"], {
    stdio: "pipe",
  });
  execFileSync("git", ["-C", repoRoot, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", repoRoot, "commit", "-m", "init"], { stdio: "pipe" });

  // Create a HOME-like dir that the script will use for cache resolution.
  mkdirSync(cacheParent, { recursive: true });

  return {
    repoRoot,
    pluginsCrewDir,
    cacheParent,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

function runScript(
  repoRoot: string,
  homeDir: string,
  extraArgs: string[] = [],
): ReturnType<typeof spawnSync> {
  return spawnSync("sh", [SCRIPT_PATH, ...extraArgs], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      // Ensure git is usable in the temp dir.
      GIT_CONFIG_NOSYSTEM: "1",
    },
    encoding: "utf8",
  });
}

describe("dev-install.sh integration scenario (Story 1.11 AC7)", () => {
  let env: ReturnType<typeof makeTempEnvironment>;

  beforeEach(() => {
    env = makeTempEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("AC7-1: first run creates a symlink from cache to the source dir", () => {
    const result = runScript(env.repoRoot, env.cacheParent);
    expect(result.status).toBe(0);

    const expectedCache = resolve(
      env.cacheParent,
      ".claude",
      "plugins",
      "cache",
      "flow",
      "flow",
      "0.0.0-test",
    );
    // The cache entry must be a symlink.
    const lstat = lstatSync(expectedCache);
    expect(lstat.isSymbolicLink()).toBe(true);

    // The symlink must resolve to the source plugins/flow dir.
    // Use realpathSync on both sides to handle macOS /var → /private/var aliasing.
    const resolved = realpathSync(expectedCache);
    const expectedReal = realpathSync(env.pluginsCrewDir);
    expect(resolved).toBe(expectedReal);

    // Success line must contain the cache path literal.
    expect(result.stdout).toContain(".claude/plugins/cache/flow/flow");
  });

  it("AC7-2: second run is a no-op (symlink mtime unchanged)", () => {
    // First run.
    runScript(env.repoRoot, env.cacheParent);

    const expectedCache = resolve(
      env.cacheParent,
      ".claude",
      "plugins",
      "cache",
      "flow",
      "flow",
      "0.0.0-test",
    );
    const mtimeBefore = lstatSync(expectedCache).mtimeMs;

    // Second run — no source changes.
    const result2 = runScript(env.repoRoot, env.cacheParent);
    expect(result2.status).toBe(0);
    expect(result2.stdout).toContain("already up to date");

    const mtimeAfter = lstatSync(expectedCache).mtimeMs;
    // The symlink itself was NOT recreated (mtime unchanged).
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("AC7-3: edit propagation — changes in source are immediately visible via cache (symlink)", () => {
    // First run.
    runScript(env.repoRoot, env.cacheParent);

    const expectedCache = resolve(
      env.cacheParent,
      ".claude",
      "plugins",
      "cache",
      "flow",
      "flow",
      "0.0.0-test",
    );

    // Modify the sentinel skill in the source.
    const skillPath = resolve(env.pluginsCrewDir, "skills", "sentinel", "SKILL.md");
    writeFileSync(skillPath, "# Sentinel skill\nEdited content — UPDATED.\n");

    // Because cache is a symlink, the change is immediately visible without re-running the script.
    const cacheSkillPath = resolve(expectedCache, "skills", "sentinel", "SKILL.md");
    const content = readFileSync(cacheSkillPath, "utf8");
    expect(content).toContain("UPDATED");

    // Running the script again still reports no-op (symlink already correct).
    const result2 = runScript(env.repoRoot, env.cacheParent);
    expect(result2.status).toBe(0);
  });

  it("AC7 error path: exits 3 when dist/index.js is missing", () => {
    rmSync(resolve(env.pluginsCrewDir, "mcp-server", "dist", "index.js"));

    const result = runScript(env.repoRoot, env.cacheParent);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("dist/index.js not found");
  });

  it("error path exit 2: exits 2 when run outside a git repo", () => {
    // Create a plain directory with a valid plugin tree but no git repo.
    const base = mkdtempSync(resolve(tmpdir(), "flow-no-git-"));
    const pluginsCrewDir = resolve(base, "plugins", "flow");
    mkdirSync(resolve(pluginsCrewDir, ".claude-plugin"), { recursive: true });
    mkdirSync(resolve(pluginsCrewDir, "mcp-server", "dist"), { recursive: true });
    writeFileSync(
      resolve(pluginsCrewDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "flow", version: "0.0.0-test" }),
    );
    writeFileSync(
      resolve(pluginsCrewDir, "mcp-server", "dist", "index.js"),
      "// stub\n",
    );

    const result = spawnSync("sh", [SCRIPT_PATH], {
      cwd: base,
      env: { ...process.env, HOME: env.cacheParent, GIT_CONFIG_NOSYSTEM: "1" },
      encoding: "utf8",
    });

    // Clean up the plain dir.
    rmSync(base, { recursive: true, force: true });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("preflight");
  });

  it("error path exit 2: exits 2 when plugin.json is missing", () => {
    // Remove the plugin.json from the valid git repo.
    rmSync(resolve(env.pluginsCrewDir, ".claude-plugin", "plugin.json"));

    const result = runScript(env.repoRoot, env.cacheParent);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("preflight");
  });

  it("happy-path replacement: replaces a real dir at $target with a symlink", () => {
    // Simulate a previous /plugin install — create a real directory at the cache path.
    const cacheVersionDir = resolve(
      env.cacheParent,
      ".claude",
      "plugins",
      "cache",
      "flow",
      "flow",
      "0.0.0-test",
    );
    mkdirSync(resolve(cacheVersionDir, "some-subdir"), { recursive: true });
    writeFileSync(resolve(cacheVersionDir, "old-file.txt"), "old content\n");

    // Confirm it is a real directory (not a symlink).
    expect(lstatSync(cacheVersionDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(cacheVersionDir).isDirectory()).toBe(true);

    // Run dev:install — must rm -rf the real dir and replace with symlink.
    const result = runScript(env.repoRoot, env.cacheParent);
    expect(result.status).toBe(0);

    // End state: the path is now a symlink.
    const lstat = lstatSync(cacheVersionDir);
    expect(lstat.isSymbolicLink()).toBe(true);

    // And it resolves to the source tree.
    const resolved = realpathSync(cacheVersionDir);
    const expectedReal = realpathSync(env.pluginsCrewDir);
    expect(resolved).toBe(expectedReal);

    // The old file is gone (replaced, not overlaid).
    expect(existsSync(resolve(cacheVersionDir, "old-file.txt"))).toBe(false);
  });

  it("--kill-daemon: kills a fake daemon process matching the pattern", async () => {
    // Spawn a fake "daemon" whose argv matches the pkill pattern BEFORE running
    // the script. The script reaches the kill step on the first (fresh-install) run.
    // We append the sentinel path as an extra arg so pkill -f matches the string
    // "node .*plugins/flow/mcp-server/dist/index.js" anywhere in the command line.
    const fakeDaemon = spawn(
      process.execPath,
      ["-e", "setTimeout(()=>{},60000)", "plugins/flow/mcp-server/dist/index.js"],
      { detached: false, stdio: "ignore" },
    );

    // Give the process time to appear in the process table.
    await new Promise((r) => setTimeout(r, 200));

    // Confirm it is alive.
    let alive = true;
    try {
      process.kill(fakeDaemon.pid!, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);

    // Run dev:install --kill-daemon on a fresh env (no prior install).
    // The script creates the symlink then reaches the kill step.
    const result = runScript(env.repoRoot, env.cacheParent, ["--kill-daemon"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("killed");

    // Give pkill a moment to deliver the signal.
    await new Promise((r) => setTimeout(r, 200));

    // Process should now be dead.
    let stillAlive = false;
    try {
      process.kill(fakeDaemon.pid!, 0);
      stillAlive = true;
    } catch {
      // Expected — process is gone.
    }
    expect(stillAlive).toBe(false);
  });

  it("--kill-daemon idempotent path: kills daemon even when symlink is already correct (issue #1 regression)", async () => {
    // Seed the cache by running dev:install once (no --kill-daemon).
    const firstResult = runScript(env.repoRoot, env.cacheParent);
    expect(firstResult.status).toBe(0);
    expect(firstResult.stdout).not.toContain("already up to date");

    // Verify the symlink is in place.
    const expectedCache = resolve(
      env.cacheParent,
      ".claude",
      "plugins",
      "cache",
      "flow",
      "flow",
      "0.0.0-test",
    );
    expect(lstatSync(expectedCache).isSymbolicLink()).toBe(true);

    // Spawn a fake daemon that the second (idempotent) run should kill.
    const fakeDaemon = spawn(
      process.execPath,
      ["-e", "setTimeout(()=>{},60000)", "plugins/flow/mcp-server/dist/index.js"],
      { detached: false, stdio: "ignore" },
    );

    await new Promise((r) => setTimeout(r, 200));

    let alive = true;
    try {
      process.kill(fakeDaemon.pid!, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);

    // Second run — symlink already points at source, so this is the idempotent
    // fast-path. --kill-daemon must still be honoured.
    const result = runScript(env.repoRoot, env.cacheParent, ["--kill-daemon"]);
    expect(result.status).toBe(0);
    // Must report "already up to date" (idempotent path taken).
    expect(result.stdout).toContain("already up to date");
    // Must also report that the daemon was killed.
    expect(result.stdout).toContain("killed");

    await new Promise((r) => setTimeout(r, 200));

    // The fake daemon process must be dead.
    let stillAlive = false;
    try {
      process.kill(fakeDaemon.pid!, 0);
      stillAlive = true;
    } catch {
      // Expected — process is gone.
    }
    expect(stillAlive).toBe(false);
  });
});
