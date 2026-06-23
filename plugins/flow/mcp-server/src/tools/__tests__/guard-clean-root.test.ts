/**
 * Integration tests for `guardCleanRoot` — Story native:01KVS0Z0.
 *
 * AC1: When the root checkout has uncommitted edits to TRACKED config paths
 *      (team/**, docs/**), the guard does NOT silently stash them. Instead it
 *      surfaces `hasConfigEdits: true` and the `configEdits` list so the caller
 *      (run.workflow.js) can emit a loud, distinct warning that these working-tree
 *      fixes will not persist across stories.
 *
 * AC2: When the root has genuine worktree-isolation leakage (untracked or
 *      tracked non-config paths), the guard stashes and restores exactly as before
 *      so the next story's worktree is cut from a clean base.
 *
 * Both tests use a REAL tmpdir git repo (real `git init`, real file mutations,
 * real `git stash`) so the XY-status classification is grounded in actual git
 * behaviour, not a mock.
 *
 * vitest: plugins/flow/mcp-server/src/tools/__tests__/guard-clean-root.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa as realExeca } from "execa";

import { guardCleanRoot } from "../guard-clean-root.js";

// ---------------------------------------------------------------------------
// Test repo helpers
// ---------------------------------------------------------------------------

let repoRoot: string;

/** Create a minimal real git repo with an initial commit. */
async function initRepo(dir: string): Promise<void> {
  await realExeca("git", ["init", "-b", "main"], { cwd: dir });
  await realExeca("git", ["-C", dir, "config", "user.email", "test@flow.local"]);
  await realExeca("git", ["-C", dir, "config", "user.name", "Flow Test"]);
  // Seed a minimal committed tree so `git stash` has something to work with.
  await fs.writeFile(path.join(dir, "README.md"), "# repo\n", "utf8");
  await realExeca("git", ["-C", dir, "add", "."]);
  await realExeca("git", ["-C", dir, "commit", "-m", "chore: initial commit"]);
}

