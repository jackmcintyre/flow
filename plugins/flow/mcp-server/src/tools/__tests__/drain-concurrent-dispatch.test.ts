/**
 * Drain concurrent-dispatch integration test — Story 8.22.
 *
 * AC1 — the main drain loop processes more than one claimed story at a time, up
 *       to a configured cap (`maxConcurrency`): given a backlog larger than the
 *       cap, at most `cap` stories are in flight at once, more than one IS in
 *       flight simultaneously, and every story is processed exactly once.
 * AC2 — concurrency changes throughput only, not the result: for a fixed backlog
 *       and fixed per-story outcomes, the result buckets and the drain reason are
 *       identical at cap 1 (serial) and cap N (concurrent), modulo the order of
 *       entries within a bucket.
 * AC3 — a per-worker hard failure is isolated: one worker that throws lands its
 *       story in the blocked/paused bucket with its reason preserved, and never
 *       aborts the run or disturbs a concurrently-running sibling — every sibling
 *       still reaches its correct bucket.
 *
 * How it runs the real workflow (same harness as drain-progress-heartbeat.test):
 * `drain.workflow.js` is a plain script body that reaches every decision through
 * injected globals — `args` (a JSON string), `agent` (the subagent/seam courier),
 * `log` (the operator narrator), and `phase` (the phase marker). It uses
 * top-level `await` and top-level `return`. We read the real workflow source and
 * wrap it in an `AsyncFunction` whose parameters ARE those globals, so the body
 * runs verbatim with our stubs. Nothing in the workflow is mocked — only its
 * injected seam surface — so the concurrency under test is the production loop's,
 * not a test-local re-implementation.
 *
 * The concurrency is OBSERVED, not faked: each `dev:` agent call (the longest
 * per-story phase) blocks on a test-controlled barrier while we record the live
 * in-flight count and its running maximum, then is released. That lets us assert
 * both ">1 in flight at once" and "never exceeds the cap" against the real loop.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Locate the real workflow source ────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
// src/tools/__tests__ → up to mcp-server → up to plugins/flow → workflows/.
const WORKFLOW_PATH = resolve(HERE, "../../../../workflows/drain.workflow.js");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** A captured agent/seam invocation (label + whether it was a seam). */
interface AgentCall {
  label: string;
  isSeam: boolean;
}

/** The per-story outcome a stubbed seam plan dictates for a ref. */
type Outcome =
  | { kind: "merge" } // verdict green + gate auto-merges → merged
  | { kind: "pause" } // verdict green + gate pauses → completed + pausedForHuman
  | { kind: "needs-changes-then-merge" } // one rework round, then green + auto-merge
  | { kind: "verdict-blocked" } // reviewer blocks (non-rework, non-green verdict)
  | { kind: "dev-no-handoff" } // dev never emits the handoff phrase → blocked
  | { kind: "dev-throws" }; // dev agent() promise rejects → worker-level isolation

interface DrainRunResult {
  result: any;
  logs: string[];
  calls: AgentCall[];
  /** Highest number of `dev:` agent calls in flight at any instant. */
  maxInFlight: number;
  /** Every ref handed out by claimNextStory, in claim order. */
  claimedRefs: string[];
}

const HANDOFF = (ref: string) => `Handoff to reviewer — story ${ref} ready for review.`;

/**
 * Drive the real workflow body with stubbed seams against a backlog whose
 * per-story outcomes are fixed by `outcomes`.
 *
 * @param backlog   ordered list of refs the claim seam hands out (then drains).
 * @param outcomes  ref → fixed outcome the stubbed seams replay.
 * @param maxConcurrency  the cap passed to the workflow.
 * @param gateDev   when true, every `dev:` call blocks on a shared barrier until
 *                  `cap` of them are simultaneously in flight, then all release —
 *                  this forces real overlap so AC1's in-flight assertions are
 *                  meaningful (without it a fast stub could finish each dev before
 *                  the next is claimed and never overlap).
 */
