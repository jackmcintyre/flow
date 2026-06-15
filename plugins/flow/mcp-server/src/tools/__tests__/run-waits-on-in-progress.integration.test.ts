/**
 * Integration tests for run re-poll on waiting-on-in-progress
 * (Story native:01KTSQXBVE4WEJ2PQKVNHVFPS6).
 *
 * Proves that a run with a B-depends-on-A backlog (where A must finish
 * before B becomes claimable) builds BOTH stories in one run rather than
 * stopping the moment the first `waiting-on-in-progress` result comes back.
 *
 * AC map:
 *   AC1 — B-depends-on-A backlog: both A and B are built in one run; the run
 *          ends with queueEmptied:true (queue-emptied), not prematurely.
 *   AC2 — waiting-on-in-progress triggers a bounded re-poll, not a terminal
 *          stop: the run reason is queue-emptied, not waiting-on-in-progress.
 *   AC3 — a genuinely empty queue ends promptly as a clean, fully-emptied
 *          finish (queueEmptied:true, runReason:'queue-emptied').
 *
 * How this runs the real workflow:
 *   `run.workflow.js` is a plain async script that injects every external
 *   decision through globals (args, agent, log, phase, notify). We read the
 *   real source and wrap it in an AsyncFunction whose parameters ARE those
 *   globals, so the body runs verbatim with our stubs. Nothing in the workflow
 *   is mocked — only its injected seam surface, using the same pattern as
 *   run-fault-injection.test.ts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Locate the real workflow source ─────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
// src/tools/__tests__ → mcp-server → plugins/flow → workflows/
const WORKFLOW_PATH = resolve(HERE, "../../../../workflows/run.workflow.js");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** Deterministic PR number per ref so distinct refs get distinct PR numbers. */
function prNumberForRef(ref?: string): number {
  let h = 0;
  for (const c of String(ref ?? "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 9000 + (h % 1000);
}

// ── Story refs ──────────────────────────────────────────────────────────────
const REF_A = "wip-test-story-a";
const REF_B = "wip-test-story-b";

// ── Core runner ─────────────────────────────────────────────────────────────

/**
 * Drives the real run workflow with a stateful claim stub that simulates a
 * B-depends-on-A scenario:
 *
 *   Phase 1 — before A finishes: any claim call that is NOT for A returns
 *             `waiting-on-in-progress` (A is being built; nothing else is
 *             claimable yet).
 *   Phase 2 — after A finishes: the next claim call returns B (spawn-dev).
 *   Phase 3 — after B finishes: claim returns `queue-emptied`.
 *
 * The `aFinishedSignal` Promise resolves when the test harness decides A has
 * "settled" (i.e. the dev agent for A returned). This lets the stub transition
 * from Phase 1 to Phase 2 without hard-coding a sleep or a call-count limit.
 *
 * `repollDelayMs` is passed to the workflow as the `repollDelayMs` arg so the
 * test does not block on real wall-clock time.
 */
async function runRunWithDependentStories(opts: {
  maxConcurrency?: number;
  repollDelayMs?: number;
}): Promise<{
  result: any;
  thrown: unknown;
  logs: string[];
  claimCallCount: number;
  waitingLogCount: number;
}> {
  const source = readFileSync(WORKFLOW_PATH, "utf8").replace(
    /^export\s+const\s+meta\b/m,
    "const meta",
  );
  const body = `${source}\n//# sourceURL=run.workflow.js`;

  const logs: string[] = [];
  let claimCallCount = 0;

  // State machine: tracks whether A has been devved (i.e. A settled).
  // A "settles" the moment the dev agent for A returns.
  let aDevCompleted = false;
  // Track whether B has been devved.
  let bDevCompleted = false;

  // All refs that have ever been issued as spawn-dev; used to disambiguate
  // per-story seam labels.
  const issuedRefs = new Set<string>([REF_A, REF_B]);

  const refOfLabel = (label: string): string | undefined =>
    Array.from(issuedRefs).find((r) => label.includes(r));

  /**
   * Claim stub — stateful:
   *   - First call → A (spawn-dev)
   *   - While A is building (aDevCompleted=false) → waiting-on-in-progress
   *   - Once A is done, next call → B (spawn-dev)
   *   - Once B is done, next call → queue-emptied
   */
  const claimResult = (): unknown => {
    claimCallCount++;
    if (!aDevCompleted) {
      // First call: issue A. Every subsequent call while A is building: wait.
      if (claimCallCount === 1) {
        return {
          next: "spawn-dev",
          ref: REF_A,
          title: "Story A",
          manifestPath: `/tmp/wip_test_story_a.yaml`,
        };
      }
      // A not yet done — caller re-polls.
      return { next: "waiting-on-in-progress" };
    }
    if (!bDevCompleted) {
      // A is done; issue B.
      return {
        next: "spawn-dev",
        ref: REF_B,
        title: "Story B",
        manifestPath: `/tmp/wip_test_story_b.yaml`,
      };
    }
    // Both done — queue exhausted.
    return { next: "queue-emptied" };
  };

  const seamResult = (label: string): unknown => {
    if (label === "mint") return { sessionUlid: "01TESTULID0000000000000000" };
    if (label.startsWith("persona:dev")) return { systemPrompt: "DEV-PERSONA" };
    if (label.startsWith("persona:reviewer")) return { systemPrompt: "REV-PERSONA" };
    if (label === "worktree-reap") return { reaped: [] };
    if (label === "orphan-scan") return { orphans: [] };
    if (label.startsWith("clean-root-guard:")) return { dirty: false };
    if (label.startsWith("build-plan:")) return { devReviewerModel: "sonnet", reviewDepth: "full" };
    if (label.startsWith("claim:")) return claimResult();
    if (label.startsWith("pd-needs-human:")) return { next: "spawn-reviewer", prNumber: 9001, reviewerPrompt: "REV-PERSONA" };
    if (label.startsWith("pd:")) {
      const ref = refOfLabel(label);
      return { next: "spawn-reviewer", prNumber: prNumberForRef(ref), reviewerPrompt: "REV-PERSONA" };
    }
    if (label.startsWith("verdict:")) return { next: "done-ready-for-merge" };
    if (label.startsWith("gate:")) return { decision: "pause-needs-human", reason: "no-agreement-history" };
    if (label.startsWith("progress-start:")) return { atMs: 1000, line: `progress-start stub` };
    if (label.startsWith("progress-done:")) return { line: `progress-done stub` };
    return { _unstubbed: label };
  };

  const agent = async (_prompt: string, agentOpts: { label?: string; schema?: unknown } = {}) => {
    const label = agentOpts.label ?? "";

    // Seam calls (schema present): return { stdout: json }
    if (agentOpts.schema) {
      return { stdout: JSON.stringify(seamResult(label)) };
    }

    // Direct dev agent call
    if (label.startsWith("dev:")) {
      const ref = refOfLabel(label);
      // Mark the story settled BEFORE returning so the claim stub sees the
      // updated state when the worker loops back.
      if (ref === REF_A) aDevCompleted = true;
      if (ref === REF_B) bDevCompleted = true;
      return `Implemented the story.\nHandoff to reviewer — story ${ref} ready for review.`;
    }

    // Direct reviewer agent call
    if (label.startsWith("rev:")) {
      return "Reviewed; verdict written.";
    }

    return "";
  };

  const log = (line: string) => {
    logs.push(String(line));
  };
  const phase = (_name: string) => { /* no-op */ };
  const notify = (_payload: unknown) => { /* no-op */ };

  const args = JSON.stringify({
    targetRepoRoot: "/tmp/target-repo",
    cli: "/tmp/cli.js",
    sessionUlid: "01TESTULID0000000000000000",
    maxConcurrency: opts.maxConcurrency ?? 1,
    repollDelayMs: opts.repollDelayMs ?? 0,
  });

  const fn = new AsyncFunction("args", "agent", "log", "phase", "notify", body);
  let result: any;
  let thrown: unknown = undefined;
  try {
    result = await fn(args, agent, log, phase, notify);
  } catch (e) {
    thrown = e;
  }

  const waitingLogCount = logs.filter((l) => l.includes("WAITING") && l.includes("in progress")).length;

  return { result, thrown, logs, claimCallCount, waitingLogCount };
}

/**
 * Runs the run with a truly empty queue (no stories at all).
 * Used by AC3 to verify the clean-run path is unchanged.
 */
async function runRunEmptyQueue(): Promise<{
  result: any;
  thrown: unknown;
}> {
  const source = readFileSync(WORKFLOW_PATH, "utf8").replace(
    /^export\s+const\s+meta\b/m,
    "const meta",
  );
  const body = `${source}\n//# sourceURL=run.workflow.js`;

  const agent = async (_prompt: string, agentOpts: { label?: string; schema?: unknown } = {}) => {
    const label = agentOpts.label ?? "";
    if (agentOpts.schema) {
      if (label === "mint") return { stdout: JSON.stringify({ sessionUlid: "01TESTULID0000000000000000" }) };
      if (label.startsWith("persona:dev")) return { stdout: JSON.stringify({ systemPrompt: "DEV-PERSONA" }) };
      if (label.startsWith("persona:reviewer")) return { stdout: JSON.stringify({ systemPrompt: "REV-PERSONA" }) };
      if (label === "worktree-reap") return { stdout: JSON.stringify({ reaped: [] }) };
      if (label === "orphan-scan") return { stdout: JSON.stringify({ orphans: [] }) };
      if (label.startsWith("claim:")) return { stdout: JSON.stringify({ next: "queue-emptied" }) };
      return { stdout: JSON.stringify({ _unstubbed: label }) };
    }
    return "";
  };

  const logs: string[] = [];
  const log = (line: string) => logs.push(String(line));
  const phase = (_name: string) => { /* no-op */ };
  const notify = (_payload: unknown) => { /* no-op */ };

  const args = JSON.stringify({
    targetRepoRoot: "/tmp/target-repo",
    cli: "/tmp/cli.js",
    sessionUlid: "01TESTULID0000000000000000",
    repollDelayMs: 0,
  });

  const fn = new AsyncFunction("args", "agent", "log", "phase", "notify", body);
  let result: any;
  let thrown: unknown = undefined;
  try {
    result = await fn(args, agent, log, phase, notify);
  } catch (e) {
    thrown = e;
  }
  return { result, thrown };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe(
  "run re-polls on waiting-on-in-progress instead of stopping (native:01KTSQXBVE4WEJ2PQKVNHVFPS6)",
  () => {
    it(
      "AC1 — a single-worker run with a B-depends-on-A backlog builds both stories and ends queueEmptied:true",
      async () => {
        const { result, thrown, logs } = await runRunWithDependentStories({
          maxConcurrency: 1,
          repollDelayMs: 0,
        });

        // The run finished cleanly (did not throw).
        expect(thrown).toBeUndefined();

        // The run ended as a genuine full empty — not prematurely on
        // waiting-on-in-progress or any other early-stop outcome.
        expect(result.runReason).toBe("queue-emptied");
        expect(result.queueEmptied).toBe(true);

        // Both stories were accounted for in the run's outcome buckets.
        // A and B each land in either completed (+ possibly pausedForHuman)
        // or blocked — never silently dropped.
        const pausedRefs = new Set(result.pausedForHuman.map((p: any) => p.ref));
        const mergedRefs = new Set(result.merged.map((m: any) => m.ref));
        const blockedRefs = new Set(result.blocked.map((b: any) => b.ref));
        const completedRefs = new Set(result.completed);

        const inSomeBucket = (ref: string) =>
          completedRefs.has(ref) ||
          pausedRefs.has(ref) ||
          mergedRefs.has(ref) ||
          blockedRefs.has(ref);

        expect(inSomeBucket(REF_A), `${REF_A} must appear in an outcome bucket`).toBe(true);
        expect(inSomeBucket(REF_B), `${REF_B} must appear in an outcome bucket`).toBe(true);

        // The run narrated both stories being claimed.
        const claimedLines = logs.filter((l) => l.startsWith("claimed "));
        expect(claimedLines.some((l) => l.includes(REF_A))).toBe(true);
        expect(claimedLines.some((l) => l.includes(REF_B))).toBe(true);
      },
      15_000,
    );

    it(
      "AC2 — the waiting-on-in-progress signal triggers a bounded re-poll; runReason is queue-emptied, not waiting-on-in-progress",
      async () => {
        // Two workers: worker 0 claims and builds A; worker 1 tries to claim
        // while A is in progress, sees waiting-on-in-progress, and re-polls
        // until A finishes. After A finishes, worker 1 picks up B and builds it.
        // The key assertion: runReason is queue-emptied (not the terminal
        // waiting-on-in-progress that the pre-fix code would have recorded).
        const { result, thrown, waitingLogCount } = await runRunWithDependentStories({
          maxConcurrency: 2,
          repollDelayMs: 0,
        });

        expect(thrown).toBeUndefined();

        // The run reason MUST be queue-emptied — not waiting-on-in-progress.
        // Before the fix, the run would record waiting-on-in-progress as a
        // terminal reason and stop. After the fix, it re-polls and eventually
        // reaches queue-emptied.
        expect(result.runReason).toBe("queue-emptied");
        expect(result.runReason).not.toBe("waiting-on-in-progress");

        // The WAITING log line was emitted at least once, proving the re-poll
        // branch was exercised (not just skipped over or never hit).
        expect(waitingLogCount).toBeGreaterThanOrEqual(1);
      },
      15_000,
    );

    it(
      "AC3 — a genuinely empty queue ends promptly as a clean, fully-emptied finish",
      async () => {
        const { result, thrown } = await runRunEmptyQueue();

        expect(thrown).toBeUndefined();

        // A truly empty queue must produce a clean run — no re-polling loop,
        // no false WAITING, no blocking. queueEmptied:true and runReason:'queue-emptied'.
        expect(result.runReason).toBe("queue-emptied");
        expect(result.queueEmptied).toBe(true);

        // No stories were claimed (everything is empty).
        expect(result.completed).toHaveLength(0);
        expect(result.pausedForHuman).toHaveLength(0);
        expect(result.merged).toHaveLength(0);
        expect(result.blocked).toHaveLength(0);
      },
      10_000,
    );

    it(
      "AC3 — a two-worker run with a B-depends-on-A backlog also ends queueEmptied:true",
      async () => {
        // Verify the fix works under concurrency too (maxConcurrency: 2): a second
        // worker that sees waiting-on-in-progress while worker 0 builds A must
        // re-poll and pick up B once A finishes, rather than stopping the whole run.
        const { result, thrown } = await runRunWithDependentStories({
          maxConcurrency: 2,
          repollDelayMs: 0,
        });

        expect(thrown).toBeUndefined();
        expect(result.runReason).toBe("queue-emptied");
        expect(result.queueEmptied).toBe(true);

        const inSomeBucket = (ref: string) => {
          const pausedRefs = new Set(result.pausedForHuman.map((p: any) => p.ref));
          const mergedRefs = new Set(result.merged.map((m: any) => m.ref));
          const blockedRefs = new Set(result.blocked.map((b: any) => b.ref));
          const completedRefs = new Set(result.completed);
          return completedRefs.has(ref) || pausedRefs.has(ref) || mergedRefs.has(ref) || blockedRefs.has(ref);
        };

        expect(inSomeBucket(REF_A)).toBe(true);
        expect(inSomeBucket(REF_B)).toBe(true);
      },
      15_000,
    );
  },
);
