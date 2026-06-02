import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * Story 1.9 — AC3 static check.
 *
 * CI must build the plugin and then verify the committed `mcp-server/dist/`
 * matches a fresh build (i.e. fail the run if `git diff` is non-empty on
 * that path). We assert the workflow shape here so that any future edit
 * to .github/workflows/ci.yml that drops the drift-check is caught by a
 * unit test rather than only by an actual drift incident in CI.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// .worktrees/<branch>/plugins/flow/mcp-server/tests -> repo root is 4 levels up
const REPO_ROOT = resolve(HERE, "../../../..");
const CI_PATH = resolve(REPO_ROOT, ".github/workflows/ci.yml");

interface Step {
  name?: string;
  run?: string;
  uses?: string;
}

interface Job {
  steps?: Step[];
}

interface Workflow {
  jobs?: Record<string, Job>;
}

describe("CI drift-check shape (Story 1.9 AC3)", () => {
  const raw = readFileSync(CI_PATH, "utf8");
  const wf = parse(raw) as Workflow;

  it("ci.yml has at least one job with steps", () => {
    expect(wf.jobs).toBeDefined();
    const jobs = Object.values(wf.jobs ?? {});
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(Array.isArray(j.steps)).toBe(true);
    }
  });

  it("contains a `pnpm build` step", () => {
    const allSteps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
    const buildStep = allSteps.find(
      (s) => typeof s.run === "string" && /\bpnpm\s+build\b/.test(s.run),
    );
    expect(buildStep, "expected a `pnpm build` run step in ci.yml").toBeDefined();
  });

  it("contains a drift-check step that runs `git diff --exit-code` against mcp-server/dist", () => {
    const allSteps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
    const driftStep = allSteps.find(
      (s) =>
        typeof s.run === "string" &&
        /git\s+diff\s+--exit-code/.test(s.run) &&
        /mcp-server\/dist/.test(s.run),
    );
    expect(
      driftStep,
      "expected a `git diff --exit-code mcp-server/dist` step after `pnpm build`",
    ).toBeDefined();
  });

  it("drift-check step is ordered AFTER `pnpm build`", () => {
    const allSteps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
    const buildIdx = allSteps.findIndex(
      (s) => typeof s.run === "string" && /\bpnpm\s+build\b/.test(s.run),
    );
    const driftIdx = allSteps.findIndex(
      (s) =>
        typeof s.run === "string" &&
        /git\s+diff\s+--exit-code/.test(s.run) &&
        /mcp-server\/dist/.test(s.run),
    );
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(driftIdx).toBeGreaterThan(buildIdx);
  });
});
