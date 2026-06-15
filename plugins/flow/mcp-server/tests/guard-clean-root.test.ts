/**
 * Integration tests for `guardCleanRoot` — Epic 10 run fix-plan, Fix 2b.
 *
 * Drives the tool against a REAL throwaway git repo (tests under tests/** may
 * spawn git and write files freely — the canonical-fs / git-spawn static guards
 * only constrain src/**). Proves the clean-root guard's binding behaviour:
 *
 *   - a dirty root (modified tracked file + leaked untracked file) is detected,
 *     those exact paths are stashed non-destructively (recoverable), and the
 *     working tree is restored to a clean base;
 *   - operational `.flow/state/**` is never stashed (it is the ledger's domain);
 *   - the guard is idempotent — a second call after a stash reports a clean root;
 *   - a clean root is a no-op (no stash created).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa } from "execa";
import { guardCleanRoot } from "../src/tools/guard-clean-root.js";

let repo: string;

async function git(args: string[]): Promise<string> {
  const { stdout } = await execa("git", ["-C", repo, ...args]);
  return stdout;
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "flow-guard-clean-root-"));
  await execa("git", ["-C", repo, "init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "commit.gpgsign", "false"]);
  // `.flow/` is gitignored — exactly as in flow's own repo — so operational ledger
  // state never shows in `git status` and the guard never stashes it. A committed
  // tracked file gives us a clean HEAD baseline.
  await fs.writeFile(path.join(repo, ".gitignore"), ".flow/\n", "utf8");
  await fs.writeFile(path.join(repo, "src.txt"), "v1\n", "utf8");
  await git(["add", ".gitignore", "src.txt"]);
  await git(["commit", "-m", "init"]);
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("guardCleanRoot — clean-root guard (Fix 2b)", () => {
  it("a clean root is a no-op (dirty:false, no stash created)", async () => {
    const result = await guardCleanRoot({ targetRepoRoot: repo });
    expect(result.dirty).toBe(false);
    expect(result.stashed).toBe(false);
    expect(result.paths).toEqual([]);
    expect(await git(["stash", "list"])).toBe("");
  });

  it("stashes leaked tracked+untracked paths, leaves .flow/state alone, restores a clean base", async () => {
    // Simulate the bgIsolation leak: dev edits land in the shared root.
    await fs.writeFile(path.join(repo, "src.txt"), "v2-leaked\n", "utf8"); // modified tracked
    await fs.writeFile(path.join(repo, "leaked.txt"), "new\n", "utf8"); // untracked
    // Operational ledger state — must NOT be stashed.
    await fs.mkdir(path.join(repo, ".flow", "state", "to-do"), { recursive: true });
    await fs.writeFile(path.join(repo, ".flow", "state", "to-do", "x.yaml"), "ref: x\n", "utf8");

    const result = await guardCleanRoot({ targetRepoRoot: repo, ref: "native:01TEST" });

    expect(result.dirty).toBe(true);
    expect(result.stashed).toBe(true);
    // Exactly the leaked source paths — the .flow/state ledger file is excluded.
    expect([...result.paths].sort()).toEqual(["leaked.txt", "src.txt"]);
    expect(result.paths).not.toContain(".flow/state/to-do/x.yaml");

    // Working tree restored to the committed base: modification reverted, leaked
    // untracked file removed — both safely held in the stash, not discarded.
    expect(await fs.readFile(path.join(repo, "src.txt"), "utf8")).toBe("v1\n");
    await expect(fs.stat(path.join(repo, "leaked.txt"))).rejects.toBeTruthy();
    // The ledger file is untouched.
    await expect(
      fs.stat(path.join(repo, ".flow", "state", "to-do", "x.yaml")),
    ).resolves.toBeTruthy();

    // The work is recoverable — one labelled stash entry.
    const stashList = await git(["stash", "list"]);
    expect(stashList).toContain("flow-run clean-root guard: native:01TEST");
  });

  it("is idempotent — a second call after a stash reports a clean root", async () => {
    await fs.writeFile(path.join(repo, "src.txt"), "v2\n", "utf8");
    const first = await guardCleanRoot({ targetRepoRoot: repo, ref: "native:01TEST" });
    expect(first.dirty).toBe(true);
    expect(first.stashed).toBe(true);

    const second = await guardCleanRoot({ targetRepoRoot: repo, ref: "native:01TEST" });
    expect(second.dirty).toBe(false);
    expect(second.stashed).toBe(false);
  });

  it("ignores a root dirty ONLY with .flow/state changes (ledger churn is not a leak)", async () => {
    await fs.mkdir(path.join(repo, ".flow", "state", "to-do"), { recursive: true });
    await fs.writeFile(path.join(repo, ".flow", "state", "to-do", "x.yaml"), "ref: x\n", "utf8");

    const result = await guardCleanRoot({ targetRepoRoot: repo });
    expect(result.dirty).toBe(false);
    expect(result.stashed).toBe(false);
    expect(await git(["stash", "list"])).toBe("");
  });

  it("a clean root on the base branch reports headMoved:false (no checkout)", async () => {
    const result = await guardCleanRoot({ targetRepoRoot: repo });
    expect(result.headMoved).toBe(false);
    expect(await git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// Root-HEAD restore (fix/run-isolation-coordination-honesty)
//
// The same bgIsolation leak that dirties the root can also move its HEAD: the
// dev's `git checkout -b story/<ref>` + commit run in the SHARED ROOT, leaving it
// DETACHED at a story commit (or on a story/* branch) after the run. The guard now
// returns the root to base, WITHOUT discarding the story work (it lives on the
// pushed story branch).
// ---------------------------------------------------------------------------
describe("guardCleanRoot — root-HEAD restore", () => {
  it("restores a DETACHED HEAD (left at a story commit) back to the base branch, work preserved", async () => {
    // Simulate the leak: a story branch with a commit, then HEAD detached at it.
    await git(["checkout", "-b", "story/native-01test-foo"]);
    await fs.writeFile(path.join(repo, "story-work.txt"), "story\n", "utf8");
    await git(["add", "story-work.txt"]);
    await git(["commit", "-m", "story work"]);
    const storySha = await git(["rev-parse", "HEAD"]);
    await git(["checkout", "--detach", "HEAD"]); // root now DETACHED at the story commit

    const result = await guardCleanRoot({ targetRepoRoot: repo });

    expect(result.headMoved).toBe(true);
    expect(result.restoredTo).toBe("main");
    expect(result.restoredFrom).toContain("detached@");
    // HEAD is back on main.
    expect(await git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
    // The story work is NOT discarded — the branch still points at the commit.
    expect(await git(["rev-parse", "story/native-01test-foo"])).toBe(storySha);
  });

  it("restores a story/* branch HEAD back to the base branch", async () => {
    await git(["checkout", "-b", "story/native-01test-bar"]);

    const result = await guardCleanRoot({ targetRepoRoot: repo });

    expect(result.headMoved).toBe(true);
    expect(result.restoredFrom).toBe("story/native-01test-bar");
    expect(result.restoredTo).toBe("main");
    expect(await git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
  });

  it("LEAVES a deliberate non-story operator branch untouched (never clobbers operator intent)", async () => {
    await git(["checkout", "-b", "feature/my-deliberate-work"]);

    const result = await guardCleanRoot({ targetRepoRoot: repo });

    expect(result.headMoved).toBe(false);
    expect(result.headNote).toContain("non-story branch");
    // Still on the operator's branch.
    expect(await git(["symbolic-ref", "--short", "HEAD"])).toBe("feature/my-deliberate-work");
  });

  it("honours an explicit baseBranch override", async () => {
    // A repo whose trunk is not 'main'.
    await git(["checkout", "-b", "trunk"]);
    await git(["checkout", "-b", "story/native-01test-baz"]);

    const result = await guardCleanRoot({ targetRepoRoot: repo, baseBranch: "trunk" });

    expect(result.headMoved).toBe(true);
    expect(result.restoredTo).toBe("trunk");
    expect(await git(["symbolic-ref", "--short", "HEAD"])).toBe("trunk");
  });
});
