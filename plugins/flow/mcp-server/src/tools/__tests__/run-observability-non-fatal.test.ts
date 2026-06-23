/**
 * Run observability-seam non-fatal integration test — Story 8.21.
 *
 * Story 8.18 added the progress heartbeat: a start line and an elapsed done line
 * bracketing each major per-story phase (dev-build, review, gate), emitted through
 * the same one-shot subagent courier the load-bearing steps use. The 8.18 wrappers
 * already degrade gracefully on a *garbled* (non-JSON) relay — they fall back to no
 * line — but neither the wrappers nor `processStory` caught a *hard rejection* from
 * the underlying courier call, and `processStory` is awaited with no surrounding
 * guard. So a hard failure on one of the six observability calls per story would
 * propagate and abort the entire run — the opposite of what an observability-only
 * feature should be able to do.
 *
 * Story 8.21 makes the read-only / observability seams swallow their own hard
 * rejection (degrade to no line, exactly like the garble path), while keeping the
 * mutating seams (claim / verdict / gate) fail-loud so a real failure still pauses
 * or blocks that one story with no silent success.
 *
 *   AC1 — an observability seam that hard-fails (throws) does not propagate; the
 *         story proceeds to its normal outcome bucket.
 *   AC2 — a run where EVERY progress seam throws produces an IDENTICAL structured
 *         result (buckets + run reason) to a run where they succeed, differing
 *         only in the absence of the progress lines (strengthening 8.18's
 *         equivalence guarantee from garble-only to hard-failure).
 *   AC3 — the swallow-guard is scoped to observability seams only: a load-bearing
 *         MUTATING step that hard-fails still surfaces — the story lands in a
 *         blocked outcome carrying the failure reason, never silently swallowed or
 *         treated as a success.
 *
 * How it runs the real workflow: `run.workflow.js` is a plain script body that
 * reaches every decision through injected globals — `args` (a JSON string),
 * `agent` (the subagent/seam courier), `log` (the operator narrator), and `phase`
 * (the phase marker). It uses top-level `await` and top-level `return`. We read
 * the real workflow source and wrap it in an `AsyncFunction` whose parameters ARE
 * those globals, so the body runs verbatim with our stubs. Nothing in the workflow
 * is mocked — only its injected seam surface. The progress seams run the REAL
 * run-phase tools so the asserted lines are the production lines.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runPhaseStart, runPhaseDone } from "../run-phase-progress.js";

// ── Locate the real workflow source ────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
// src/tools/__tests__ → up to mcp-server → up to plugins/flow → workflows/.
const WORKFLOW_PATH = resolve(HERE, "../../../../workflows/internal/run.workflow.js");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** A single captured agent/seam invocation. */
interface AgentCall {
  prompt: string;
  opts: { label?: string; schema?: unknown; phase?: string; model?: string };
}

const REF = "bmad:8.21";
const PR = 9191;

interface RunOpts {
  /** When true, every progress-heartbeat seam (start AND done) hard-throws. */
  progressThrows?: boolean;
  /**
   * When set, the seam whose label starts with this prefix is served a GARBLED
   * (non-JSON) relay — the seam layer's existing fail-loud channel for a mutating
   * step. Used by AC3 to prove a load-bearing failure is NOT swallowed.
   */
  garbleSeamPrefix?: string;
}

/**
 * Drive the real workflow body with stubbed seams. Returns the workflow's
 * structured result (or the thrown error), the captured narrator lines, and the
 * captured agent calls.
 */
