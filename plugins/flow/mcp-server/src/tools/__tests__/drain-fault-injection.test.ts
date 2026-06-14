/**
 * Drain fault-injection integration test — native:01KT19N3H7WZCF1SKQSWDGARF4.
 *
 * Proves the unattended drain reports every story it picks up HONESTLY when one
 * of its seams misbehaves: under any single injected fault the run still finishes
 * on its own and lands every claimed ref in exactly one outcome bucket
 * (completed / merged / pausedForHuman / blocked) with a stated reason — never
 * zero, never two — and a run-level drain reason, rather than throwing.
 *
 * This is ADDITIVE test infrastructure only. There is NO production-behaviour
 * change to the drain: the harness runs the real `drain.workflow.js` body
 * VERBATIM through the existing AsyncFunction runner, exactly as
 * drain-observability-non-fatal.test.ts does. That means it runs the production
 * bounded `drainWorker` concurrency pool
 * (`await Promise.allSettled(Array.from({length: workerCount}, …))`) AND each
 * worker's per-worker try/catch backstop — so faults are exercised against the
 * production loop, never a single-story shortcut. A hard reject from a mutating
 * seam is therefore CAUGHT by `drainWorker` and bucketed as
 * `blocked: { ref, blocked_by: 'worker-threw', … }`; it does not escape the run.
 *
 * The runner here GENERALISES the four-global runner the reference test uses
 * (`args`, `agent`, `log`, `phase`) to inject a FIFTH global — `notify` — so the
 * needs-human pause notification (drain.workflow.js notifyHumanNeeded) can be
 * asserted to carry the story ref and the verbatim question.
 *
 * The AC ↔ test map:
 *   AC1 — honesty invariant under every injected fault: exactly-one-bucket,
 *         non-empty reason, drainedReason set, run did not throw.
 *   AC2 — a scrambled / non-JSON relay to the step that records a story's result
 *         (verdict / gate, both mutating) → that story is paused-or-blocked with
 *         the reason naming that step, the run keeps going and finishes the rest.
 *   AC3 — under a concurrent run (maxConcurrency: 2), one story hits an outright
 *         hard failure deep in processing → blocked with `worker-threw`, while
 *         the sibling finishes normally; one failure never aborts the run.
 *   AC4 — a story that genuinely needs a decision → paused for the human AND a
 *         notify payload delivered carrying the story ref + the exact question.
 *   AC5 — a purely-informational status seam (the progress heartbeat) failing →
 *         identical buckets + reasons to a clean run, differing only by the
 *         dropped status line.
 *
 * How it runs the real workflow: `drain.workflow.js` is a plain script body that
 * reaches every decision through injected globals. We read the real source and
 * wrap it in an AsyncFunction whose parameters ARE those globals, so the body
 * runs verbatim with our stubs. Nothing in the workflow is mocked — only its
 * injected seam surface.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { drainPhaseStart, drainPhaseDone } from "../drain-phase-progress.js";

// ── Locate the real workflow source ────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
// src/tools/__tests__ → up to mcp-server → up to plugins/flow → workflows/.
const WORKFLOW_PATH = resolve(HERE, "../../../../workflows/drain.workflow.js");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** A single captured agent/seam invocation. */
interface AgentCall {
  prompt: string;
  opts: { label?: string; schema?: unknown; phase?: string; model?: string };
}

/** A single captured notify() payload. */
interface NotifyPayload {
  kind?: string;
  ref?: string;
  question?: string;
  line?: string;
}

/** A queued story the claim seam hands out, in order. */
interface QueuedStory {
  ref: string;
  title: string;
}

