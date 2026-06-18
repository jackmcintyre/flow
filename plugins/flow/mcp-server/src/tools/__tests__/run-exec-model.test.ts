/**
 * Run execution-model pin test — Story FU6 / native:01KT2PS8A5D13SBDDMKM04VN94.
 *
 * Verifies that the run's dev and reviewer subagents receive the expected
 * model option:
 *
 *   AC1 — with no devReviewerModel arg, both dev and reviewer calls receive
 *         model: 'sonnet' (the default).
 *   AC2 — with devReviewerModel: 'opus' in the launch args, both dev and
 *         reviewer calls receive model: 'opus'.
 *
 * The seam-relay courier calls (label carries 'run', 'persona:', 'claim:',
 * etc., OR agentOpts.schema is present) are NOT dev/reviewer direct calls and
 * must NOT be asserted on model in these ACs.
 *
 * How it runs the real workflow: `run.workflow.js` is a plain script body that
 * reaches every decision through injected globals — `args` (a JSON string),
 * `agent` (the subagent/seam courier), `log` (the operator narrator), and `phase`
 * (the phase marker). It uses top-level `await` and top-level `return`. We read
 * the real workflow source and wrap it in an `AsyncFunction` whose parameters ARE
 * those globals, so the body runs verbatim with our stubs. The same pattern as
 * run-observability-non-fatal.test.ts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
  opts: { label?: string; schema?: unknown; phase?: string; model?: string; isolation?: string };
}

const REF = "native:01TESTEXECMODEL000000000";
const PR = 7272;

/**
 * Drive the real workflow body with stubbed seams.
 * Returns the structured result and the captured agent calls.
 */
async function runRun(extraArgs: Record<string, unknown> = {}): Promise<{
  result: any;
  thrown: unknown;
  calls: AgentCall[];
}> {
  // Strip export const meta to plain const before wrapping in AsyncFunction.
  const source = readFileSync(WORKFLOW_PATH, "utf8").replace(
    /^export\s+const\s+meta\b/m,
    "const meta",
  );
  const body = `${source}\n//# sourceURL=run.workflow.js`;

  const calls: AgentCall[] = [];

  // Seam responses keyed by label PREFIX. Each returns the structured object
  // the CLI tool would print; the stub wraps it as { stdout: JSON } because
  // the workflow's seam() parses agent.stdout.
  const seamResult = (label: string): unknown => {
    if (label === "mint") return { sessionUlid: "01TESTULID0000000000000000" };
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
          title: "Pin the run's dev and reviewer to Sonnet by default",
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
    // Progress seams — return minimal valid shapes; not what we're asserting here.
    if (label.startsWith("progress-start:")) return { atMs: Date.now(), line: `${REF} phase: start` };
    if (label.startsWith("progress-done:")) return { line: `${REF} phase: done (0ms)` };
    // clean-root-guard
    if (label.startsWith("clean-root-guard:")) return { dirty: false, paths: [] };
    return { _unstubbed: label };
  };

  const agent = async (prompt: string, agentOpts: AgentCall["opts"] = {}) => {
    calls.push({ prompt, opts: agentOpts });
    const label = agentOpts.label ?? "";

    // A SEAM call carries `schema`; it must return { stdout: <json line> }.
    if (agentOpts.schema) {
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

  const log = (_line: string) => { /* no-op — not asserting on logs here */ };
  const phase = (_name: string) => { /* phase marker — no-op in the test harness */ };

  const args = JSON.stringify({
    targetRepoRoot: "/tmp/target-repo",
    cli: "/tmp/cli.js",
    sessionUlid: "01TESTULID0000000000000000",
    ...extraArgs,
  });

  const fn = new AsyncFunction("args", "agent", "log", "phase", body);
  let result: any;
  let thrown: unknown = undefined;
  try {
    result = await fn(args, agent, log, phase);
  } catch (e) {
    thrown = e;
  }
  return { result, thrown, calls };
}

/** Filter captured calls to only the direct dev: and rev: agent calls (no schema). */
function devAndReviewerCalls(calls: AgentCall[]): AgentCall[] {
  return calls.filter(
    (c) =>
      !c.opts.schema &&
      (c.opts.label?.startsWith("dev:") || c.opts.label?.startsWith("rev:")),
  );
}

describe("run execution-model pin (FU6 / native:01KT2PS8A5D13SBDDMKM04VN94)", () => {
  it("AC1: with no devReviewerModel arg, dev and reviewer calls both receive model: 'sonnet'", async () => {
    const { result, thrown, calls } = await runRun();

    // Run completed without throwing.
    expect(thrown).toBeUndefined();

    // The run ran to completion (queue emptied, one story processed).
    expect(result.runReason).toBe("queue-emptied");
    expect(result.queueEmptied).toBe(true);

    // At least one dev: and one rev: call must have been made.
    const direct = devAndReviewerCalls(calls);
    expect(direct.length).toBeGreaterThanOrEqual(2);

    // Every dev: and rev: call must carry model: 'sonnet'.
    for (const c of direct) {
      expect(c.opts.model).toBe("sonnet");
    }
  });

  it("AC2: with devReviewerModel: 'opus', dev and reviewer calls both receive model: 'opus'", async () => {
    const { result, thrown, calls } = await runRun({ devReviewerModel: "opus" });

    // Run completed without throwing.
    expect(thrown).toBeUndefined();

    // The run ran to completion.
    expect(result.runReason).toBe("queue-emptied");
    expect(result.queueEmptied).toBe(true);

    // At least one dev: and one rev: call must have been made.
    const direct = devAndReviewerCalls(calls);
    expect(direct.length).toBeGreaterThanOrEqual(2);

    // Every dev: and rev: call must carry model: 'opus'.
    for (const c of direct) {
      expect(c.opts.model).toBe("opus");
    }
  });
});
