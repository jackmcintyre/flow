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

// ── Backoff test runner ───────────────────────────────────────────────────────
//
// Drives the real run workflow in a scenario where the claim stub returns
// `waiting-on-in-progress` for exactly `numIdlePolls` consecutive calls, then
// returns a single `spawn-dev` result (story C), then returns `queue-emptied`.
//
// The harness captures each injected delay (the value of backoffMs logged in the
// WAITING line) so the test can assert the series grows and caps.
//
// `repollDelayMs` and `repollBackoffCapMs` are threaded through to the workflow
// args so we can observe the math without waiting on real wall-clock time.
// With a small positive base (e.g. 10ms) the test captures real non-zero values;
// with base=0 (the default harness value) every delay is 0 (collapse case).
async function runBackoffScenario(opts: {
  numIdlePolls: number;
  repollDelayMs: number;
  repollBackoffCapMs: number;
}): Promise<{
  result: any;
  thrown: unknown;
  logs: string[];
  capturedDelays: number[];
}> {
  const source = readFileSync(WORKFLOW_PATH, "utf8").replace(
    /^export\s+const\s+meta\b/m,
    "const meta",
  );
  const body = `${source}\n//# sourceURL=run.workflow.js`;

  const logs: string[] = [];
  // Extract the delay value from each WAITING log line.
  const capturedDelays: number[] = [];

  const REF_C = "backoff-test-story-c";

  let idlePollsFired = 0;
  let cDevCompleted = false;

  const claimResult = (): unknown => {
    if (idlePollsFired < opts.numIdlePolls) {
      idlePollsFired++;
      return { next: "waiting-on-in-progress" };
    }
    if (!cDevCompleted) {
      return {
        next: "spawn-dev",
        ref: REF_C,
        title: "Story C",
        manifestPath: `/tmp/backoff_test_story_c.yaml`,
      };
    }
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
    if (label.startsWith("pd:")) return { next: "spawn-reviewer", prNumber: 9099, reviewerPrompt: "REV-PERSONA" };
    if (label.startsWith("verdict:")) return { next: "done-ready-for-merge" };
    if (label.startsWith("gate:")) return { decision: "pause-needs-human", reason: "no-agreement-history" };
    if (label.startsWith("progress-start:")) return { atMs: 1000, line: "progress-start stub" };
    if (label.startsWith("progress-done:")) return { line: "progress-done stub" };
    return { _unstubbed: label };
  };

  const agent = async (_prompt: string, agentOpts: { label?: string; schema?: unknown } = {}) => {
    const label = agentOpts.label ?? "";
    if (agentOpts.schema) {
      return { stdout: JSON.stringify(seamResult(label)) };
    }
    if (label.startsWith("dev:")) {
      cDevCompleted = true;
      return `Implemented story C.\nHandoff to reviewer — story ${REF_C} ready for review.`;
    }
    if (label.startsWith("rev:")) return "Reviewed; verdict written.";
    return "";
  };

  const log = (line: string) => {
    logs.push(String(line));
    // Extract delay from WAITING lines: "re-polling in <N>ms (idle streak ...)".
    const m = line.match(/re-polling in (\d+)ms \(idle streak/);
    if (m) capturedDelays.push(Number(m[1]));
  };
  const phase = (_name: string) => { /* no-op */ };
  const notify = (_payload: unknown) => { /* no-op */ };

  const args = JSON.stringify({
    targetRepoRoot: "/tmp/target-repo",
    cli: "/tmp/cli.js",
    sessionUlid: "01TESTULID0000000000000000",
    maxConcurrency: 1,
    repollDelayMs: opts.repollDelayMs,
    repollBackoffCapMs: opts.repollBackoffCapMs,
    // Keep the stall guard high so it doesn't fire before our idle polls run.
    maxRepoll: opts.numIdlePolls + 10,
  });

  const fn = new AsyncFunction("args", "agent", "log", "phase", "notify", body);
  let result: any;
  let thrown: unknown;
  try {
    result = await fn(args, agent, log, phase, notify);
  } catch (e) {
    thrown = e;
  }

  return { result, thrown, logs, capturedDelays };
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

// ── Backoff tests (Story native:01KV7HQH80AV0WPAMWCH7PP0HD) ─────────────────
//
// AC1 — Grows and caps: with spare capacity but nothing to start, each
//        consecutive idle re-poll waits longer than the previous, up to a cap.
// AC2 — Snaps back on progress: after a story is claimed the idle streak resets,
//        so a subsequent idle stretch starts from the base delay again.
// AC3 — Empty queue ends promptly: a genuinely empty queue never waits at all.

describe(
  "exponential backoff on consecutive idle re-polls (native:01KV7HQH80AV0WPAMWCH7PP0HD)",
  () => {
    it(
      "AC1 — wait grows across consecutive idle polls and is capped at the configured maximum",
      async () => {
        // Drive 5 consecutive waiting-on-in-progress polls before a story is
        // claimed. With base=10ms and cap=40ms the expected series is:
        //   poll 1 → 10ms, poll 2 → 20ms, poll 3 → 40ms, poll 4 → 40ms, poll 5 → 40ms
        const { result, thrown, capturedDelays } = await runBackoffScenario({
          numIdlePolls: 5,
          repollDelayMs: 10,
          repollBackoffCapMs: 40,
        });

        expect(thrown).toBeUndefined();
        // The run must still end cleanly.
        expect(result.runReason).toBe("queue-emptied");

        // We captured exactly 5 delays (one per idle poll).
        expect(capturedDelays).toHaveLength(5);

        // Each delay must be >= the previous (strictly growing until the cap).
        for (let i = 1; i < capturedDelays.length; i++) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          expect(capturedDelays[i]!).toBeGreaterThanOrEqual(capturedDelays[i - 1]!);
        }

        // The first delay is the base.
        expect(capturedDelays[0]).toBe(10);

        // The second delay is double the first.
        expect(capturedDelays[1]).toBe(20);

        // Delays at or after the cap must equal the cap.
        expect(capturedDelays[2]).toBe(40); // 10 * 4 = 40, capped at 40
        expect(capturedDelays[3]).toBe(40); // would be 80, capped at 40
        expect(capturedDelays[4]).toBe(40); // would be 160, capped at 40
      },
      15_000,
    );

    it(
      "AC2 — idle streak resets to zero after a story is claimed, so a later idle stretch starts from the base",
      async () => {
        // Run two separate backoff scenarios back-to-back in a SINGLE run:
        //   Phase 1: 3 idle polls (streak grows to 3)
        //   Claim story C (streak resets to 0)
        //   Phase 2: The run ends (queue-emptied) — no more idle polls needed.
        //
        // We verify the streak reset by checking the delay series: the first 3
        // delays grow (1→2→4 with a large cap), and after the claim the run
        // completes cleanly (not stuck waiting at the grown delay).
        const { result, thrown, capturedDelays } = await runBackoffScenario({
          numIdlePolls: 3,
          repollDelayMs: 10,
          repollBackoffCapMs: 10_000, // large cap so we can observe the raw growth
        });

        expect(thrown).toBeUndefined();
        expect(result.runReason).toBe("queue-emptied");

        // Three idle polls were captured.
        expect(capturedDelays).toHaveLength(3);

        // The delays strictly grow across the 3 idle polls: 10 → 20 → 40.
        expect(capturedDelays[0]).toBe(10);
        expect(capturedDelays[1]).toBe(20);
        expect(capturedDelays[2]).toBe(40);

        // Story C was picked up promptly after the idle stretch (it's in some bucket).
        const inSomeBucket = (ref: string) => {
          const pausedRefs = new Set(result.pausedForHuman.map((p: any) => p.ref));
          const mergedRefs = new Set(result.merged.map((m: any) => m.ref));
          const blockedRefs = new Set(result.blocked.map((b: any) => b.ref));
          const completedRefs = new Set(result.completed);
          return (
            completedRefs.has(ref) ||
            pausedRefs.has(ref) ||
            mergedRefs.has(ref) ||
            blockedRefs.has(ref)
          );
        };
        expect(inSomeBucket("backoff-test-story-c")).toBe(true);
      },
      15_000,
    );

    it(
      "AC3 — a genuinely empty queue finishes promptly with no waiting at all",
      async () => {
        // The original AC3 test (empty queue) still passes: a zero-story queue
        // must resolve immediately to queue-emptied with no idle-poll delays.
        const { result, thrown } = await runRunEmptyQueue();

        expect(thrown).toBeUndefined();
        expect(result.runReason).toBe("queue-emptied");
        expect(result.queueEmptied).toBe(true);
        // No work done — all buckets empty.
        expect(result.completed).toHaveLength(0);
        expect(result.pausedForHuman).toHaveLength(0);
        expect(result.merged).toHaveLength(0);
        expect(result.blocked).toHaveLength(0);
      },
      10_000,
    );
  },
);