interface DrainOpts {
  /** Stories the `claim:` seam hands out in order; an empty queue → queue-drained. */
  queue?: QueuedStory[];
  /** Concurrency for the main drain loop (the workflow's maxConcurrency arg). */
  maxConcurrency?: number;
  /**
   * Feed a GARBLED (non-JSON) relay to the seam whose label, after the prefix, is
   * scoped to this ref — keyed `{ ref, prefix }`. Used for the mutating
   * garble sub-case (verdict / gate). A null-ref entry garbles by prefix only.
   */
  garble?: { ref?: string; prefix: string };
  /**
   * Hard-throw the underlying courier call for the seam whose label starts with
   * `prefix` AND is scoped to `ref` (when set). Used for the mutating hard-reject
   * (AC3) and the observability hard-fail (AC5).
   */
  throwSeam?: { ref?: string; prefix: string };
  /** Refs that should drive the needs-human-decision path, → their verbatim question. */
  needsHuman?: Record<string, string>;
  /**
   * What the `claim:` seam returns once the queue is exhausted. Default
   * `"queue-drained"` (the happy terminal). Set `"waiting-on-in-progress"` to
   * simulate a manifest WEDGED in in-progress/ with no live owner — the
   * non-termination scenario the re-poll guard must escape (Bug 1).
   */
  claimAfterQueue?: "queue-drained" | "waiting-on-in-progress";
  /** Re-poll delay (ms) for waiting-on-in-progress. Tests pass 0 to avoid sleeping. */
  repollDelayMs?: number;
  /** Consecutive no-active-worker re-poll cap before the run exits stalled-in-progress. */
  maxRepoll?: number;
}

/**
 * Does `label` belong to story `ref`? Drain seam labels for a story carry the ref
 * as a colon-segment (e.g. `verdict:bmad:8.30:0` or `gate:bmad:8.30`). The ref
 * itself contains a colon (`native:01…`/`bmad:8.30`), so we substring-match the
 * ref rather than split on `:`.
 */
function labelForRef(label: string, ref?: string): boolean {
  if (!ref) return true;
  return label.includes(ref);
}

/**
 * Drive the real workflow body with stubbed seams. Returns the workflow's
 * structured result (or the thrown error), the captured narrator lines, the
 * captured agent calls, and the captured notify payloads.
 */