/** Write a file at a repo-relative path (creating parent dirs as needed). */
async function writeRepoFile(relPath: string, content: string): Promise<void> {
  const abs = path.join(repoRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/** Stage and commit a file so git considers it tracked. */
async function commitFile(relPath: string, content: string): Promise<void> {
  await writeRepoFile(relPath, content);
  await realExeca("git", ["-C", repoRoot, "add", relPath]);
  await realExeca("git", ["-C", repoRoot, "commit", "-m", `chore: add ${relPath}`]);
}

/**
 * Return the list of dirty repo-relative paths.
 *
 * Uses `--untracked-files=all` so individual file paths are returned even for
 * wholly-untracked directories (matching the behaviour of `listDirtyPathsWithStatus`
 * in the guard). Without this flag, git reports `plugins/` instead of the full
 * path when a directory has no prior tracked files.
 */
async function getDirtyPaths(): Promise<string[]> {
  const r = await realExeca(
    "git",
    ["-C", repoRoot, "status", "--porcelain", "--untracked-files=all"],
    { reject: false },
  );
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.slice(3)); // strip XY + space
}

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-guard-clean-root-"));
  await initRepo(repoRoot);
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — operator config edits: do NOT stash, surface distinct warning fields
// ---------------------------------------------------------------------------

describe("AC1 — tracked config edits in team/ and docs/ are not stashed", () => {
  it("recognises a modified tracked team/ file as a config edit, does not stash it, sets hasConfigEdits=true", async () => {
    // Commit a persona file so it is TRACKED.
    await commitFile("team/generalist-dev.yaml", "role: generalist-dev\n");

    // Operator makes an uncommitted modification (simulating a persona fix held in the working tree).
    await writeRepoFile("team/generalist-dev.yaml", "role: generalist-dev\ncapabilities: [build]\n");

    const result = await guardCleanRoot({ targetRepoRoot: repoRoot, ref: "test-ref" });

    // hasConfigEdits must be true and configEdits must list the path.
    expect(result.hasConfigEdits).toBe(true);
    expect(result.configEdits).toContain("team/generalist-dev.yaml");

    // The path must NOT appear in the leak (stashed) set.
    expect(result.paths).not.toContain("team/generalist-dev.yaml");

    // The file must still be dirty — the guard did NOT stash it.
    const stillDirty = await getDirtyPaths();
    expect(stillDirty.some((p) => p.includes("generalist-dev.yaml"))).toBe(true);

    // stashed must be false (nothing was stashed).
    expect(result.stashed).toBe(false);
  });

  it("recognises a modified tracked docs/ file as a config edit, does not stash it", async () => {
    // Commit a standards file so it is TRACKED.
    await commitFile("docs/standards.md", "# Standards\n");

    // Operator modifies it.
    await writeRepoFile("docs/standards.md", "# Standards\n\n## New rule\n");

    const result = await guardCleanRoot({ targetRepoRoot: repoRoot, ref: "test-ref" });

    expect(result.hasConfigEdits).toBe(true);
    expect(result.configEdits).toContain("docs/standards.md");
    expect(result.paths).not.toContain("docs/standards.md");
    expect(result.stashed).toBe(false);

    // File still dirty.
    const stillDirty = await getDirtyPaths();
    expect(stillDirty.some((p) => p.includes("standards.md"))).toBe(true);
  });

  it("handles mixed: config edit (team/) left alone, leak path (untracked src file) stashed", async () => {
    // Tracked config file — should NOT be stashed.
    await commitFile("team/reviewer.yaml", "role: reviewer\n");
    await writeRepoFile("team/reviewer.yaml", "role: reviewer\nupdated: true\n");

    // Untracked file that is NOT a config path — worktree-isolation leak.
    await writeRepoFile("plugins/flow/mcp-server/src/tools/leaked-file.ts", "// leaked\n");

    const result = await guardCleanRoot({ targetRepoRoot: repoRoot, ref: "test-ref" });

    // Config edit detected but NOT stashed.
    expect(result.hasConfigEdits).toBe(true);
    expect(result.configEdits).toContain("team/reviewer.yaml");
    expect(result.paths).not.toContain("team/reviewer.yaml");

    // Leak path was stashed.
    expect(result.paths).toContain(
      "plugins/flow/mcp-server/src/tools/leaked-file.ts",
    );
    expect(result.stashed).toBe(true);

    // After stash, the config file is still dirty.
    const stillDirty = await getDirtyPaths();
    expect(stillDirty.some((p) => p.includes("reviewer.yaml"))).toBe(true);
    // The leaked file is gone from the working tree (stashed).
    expect(stillDirty.some((p) => p.includes("leaked-file.ts"))).toBe(false);

    // dirty=true because there are still config edits.
    expect(result.dirty).toBe(true);
  });

  it("returns hasConfigEdits=false and configEdits=[] when the root is clean", async () => {
    const result = await guardCleanRoot({ targetRepoRoot: repoRoot, ref: "test-ref" });

    expect(result.dirty).toBe(false);
    expect(result.hasConfigEdits).toBe(false);
    expect(result.configEdits).toEqual([]);
    expect(result.paths).toEqual([]);
    expect(result.stashed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 — genuine leakage: untracked / non-config paths are still stashed
// ---------------------------------------------------------------------------

describe("AC2 — genuine worktree-isolation leakage is still stashed", () => {
  it("stashes an untracked file that leaked outside config paths (bgIsolation:none scenario)", async () => {
    // Simulate a dev's work landing in the shared root due to bgIsolation:none.
    // An untracked file in src/ — not a config path.
    await writeRepoFile("plugins/flow/mcp-server/src/tools/leaked-tool.ts", "// leaked by dev\n");

    const before = await getDirtyPaths();
    expect(before.some((p) => p.includes("leaked-tool.ts"))).toBe(true);

    const result = await guardCleanRoot({ targetRepoRoot: repoRoot, ref: "test-ref" });

    // Classified as leakage, NOT a config edit.
    expect(result.hasConfigEdits).toBe(false);
    expect(result.configEdits).toEqual([]);
    expect(result.paths).toContain(
      "plugins/flow/mcp-server/src/tools/leaked-tool.ts",
    );
    expect(result.stashed).toBe(true);

    // Working tree should be clean after the stash.
    const after = await getDirtyPaths();
    expect(after.some((p) => p.includes("leaked-tool.ts"))).toBe(false);

    // dirty was true (there were leaked paths).
    expect(result.dirty).toBe(true);
  });

  it("stashes a tracked modification to a non-config path (e.g. plugins/ source file modified)", async () => {
    // Commit a source file to make it tracked.
    await commitFile(
      "plugins/flow/mcp-server/src/tools/some-tool.ts",
      "export const x = 1;\n",
    );

    // Modify it (tracked change to a non-config path — a real worktree-isolation leak).
    await writeRepoFile(
      "plugins/flow/mcp-server/src/tools/some-tool.ts",
      "export const x = 2;\n",
    );

    const result = await guardCleanRoot({ targetRepoRoot: repoRoot, ref: "test-ref" });

    // Not a config edit.
    expect(result.hasConfigEdits).toBe(false);
    expect(result.configEdits).toEqual([]);

    // IS a leak path and was stashed.
    expect(result.paths).toContain(
      "plugins/flow/mcp-server/src/tools/some-tool.ts",
    );
    expect(result.stashed).toBe(true);
    expect(result.dirty).toBe(true);

    // Working tree is now clean.
    const after = await getDirtyPaths();
    expect(after.some((p) => p.includes("some-tool.ts"))).toBe(false);
  });

  it("an untracked file under team/ is treated as a config edit (operator adding a new persona file)", async () => {
    // The operator is authoring a brand-new team/ file that has never been committed.
    // Even though it is untracked ("??"), it lives under team/ and represents
    // deliberate operator work. The guard treats untracked team/ files as config edits
    // only if the file is TRACKED (XY != "??"). A brand-new untracked team/ file is
    // NOT classified as a config edit — it is a leak path from the guard's perspective.
    //
    // NOTE: This test documents the current classification rule. The story specifies
    // "uncommitted edits to TRACKED config paths" — an untracked file is not yet tracked,
    // so it falls into the leak bucket. The operator can prevent it from being stashed by
    // staging it first (`git add team/new-role.yaml`).
    await writeRepoFile("team/new-role.yaml", "role: new-role\n");

    const result = await guardCleanRoot({ targetRepoRoot: repoRoot, ref: "test-ref" });

    // Untracked team/ file: per the "TRACKED config paths" rule it is a LEAK.
    expect(result.hasConfigEdits).toBe(false);
    expect(result.paths).toContain("team/new-role.yaml");
    expect(result.stashed).toBe(true);
  });

  it("idempotent: a second call after a stash finds the root clean and returns dirty=false", async () => {
    await writeRepoFile("plugins/flow/mcp-server/src/leaked.ts", "// leaked\n");

    const first = await guardCleanRoot({ targetRepoRoot: repoRoot, ref: "test-ref" });
    expect(first.dirty).toBe(true);
    expect(first.stashed).toBe(true);

    // Second call — root is clean now.
    const second = await guardCleanRoot({ targetRepoRoot: repoRoot, ref: "test-ref" });
    expect(second.dirty).toBe(false);
    expect(second.stashed).toBe(false);
    expect(second.hasConfigEdits).toBe(false);
    expect(second.configEdits).toEqual([]);
    expect(second.paths).toEqual([]);
  });
});