async function runRun(opts: RunOpts = {}): Promise<{
  result: any;
  thrown: unknown;
  logs: string[];
  calls: AgentCall[];
}> {
  // The runtime evaluates the workflow body with injected globals; it has no
  // module scope, so the top-level `export const meta = …` is stripped to a plain
  // `const` before wrapping.
  const source = readFileSync(WORKFLOW_PATH, "utf8").replace(
    /^export\s+const\s+meta\b/m,
    "const meta",
  );
  const body = `${source}\n//# sourceURL=run.workflow.js`;

  const logs: string[] = [];
  const calls: AgentCall[] = [];

  // Seam responses keyed by label PREFIX (labels carry per-story suffixes). Each
  // returns the structured object the CLI tool would print; the stub wraps it as
  // { stdout: JSON } because the workflow's `seam()` parses agent.stdout.
  const seamResult = (label: string): unknown => {
    if (label === "mint") return { sessionUlid: "01TESTULID0000000000000000" };
    // Story native:01KVS0ZW2GYSN25VC45GWNA4MG — pre-flight checklist stubs.
    if (label === "preflight:standards") return { standards: { state: "ok", path: "/tmp/target-repo/docs/standards.md" } };
    if (label === "preflight:remote") return { hasRemote: true };
    // Story native:01KVPQS1DVJE41KNG065D6X1X7 — slot resolution stubs.
    if (label === "slot:build") return { role: "generalist-dev", isDefault: true };
    if (label === "slot:review") return { role: "generalist-reviewer", isDefault: true };
    if (label.startsWith("persona:dev")) return { systemPrompt: "DEV-PERSONA" };
    if (label.startsWith("persona:reviewer")) return { systemPrompt: "REV-PERSONA" };
    if (label === "worktree-reap") return { reaped: [] };
    if (label === "orphan-scan") return { orphans: [] };
    if (label.startsWith("claim:")) {
      const idx = Number(label.split(":")[1]);
      if (idx === 0) {
        return {
          next: "spawn-dev",
          ref: REF,
          title: "Run observability seams are non-fatal to the run",
          manifestPath: "/tmp/does-not-matter.yaml",
        };
      }
      return { next: "queue-emptied" };
    }
    if (label.startsWith("pd:")) {
      return { next: "spawn-reviewer", prNumber: PR, reviewerPrompt: "REV-PERSONA" };
    }
    if (label.startsWith("verdict:")) return { next: "done-ready-for-merge" };
    if (label.startsWith("gate:")) {
      return { decision: "pause-needs-human", reason: "no-agreement-history" };
    }
    // Progress seams — exercise the REAL tools so the asserted lines are the
    // production lines. (The throw branch is handled in `agent`, below.)
    if (label.startsWith("progress-start:")) {
      const phase = label.split(":").pop();
      return runPhaseStart({ ref: REF, phase: phase as any });
    }
    if (label.startsWith("progress-done:")) {
      const phase = label.split(":").pop();
      return runPhaseDone({ ref: REF, phase: phase as any, startedAtMs: Date.now() - 5000 });
    }
    return { _unstubbed: label };
  };

  const agent = async (prompt: string, agentOpts: AgentCall["opts"] = {}) => {
    calls.push({ prompt, opts: agentOpts });
    const label = agentOpts.label ?? "";

    // HARD rejection of an OBSERVABILITY seam (AC1/AC2): the underlying courier
    // call throws/rejects rather than returning a garbled line.
    if (
      opts.progressThrows &&
      (label.startsWith("progress-start:") || label.startsWith("progress-done:"))
    ) {
      throw new Error(`courier hard-failed for ${label}`);
    }

    // A SEAM call carries `schema`; it must return { stdout: <json line> }.
    if (agentOpts.schema) {
      // GARBLE a chosen MUTATING seam (AC3): return a non-JSON line so the seam
      // layer's existing _parseError fail-loud channel fires (no silent success).
      if (opts.garbleSeamPrefix && label.startsWith(opts.garbleSeamPrefix)) {
        return { stdout: "<<not json — courier returned a garbled relay>>" };
      }
      return { stdout: JSON.stringify(seamResult(label)) };
    }
    // A DIRECT agent call (dev / reviewer) returns a plain final-message string.
    if (label.startsWith("dev:")) {
      return `Implemented the story.\nHandoff to reviewer — story ${REF} ready for review.`;
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

  const args = JSON.stringify({
    targetRepoRoot: "/tmp/target-repo",
    cli: "/tmp/cli.js",
    sessionUlid: "01TESTULID0000000000000000",
  });

  const fn = new AsyncFunction("args", "agent", "log", "phase", body);
  let result: any;
  let thrown: unknown = undefined;
  try {
    result = await fn(args, agent, log, phase);
  } catch (e) {
    thrown = e;
  }
  return { result, thrown, logs, calls };
}

/** The six per-story progress labels the heartbeat emits. */
const PROGRESS_LABEL = /^seam progress-(start|done):/;
function isProgressLogLine(l: string): boolean {
  // Progress lines use the short handle (local part of the ref).
  // bmad:8.21 → short handle "8.21"
  return /^8\.21 (dev-build|review|gate): (start|done)/.test(l);
}

describe("run observability seams are non-fatal (Story 8.21)", () => {
  it("AC1: a progress seam that hard-throws does not escape; the story still reaches its bucket", async () => {
    const { result, thrown, logs } = await runRun({ progressThrows: true });

    // No exception escaped the run.
    expect(thrown).toBeUndefined();

    // The story still reached its normal outcome bucket (gate paused for a human),
    // exactly as if the heartbeat line had simply been suppressed.
    expect(result.runReason).toBe("queue-emptied");
    expect(result.queueEmptied).toBe(true);
    expect(result.completed).toEqual([REF]);
    expect(result.blocked).toEqual([]);
    expect(result.pausedForHuman).toEqual([
      { ref: REF, prNumber: PR, reason: "no-agreement-history" },
    ]);

    // The swallowed hard failure emits a single quiet diagnostic line (so the
    // operator knows the heartbeat degraded) and NO progress line.
    expect(logs.some((l) => PROGRESS_LABEL.test(l) && /hard-failed.*swallowed/.test(l))).toBe(true);
    expect(logs.some(isProgressLogLine)).toBe(false);
  });

  it("AC2: a run where every progress seam throws is structurally identical to one where they succeed", async () => {
    const succeed = await runRun({});
    const throwAll = await runRun({ progressThrows: true });

    // Neither run threw.
    expect(succeed.thrown).toBeUndefined();
    expect(throwAll.thrown).toBeUndefined();

    // Identical structured result — buckets AND run reason — proving the
    // observability hard-failure changes NO control flow.
    expect(throwAll.result).toEqual(succeed.result);
    expect(succeed.result.runReason).toBe("queue-emptied");

    // The ONLY difference is the absence of the progress lines: the succeed run
    // emits the six heartbeat lines; the throw-all run emits none of them.
    expect(succeed.logs.filter(isProgressLogLine)).toHaveLength(6);
    expect(throwAll.logs.filter(isProgressLogLine)).toHaveLength(0);

    // Stripping the progress lines (and the swallow-diagnostic lines) from both,
    // the remaining narrator output is identical.
    const stripObs = (logs: string[]) =>
      logs.filter((l) => !isProgressLogLine(l) && !PROGRESS_LABEL.test(l));
    expect(stripObs(throwAll.logs)).toEqual(stripObs(succeed.logs));
  });

  it("AC3: a load-bearing mutating step that hard-fails still surfaces — NOT completed, reason preserved", async () => {
    // Inject a hard failure into the MUTATING verdict seam (swallow=false). The
    // seam layer's fail-loud _parseError channel must fire — the story must NOT be
    // treated as a success, and the failure reason must be preserved in its bucket.
    const { result, thrown } = await runRun({ garbleSeamPrefix: "verdict:" });

    // The mutating failure surfaces as a real outcome — the run did not silently
    // swallow it (it never reached the green-verdict completion path).
    expect(thrown).toBeUndefined();
    expect(result.completed).toEqual([]);
    expect(result.merged).toEqual([]);
    expect(result.pausedForHuman).toEqual([]);

    // The affected story lands in `blocked` carrying the failure reason — proving
    // the observability swallow-guard cannot mask a load-bearing failure.
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].ref).toBe(REF);
    expect(typeof result.blocked[0].blocked_by).toBe("string");
    expect(result.blocked[0].blocked_by.length).toBeGreaterThan(0);
  });
});
