/**
 * Drain progress-heartbeat integration test — Story 8.18, AC3.
 *
 * AC3: the progress lines are emitted through the existing narrator channel and
 *      change NO control flow — the set of result buckets (completed / merged /
 *      pausedForHuman / blocked) and the drain reason for a run are identical
 *      with and without the new lines. This existing-style drain integration
 *      test (seams stubbed) asserts the run's structured result is unchanged and
 *      that the new progress lines appear in the captured narrator output.
 *
 * How it runs the real workflow: `drain.workflow.js` is a plain script body that
 * reaches every decision through injected globals — `args` (a JSON string),
 * `agent` (the subagent/seam courier), `log` (the operator narrator), and
 * `phase` (the phase marker). It uses top-level `await` and top-level `return`.
 * We read the real workflow source and wrap it in an `AsyncFunction` whose
 * parameters ARE those globals, so the body runs verbatim with our stubs. This
 * is the "existing-style drain integration test (with seams stubbed)" the AC
 * asks for: nothing in the workflow is mocked — only its injected seam surface.
 *
 * The clock seams (`drainPhaseStart`/`drainPhaseDone`) are exercised for real:
 * the stub invokes the actual tool functions, so the asserted progress lines are
 * the lines the production tools produce, not test-local fabrications.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { drainPhaseStart, drainPhaseDone, } from "../drain-phase-progress.js";
import { LONG_PHASE_MARKER } from "../../lib/format-drain-progress.js";
// ── Locate the real workflow source ────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
// src/tools/__tests__ → up to mcp-server → up to plugins/crew → workflows/.
const WORKFLOW_PATH = resolve(HERE, "../../../../workflows/drain.workflow.js");
const AsyncFunction = Object.getPrototypeOf(async () => { }).constructor;
/**
 * Drive the real workflow body with stubbed seams. Returns the workflow's
 * structured result, the captured narrator lines, and the captured agent calls.
 *
 * `withHeartbeat` controls whether the progress seams (drainPhaseStart/Done) are
 * served their real lines or treated as no-ops — the two runs must produce an
 * IDENTICAL structured result (AC3's "change no control flow"), differing only
 * in the narrator output.
 */
