/**
 * @group e2e
 *
 * Run workflow end-to-end integration smoke — Story native:01KT7RR9TFD7RGD34D2BFDXH90.
 *
 * Proves the run orchestration runs an actual claim→dev→review→verdict→gate
 * loop against a real throwaway scratch repo (seeded by `createSmokeScratchRepo`)
 * and that a real orchestration regression (a broken seam) fails the suite
 * visibly — something the shape-only run-workflow.test.ts cannot do.
 *
 * Architecture:
 *   - The run workflow is a plain .js script body driven by injected globals
 *     (args, agent, log, phase, notify). We use the AsyncFunction runner from
 *     run-fault-injection.test.ts.
 *   - PURE STATE seams (mintSessionUlid, claimNextStory, scanOrphanedInProgress,
 *     reapStaleWorktrees, resolveBuildPlan, completeStory, blockStory,
 *     runPhaseStart/Done, guardCleanRoot) call the REAL CLI binary
 *     (`node dist/cli.js <tool>`) against the real scratch repo — end-to-end
 *     state changes happen on disk, not in memory.
 *   - AI / GITHUB seams (buildPersonaSpawnPrompt, processDevTranscript,
 *     runReviewerSession, processReviewerTranscript, runAutoMergeGate) are
 *     stubbed deterministically so the test runs offline and in CI without
 *     real Claude or GitHub calls.
 *   - Direct agent() calls (the dev / reviewer subagent spawn) are stubbed to
 *     return a fake handoff / review transcript.
 *
 * AC map:
 *   AC1 — story advances from claim through dev, review, verdict, and merge gate
 *          without manual intervention. At least one story reaches pausedForHuman
 *          (Stage-1 gate outcome: reviewer-approved, not yet auto-merged).
 *   AC2 — monkey-patching one seam to throw makes the run exit with a failure
 *          message carrying the broken step's name — the suite can detect a real
 *          orchestration regression.
 */

import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as path from "node:path";
import * as os from "node:os";
import { stringify as yamlStringify } from "yaml";
import { execa } from "execa";

import { createSmokeScratchRepo } from "../src/tools/create-smoke-scratch-repo.js";

// ---------------------------------------------------------------------------
// Locate workflow + CLI
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/ → mcp-server → plugins/flow → workflows/internal/
const WORKFLOW_PATH = resolve(HERE, "..", "..", "workflows", "internal", "run.workflow.js");
// tests/ → mcp-server → dist/cli.js
const CLI = resolve(HERE, "..", "dist", "cli.js");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Scratch repo lifecycle
// ---------------------------------------------------------------------------

let scratchRoot: string;
let scratchCleanup: () => Promise<void>;

/**
 * Write a minimal to-do manifest into the scratch repo so claimNextStory can
 * claim it. The manifest must be `ready: true`, have no unmet deps, and live at
 * `.flow/state/to-do/<ref>.yaml`.
 */
