/**
 * Unit tests for the build-blind dependency-merge check.
 *
 * `isDependencyPrMerged` reproduces a dependency's PR head branch from its
 * {ref, title} and asks `gh pr list --head <branch> --state merged`. It returns
 * true iff a merged PR exists, and FAIL-SAFE false on any gh/parse failure.
 *
 * Primary probe (Story native:01KTNJ6QVZWVF407QEJPZSDTZK): when `prNumber` is
 * supplied, uses `gh pr view <prNumber> --json state` so the check is correct
 * even when the real branch name differs from the title-derived slug.
 *
 * `areDependenciesMerged` reads each dep's `done/` manifest for its title, then
 * defers to a (mockable) per-dep merge probe; it short-circuits false on the
 * first unmerged / missing / malformed dependency.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../managed-fs.js";
import {
  isDependencyPrMerged,
  areDependenciesMerged,
  isOverlapBlockerInFlight,
  anyOverlapBlockerInFlight,
} from "../dep-merge-check.js";

// A minimal execa stub: returns the configured stdout/exitCode, or throws.
function fakeExeca(behaviour: { stdout?: string; throws?: boolean }) {
  const calls: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
  const impl = (async (file: string, args: readonly string[], opts?: { cwd?: string }) => {
    calls.push({ file, args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    if (behaviour.throws) throw new Error("gh blew up");
    return { stdout: behaviour.stdout ?? "", stderr: "", exitCode: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { impl, calls };
}

describe("isDependencyPrMerged", () => {
  const base = { targetRepoRoot: "/repo", ref: "native:01HZDEP000000000000000001", title: "A dep story" };

  it("returns true when gh reports a merged PR for the dep's head branch", async () => {
    const { impl, calls } = fakeExeca({ stdout: JSON.stringify([{ number: 42 }]) });
    const merged = await isDependencyPrMerged({ ...base, execaImpl: impl });
    expect(merged).toBe(true);
    // Probes by the reproduced branch slug, scoped to merged state, in the repo cwd.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("gh");
    expect(calls[0]!.args).toContain("--head");
    expect(calls[0]!.args).toContain("--state");
    expect(calls[0]!.args).toContain("merged");
    expect(calls[0]!.cwd).toBe("/repo");
    // The branch passed to --head is the buildBranchSlug of {ref,title}.
    const headIdx = calls[0]!.args.indexOf("--head");
    expect(calls[0]!.args[headIdx + 1]).toMatch(/^story\/native-01hzdep.*-a-dep-story$/);
  });

  it("returns false when gh reports no merged PR (empty array)", async () => {
    const { impl } = fakeExeca({ stdout: "[]" });
    expect(await isDependencyPrMerged({ ...base, execaImpl: impl })).toBe(false);
  });

  it("FAIL-SAFE: returns false when gh throws (missing/auth/network)", async () => {
    const { impl } = fakeExeca({ throws: true });
    expect(await isDependencyPrMerged({ ...base, execaImpl: impl })).toBe(false);
  });

  it("FAIL-SAFE: returns false on unparseable gh output", async () => {
    const { impl } = fakeExeca({ stdout: "not json" });
    expect(await isDependencyPrMerged({ ...base, execaImpl: impl })).toBe(false);
  });

  // AC3 — primary probe via recorded pr_number
  it("(AC3) uses `gh pr view <prNumber>` when prNumber is supplied, not the slug probe", async () => {
    // Return a MERGED state response from `gh pr view`.
    const { impl, calls } = fakeExeca({ stdout: JSON.stringify({ state: "MERGED" }) });
    const merged = await isDependencyPrMerged({ ...base, prNumber: 99, execaImpl: impl });
    expect(merged).toBe(true);
    // Must call `gh pr view <prNumber>` — the number-based probe, not pr list --head.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe("pr");
    expect(calls[0]!.args[1]).toBe("view");
    expect(calls[0]!.args[2]).toBe("99");
    expect(calls[0]!.args).not.toContain("--head");
  });

  it("(AC3) returns false via primary probe when gh pr view reports OPEN state", async () => {
    const { impl } = fakeExeca({ stdout: JSON.stringify({ state: "OPEN" }) });
    expect(await isDependencyPrMerged({ ...base, prNumber: 99, execaImpl: impl })).toBe(false);
  });

  it("(AC3) returns false via primary probe when gh pr view reports CLOSED state", async () => {
    const { impl } = fakeExeca({ stdout: JSON.stringify({ state: "CLOSED" }) });
    expect(await isDependencyPrMerged({ ...base, prNumber: 99, execaImpl: impl })).toBe(false);
  });

  it("(AC4) FAIL-SAFE: primary probe returns false when gh throws (unverifiable)", async () => {
    const { impl } = fakeExeca({ throws: true });
    expect(await isDependencyPrMerged({ ...base, prNumber: 99, execaImpl: impl })).toBe(false);
  });

  it("(AC4) FAIL-SAFE: primary probe returns false on unparseable gh output (unverifiable)", async () => {
    const { impl } = fakeExeca({ stdout: "not json at all" });
    expect(await isDependencyPrMerged({ ...base, prNumber: 99, execaImpl: impl })).toBe(false);
  });

  it("(AC3) real branch name differs from title-slug but recorded prNumber confirms merged", async () => {
    // Simulate the concrete bug: the real branch was shipped with a different slug
    // (e.g. via /ship-story), so `pr list --head <title-slug>` would return [].
    // The primary `pr view` probe uses the recorded number, not the title slug.
    const { impl, calls } = fakeExeca({ stdout: JSON.stringify({ state: "MERGED" }) });
    const merged = await isDependencyPrMerged({
      targetRepoRoot: "/repo",
      ref: "native:01KT3FKYB7AAAAAAAAAAAAAAAA",
      // Title that would produce a different slug than the real shipped branch:
      title: "Guarantee the .crew symlink never appears in a story's pull request",
      prNumber: 123,
      execaImpl: impl,
    });
    expect(merged).toBe(true);
    // Confirmed: used pr view with the number, not a head slug.
    expect(calls[0]!.args[1]).toBe("view");
    expect(calls[0]!.args[2]).toBe("123");
    expect(calls[0]!.args).not.toContain("--head");
  });
});

describe("areDependenciesMerged", () => {
  let tmpRoot: string;
  let doneDir: string;

  function makeDoneManifest(ref: string, extra: Record<string, unknown> = {}): string {
    return yamlStringify(
      {
        ref,
        status: "done",
        adapter: "native",
        source_path: `.flow/native-stories/${ref}.yaml`,
        source_hash: "a".repeat(64),
        depends_on: [],
        acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
        title: `Title for ${ref}`,
        narrative: "As a dev, I want to test.",
        withdrawn: false,
        ready: true,
        ...extra,
      },
      { lineWidth: 0 },
    );
  }

  async function seedDone(ref: string, extra: Record<string, unknown> = {}): Promise<void> {
    await atomicWriteFile(path.join(doneDir, `${ref}.yaml`), makeDoneManifest(ref, extra));
  }

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-dep-merge-"));
    doneDir = path.join(tmpRoot, ".flow", "state", "done");
    await fs.mkdir(doneDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns true for an empty dependency list (nothing to gate)", async () => {
    const merged = await areDependenciesMerged({
      targetRepoRoot: tmpRoot,
      deps: [],
      isMerged: async () => false, // never consulted
    });
    expect(merged).toBe(true);
  });

  it("returns true only when EVERY dependency is merged, passing the dep's title through", async () => {
    const d1 = "native:01HZDEP000000000000000001";
    const d2 = "native:01HZDEP000000000000000002";
    await seedDone(d1);
    await seedDone(d2);

    const probed: Array<{ ref: string; title: string }> = [];
    const merged = await areDependenciesMerged({
      targetRepoRoot: tmpRoot,
      deps: [d1, d2],
      isMerged: async ({ ref, title }) => {
        probed.push({ ref, title });
        return true;
      },
    });

    expect(merged).toBe(true);
    expect(probed).toEqual([
      { ref: d1, title: `Title for ${d1}` },
      { ref: d2, title: `Title for ${d2}` },
    ]);
  });

  it("short-circuits false on the first unmerged dependency", async () => {
    const d1 = "native:01HZDEP000000000000000001";
    const d2 = "native:01HZDEP000000000000000002";
    await seedDone(d1);
    await seedDone(d2);

    let probeCount = 0;
    const merged = await areDependenciesMerged({
      targetRepoRoot: tmpRoot,
      deps: [d1, d2],
      isMerged: async () => {
        probeCount += 1;
        return false; // first dep not merged
      },
    });

    expect(merged).toBe(false);
    expect(probeCount).toBe(1); // never probed the second
  });

  it("FAIL-SAFE: returns false when a dependency manifest is missing from done/", async () => {
    const merged = await areDependenciesMerged({
      targetRepoRoot: tmpRoot,
      deps: ["native:01HZDEP000000000000000099"], // never seeded
      isMerged: async () => true,
    });
    expect(merged).toBe(false);
  });

  // AC3 — pr_number is read from the done/ manifest and forwarded to isMerged
  it("(AC3) forwards pr_number from the done/ manifest to the isMerged probe", async () => {
    const dep = "native:01HZDEP000000000000000001";
    // Seed with a recorded pr_number (simulating a story shipped with the new code path).
    await seedDone(dep, { pr_number: 42 });

    const probed: Array<{ ref: string; title: string; prNumber?: number }> = [];
    const merged = await areDependenciesMerged({
      targetRepoRoot: tmpRoot,
      deps: [dep],
      isMerged: async ({ ref, title, prNumber }) => {
        probed.push({ ref, title, prNumber });
        return true;
      },
    });

    expect(merged).toBe(true);
    expect(probed).toHaveLength(1);
    expect(probed[0]!.prNumber).toBe(42);
    expect(probed[0]!.ref).toBe(dep);
  });

  // AC3 — legacy manifests without pr_number still work (prNumber is undefined)
  it("(AC3) passes prNumber=undefined for legacy done/ manifests without pr_number", async () => {
    const dep = "native:01HZDEP000000000000000002";
    // Seed WITHOUT pr_number (legacy manifest).
    await seedDone(dep);

    const probed: Array<{ prNumber?: number }> = [];
    const merged = await areDependenciesMerged({
      targetRepoRoot: tmpRoot,
      deps: [dep],
      isMerged: async ({ prNumber }) => {
        probed.push({ prNumber });
        return true;
      },
    });

    expect(merged).toBe(true);
    expect(probed[0]!.prNumber).toBeUndefined();
  });

  // AC4 — conservative fail-safe preserved
  it("(AC4) FAIL-SAFE: returns false when isMerged returns false (genuinely un-merged)", async () => {
    const dep = "native:01HZDEP000000000000000003";
    await seedDone(dep, { pr_number: 55 });

    const merged = await areDependenciesMerged({
      targetRepoRoot: tmpRoot,
      deps: [dep],
      isMerged: async () => false, // not yet merged
    });

    expect(merged).toBe(false);
  });
});

describe("isOverlapBlockerInFlight (overlap gate — open-PR probe)", () => {
  const base = { targetRepoRoot: "/repo", prNumber: 99 };

  it("in flight (true) when the PR is still OPEN", async () => {
    const { impl, calls } = fakeExeca({ stdout: JSON.stringify({ state: "OPEN" }) });
    expect(await isOverlapBlockerInFlight({ ...base, execaImpl: impl })).toBe(true);
    // probes the recorded PR number via `gh pr view <n>`
    expect(calls[0]?.args).toContain("99");
  });

  it("settled (false) when the PR is MERGED — its change is already on main", async () => {
    const { impl } = fakeExeca({ stdout: JSON.stringify({ state: "MERGED" }) });
    expect(await isOverlapBlockerInFlight({ ...base, execaImpl: impl })).toBe(false);
  });

  it("settled (false) when the PR is CLOSED — abandoned, will never land", async () => {
    const { impl } = fakeExeca({ stdout: JSON.stringify({ state: "CLOSED" }) });
    expect(await isOverlapBlockerInFlight({ ...base, execaImpl: impl })).toBe(false);
  });

  it("CONSERVATIVE: in flight (true) on a gh error (transient → never a blind build)", async () => {
    const { impl } = fakeExeca({ throws: true });
    expect(await isOverlapBlockerInFlight({ ...base, execaImpl: impl })).toBe(true);
  });

  it("CONSERVATIVE: in flight (true) on empty / unparseable gh output", async () => {
    const empty = fakeExeca({ stdout: "" });
    expect(await isOverlapBlockerInFlight({ ...base, execaImpl: empty.impl })).toBe(true);
    const garbage = fakeExeca({ stdout: "not json" });
    expect(await isOverlapBlockerInFlight({ ...base, execaImpl: garbage.impl })).toBe(true);
  });
});

describe("anyOverlapBlockerInFlight (overlap gate — per-blocker resolution)", () => {
  let tmpRoot: string;
  let doneDir: string;

  function makeDoneManifest(ref: string, extra: Record<string, unknown> = {}): string {
    return yamlStringify(
      {
        ref,
        status: "done",
        adapter: "native",
        source_path: `.flow/native-stories/${ref}.yaml`,
        source_hash: "a".repeat(64),
        depends_on: [],
        acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
        title: `Title for ${ref}`,
        narrative: "As a dev, I want to test.",
        withdrawn: false,
        ready: true,
        ...extra,
      },
      { lineWidth: 0 },
    );
  }
  async function seedDone(ref: string, extra: Record<string, unknown> = {}): Promise<void> {
    await atomicWriteFile(path.join(doneDir, `${ref}.yaml`), makeDoneManifest(ref, extra));
  }

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-overlap-inflight-"));
    doneDir = path.join(tmpRoot, ".flow", "state", "done");
    await fs.mkdir(doneDir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const REF = "native:01HZBLOCKER0000000000000001";

  it("returns false for an empty blocker list", async () => {
    expect(
      await anyOverlapBlockerInFlight({
        targetRepoRoot: tmpRoot,
        blockers: [],
        isInFlight: async () => true,
      }),
    ).toBe(false);
  });

  it("THE FIX: a blocker with NO pr_number is settled — never probed", async () => {
    await seedDone(REF); // legacy / manually-shipped: no pr_number
    let probed = false;
    const result = await anyOverlapBlockerInFlight({
      targetRepoRoot: tmpRoot,
      blockers: [REF],
      isInFlight: async () => {
        probed = true;
        return true;
      },
    });
    expect(result).toBe(false);
    expect(probed).toBe(false); // no GitHub call for a historical blocker
  });

  it("a blocker WITH a pr_number is probed and blocks when in flight", async () => {
    await seedDone(REF, { pr_number: 42 });
    const result = await anyOverlapBlockerInFlight({
      targetRepoRoot: tmpRoot,
      blockers: [REF],
      isInFlight: async ({ prNumber }) => prNumber === 42, // open
    });
    expect(result).toBe(true);
  });

  it("a blocker WITH a pr_number that is settled does not block", async () => {
    await seedDone(REF, { pr_number: 42 });
    const result = await anyOverlapBlockerInFlight({
      targetRepoRoot: tmpRoot,
      blockers: [REF],
      isInFlight: async () => false, // merged / closed
    });
    expect(result).toBe(false);
  });

  it("settled (false) when the blocker manifest is absent / unreadable", async () => {
    const result = await anyOverlapBlockerInFlight({
      targetRepoRoot: tmpRoot,
      blockers: ["native:01HZMISSING000000000000001"],
      isInFlight: async () => true, // never reached
    });
    expect(result).toBe(false);
  });

  it("returns true if ANY blocker is in flight (mixed historical + in-flight set)", async () => {
    const settled = "native:01HZBLOCKER0000000000000002";
    await seedDone(settled); // no pr_number → settled
    await seedDone(REF, { pr_number: 7 }); // in flight
    const result = await anyOverlapBlockerInFlight({
      targetRepoRoot: tmpRoot,
      blockers: [settled, REF],
      isInFlight: async ({ prNumber }) => prNumber === 7,
    });
    expect(result).toBe(true);
  });
});