async function runDrain(opts: DrainOpts = {}): Promise<{
  result: any;
  thrown: unknown;
  logs: string[];
  calls: AgentCall[];
  notifications: NotifyPayload[];
}> {
  // The runtime evaluates the workflow body with injected globals; it has no
  // module scope, so the top-level `export const meta = …` is stripped to a plain
  // `const` before wrapping.
  const source = readFileSync(WORKFLOW_PATH, "utf8").replace(
    /^export\s+const\s+meta\b/m,
    "const meta",
  );
  const body = `${source}\n//# sourceURL=drain.workflow.js`;

  const queue = opts.queue ?? [];
  const needsHuman = opts.needsHuman ?? {};

  const logs: string[] = [];
  const calls: AgentCall[] = [];
  const notifications: NotifyPayload[] = [];

  // Map each claim index to the story it hands out (in queue order); past the
  // queue length the claim seam reports the genuine full-drain outcome.
  const storyForClaimIdx = (idx: number): unknown => {
    const s = queue[idx];
    if (!s) return { next: opts.claimAfterQueue ?? "queue-drained" };
    return {
      next: "spawn-dev",
      ref: s.ref,
      title: s.title,
      manifestPath: `/tmp/${s.ref.replace(/[^a-z0-9]/gi, "_")}.yaml`,
    };
  };

  // Recover the ref carried by a per-story seam label by substring-scanning the
  // queue (labels embed the ref, which itself contains a colon).
  const refOfLabel = (label: string): string | undefined =>
    queue.map((s) => s.ref).find((r) => label.includes(r));

  // Seam responses keyed by label PREFIX. Each returns the structured object the
  // CLI tool would print; the stub wraps it as { stdout: JSON } because the
  // workflow's `seam()` parses agent.stdout.
  const seamResult = (label: string): unknown => {
    if (label === "mint") return { sessionUlid: "01TESTULID0000000000000000" };
    if (label.startsWith("persona:dev")) return { systemPrompt: "DEV-PERSONA" };
    if (label.startsWith("persona:reviewer")) return { systemPrompt: "REV-PERSONA" };
    if (label === "worktree-reap") return { reaped: [] };
    if (label === "orphan-scan") return { orphans: [] };
    if (label.startsWith("clean-root-guard:")) return { dirty: false };
    if (label.startsWith("claim:")) {
      const idx = Number(label.split(":")[1]);
      return storyForClaimIdx(idx);
    }
    // processDevTranscript for the needs-human path — the dev signalled the
    // marker; this seam confirms the route and hands back the verbatim question.
    if (label.startsWith("pd-needs-human:")) {
      const ref = refOfLabel(label);
      const question = (ref && needsHuman[ref]) || "(no question text captured)";
      return { next: "done-needs-human-decision", question };
    }
    if (label.startsWith("pd:")) {
      const ref = refOfLabel(label);
      return {
        next: "spawn-reviewer",
        prNumber: prNumberForRef(ref),
        reviewerPrompt: "REV-PERSONA",
      };
    }
    if (label.startsWith("verdict:")) return { next: "done-ready-for-merge" };
    if (label.startsWith("gate:")) {
      return { decision: "pause-needs-human", reason: "no-agreement-history" };
    }
    // fix/drain-isolation-coordination-honesty: completeStory now runs as a drain
    // seam AFTER a confirmed-green gate (the done/ move), and blockStory is the
    // give-up move that pulls an abandoned/red story out of in-progress/.
    if (label.startsWith("complete:")) {
      const ref = refOfLabel(label);
      return { ref, absPath: `/tmp/done/${String(ref).replace(/[^a-z0-9]/gi, "_")}.yaml` };
    }
    if (label.startsWith("block-story:")) {
      const ref = refOfLabel(label);
      return { ref, absPath: `/tmp/blocked/${String(ref).replace(/[^a-z0-9]/gi, "_")}.yaml` };
    }
    // Progress seams — exercise the REAL tools so the asserted lines are the
    // production lines. (The throw branch is handled in `agent`, below.)
    if (label.startsWith("progress-start:")) {
      const phase = label.split(":").pop();
      return drainPhaseStart({ ref: refOfLabel(label) ?? "x", phase: phase as any });
    }
    if (label.startsWith("progress-done:")) {
      const phase = label.split(":").pop();
      return drainPhaseDone({
        ref: refOfLabel(label) ?? "x",
        phase: phase as any,
        startedAtMs: 1000,
      });
    }
    return { _unstubbed: label };
  };

  const agent = async (prompt: string, agentOpts: AgentCall["opts"] = {}) => {
    calls.push({ prompt, opts: agentOpts });
    const label = agentOpts.label ?? "";

    // HARD rejection of the courier call (throwSeam). For an observability seam
    // (swallow=true) the workflow degrades to no line; for a MUTATING seam
    // (swallow=false) seam() re-throws, processStory propagates it, and
    // drainWorker's catch buckets it as worker-threw.
    if (
      opts.throwSeam &&
      label.startsWith(opts.throwSeam.prefix) &&
      labelForRef(label, opts.throwSeam.ref)
    ) {
      throw new Error(`courier hard-failed for ${label}`);
    }

    // A SEAM call carries `schema`; it must return { stdout: <json line> }.
    if (agentOpts.schema) {
      // GARBLE a chosen seam: return a non-JSON line so seam()'s _parseError
      // fail-loud channel fires (mutating seams do not swallow it).
      if (
        opts.garble &&
        label.startsWith(opts.garble.prefix) &&
        labelForRef(label, opts.garble.ref)
      ) {
        return { stdout: "<<not json — courier returned a garbled relay>>" };
      }
      return { stdout: JSON.stringify(seamResult(label)) };
    }
    // A DIRECT agent call (dev / reviewer) returns a plain final-message string.
    if (label.startsWith("dev:")) {
      const ref = refOfLabel(label);
      // NEEDS-HUMAN path: the dev emits the locked marker as its LAST line
      // INSTEAD of the handoff phrase (drain.workflow.js NEEDS_HUMAN_MARKER).
      if (ref && needsHuman[ref] !== undefined) {
        return `Worked the story but hit a genuine decision.\nneeds-human-decision: ${needsHuman[ref]}`;
      }
      return `Implemented the story.\nHandoff to reviewer — story ${ref} ready for review.`;
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
    /* phase marker — no-op in the test harness */
  };
  // The FIFTH global the workflow guards with `typeof notify === 'function'`
  // (drain.workflow.js notifyHumanNeeded). Capturing it lets AC4 assert the
  // pause notification carries the ref + verbatim question.
  const notify = (payload: NotifyPayload) => {
    notifications.push(payload);
  };

  const args = JSON.stringify({
    targetRepoRoot: "/tmp/target-repo",
    cli: "/tmp/cli.js",
    sessionUlid: "01TESTULID0000000000000000",
    ...(opts.maxConcurrency ? { maxConcurrency: opts.maxConcurrency } : {}),
    ...(opts.repollDelayMs !== undefined ? { repollDelayMs: opts.repollDelayMs } : {}),
    ...(opts.maxRepoll !== undefined ? { maxRepoll: opts.maxRepoll } : {}),
  });

  // GENERALISED runner: inject the fifth global `notify` alongside the existing
  // four, so the needs-human pause notification can be captured.
  const fn = new AsyncFunction("args", "agent", "log", "phase", "notify", body);
  let result: any;
  let thrown: unknown = undefined;
  try {
    result = await fn(args, agent, log, phase, notify);
  } catch (e) {
    thrown = e;
  }
  return { result, thrown, logs, calls, notifications };
}

/** Deterministic PR number per ref so multi-story runs carry distinct PRs. */
function prNumberForRef(ref?: string): number {
  let h = 0;
  for (const c of String(ref ?? "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 9000 + (h % 1000);
}

// ── Story refs used across the cases ─────────────────────────────────────────
const REF = "drain-fi-story-1";
const REF_A = "drain-fi-story-a";
const REF_B = "drain-fi-story-b";

/** The six per-story progress labels the heartbeat emits. */
const PROGRESS_LABEL = /^seam progress-(start|done):/;

/**
 * The run-level HONESTY INVARIANT (AC1). Given the set of refs the run CLAIMED,
 * assert each appears in exactly one terminal outcome — never zero, never two —
 * each carrying a non-empty reason where its bucket has one, and that the run
 * returned a drain reason without throwing.
 *
 * Per drain-result-and-exit-reasons.md, `merged`/`pausedForHuman` refs are a
 * subset of `completed`; the gate outcome (merged | pausedForHuman) is the single
 * terminal bucket for a green story, so we do NOT double-count it against
 * `completed`. A green story therefore terminates as EITHER (merged|paused) OR
 * (completed with no gate outcome); a non-green story terminates in `blocked`.
 */
function assertHonestyInvariant(
  result: any,
  thrown: unknown,
  claimedRefs: string[],
): void {
  // The run finished on its own — it did not throw and it set a drain reason.
  expect(thrown).toBeUndefined();
  expect(typeof result.drainedReason).toBe("string");
  expect(result.drainedReason.length).toBeGreaterThan(0);

  const mergedRefs = new Set<string>(result.merged.map((m: any) => m.ref));
  const pausedRefs = new Set<string>(result.pausedForHuman.map((p: any) => p.ref));
  const blockedRefs = new Set<string>(result.blocked.map((b: any) => b.ref));
  const completedRefs = new Set<string>(result.completed);

  for (const ref of claimedRefs) {
    // Terminal buckets, treating the gate outcome as the single bucket for a
    // green story (merged XOR paused), else completed-without-gate, else blocked.
    const gated = mergedRefs.has(ref) || pausedRefs.has(ref);
    const completedNoGate = completedRefs.has(ref) && !gated;
    const isBlocked = blockedRefs.has(ref);

    const terminalCount =
      Number(gated) + Number(completedNoGate) + Number(isBlocked);
    // Exactly one terminal outcome — never zero, never two.
    expect(terminalCount, `ref ${ref} terminal-bucket count`).toBe(1);

    // merged and pausedForHuman are mutually exclusive per ref.
    expect(mergedRefs.has(ref) && pausedRefs.has(ref)).toBe(false);

    // Each bucket that carries a reason carries a NON-EMPTY one.
    if (pausedRefs.has(ref)) {
      const p = result.pausedForHuman.find((x: any) => x.ref === ref);
      expect(typeof p.reason).toBe("string");
      expect(p.reason.length).toBeGreaterThan(0);
    }
    if (isBlocked) {
      const b = result.blocked.find((x: any) => x.ref === ref);
      expect(typeof b.blocked_by).toBe("string");
      expect(b.blocked_by.length).toBeGreaterThan(0);
    }
  }
}

describe("drain fault-injection — honest reporting under misbehaving seams (native:01KT19N3H7WZCF1SKQSWDGARF4)", () => {
  it("AC1: under each injected fault the run finishes itself and reports every story in exactly one outcome with a reason", async () => {
    // A two-story queue exercised under each distinct fault class. Every run must
    // satisfy the honesty invariant for BOTH claimed refs.
    const queue = [
      { ref: REF_A, title: "Story A" },
      { ref: REF_B, title: "Story B" },
    ];

    const faults: Array<{ name: string; opts: DrainOpts }> = [
      { name: "clean (no fault)", opts: { queue, maxConcurrency: 2 } },
      {
        name: "garbled verdict relay on A",
        opts: { queue, maxConcurrency: 2, garble: { ref: REF_A, prefix: "verdict:" } },
      },
      {
        name: "garbled gate relay on A",
        opts: { queue, maxConcurrency: 2, garble: { ref: REF_A, prefix: "gate:" } },
      },
      {
        name: "hard-reject (worker-threw) on A's verdict",
        opts: { queue, maxConcurrency: 2, throwSeam: { ref: REF_A, prefix: "verdict:" } },
      },
      {
        name: "needs-human on A",
        opts: { queue, maxConcurrency: 2, needsHuman: { [REF_A]: "Which migration path do you want?" } },
      },
      {
        name: "observability heartbeat hard-fails",
        opts: { queue, maxConcurrency: 2, throwSeam: { prefix: "progress-" } },
      },
    ];

    for (const { name, opts } of faults) {
      const { result, thrown } = await runDrain(opts);
      // Both claimed refs accounted for, exactly once, with a reason — for EVERY
      // fault class. Annotate failures with the fault name.
      try {
        assertHonestyInvariant(result, thrown, [REF_A, REF_B]);
        // A genuine full drain: the queue emptied (no fault aborts the loop).
        expect(result.drainedReason).toBe("queue-drained");
        expect(result.drained).toBe(true);
      } catch (e) {
        throw new Error(`honesty invariant failed under fault "${name}": ${String(e)}`);
      }
    }
  });

  it("AC2: a garbled VERDICT relay buckets that story in blocked with the verdict-step reason, run keeps going", async () => {
    const queue = [
      { ref: REF_A, title: "Story A (garbled verdict)" },
      { ref: REF_B, title: "Story B (clean)" },
    ];
    const { result, thrown } = await runDrain({
      queue,
      maxConcurrency: 2,
      garble: { ref: REF_A, prefix: "verdict:" },
    });

    expect(thrown).toBeUndefined();
    // A's verdict relay garbled → seam() returns the _parseError sentinel and
    // processStory buckets A in `blocked` WITHOUT aborting (drain.workflow.js
    // verdict branch). The reason names that step (the parse error, surfaced
    // verbatim) — NOT silently dropped.
    const a = result.blocked.find((b: any) => b.ref === REF_A);
    expect(a, "story A should be blocked").toBeDefined();
    expect(typeof a.blocked_by).toBe("string");
    expect(a.blocked_by.length).toBeGreaterThan(0);
    // A never reached the green-verdict completion path.
    expect(result.completed).not.toContain(REF_A);

    // The run kept going and finished the OTHER story cleanly (green → paused
    // at the gate, the Stage-1 expected outcome).
    expect(result.completed).toContain(REF_B);
    expect(result.pausedForHuman.some((p: any) => p.ref === REF_B)).toBe(true);

    // And the run drained.
    expect(result.drainedReason).toBe("queue-drained");
    assertHonestyInvariant(result, thrown, [REF_A, REF_B]);
  });

  it("AC2: a garbled GATE relay (after a green verdict) buckets that story in BLOCKED — a story whose merge gate cannot be confirmed never reaches done/, run keeps going", async () => {
    // fix/drain-isolation-coordination-honesty: a garbled gate relay means the
    // gate decision (incl. the CI-green check) could NOT be confirmed. Under the
    // honesty rebuild a story reaches done/ ONLY on a CONFIRMED-green gate, so an
    // unconfirmable gate must NOT complete or pause-as-merge-ready — it is bucketed
    // BLOCKED (with the gate parse-error reason) and the manifest is moved out of
    // in-progress/. This is the #355 guarantee: nothing unconfirmed looks shippable.
    const queue = [
      { ref: REF_A, title: "Story A (garbled gate)" },
      { ref: REF_B, title: "Story B (clean)" },
    ];
    const { result, thrown } = await runDrain({
      queue,
      maxConcurrency: 2,
      garble: { ref: REF_A, prefix: "gate:" },
    });

    expect(thrown).toBeUndefined();
    // A earned a green verdict but its gate relay garbled → NOT confirmed green →
    // blocked, never completed (done/) and never merged.
    const a = result.blocked.find((b: any) => b.ref === REF_A);
    expect(a, "story A should be blocked (unconfirmable gate)").toBeDefined();
    expect(typeof a.blocked_by).toBe("string");
    expect(a.blocked_by.length).toBeGreaterThan(0);
    expect(result.completed).not.toContain(REF_A);
    expect(result.merged.some((m: any) => m.ref === REF_A)).toBe(false);
    expect(result.pausedForHuman.some((p: any) => p.ref === REF_A)).toBe(false);

    // The other story still finishes normally (green → confirmed → paused at gate).
    expect(result.completed).toContain(REF_B);

    expect(result.drainedReason).toBe("queue-drained");
    assertHonestyInvariant(result, thrown, [REF_A, REF_B]);
  });

  it("AC3: under concurrency, one story's hard failure blocks ONLY it (worker-threw) — the sibling completes and the run never aborts", async () => {
    const queue = [
      { ref: REF_A, title: "Story A (hard-rejects deep in processing)" },
      { ref: REF_B, title: "Story B (clean sibling)" },
    ];
    // Hard-throw the courier for A's MUTATING verdict seam (swallow=false):
    // seam() re-throws, processStory propagates, and drainWorker's per-worker
    // try/catch backstop buckets it as worker-threw. maxConcurrency: 2 puts both
    // stories in flight so we prove the failure does not poison the sibling.
    const { result, thrown } = await runDrain({
      queue,
      maxConcurrency: 2,
      throwSeam: { ref: REF_A, prefix: "verdict:" },
    });

    // The run did NOT abort — the per-worker catch contained the throw.
    expect(thrown).toBeUndefined();

    // A is blocked, with the SPECIFIC worker-threw reason (not merely "some
    // blocked reason") — proving the drainWorker backstop fired, not a path
    // inside processStory.
    const a = result.blocked.find((b: any) => b.ref === REF_A);
    expect(a, "story A should be blocked").toBeDefined();
    expect(a.blocked_by).toBe("worker-threw");
    // The backstop preserves the failure REASON up front (the error message).
    expect(typeof a.tail).toBe("string");
    expect(a.tail.length).toBeGreaterThan(0);

    // The sibling finished normally (green → paused at the gate, Stage-1 happy).
    expect(result.completed).toContain(REF_B);
    expect(result.pausedForHuman.some((p: any) => p.ref === REF_B)).toBe(true);
    expect(result.blocked.some((b: any) => b.ref === REF_B)).toBe(false);

    // And the run still drained the queue.
    expect(result.drainedReason).toBe("queue-drained");
    assertHonestyInvariant(result, thrown, [REF_A, REF_B]);
  });

  it("AC4: a story that genuinely needs a decision pauses for the human AND delivers a notify payload carrying the ref + verbatim question", async () => {
    const QUESTION = "Should the v2 schema drop the legacy `owner` column or keep it nullable?";
    const queue = [{ ref: REF, title: "Story needing a human decision" }];

    const { result, thrown, notifications } = await runDrain({
      queue,
      needsHuman: { [REF]: QUESTION },
    });

    expect(thrown).toBeUndefined();

    // The story is paused for the human, carrying the needs-human reason and the
    // verbatim question (drain.workflow.js needs-human branch).
    const p = result.pausedForHuman.find((x: any) => x.ref === REF);
    expect(p, "story should be paused for a human").toBeDefined();
    expect(p.reason).toBe("needs-human-decision");
    expect(p.question).toBe(QUESTION);
    // It never opened a PR / completed.
    expect(result.completed).not.toContain(REF);
    expect(result.merged.some((m: any) => m.ref === REF)).toBe(false);

    // The injected notify global received a payload carrying the ref AND the
    // exact question — the operator notification is delivered, not dropped.
    const note = notifications.find((n) => n.kind === "needs-human-decision");
    expect(note, "a needs-human-decision notification should be delivered").toBeDefined();
    expect(note!.ref).toBe(REF);
    expect(note!.question).toBe(QUESTION);

    expect(result.drainedReason).toBe("queue-drained");
    assertHonestyInvariant(result, thrown, [REF]);
  });

  it("AC5: a failing INFORMATIONAL status seam drops only its line — buckets + reasons are identical to a clean run", async () => {
    const queue = [
      { ref: REF_A, title: "Story A" },
      { ref: REF_B, title: "Story B" },
    ];

    const clean = await runDrain({ queue, maxConcurrency: 2 });
    // The progress heartbeat is the ONLY swallow=true (informational) seam set;
    // hard-fail every heartbeat call.
    const degraded = await runDrain({
      queue,
      maxConcurrency: 2,
      throwSeam: { prefix: "progress-" },
    });

    // Neither run threw.
    expect(clean.thrown).toBeUndefined();
    expect(degraded.thrown).toBeUndefined();

    // The structured result — buckets AND drain reason — is byte-identical: the
    // cosmetic status hiccup changed what happened to NO story.
    expect(degraded.result).toEqual(clean.result);
    expect(clean.result.drainedReason).toBe("queue-drained");

    // The ONLY observable difference is the dropped status lines: the clean run
    // emits heartbeat lines (a start + done per phase, per story); the degraded
    // run emits none. Stripping the heartbeat + its swallow-diagnostic lines from
    // both leaves identical narrator output.
    const isProgressLine = (l: string): boolean =>
      /(dev-build|review|gate): (start|done)/.test(l);
    expect(clean.logs.filter(isProgressLine).length).toBeGreaterThan(0);
    expect(degraded.logs.filter(isProgressLine).length).toBe(0);

    const stripObs = (logs: string[]) =>
      logs.filter((l) => !isProgressLine(l) && !PROGRESS_LABEL.test(l));
    expect(stripObs(degraded.logs)).toEqual(stripObs(clean.logs));

    assertHonestyInvariant(degraded.result, degraded.thrown, [REF_A, REF_B]);
  });

  it("TERMINATION: a manifest wedged in in-progress/ with no live worker makes the run EXIT (stalled-in-progress), never spin forever", async () => {
    // fix/drain-isolation-coordination-honesty — the non-termination fix.
    //
    // Reproduces the observed hang: a story is given up (here: its verdict relay is
    // garbled → blocked), and thereafter the claim seam reports
    // `waiting-on-in-progress` PERMANENTLY (a manifest stuck in in-progress/ with no
    // live owner). Before the fix the worker re-polled on that signal forever
    // ("lots of claim", ~197 agents, no exit). The re-poll termination guard counts
    // consecutive no-active-worker polls and, past maxRepoll, exits HONESTLY with
    // drainedReason 'stalled-in-progress' instead of spinning.
    //
    // repollDelayMs:0 + a SMALL maxRepoll keep the test fast; the 5s vitest timeout
    // is the safety net — pre-fix this test would TIME OUT (the failing signal).
    const queue = [{ ref: REF_A, title: "Story A (given up, then queue wedges)" }];
    const { result, thrown } = await runDrain({
      queue,
      maxConcurrency: 1,
      // Drive REF_A to a given-up bucket so no worker is processing afterwards.
      garble: { ref: REF_A, prefix: "verdict:" },
      // After REF_A is claimed, every further claim reports a wedged in-progress slot.
      claimAfterQueue: "waiting-on-in-progress",
      repollDelayMs: 0,
      maxRepoll: 5,
    });

    // The run RETURNED (did not throw, did not hang) with the honest stall reason.
    expect(thrown).toBeUndefined();
    expect(result.drainedReason).toBe("stalled-in-progress");
    expect(result.drained).toBe(false);
    // REF_A still landed in exactly one bucket (blocked, from the garbled verdict).
    expect(result.blocked.some((b: any) => b.ref === REF_A)).toBe(true);
  }, 5_000);
});