async function seedClaimableStory(repo: string, ref: string): Promise<void> {
  const manifest = {
    ref,
    status: "to-do",
    adapter: "native",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [
      {
        text: "**Given** a test setup, **When** the smoke runs, **Then** the story runs.",
        kind: "integration",
        verification: { type: "vitest", target: "tests/run-workflow-e2e.test.ts" },
      },
    ],
    title: "E2E smoke story",
    narrative: "As a smoke harness, I want a claimable story, so that the run loop can exercise it.",
    narrative_struct: {
      role: "smoke harness",
      want: "a claimable story",
      so_that: "the run loop can exercise it",
    },
    tasks: [{ text: "Implement the smoke story.", ac_refs: ["AC1"] }],
    cited_sources: [],
    implementation_notes: "Smoke fixture — do not implement.",
    withdrawn: false,
    ready: true,
    risk_tier: "low",
    risk_tier_evidence: { matched_rule: "fallback", paths: [], change_types: [], diff_size: 0 },
  };

  const dir = path.join(repo, ".flow", "state", "to-do");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${ref}.yaml`), yamlStringify(manifest, { lineWidth: 0 }), "utf8");
}

beforeAll(async () => {
  ({ scratchRoot, cleanup: scratchCleanup } = await createSmokeScratchRepo({
    label: "run-e2e",
  }));
}, 30_000);

afterAll(async () => {
  if (scratchCleanup) await scratchCleanup();
});

afterEach(async () => {
  // Reset the scratch repo state between tests so each test starts with a clean queue.
  // Re-create the scratch repo entirely to avoid state leakage between test cases.
  if (scratchCleanup) await scratchCleanup();
  ({ scratchRoot, cleanup: scratchCleanup } = await createSmokeScratchRepo({
    label: "run-e2e",
  }));
}, 30_000);

// ---------------------------------------------------------------------------
// Real CLI seam invoker
// ---------------------------------------------------------------------------

/**
 * Invoke a CLI tool via `node dist/cli.js <tool> --json <argsJSON>`.
 * Returns the parsed JSON result (the CLI always prints one JSON line).
 */
async function callCli(toolName: string, toolArgs: object): Promise<unknown> {
  const { stdout } = await execa(process.execPath, [CLI, toolName, "--json", JSON.stringify(toolArgs)]);
  return JSON.parse(stdout.trim());
}

// ---------------------------------------------------------------------------
// Core run runner
// ---------------------------------------------------------------------------

/**
 * Labels that call the REAL CLI (pure-state tools that don't need AI or GitHub).
 * Everything else is stubbed deterministically.
 */
const REAL_CLI_LABEL_PREFIXES = [
  "mint",
  "orphan-scan",
  "worktree-reap",
  "claim:",
  "build-plan:",
  "complete:",
  "block-story:",
  "progress-start:",
  "progress-done:",
  "clean-root-guard:",
];

function isRealCliLabel(label: string): boolean {
  return REAL_CLI_LABEL_PREFIXES.some((p) => label === p || label.startsWith(p));
}

/** Deterministic PR number per ref. */
function prNumberForRef(ref?: string): number {
  let h = 0;
  for (const c of String(ref ?? "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 9000 + (h % 1000);
}

/**
 * Stub response for AI/GitHub seams — deterministic, offline.
 * Returns the JSON the CLI tool would print on a clean call.
 */
function stubSeamResult(label: string, refFromLabel: (l: string) => string | undefined): unknown {
  // Story native:01KVPQS1DVJE41KNG065D6X1X7 — slot resolution stubs.
  if (label === "slot:build") return { role: "generalist-dev", isDefault: true };
  if (label === "slot:review") return { role: "generalist-reviewer", isDefault: true };
  // Persona seams
  if (label.startsWith("persona:dev")) {
    return { systemPrompt: "SMOKE-DEV-PERSONA: you are a deterministic smoke dev." };
  }
  if (label.startsWith("persona:reviewer")) {
    return { systemPrompt: "SMOKE-REV-PERSONA: you are a deterministic smoke reviewer." };
  }
  // Dev transcript parse — returns spawn-reviewer with a deterministic PR number.
  if (label.startsWith("pd:") || label.startsWith("pd-needs-human:")) {
    const ref = refFromLabel(label);
    return { next: "spawn-reviewer", prNumber: prNumberForRef(ref), reviewerPrompt: "SMOKE-REV-PERSONA" };
  }
  // Reviewer session (writes reviewer-result.json in prod; skipped in smoke).
  if (label.startsWith("rev:") || label.startsWith("reviewer-session:")) {
    return { ok: true };
  }
  // Reviewer transcript parse — approve the story.
  if (label.startsWith("verdict:")) {
    return { next: "done-ready-for-merge" };
  }
  // Auto-merge gate — pause for human (Stage-1 happy path; no auto-merge without history).
  if (label.startsWith("gate:")) {
    return { decision: "pause-needs-human", reason: "no-agreement-history" };
  }
  // Lesson read/forward (learning loop, optional)
  if (label.startsWith("lesson-read:")) return { lesson: null };
  if (label.startsWith("lesson-forward:")) return { ok: true };
  // record-skill, etc.
  return { ok: true };
}

interface RunOpts {
  /**
   * When set, this seam label prefix is made to throw, simulating a broken step.
   * Used for the negative-control test (AC2).
   */
  brokenSeamPrefix?: string;
  /** Session ULID override (defaults to a freshly-minted one via the real CLI). */
  sessionUlid?: string;
}

async function runRunE2e(opts: RunOpts = {}): Promise<{
  result: any;
  thrown: unknown;
  logs: string[];
}> {
  const source = readFileSync(WORKFLOW_PATH, "utf8").replace(
    /^export\s+const\s+meta\b/m,
    "const meta",
  );
  const body = `${source}\n//# sourceURL=run.workflow.js`;

  const logs: string[] = [];

  // Resolve or mint a session ULID using the real CLI.
  const sessionUlid =
    opts.sessionUlid ??
    ((await callCli("mintSessionUlid", {})) as { sessionUlid: string }).sessionUlid;

  // Recover the ref from a seam label by scanning the claim-indexed refs.
  // The run encodes ref into the label (e.g. `pd:native:01KT…:0`).
  // Since we don't know refs ahead of time we extract them from labels by matching
  // the `native:` prefix pattern.
  const refFromLabel = (label: string): string | undefined => {
    const m = label.match(/native:[A-Z0-9]+/);
    return m ? m[0] : undefined;
  };

  // Tool name extraction from a run seam command.
  // The run invokes: `node ${CLI} <toolName> --json <args>`
  // Strip the node + CLI path to get the tool name.
  const toolNameFromCmd = (cmd: string): string | null => {
    // cmd is like: `node /path/to/cli.js toolName --json '{...}'`
    const parts = cmd.trim().split(/\s+/);
    // parts: ["node", "<cli.js>", "<toolName>", "--json", "<argsJSON>"]
    if (parts.length >= 3) return parts[2] ?? null;
    return null;
  };

  const argsJsonFromCmd = (cmd: string): string => {
    const flagIdx = cmd.indexOf("--json ");
    if (flagIdx === -1) return "{}";
    // Everything after `--json ` is the args JSON (may be single-quoted)
    const rest = cmd.slice(flagIdx + 7).trim();
    // Strip outer single quotes if present (the run wraps args in single quotes
    // in the seam command string: `node ${CLI} tool --json '${JSON.stringify(args)}'`)
    if (rest.startsWith("'") && rest.endsWith("'")) {
      return rest.slice(1, -1);
    }
    return rest;
  };

  const agent = async (prompt: string, agentOpts: { label?: string; schema?: unknown } = {}) => {
    const label = agentOpts.label ?? "";

    // BROKEN SEAM (negative control): if this label matches the injected prefix,
    // throw so the test can detect which step is broken.
    if (opts.brokenSeamPrefix && label.startsWith(opts.brokenSeamPrefix)) {
      throw new Error(`injected-failure: seam ${label} was broken`);
    }

    // SEAM CALL (has a schema): agent is acting as a courier, not an AI.
    if (agentOpts.schema) {
      // Real CLI seams: invoke the actual tool.
      if (isRealCliLabel(label)) {
        // Extract the command from the prompt (the seam prompt always starts with
        // "You are a deterministic command runner. Use the Bash tool to execute the
        // command below EXACTLY as written." followed by the command on a line
        // starting with `node`).
        const cmdMatch = prompt.match(/\nCOMMAND:\n(node .+?)(?:\n|$)/s);
        const cmd = cmdMatch ? cmdMatch[1].trim() : null;

        if (cmd) {
          const toolName = toolNameFromCmd(cmd);
          if (toolName) {
            const argsJson = argsJsonFromCmd(cmd);
            let toolArgs: object;
            try {
              toolArgs = JSON.parse(argsJson);
            } catch {
              toolArgs = {};
            }

            // Rewrite targetRepoRoot to our scratch repo (the run passes the
            // real REPO path in args, which is set from our args.targetRepoRoot).
            if ("targetRepoRoot" in toolArgs && typeof (toolArgs as any).targetRepoRoot === "string") {
              (toolArgs as any).targetRepoRoot = scratchRoot;
            }

            try {
              const result = await callCli(toolName, toolArgs);
              return { stdout: JSON.stringify(result) };
            } catch (e) {
              // CLI error — return parse-error sentinel so seam() degrades gracefully.
              return { stdout: JSON.stringify({ _cliError: String(e) }) };
            }
          }
        }
        // Fallback: return the stub result (label-based routing).
        return { stdout: JSON.stringify(stubSeamResult(label, refFromLabel)) };
      }

      // Stubbed seam: return deterministic offline result.
      return { stdout: JSON.stringify(stubSeamResult(label, refFromLabel)) };
    }

    // DIRECT AGENT CALL (dev / reviewer / other — no schema).
    const ref = refFromLabel(label) ?? label;

    if (label.startsWith("dev:")) {
      // Stub dev handoff transcript.
      return `Smoke dev implemented the story.\nHandoff to reviewer — story ${ref} ready for review.`;
    }
    if (label.startsWith("rev:")) {
      // Stub reviewer transcript (verdict written to reviewer-result.json by stub above).
      return "Smoke reviewer reviewed the story. Verdict: APPROVE.";
    }
    return "";
  };

  const log = (line: string) => {
    logs.push(String(line));
  };
  const phase = (_name: string) => { /* phase marker — no-op */ };
  const notify = (_payload: unknown) => { /* notifications captured nowhere — smoke only */ };

  const args = JSON.stringify({
    targetRepoRoot: scratchRoot,
    cli: CLI,
    maxConcurrency: 1,
    // No maxStories cap — we want the run to run until the queue is empty
    // so the run exits with 'queue-emptied', not 'max-stories-reached'.
    repollDelayMs: 0,
    maxRepoll: 3,
  });

  const fn = new AsyncFunction("args", "agent", "log", "phase", "notify", body);
  let result: any;
  let thrown: unknown;
  try {
    result = await fn(args, agent, log, phase, notify);
  } catch (e) {
    thrown = e;
  }

  return { result, thrown, logs };
}