async function runDrain(opts) {
    // The runtime evaluates the workflow body with injected globals; it has no
    // module scope, so the top-level `export const meta = …` (runtime metadata,
    // not load-bearing for a run) is stripped to a plain `const` before wrapping.
    const source = readFileSync(WORKFLOW_PATH, "utf8").replace(/^export\s+const\s+meta\b/m, "const meta");
    const body = `${source}\n//# sourceURL=drain.workflow.js`;
    const logs = [];
    const calls = [];
    const REF = "bmad:8.18";
    const PR = 4242;
    // Seam responses keyed by label PREFIX (labels carry per-story suffixes).
    // Each returns the structured object the CLI tool would print; the stub wraps
    // it as { stdout: JSON } because the workflow's `seam()` parses agent.stdout.
    const seamResult = (label) => {
        if (label === "mint")
            return { sessionUlid: "01TESTULID0000000000000000" };
        if (label.startsWith("persona:dev"))
            return { systemPrompt: "DEV-PERSONA" };
        if (label.startsWith("persona:reviewer"))
            return { systemPrompt: "REV-PERSONA" };
        if (label === "orphan-scan")
            return { orphans: [] };
        if (label.startsWith("claim:")) {
            // First claim hands out the one story; the second drains the queue.
            const idx = Number(label.split(":")[1]);
            if (idx === 0) {
                return {
                    next: "spawn-dev",
                    ref: REF,
                    title: "Drain progress heartbeat through long phases",
                    manifestPath: "/tmp/does-not-matter.yaml",
                };
            }
            return { next: "queue-drained" };
        }
        if (label.startsWith("baseline:"))
            return { dirtyPaths: [] };
        if (label.startsWith("pd:")) {
            return { next: "spawn-reviewer", prNumber: PR, reviewerPrompt: "REV-PERSONA" };
        }
        if (label.startsWith("verdict:"))
            return { next: "done-ready-for-merge" };
        if (label.startsWith("gate:")) {
            return { decision: "pause-needs-human", reason: "no-agreement-history" };
        }
        // Progress seams — exercise the REAL tools so the asserted lines are the
        // production lines. When the heartbeat is "off", behave as a degraded relay
        // (no `line`) so the workflow emits nothing and control flow is unchanged.
        // The label is `progress-<t>:<ref>:<phase>` and the ref itself contains a
        // colon (`bmad:8.18`), so the phase is the LAST colon-segment, not index 2.
        if (label.startsWith("progress-start:")) {
            if (!opts.withHeartbeat)
                return {};
            const phase = label.split(":").pop();
            return drainPhaseStart({ ref: REF, phase: phase });
        }
        if (label.startsWith("progress-done:")) {
            if (!opts.withHeartbeat)
                return {};
            const phase = label.split(":").pop();
            return drainPhaseDone({ ref: REF, phase: phase, startedAtMs: Date.now() - 5000 });
        }
        return { _unstubbed: label };
    };
    const agent = async (prompt, agentOpts = {}) => {
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
    const log = (line) => {
        logs.push(String(line));
    };
    const phase = (_name) => {
        /* phase marker — no-op in the test harness */
    };
    const args = JSON.stringify({
        targetRepoRoot: "/tmp/target-repo",
        cli: "/tmp/cli.js",
        sessionUlid: "01TESTULID0000000000000000",
    });
    const fn = new AsyncFunction("args", "agent", "log", "phase", body);
    const result = await fn(args, agent, log, phase);
    return { result, logs, calls };
}
/** Strip the volatile elapsed-time tail so two runs' logs compare structurally. */
function normaliseLogs(logs) {
    return logs.map((l) => l.replace(/done in .*/, "done in <elapsed>"));
}
describe("drain progress heartbeat (Story 8.18, AC3)", () => {
    it("produces the same structured result with and without the heartbeat lines", async () => {
        const withHb = await runDrain({ withHeartbeat: true });
        const without = await runDrain({ withHeartbeat: false });
        // Identical result buckets and drain reason — the lines change NO control flow.
        expect(withHb.result).toEqual(without.result);
        expect(withHb.result.drainedReason).toBe("queue-drained");
        expect(withHb.result.drained).toBe(true);
        expect(withHb.result.completed).toEqual(["bmad:8.18"]);
        expect(withHb.result.merged).toEqual([]);
        expect(withHb.result.blocked).toEqual([]);
        expect(withHb.result.pausedForHuman).toEqual([
            { ref: "bmad:8.18", prNumber: 4242, reason: "no-agreement-history" },
        ]);
    });
    it("emits the new progress lines through the existing narrator channel", async () => {
        const { logs } = await runDrain({ withHeartbeat: true });
        // Each major phase emits a start line and a done-with-elapsed line.
        // Progress lines use the short handle (local part of the ref), so
        // bmad:8.18 → "8.18" not "bmad:8.18".
        expect(logs.some((l) => l.startsWith("8.18 dev-build: start"))).toBe(true);
        expect(logs.some((l) => /^8\.18 dev-build: done in /.test(l))).toBe(true);
        expect(logs.some((l) => l.startsWith("8.18 review: start"))).toBe(true);
        expect(logs.some((l) => /^8\.18 review: done in /.test(l))).toBe(true);
        expect(logs.some((l) => l.startsWith("8.18 gate: start"))).toBe(true);
        expect(logs.some((l) => /^8\.18 gate: done in /.test(l))).toBe(true);
    });
    it("marks the dev-build start line as the long phase (and not the short phases)", async () => {
        const { logs } = await runDrain({ withHeartbeat: true });
        // Progress lines now use the short handle ("8.18" for bmad:8.18).
        const devStart = logs.find((l) => l.startsWith("8.18 dev-build: start"));
        const reviewStart = logs.find((l) => l.startsWith("8.18 review: start"));
        const gateStart = logs.find((l) => l.startsWith("8.18 gate: start"));
        expect(devStart).toContain(LONG_PHASE_MARKER);
        expect(reviewStart).not.toContain(LONG_PHASE_MARKER);
        expect(gateStart).not.toContain(LONG_PHASE_MARKER);
    });
    it("adds ONLY narrator lines — the non-progress log lines are identical", async () => {
        const withHb = normaliseLogs((await runDrain({ withHeartbeat: true })).logs);
        const without = normaliseLogs((await runDrain({ withHeartbeat: false })).logs);
        // Progress lines now use the short handle ("8.18" for bmad:8.18).
        const isProgress = (l) => /^8\.18 (dev-build|review|gate): (start|done)/.test(l);
        // The heartbeat run's non-progress lines match the baseline run exactly,
        // and the only extra lines are the six progress lines.
        expect(withHb.filter((l) => !isProgress(l))).toEqual(without.filter((l) => !isProgress(l)));
        expect(withHb.filter(isProgress)).toHaveLength(6);
        expect(without.filter(isProgress)).toHaveLength(0);
    });
});
