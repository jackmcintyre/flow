/**
 * Tests for the CI-status unreadable vs still-pending distinction in the
 * auto-merge gate's CI poll.
 *
 * AC3 — When the auto-merge check cannot read the CI status (e.g. a permissions
 *        or configuration problem), it reports exactly that — the status is
 *        unreadable and why — rather than reporting "CI is not green".
 *
 * AC4 — When CI checks are still running (genuinely pending), that outcome is
 *        distinct from the unreadable-status outcome so a slow-but-healthy run
 *        is never confused with a broken one.
 *
 * The `ciGateImpl` seam is used to inject the desired CI outcome directly, so
 * these tests focus on the gate's response to the CI result rather than the
 * polling mechanics.
 *
 * Story native:01KTSR1HYG02PDVGGM7382ZSR6
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { stringify as yamlStringify } from "yaml";
import { runAutoMergeGate } from "../run-auto-merge-gate.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { __resetGhErrorMapCacheForTests } from "../../lib/gh-error-map.js";
import type { AgreementMetricResult } from "../compute-agreement.js";
import type { CiGateState } from "../run-auto-merge-gate.js";

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

const SESSION_ULID = "01HZCITEST000000000000000";
const PR_NUMBER = 77;
const REF = "native:01HZCITEST000000000000000";

function makeMetric(ratio: number): AgreementMetricResult {
  return {
    ratio,
    distribution: { "READY FOR MERGE": Math.round(ratio * 10), "NEEDS CHANGES": 0, BLOCKED: 0 },
    window_size: 10,
    sample_size: 10,
    skipped_unresolved: 0,
    skipped_excluded: 0,
    malformed_lines: 0,
  };
}

function makeAgreementImpl(result: AgreementMetricResult | null) {
  return async (): Promise<AgreementMetricResult | null> => result;
}

function makeDoneManifestYaml(opts: { ref: string; risk_tier?: "low" | "medium" | "high" }): string {
  const manifest: Record<string, unknown> = {
    ref: opts.ref,
    status: "done",
    adapter: "native",
    source_path: `.flow/native-stories/${opts.ref.replace("native:", "")}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" as const }],
    title: "CI unreadable gate test",
    narrative: "Testing the CI unreadable gate path.",
    withdrawn: false,
    claimed_by: SESSION_ULID,
  };
  if (opts.risk_tier !== undefined) manifest["risk_tier"] = opts.risk_tier;
  return yamlStringify(manifest, { lineWidth: 0 });
}

async function seedDoneManifest(
  repoRoot: string,
  opts: { ref: string; risk_tier?: "low" | "medium" | "high" },
): Promise<void> {
  const doneDir = path.join(repoRoot, ".flow", "state", "done");
  await fs.mkdir(doneDir, { recursive: true });
  await atomicWriteFile(path.join(doneDir, `${opts.ref}.yaml`), makeDoneManifestYaml(opts));
}

async function seedPluginPermissions(pluginRoot: string): Promise<void> {
  await fs.mkdir(path.join(pluginRoot, "permissions"), { recursive: true });
  await atomicWriteFile(
    path.join(pluginRoot, "permissions", "generalist-dev.yaml"),
    [
      "role: generalist-dev",
      "tools_allow:",
      "  - claimStory",
      "gh_allow:",
      "  - pr-view",
      "  - pr-merge",
      "  - api",
      "  - repo-view",
      "gh_allow_args: {}",
    ].join("\n") + "\n",
  );
  await atomicWriteFile(
    path.join(pluginRoot, "permissions", "gh-error-map.yaml"),
    ["entries:", "  - exit_code: 4", '    stderr_regex: "API rate limit exceeded"', "    class: defer"].join("\n") + "\n",
  );
}

let repoRoot: string;
let pluginRoot: string;

beforeEach(async () => {
  __resetGhErrorMapCacheForTests();
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-ci-unreadable-test-"));
  pluginRoot = path.join(repoRoot, "_plugin");
  await seedDoneManifest(repoRoot, { ref: REF, risk_tier: "low" });
  await seedPluginPermissions(pluginRoot);
});

afterEach(async () => {
  __resetGhErrorMapCacheForTests();
  await fs.rm(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC3 — CI status unreadable: reported as unreadable, not as CI-not-green
// ---------------------------------------------------------------------------

describe("AC3 — CI status unreadable is reported as unreadable with the reason", () => {
  it("permissions error reading statusCheckRollup → reason=ci-status-unreadable, not ci-not-green", async () => {
    const ciGateImpl = async (): Promise<CiGateState> =>
      ({ kind: "ci-status-unreadable", reason: "HTTP 403: Resource not accessible by integration" });

    // dryRun skips the CI gate — verify the ci gate result is threaded correctly
    // by using dryRun:false with the ciGateImpl seam
    const resultWithCi = await runAutoMergeGate({
      targetRepoRoot: repoRoot,
      prNumber: PR_NUMBER,
      ref: REF,
      sessionUlid: SESSION_ULID,
      thresholdOverride: 0.7,
      computeAgreementImpl: makeAgreementImpl(makeMetric(1.0)),
      ciGateImpl,
      pluginRootOverride: pluginRoot,
      dryRun: false,
      // We need to also stub the needs-human label path: the gate will try to
      // call gh repo-view and gh api. Use execaImpl to stub those.
      execaImpl: (async (cmd: string, args: string[]) => {
        if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
          return { stdout: JSON.stringify({ name: "flow", owner: { login: "jackmcintyre" } }), stderr: "", exitCode: 0 };
        }
        if (cmd === "gh" && args[0] === "api") {
          return { stdout: JSON.stringify([{ id: 1, name: "needs-human" }]), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: `unexpected: ${cmd} ${args.join(" ")}`, exitCode: 0 };
      }) as unknown as Parameters<typeof runAutoMergeGate>[0]["execaImpl"],
    });

    expect(resultWithCi.decision).toBe("pause-needs-human");
    expect(resultWithCi.reason).toBe("ci-status-unreadable");
    // The chat log should contain the unreadable reason, not "CI is not green"
    const chatLogText = resultWithCi.chatLog.join(" ");
    expect(chatLogText).toContain("ci-status-unreadable");
    expect(chatLogText).not.toContain("ci-not-green");
  });

  it("configuration error → reason=ci-status-unreadable is kept separate from ci-not-green", async () => {
    const ciGateImpl = async (): Promise<CiGateState> =>
      ({ kind: "ci-status-unreadable", reason: "no statusCheckRollup field in response" });

    const result = await runAutoMergeGate({
      targetRepoRoot: repoRoot,
      prNumber: PR_NUMBER,
      ref: REF,
      sessionUlid: SESSION_ULID,
      thresholdOverride: 0.7,
      computeAgreementImpl: makeAgreementImpl(makeMetric(1.0)),
      ciGateImpl,
      pluginRootOverride: pluginRoot,
      dryRun: false,
      execaImpl: (async (cmd: string, args: string[]) => {
        if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
          return { stdout: JSON.stringify({ name: "flow", owner: { login: "jackmcintyre" } }), stderr: "", exitCode: 0 };
        }
        if (cmd === "gh" && args[0] === "api") {
          return { stdout: JSON.stringify([{ id: 1, name: "needs-human" }]), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }) as unknown as Parameters<typeof runAutoMergeGate>[0]["execaImpl"],
    });

    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("ci-status-unreadable");
    // ci-status-unreadable is distinct from ci-not-green
    expect(result.reason).not.toBe("ci-not-green");
  });

  it("unreadable reason carries the underlying error message in the chat log", async () => {
    const specificReason = "HTTP 404: Pull request not found";
    const ciGateImpl = async (): Promise<CiGateState> =>
      ({ kind: "ci-status-unreadable", reason: specificReason });

    const result = await runAutoMergeGate({
      targetRepoRoot: repoRoot,
      prNumber: PR_NUMBER,
      ref: REF,
      sessionUlid: SESSION_ULID,
      thresholdOverride: 0.7,
      computeAgreementImpl: makeAgreementImpl(makeMetric(1.0)),
      ciGateImpl,
      pluginRootOverride: pluginRoot,
      dryRun: false,
      execaImpl: (async (cmd: string, args: string[]) => {
        if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
          return { stdout: JSON.stringify({ name: "flow", owner: { login: "jackmcintyre" } }), stderr: "", exitCode: 0 };
        }
        if (cmd === "gh" && args[0] === "api") {
          return { stdout: JSON.stringify([{ id: 1, name: "needs-human" }]), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }) as unknown as Parameters<typeof runAutoMergeGate>[0]["execaImpl"],
    });

    expect(result.reason).toBe("ci-status-unreadable");
    // The specific underlying reason should appear in the chat log
    const chatLogText = result.chatLog.join(" ");
    expect(chatLogText).toContain(specificReason);
  });
});

// ---------------------------------------------------------------------------
// AC4 — Still pending is distinct from unreadable
// ---------------------------------------------------------------------------

describe("AC4 — CI still-pending outcome is distinct from unreadable-status", () => {
  it("pending-timeout from CI gate → reason=ci-not-green, NOT ci-status-unreadable", async () => {
    const ciGateImpl = async (): Promise<CiGateState> => "pending-timeout";

    const result = await runAutoMergeGate({
      targetRepoRoot: repoRoot,
      prNumber: PR_NUMBER,
      ref: REF,
      sessionUlid: SESSION_ULID,
      thresholdOverride: 0.7,
      computeAgreementImpl: makeAgreementImpl(makeMetric(1.0)),
      ciGateImpl,
      pluginRootOverride: pluginRoot,
      dryRun: false,
      execaImpl: (async (cmd: string, args: string[]) => {
        if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
          return { stdout: JSON.stringify({ name: "flow", owner: { login: "jackmcintyre" } }), stderr: "", exitCode: 0 };
        }
        if (cmd === "gh" && args[0] === "api") {
          return { stdout: JSON.stringify([{ id: 1, name: "needs-human" }]), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }) as unknown as Parameters<typeof runAutoMergeGate>[0]["execaImpl"],
    });

    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("ci-not-green");
    // Explicitly distinct from the unreadable case
    expect(result.reason).not.toBe("ci-status-unreadable");
  });

  it("CI failed → reason=ci-not-green, NOT ci-status-unreadable", async () => {
    const ciGateImpl = async (): Promise<CiGateState> => "failed";

    const result = await runAutoMergeGate({
      targetRepoRoot: repoRoot,
      prNumber: PR_NUMBER,
      ref: REF,
      sessionUlid: SESSION_ULID,
      thresholdOverride: 0.7,
      computeAgreementImpl: makeAgreementImpl(makeMetric(1.0)),
      ciGateImpl,
      pluginRootOverride: pluginRoot,
      dryRun: false,
      execaImpl: (async (cmd: string, args: string[]) => {
        if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
          return { stdout: JSON.stringify({ name: "flow", owner: { login: "jackmcintyre" } }), stderr: "", exitCode: 0 };
        }
        if (cmd === "gh" && args[0] === "api") {
          return { stdout: JSON.stringify([{ id: 1, name: "needs-human" }]), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }) as unknown as Parameters<typeof runAutoMergeGate>[0]["execaImpl"],
    });

    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("ci-not-green");
    expect(result.reason).not.toBe("ci-status-unreadable");
  });

  it("CI green → auto-merged, no unreadable reason in chat log", async () => {
    const ciGateImpl = async (): Promise<CiGateState> => "green";

    const result = await runAutoMergeGate({
      targetRepoRoot: repoRoot,
      prNumber: PR_NUMBER,
      ref: REF,
      sessionUlid: SESSION_ULID,
      thresholdOverride: 0.7,
      computeAgreementImpl: makeAgreementImpl(makeMetric(1.0)),
      ciGateImpl,
      pluginRootOverride: pluginRoot,
      dryRun: false,
      execaImpl: (async (cmd: string, args: string[]) => {
        if (cmd === "gh" && args[0] === "pr" && args[1] === "merge") {
          return { stdout: "Pull request #77 was successfully merged.", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }) as unknown as Parameters<typeof runAutoMergeGate>[0]["execaImpl"],
    });

    expect(result.decision).toBe("auto-merge");
    expect(result.merged).toBe(true);
    const chatLogText = result.chatLog.join(" ");
    expect(chatLogText).not.toContain("ci-status-unreadable");
    expect(chatLogText).not.toContain("ci-not-green");
  });

  it("pending-timeout vs ci-status-unreadable produce different reasons (explicit distinction)", async () => {
    // This is the core AC4 assertion: the two outcomes are clearly different
    // in the gate's result, so operators are never misled.
    const pendingGate = async (): Promise<CiGateState> => "pending-timeout";
    const unreadableGate = async (): Promise<CiGateState> =>
      ({ kind: "ci-status-unreadable", reason: "HTTP 403 Forbidden" });

    const execaStub = (async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: JSON.stringify({ name: "flow", owner: { login: "jackmcintyre" } }), stderr: "", exitCode: 0 };
      }
      if (cmd === "gh" && args[0] === "api") {
        return { stdout: JSON.stringify([{ id: 1, name: "needs-human" }]), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }) as unknown as Parameters<typeof runAutoMergeGate>[0]["execaImpl"];

    const sharedOpts = {
      targetRepoRoot: repoRoot,
      prNumber: PR_NUMBER,
      ref: REF,
      sessionUlid: SESSION_ULID,
      thresholdOverride: 0.7,
      computeAgreementImpl: makeAgreementImpl(makeMetric(1.0)),
      pluginRootOverride: pluginRoot,
      dryRun: false,
      execaImpl: execaStub,
    };

    const pendingResult = await runAutoMergeGate({ ...sharedOpts, ciGateImpl: pendingGate });
    const unreadableResult = await runAutoMergeGate({ ...sharedOpts, ciGateImpl: unreadableGate });

    expect(pendingResult.reason).toBe("ci-not-green");
    expect(unreadableResult.reason).toBe("ci-status-unreadable");
    // They must differ
    expect(pendingResult.reason).not.toBe(unreadableResult.reason);
  });
});
