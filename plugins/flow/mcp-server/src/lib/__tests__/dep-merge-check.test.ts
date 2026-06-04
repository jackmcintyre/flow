/**
 * Unit tests for the build-blind dependency-merge check.
 *
 * `isDependencyPrMerged` reproduces a dependency's PR head branch from its
 * {ref, title} and asks `gh pr list --head <branch> --state merged`. It returns
 * true iff a merged PR exists, and FAIL-SAFE false on any gh/parse failure.
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
import { isDependencyPrMerged, areDependenciesMerged } from "../dep-merge-check.js";

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
});

describe("areDependenciesMerged", () => {
  let tmpRoot: string;
  let doneDir: string;

  function makeDoneManifest(ref: string): string {
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
      },
      { lineWidth: 0 },
    );
  }

  async function seedDone(ref: string): Promise<void> {
    await atomicWriteFile(path.join(doneDir, `${ref}.yaml`), makeDoneManifest(ref));
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
});
