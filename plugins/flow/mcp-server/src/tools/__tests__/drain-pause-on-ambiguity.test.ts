/**
 * Drain pause-on-ambiguity integration test — Story 8.19 AC2 + AC3.
 *
 * AC2: a story paused for a human decision lands in the human-needed result
 *      bucket (pausedForHuman) carrying its question text and ref; the dev does
 *      NOT open a PR or guess an implementation for it; and the drain continues
 *      to the next claimable story rather than halting the whole run. This drain
 *      integration test (seams stubbed) drives one ambiguous story and one
 *      normal story and asserts the ambiguous one appears in the human-needed
 *      bucket with its question and the normal one still completes.
 *
 * AC3: when a story pauses for a human decision, the drain emits an operator
 *      notification naming the ref and the question through the notification
 *      seam the run supports. The test injects a notifier seam and asserts a
 *      notification carrying the ref and question is emitted when a story pauses,
 *      and that NO notification is emitted for a story that completes normally.
 *
 * Harness shape (mirrors drain-progress-heartbeat.test.ts): `drain.workflow.js`
 * is a plain script body that reaches every decision through injected globals.
 * We read the real workflow source and wrap it in an `AsyncFunction` whose
 * parameters ARE those globals, so the body runs verbatim against our stubs.
 * Nothing in the workflow is mocked — only its injected seam surface. We
 * additionally inject a `notify` global (the notification seam the run supports)
 * and capture every notification it receives.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Locate the real workflow source ────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(HERE, "../../../../workflows/drain.workflow.js");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** A single captured agent/seam invocation. */
interface AgentCall {
  prompt: string;
  opts: { label?: string; schema?: unknown; phase?: string; model?: string };
}

/** A single captured notification payload. */
interface NotifyCall {
  kind: string;
  ref: string;
  question: string;
  line: string;
}

const AMBIGUOUS_REF = "bmad:8.19";
const NORMAL_REF = "bmad:8.20";
const NORMAL_PR = 4242;
const QUESTION =
  "Should the cap default to per-run or per-story? The two diverge on a crashed-resume and change operator-visible behaviour.";

/**
 * Drive the real workflow body with stubbed seams: an ambiguous story (the dev
 * emits the needs-human-decision signal instead of the handoff) followed by a
 * normal story (clean handoff → review → green verdict). Returns the workflow's
 * structured result plus captured narrator lines, agent calls, and notifications.
 */