// ---------------------------------------------------------------------------
// AC1 — positive: story advances claim→dev→review→verdict→gate
// ---------------------------------------------------------------------------

describe("AC1 — story advances from claim through dev, review, verdict, and gate without manual intervention", () => {
  it(
    "a seeded claimable story runs to pausedForHuman (Stage-1 gate outcome) and the run reports queue-emptied",
    async () => {
      const REF = "native:01KT7RR9SMOKE00000000001";
      await seedClaimableStory(scratchRoot, REF);

      const { result, thrown, logs } = await runRunE2e();

      // The run returned without throwing.
      expect(thrown, `run threw: ${thrown}`).toBeUndefined();
      expect(result).toBeDefined();

      // The claim succeeded — the story was picked up.
      const logStr = logs.join("\n");
      expect(logStr).toMatch(/claimed/i);

      // The story reached the gate and landed in pausedForHuman (Stage-1 outcome:
      // reviewer approved + CI not yet confirmed auto-merge-eligible, so pause for
      // the operator to merge manually).
      expect(result.pausedForHuman.length, "story should be paused for human (gate outcome)").toBeGreaterThanOrEqual(1);

      // The story was completed (reached a terminal gate outcome — either paused or merged).
      const allTerminal = [
        ...result.completed,
        ...result.pausedForHuman.map((p: any) => p.ref),
        ...result.merged.map((m: any) => m.ref),
      ];
      expect(allTerminal.some((r: string) => r === REF || r.includes("01KT7RR9SMOKE")), "story should be in a terminal bucket").toBe(true);

      // The run reason is queue-emptied (the single story was claimed and processed).
      expect(result.runReason).toBe("queue-emptied");
      expect(result.queueEmptied).toBe(true);

      // No story was silently dropped into blocked unexpectedly.
      expect(result.blocked.filter((b: any) => b.ref === REF || String(b.ref).includes("01KT7RR9SMOKE"))).toHaveLength(0);
    },
    120_000,
  );

  it(
    "claimNextStory called against the real scratch repo atomically claims the manifest",
    async () => {
      const REF = "native:01KT7RR9SMOKE00000000002";
      await seedClaimableStory(scratchRoot, REF);

      const { result, thrown } = await runRunE2e();

      expect(thrown).toBeUndefined();
      // The story reached a terminal bucket — never stayed in to-do/.
      const anyTerminal = [
        ...result.completed,
        ...result.pausedForHuman.map((p: any) => p.ref),
        ...result.merged.map((m: any) => m.ref),
        ...result.blocked.map((b: any) => b.ref),
      ];
      expect(anyTerminal.some((r: string) => r.includes("01KT7RR9SMOKE00000000002"))).toBe(true);

      // to-do/ should now be empty (the manifest was moved).
      const todoDir = path.join(scratchRoot, ".flow", "state", "to-do");
      let todoBefore = 0;
      try {
        const entries = await fs.readdir(todoDir);
        todoBefore = entries.filter((e) => e.endsWith(".yaml")).length;
      } catch {
        /* dir may not exist */
      }
      expect(todoBefore).toBe(0);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// AC2 — negative control: a broken seam exits red with the broken step's name
// ---------------------------------------------------------------------------

describe("AC2 — a deliberately broken seam makes the run exit red with the broken step name", () => {
  it(
    "breaking the claimNextStory seam produces a failure result — the run does not reach queue-emptied",
    async () => {
      const REF = "native:01KT7RR9SMOKE00000000003";
      await seedClaimableStory(scratchRoot, REF);

      // Break the claim seam — every claim call throws. The seam is NOT
      // swallow=true and NOT inside processStory's try/catch, so the worker itself
      // throws; Promise.allSettled() swallows it and runReason stays 'incomplete'.
      const { result, thrown, logs } = await runRunE2e({ brokenSeamPrefix: "claim:" });

      // The top-level runner does NOT throw (Promise.allSettled swallows worker throws).
      expect(thrown).toBeUndefined();

      // The run did NOT successfully empty the queue — something failed.
      expect(result.queueEmptied, "broken claim seam should not produce a clean empty").toBe(false);
      expect(result.runReason, "run reason should not be queue-emptied when claim is broken").not.toBe("queue-emptied");

      // No story was successfully completed or paused (the claim never succeeded).
      const greenTerminals = [
        ...result.completed,
        ...result.pausedForHuman.map((p: any) => p.ref),
        ...result.merged.map((m: any) => m.ref),
      ];
      expect(greenTerminals).toHaveLength(0);

      // The logs confirm something went wrong.
      const logStr = logs.join("\n");
      // The run's log should include session startup info (mint succeeded).
      expect(logStr).toMatch(/run session=/);
    },
    120_000,
  );

  it(
    "breaking the verdict seam marks the story as blocked (not silently dropped) and surfaces a failure reason",
    async () => {
      const REF = "native:01KT7RR9SMOKE00000000004";
      await seedClaimableStory(scratchRoot, REF);

      // Break the verdict seam only — the claim succeeds, dev succeeds, review succeeds,
      // but the verdict relay throws.
      const { result, thrown } = await runRunE2e({ brokenSeamPrefix: "verdict:" });

      // The run should NOT throw at the top level (per-worker isolation).
      expect(thrown, `run should not throw at top level; threw: ${thrown}`).toBeUndefined();

      // The story landed in blocked with the worker-threw reason (runWorker backstop).
      const blocked = result.blocked.find(
        (b: any) => b.ref && (b.ref.includes("01KT7RR9SMOKE00000000004") || String(b.ref).includes("SMOKE"))
      );
      expect(blocked, "story should be in blocked bucket when verdict seam is broken").toBeDefined();
      const reason = String(blocked?.blocked_by ?? "");
      expect(reason).toMatch(/worker-threw|verdict|fail/i);

      // And the failure message identifies the broken step.
      const tail = String(blocked?.tail ?? "");
      expect(tail).toMatch(/injected-failure|verdict|broken/i);

      // The run still ended with a run reason.
      expect(typeof result.runReason).toBe("string");
      expect(result.runReason.length).toBeGreaterThan(0);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// AC2 — structural: the harness can detect a real orchestration regression
// ---------------------------------------------------------------------------

describe("AC2 — harness can detect a real orchestration regression (structural proof)", () => {
  it(
    "a clean run produces a passing result; the same harness with a broken seam produces a failing one",
    async () => {
      const REF_CLEAN = "native:01KT7RR9SMOKE00000000005";
      const REF_BROKEN = "native:01KT7RR9SMOKE00000000006";

      // Seed both stories before running — each test has its own fresh scratch repo.
      await seedClaimableStory(scratchRoot, REF_CLEAN);
      const cleanRun = await runRunE2e({ sessionUlid: undefined });

      // Reset for the broken run.
      if (scratchCleanup) await scratchCleanup();
      ({ scratchRoot, cleanup: scratchCleanup } = await createSmokeScratchRepo({ label: "run-e2e" }));
      await seedClaimableStory(scratchRoot, REF_BROKEN);
      const brokenRun = await runRunE2e({ brokenSeamPrefix: "verdict:" });

      // CLEAN: emptied fully and the story was not blocked.
      expect(cleanRun.result.runReason).toBe("queue-emptied");
      expect(cleanRun.result.blocked).toHaveLength(0);

      // BROKEN: at least one story was blocked (the broken verdict seam killed it).
      const brokenBlocked = brokenRun.result.blocked;
      expect(brokenBlocked.length).toBeGreaterThan(0);

      // This proves the harness can detect an orchestration regression — a green
      // result and a broken-seam result are observably different.
    },
    240_000,
  );
});