async function runDrain(opts: {
  backlog: string[];
  outcomes: Record<string, Outcome>;
  maxConcurrency: number;
  gateDev?: boolean;
}): Promise<DrainRunResult> {
  const { backlog, outcomes, maxConcurrency, gateDev = false } = opts;

  // The runtime evaluates the workflow body with injected globals; it has no
  // module scope, so the top-level `export const meta = …` is stripped to a
  // plain `const` before wrapping.
  const source = readFileSync(WORKFLOW_PATH, "utf8").replace(
    /^export\s+const\s+meta\b/m,
    "const meta",
  );
  const body = `${source}\n//# sourceURL=drain.workflow.js`;

  const logs: string[] = [];
  const calls: AgentCall[] = [];
  const claimedRefs: string[] = [];
  // Per-ref rework counter so a "needs-changes-then-merge" story returns
  // NEEDS-CHANGES on its first verdict and READY-FOR-MERGE on its second.
  const verdictRound: Record<string, number> = {};

  // ── Live-concurrency instrumentation ─────────────────────────────────────
  let inFlight = 0;
  let maxInFlight = 0;
  // Barrier: when gating dev, a dev call parks until `release` is fired; the
  // releaser fires once enough dev calls have arrived to prove overlap up to the
  // expected ceiling (min(cap, backlog)). It always eventually fires so the run
  // can never hang even if fewer devs arrive than expected (e.g. early blocks).
  const expectedCeiling = Math.min(maxConcurrency, backlog.length);
  let releaseAll: () => void = () => {};
  const allReleased = new Promise<void>((r) => {
    releaseAll = r;
  });
  let arrived = 0;
  const onDevArrive = () => {
    arrived++;
    if (gateDev && arrived >= expectedCeiling) releaseAll();
  };

  // Resolve a label's ref. The workflow builds per-story labels as
  // `<prefix><ref>:<rw>[:resume]` (dev / pd / verdict) or `gate:<ref>` (no rw).
  // The ref itself may contain colons AND a numeric final segment (`s:1`), so we
  // strip EXACTLY the known trailing suffixes once each — an optional `:resume`
  // recover tag, then exactly one `:<digits>` rework index — never a greedy
  // numeric pop (which would eat the ref's own `:1`).
  const refFromLabel = (label: string, prefix: string): string => {
    let rest = label.slice(prefix.length); // `<ref>:<rw>[:resume]` or `<ref>`
    rest = rest.replace(/:resume$/, ""); // recover-phase tag, if present
    if (prefix !== "gate:") rest = rest.replace(/:\d+$/, ""); // the single rework index
    return rest;
  };

  // PR number is deterministic per ref so assertions are stable.
  const prFor = (ref: string): number =>
    1000 + backlog.indexOf(ref) * 7;

  // Shared claim cursor: concurrent claims each take the next distinct ref. The
  // workflow's own claimsStarted counter enforces the cap; the label index is a
  // reservation slot, not a guaranteed position, so we serve from this cursor.
  let claimCursor = 0;

  const seamResult = (label: string): unknown => {
    if (label === "mint") return { sessionUlid: "01TESTULID0000000000000000" };
    if (label.startsWith("persona:dev")) return { systemPrompt: "DEV-PERSONA" };
    if (label.startsWith("persona:reviewer")) return { systemPrompt: "REV-PERSONA" };
    if (label === "worktree-reap") return { reaped: [] };
    if (label === "orphan-scan") return { orphans: [] };
    if (label.startsWith("claim:")) {
      // Hand out backlog refs in order, then drain the queue. The workflow's own
      // claimsStarted counter is what enforces the cap; the index in the label is
      // a reservation slot, NOT a guaranteed position, so serve from a shared
      // cursor instead so concurrent claims each get the next distinct ref.
      if (claimCursor < backlog.length) {
        const ref = backlog[claimCursor++]!;
        claimedRefs.push(ref);
        return {
          next: "spawn-dev",
          ref,
          title: `story ${ref}`,
          manifestPath: `/tmp/${ref.replace(/[^a-z0-9]/gi, "_")}.yaml`,
        };
      }
      return { next: "queue-drained" };
    }
    if (label.startsWith("pd:")) {
      const ref = refFromLabel(label, "pd:");
      return { next: "spawn-reviewer", prNumber: prFor(ref), reviewerPrompt: "REV-PERSONA" };
    }
    if (label.startsWith("verdict:")) {
      const ref = refFromLabel(label, "verdict:");
      const o = outcomes[ref]!;
      if (o.kind === "verdict-blocked") return { next: "blocked-something" };
      if (o.kind === "needs-changes-then-merge") {
        const round = (verdictRound[ref] ??= 0);
        verdictRound[ref] = round + 1;
        return round === 0
          ? { next: "done-blocked-reviewer-needs-changes" }
          : { next: "done-ready-for-merge" };
      }
      return { next: "done-ready-for-merge" };
    }
    if (label.startsWith("gate:")) {
      const ref = refFromLabel(label, "gate:");
      const o = outcomes[ref]!;
      // Both "merge" and "needs-changes-then-merge" are GREEN by the time they
      // reach the gate → auto-merge; "pause" is green-verdict-but-gate-pauses.
      return o.kind === "merge" || o.kind === "needs-changes-then-merge"
        ? { decision: "auto-merge" }
        : { decision: "pause-needs-human", reason: "no-agreement-history" };
    }
    // Progress heartbeat seams degrade to no line (off) — pure observability.
    if (label.startsWith("progress-start:")) return {};
    if (label.startsWith("progress-done:")) return {};
    return { _unstubbed: label };
  };

  const agent = async (prompt: string, agentOpts: { label?: string; schema?: unknown } = {}) => {
    const label = agentOpts.label ?? "";
    const isSeam = Boolean(agentOpts.schema);
    calls.push({ label, isSeam });
    if (isSeam) {
      return { stdout: JSON.stringify(seamResult(label)) };
    }
    // DIRECT agent call (dev / reviewer).
    if (label.startsWith("dev:")) {
      const ref = refFromLabel(label, "dev:");
      const o = outcomes[ref]!;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      onDevArrive();
      try {
        // Force real overlap: park until the barrier releases (it fires once
        // `cap` dev calls have arrived, proving concurrency up to the ceiling).
        if (gateDev) await allReleased;
        // Yield once more so siblings interleave even without the barrier.
        await Promise.resolve();
        if (o.kind === "dev-throws") throw new Error(`injected dev crash for ${ref}`);
        if (o.kind === "dev-no-handoff") {
          return `Worked on ${ref} but did not finish cleanly.`;
        }
        return `Implemented ${ref}.\n${HANDOFF(ref)}`;
      } finally {
        inFlight--;
      }
    }
    if (label.startsWith("rev:")) {
      return "Reviewed; verdict written to reviewer-result.json.";
    }
    return "";
  };

  const log = (line: string) => {
    logs.push(String(line));
  };
  const phase = (_name: string) => {
    /* phase marker — no-op */
  };

  const args = JSON.stringify({
    targetRepoRoot: "/tmp/target-repo",
    cli: "/tmp/cli.js",
    sessionUlid: "01TESTULID0000000000000000",
    maxConcurrency,
  });

  const fn = new AsyncFunction("args", "agent", "log", "phase", body);
  const result = await fn(args, agent, log, phase);
  return { result, logs, calls, maxInFlight, claimedRefs };
}