async function runDrain(): Promise<{
  result: any;
  logs: string[];
  calls: AgentCall[];
  notifications: NotifyCall[];
}> {
  const source = readFileSync(WORKFLOW_PATH, "utf8").replace(
    /^export\s+const\s+meta\b/m,
    "const meta",
  );
  const body = `${source}\n//# sourceURL=drain.workflow.js`;

  const logs: string[] = [];
  const calls: AgentCall[] = [];
  const notifications: NotifyCall[] = [];

  const seamResult = (label: string): unknown => {
    if (label === "mint") return { sessionUlid: "01TESTULID0000000000000000" };
    if (label.startsWith("persona:dev")) return { systemPrompt: "DEV-PERSONA" };
    if (label.startsWith("persona:reviewer")) return { systemPrompt: "REV-PERSONA" };
    if (label === "orphan-scan") return { orphans: [] };
    if (label.startsWith("claim:")) {
      const idx = Number(label.split(":")[1]);
      // First claim → the ambiguous story; second → the normal story; third drains.
      if (idx === 0) {
        return {
          next: "spawn-dev",
          ref: AMBIGUOUS_REF,
          title: "Drain pauses and pings the operator on genuine ambiguity",
          manifestPath: "/tmp/ambiguous.yaml",
        };
      }
      if (idx === 1) {
        return {
          next: "spawn-dev",
          ref: NORMAL_REF,
          title: "A normal story that completes cleanly",
          manifestPath: "/tmp/normal.yaml",
        };
      }
      return { next: "queue-drained" };
    }
    if (label.startsWith("baseline:")) return { dirtyPaths: [] };
    // The ambiguity routing seam (only fired for the ambiguous story): the real
    // processDevTranscript contract — return the human-needed outcome + question.
    if (label.startsWith("pd-needs-human:")) {
      return { next: "done-needs-human-decision", question: QUESTION };
    }
    // The normal handoff parse seam (fired for the normal story).
    if (label.startsWith("pd:")) {
      return { next: "spawn-reviewer", prNumber: NORMAL_PR, reviewerPrompt: "REV-PERSONA" };
    }
    if (label.startsWith("verdict:")) return { next: "done-ready-for-merge" };
    if (label.startsWith("gate:")) {
      return { decision: "pause-needs-human", reason: "no-agreement-history" };
    }
    // Progress seams degrade to no-ops (no `line`) — irrelevant to this test.
    if (label.startsWith("progress-start:")) return {};
    if (label.startsWith("progress-done:")) return {};
    return { _unstubbed: label };
  };

  const agent = async (prompt: string, agentOpts: AgentCall["opts"] = {}) => {
    calls.push({ prompt, opts: agentOpts });
    const label = agentOpts.label ?? "";
    if (agentOpts.schema) {
      return { stdout: JSON.stringify(seamResult(label)) };
    }
    // DEV agent: the ambiguous story emits the needs-human signal (no handoff);
    // the normal story hands off cleanly.
    if (label.startsWith(`dev:${AMBIGUOUS_REF}`)) {
      return `I scaffolded the change but hit a real fork the AC does not settle.\nneeds-human-decision: ${QUESTION}`;
    }
    if (label.startsWith(`dev:${NORMAL_REF}`)) {
      return `Implemented and built green.\nHandoff to reviewer — story ${NORMAL_REF} ready for review.`;
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
    /* no-op */
  };
  // The injected notification seam the run supports (AC3): capture every payload.
  const notify = (payload: NotifyCall) => {
    notifications.push(payload);
  };

  const args = JSON.stringify({
    targetRepoRoot: "/tmp/target-repo",
    cli: "/tmp/cli.js",
    sessionUlid: "01TESTULID0000000000000000",
  });

  const fn = new AsyncFunction("args", "agent", "log", "phase", "notify", body);
  const result = await fn(args, agent, log, phase, notify);
  return { result, logs, calls, notifications };
}

describe("drain pause-on-ambiguity (Story 8.19 AC2 + AC3)", () => {
  it("files the ambiguous story into the human-needed bucket with its question, and the normal story still completes", async () => {
    const { result } = await runDrain();

    // The whole run did not halt — it drained the queue to empty.
    expect(result.drainedReason).toBe("queue-drained");
    expect(result.drained).toBe(true);

    // AC2: the ambiguous story is in pausedForHuman carrying ref + verbatim question.
    const paused = result.pausedForHuman.find((p: any) => p.ref === AMBIGUOUS_REF);
    expect(paused).toBeDefined();
    expect(paused.reason).toBe("needs-human-decision");
    expect(paused.question).toBe(QUESTION);

    // The ambiguous story is NOT blocked and NOT completed.
    expect(result.blocked.some((b: any) => b.ref === AMBIGUOUS_REF)).toBe(false);
    expect(result.completed).not.toContain(AMBIGUOUS_REF);

    // AC2: the normal story still completes (and reaches its own human-merge pause).
    expect(result.completed).toContain(NORMAL_REF);
    expect(
      result.pausedForHuman.some(
        (p: any) => p.ref === NORMAL_REF && p.prNumber === NORMAL_PR,
      ),
    ).toBe(true);
  });

  it("does NOT open a PR or run review/gate for the paused story", async () => {
    const { calls } = await runDrain();

    // No reviewer spawn for the ambiguous story (review is skipped — it paused).
    const ambiguousReviewer = calls.find(
      (c) => (c.opts.label ?? "").startsWith(`rev:${AMBIGUOUS_REF}`),
    );
    expect(ambiguousReviewer).toBeUndefined();

    // No verdict/gate seam for the ambiguous story.
    expect(
      calls.some((c) => (c.opts.label ?? "").startsWith(`verdict:${AMBIGUOUS_REF}`)),
    ).toBe(false);
    expect(
      calls.some((c) => (c.opts.label ?? "").startsWith(`gate:${AMBIGUOUS_REF}`)),
    ).toBe(false);

    // The dev was NOT instructed to re-run on the ambiguous story (single dev call).
    const ambiguousDevCalls = calls.filter(
      (c) => (c.opts.label ?? "").startsWith(`dev:${AMBIGUOUS_REF}`),
    );
    expect(ambiguousDevCalls).toHaveLength(1);

    // The normal story DID reach its reviewer + gate (it completed).
    expect(
      calls.some((c) => (c.opts.label ?? "").startsWith(`rev:${NORMAL_REF}`)),
    ).toBe(true);
    expect(
      calls.some((c) => (c.opts.label ?? "").startsWith(`gate:${NORMAL_REF}`)),
    ).toBe(true);
  });

  it("emits an operator notification naming the ref and question when a story pauses — and none for a story that completes normally", async () => {
    const { notifications, logs } = await runDrain();

    // AC3: exactly one notification, for the paused story, carrying ref + question.
    expect(notifications).toHaveLength(1);
    const n = notifications[0]!;
    expect(n.kind).toBe("needs-human-decision");
    expect(n.ref).toBe(AMBIGUOUS_REF);
    expect(n.question).toBe(QUESTION);

    // No notification fired for the normal story.
    expect(notifications.some((x) => x.ref === NORMAL_REF)).toBe(false);

    // The notification also surfaced through the narrator (the always-available
    // channel) carrying ref + question — so the operator sees it even if no
    // dedicated notifier is wired.
    const narratorLine = logs.find(
      (l) => l.includes("NEEDS HUMAN") && l.includes(AMBIGUOUS_REF),
    );
    expect(narratorLine).toBeDefined();
    expect(narratorLine).toContain(QUESTION);
  });

  it("the run is safe when NO notifier seam is injected — it still pauses and surfaces through the narrator", async () => {
    // Re-run the workflow WITHOUT the `notify` param to prove the typeof guard
    // keeps the workflow from throwing when the runtime exposes no notifier.
    const source = readFileSync(WORKFLOW_PATH, "utf8").replace(
      /^export\s+const\s+meta\b/m,
      "const meta",
    );
    const body = `${source}\n//# sourceURL=drain.workflow.js`;

    const logs: string[] = [];
    const seamResult = (label: string): unknown => {
      if (label === "mint") return { sessionUlid: "01TESTULID0000000000000000" };
      if (label.startsWith("persona:dev")) return { systemPrompt: "DEV-PERSONA" };
      if (label.startsWith("persona:reviewer")) return { systemPrompt: "REV-PERSONA" };
      if (label === "orphan-scan") return { orphans: [] };
      if (label.startsWith("claim:")) {
        const idx = Number(label.split(":")[1]);
        if (idx === 0) {
          return {
            next: "spawn-dev",
            ref: AMBIGUOUS_REF,
            title: "Ambiguous",
            manifestPath: "/tmp/ambiguous.yaml",
          };
        }
        return { next: "queue-drained" };
      }
      if (label.startsWith("baseline:")) return { dirtyPaths: [] };
      if (label.startsWith("pd-needs-human:")) {
        return { next: "done-needs-human-decision", question: QUESTION };
      }
      if (label.startsWith("progress-start:")) return {};
      if (label.startsWith("progress-done:")) return {};
      return { _unstubbed: label };
    };
    const agent = async (_prompt: string, agentOpts: AgentCall["opts"] = {}) => {
      const label = agentOpts.label ?? "";
      if (agentOpts.schema) return { stdout: JSON.stringify(seamResult(label)) };
      if (label.startsWith(`dev:${AMBIGUOUS_REF}`)) {
        return `Hit a fork.\nneeds-human-decision: ${QUESTION}`;
      }
      return "";
    };
    const log = (line: string) => logs.push(String(line));
    const phase = (_name: string) => {};
    const args = JSON.stringify({
      targetRepoRoot: "/tmp/target-repo",
      cli: "/tmp/cli.js",
      sessionUlid: "01TESTULID0000000000000000",
    });

    // No `notify` param — the workflow must not throw on the undeclared global.
    const fn = new AsyncFunction("args", "agent", "log", "phase", body);
    const result: any = await fn(args, agent, log, phase);

    expect(result.drainedReason).toBe("queue-drained");
    const paused = result.pausedForHuman.find((p: any) => p.ref === AMBIGUOUS_REF);
    expect(paused).toBeDefined();
    expect(paused.question).toBe(QUESTION);
    expect(
      logs.some((l) => l.includes("NEEDS HUMAN") && l.includes(QUESTION)),
    ).toBe(true);
  });
});