/** Sort each bucket so two runs compare modulo intra-bucket ordering (AC2). */
function normaliseBuckets(result: any) {
  const byRef = (a: any, b: any) => String(a.ref ?? a).localeCompare(String(b.ref ?? b));
  return {
    drainedReason: result.drainedReason,
    drained: result.drained,
    completed: [...(result.completed ?? [])].sort(),
    merged: [...(result.merged ?? [])].sort(byRef),
    pausedForHuman: [...(result.pausedForHuman ?? [])].sort(byRef),
    blocked: [...(result.blocked ?? [])].sort(byRef),
  };
}

describe("drain concurrent dispatch (Story 8.22)", () => {
  // A backlog of several stories, all happily merging. Cap below the backlog
  // size so the cap is the binding constraint.
  const sixRefs = ["s:1", "s:2", "s:3", "s:4", "s:5", "s:6"];
  const allMerge: Record<string, Outcome> = Object.fromEntries(
    sixRefs.map((r) => [r, { kind: "merge" } as Outcome]),
  );

  it("AC1: runs more than one story at once, never exceeds the cap, and processes each exactly once", async () => {
    const cap = 3;
    const run = await runDrain({
      backlog: sixRefs,
      outcomes: allMerge,
      maxConcurrency: cap,
      gateDev: true,
    });

    // More than one in flight simultaneously (genuine concurrency)…
    expect(run.maxInFlight).toBeGreaterThan(1);
    // …but never more than the cap.
    expect(run.maxInFlight).toBeLessThanOrEqual(cap);
    // For a backlog > cap the loop should actually reach the ceiling.
    expect(run.maxInFlight).toBe(cap);

    // Every story processed EXACTLY once: claimed once each, no duplicates, no misses.
    expect([...run.claimedRefs].sort()).toEqual([...sixRefs].sort());
    expect(run.claimedRefs.length).toBe(sixRefs.length);
    expect(new Set(run.claimedRefs).size).toBe(sixRefs.length);

    // Each ref ran its dev exactly once (one `dev:<ref>:0` call per story).
    for (const ref of sixRefs) {
      const devCalls = run.calls.filter((c) => !c.isSeam && c.label.startsWith(`dev:${ref}:`));
      expect(devCalls).toHaveLength(1);
    }

    // All landed in merged (the fixed outcome), and nowhere else.
    expect(normaliseBuckets(run.result).merged.map((m: any) => m.ref)).toEqual([...sixRefs].sort());
    expect(run.result.blocked).toEqual([]);
    expect(run.result.pausedForHuman).toEqual([]);
    expect(run.result.drainedReason).toBe("queue-drained");
    expect(run.result.drained).toBe(true);
  });

  it("AC1: cap of 1 stays strictly serial (never more than one in flight)", async () => {
    const run = await runDrain({
      backlog: sixRefs,
      outcomes: allMerge,
      maxConcurrency: 1,
      // gateDev would deadlock at cap 1 (ceiling 1 releases immediately — fine),
      // but leave it off to assert genuine serial execution with no barrier help.
    });
    expect(run.maxInFlight).toBe(1);
    expect([...run.claimedRefs].sort()).toEqual([...sixRefs].sort());
  });

  it("AC2: identical result buckets and drain reason at cap 1 vs cap N (modulo intra-bucket order)", async () => {
    // A mixed, fixed outcome set exercising every bucket: merge, pause,
    // rework-then-merge, reviewer-block, dev-no-handoff.
    const refs = ["s:1", "s:2", "s:3", "s:4", "s:5"];
    const outcomes: Record<string, Outcome> = {
      "s:1": { kind: "merge" },
      "s:2": { kind: "pause" },
      "s:3": { kind: "needs-changes-then-merge" },
      "s:4": { kind: "verdict-blocked" },
      "s:5": { kind: "dev-no-handoff" },
    };

    const serial = await runDrain({ backlog: refs, outcomes, maxConcurrency: 1 });
    const concurrent = await runDrain({ backlog: refs, outcomes, maxConcurrency: 4, gateDev: false });

    // The two structured results are equal, modulo intra-bucket ordering.
    expect(normaliseBuckets(concurrent.result)).toEqual(normaliseBuckets(serial.result));

    // And the buckets are what the fixed outcomes dictate (sanity on the harness).
    const n = normaliseBuckets(serial.result);
    expect(n.drainedReason).toBe("queue-drained");
    expect(n.merged.map((m: any) => m.ref)).toEqual(["s:1", "s:3"]); // merge + rework-then-merge
    expect(n.pausedForHuman.map((p: any) => p.ref)).toEqual(["s:2"]);
    expect(n.completed.sort()).toEqual(["s:1", "s:2", "s:3"]); // every green verdict completes
    expect(n.blocked.map((b: any) => b.ref).sort()).toEqual(["s:4", "s:5"]);
    // Each blocked entry preserved its reason verbatim.
    const block4 = n.blocked.find((b: any) => b.ref === "s:4");
    const block5 = n.blocked.find((b: any) => b.ref === "s:5");
    expect(block4.blocked_by).toBe("blocked-something");
    expect(block5.blocked_by).toBe("dev-no-handoff");
  });

  it("AC2: the same total story COUNT is processed at cap 1 and cap N (none lost or double-counted)", async () => {
    const refs = ["s:1", "s:2", "s:3", "s:4", "s:5", "s:6", "s:7"];
    const outcomes = Object.fromEntries(refs.map((r) => [r, { kind: "merge" } as Outcome]));
    const serial = await runDrain({ backlog: refs, outcomes, maxConcurrency: 1 });
    const concurrent = await runDrain({ backlog: refs, outcomes, maxConcurrency: 5, gateDev: true });

    const count = (r: any) =>
      (r.completed?.length ?? 0) + (r.merged?.length ?? 0) +
      (r.pausedForHuman?.length ?? 0) + (r.blocked?.length ?? 0);

    // merged is the only terminal bucket here; completed mirrors it. Total
    // distinct stories is the backlog size in both runs.
    expect(serial.claimedRefs.length).toBe(refs.length);
    expect(concurrent.claimedRefs.length).toBe(refs.length);
    expect(new Set(concurrent.claimedRefs).size).toBe(refs.length);
    expect(count(serial.result)).toBe(count(concurrent.result));
    expect(concurrent.result.merged.map((m: any) => m.ref).sort()).toEqual([...refs].sort());
  });

  it("AC3: a worker that hard-fails is isolated — the run completes, the failure is bucketed with its reason, and every sibling reaches its bucket", async () => {
    // s:3's dev agent throws mid-flight. Siblings span the other buckets.
    const refs = ["s:1", "s:2", "s:3", "s:4", "s:5"];
    const outcomes: Record<string, Outcome> = {
      "s:1": { kind: "merge" },
      "s:2": { kind: "pause" },
      "s:3": { kind: "dev-throws" }, // ← the hard failure
      "s:4": { kind: "merge" },
      "s:5": { kind: "pause" },
    };

    const run = await runDrain({
      backlog: refs,
      outcomes,
      maxConcurrency: 5, // all five concurrently → the throw happens alongside live siblings
      gateDev: true,
    });

    // The run COMPLETED (did not abort) with the honest drain reason.
    expect(run.result.drainedReason).toBe("queue-drained");
    expect(run.result.drained).toBe(true);

    // The failed story is bucketed (blocked) carrying a reason — not lost, not faked-success.
    const failed = run.result.blocked.find((b: any) => b.ref === "s:3");
    expect(failed).toBeDefined();
    expect(failed.blocked_by).toBe("worker-threw");
    expect(typeof failed.tail).toBe("string");
    expect(failed.tail).toContain("injected dev crash for s:3");

    // Every SIBLING still reached its correct bucket — the throw disturbed none.
    const merged = run.result.merged.map((m: any) => m.ref).sort();
    expect(merged).toEqual(["s:1", "s:4"]);
    const paused = run.result.pausedForHuman.map((p: any) => p.ref).sort();
    expect(paused).toEqual(["s:2", "s:5"]);

    // Exactly one story is blocked (only s:3) — the failure neither cascaded nor
    // double-bucketed a sibling.
    expect(run.result.blocked.map((b: any) => b.ref)).toEqual(["s:3"]);

    // All five stories were claimed exactly once even though one crashed.
    expect([...run.claimedRefs].sort()).toEqual([...refs].sort());
  });

  it("AC3: a hard failure under concurrency still lets the cap recycle — later stories beyond the cap are reached", async () => {
    // Backlog larger than the cap; one early story throws. The pool must keep
    // claiming so stories beyond the first `cap` are still reached and bucketed.
    const refs = ["s:1", "s:2", "s:3", "s:4", "s:5", "s:6"];
    const outcomes: Record<string, Outcome> = {
      "s:1": { kind: "dev-throws" },
      "s:2": { kind: "merge" },
      "s:3": { kind: "merge" },
      "s:4": { kind: "merge" },
      "s:5": { kind: "merge" },
      "s:6": { kind: "merge" },
    };
    const run = await runDrain({ backlog: refs, outcomes, maxConcurrency: 2 });

    expect(run.result.drainedReason).toBe("queue-drained");
    expect(run.result.blocked.map((b: any) => b.ref)).toEqual(["s:1"]);
    // All five healthy stories merged — the early crash did not stall the pool.
    expect(run.result.merged.map((m: any) => m.ref).sort()).toEqual([
      "s:2",
      "s:3",
      "s:4",
      "s:5",
      "s:6",
    ]);
    expect([...run.claimedRefs].sort()).toEqual([...refs].sort());
  });
});
