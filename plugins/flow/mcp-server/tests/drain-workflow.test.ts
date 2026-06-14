/**
 * Story 8.5 — drain workflow structural integrity.
 *
 * The stateless drain runs under the Workflow primitive (`export const meta`,
 * top-level `await`/`return`), so it cannot be unit-executed here. This file
 * is a structure/integrity anchor: the script parses, declares its meta,
 * accounts for every ref in a structured return (no-silent-failures surface),
 * and preserves load-bearing architectural decisions that are cheap to verify
 * at the source level.
 *
 * **End-to-end orchestration behaviour** is now exercised in
 * `tests/drain-workflow-e2e.test.ts` — that test actually runs the workflow
 * against a real scratch repo and proves a broken seam is detected. Any
 * source-text assertion that merely checks a token exists in the workflow
 * source ("shape assertion") should live here ONLY if it guards a regression
 * that the e2e test cannot catch (e.g. an architectural decision expressed as
 * a specific identifier, or a NOT-present guard on a previously-mislabelled
 * token). Pure "tool name present in source" checks have been removed in favour
 * of the e2e smoke that actually invokes those tools.
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRAIN = path.resolve(HERE, "..", "..", "workflows", "drain.workflow.js");
const SRC = readFileSync(DRAIN, "utf8");

describe("Story 8.5 — drain workflow integrity", () => {
  it("parses as a Workflow-runtime script (export/meta/top-level await+return)", () => {
    // Wrap the body in an async fn so top-level await/return are valid for parse.
    const wrapped = "(async()=>{" + SRC.replace("export const meta", "const meta") + "})()";
    expect(() => new vm.Script(wrapped)).not.toThrow();
  });

  it("declares meta.name = flow-drain with a drain phase", () => {
    expect(SRC).toMatch(/export const meta\s*=/);
    expect(SRC).toContain("name: 'flow-drain'");
    expect(SRC).toContain("title: 'drain'");
  });

  it("accounts for every ref in a structured return (no silent failures)", () => {
    // The return object shape is the no-silent-failures contract: every story
    // lands in exactly one bucket. Keep this check — it verifies the shape at
    // the source level AND is not otherwise covered by the e2e smoke (the e2e
    // proves the runtime enforces it; this proves the fields are defined in the
    // return statement, which is a distinct regression surface).
    for (const field of ["completed", "merged", "pausedForHuman", "blocked", "drainedReason"]) {
      expect(SRC).toContain(field);
    }
  });

  // NOTE: "wires the load-bearing seam tools via the one-shot CLI" and
  // "switches on the verified seam discriminants" were pure shape assertions —
  // they checked that token strings exist in the source but proved nothing about
  // whether the tools are actually called or the discriminants are actually
  // handled. Those checks have been removed in favour of drain-workflow-e2e.test.ts,
  // which actually claims a story, drives it through the loop, and asserts a broken
  // seam is detected — something a source-text string search cannot do.

  it("classifies drain exits with explicit reasons (no budget-exhausted mislabel)", () => {
    // The happy unattended path keys off the real claimNextStory empty-queue signal.
    expect(SRC).toContain("queue-drained");
    // Hitting the optional cap is its OWN named exit, not a queue state.
    expect(SRC).toContain("max-stories-reached");
    // `drained` is the positive full-drain signal, not the old sentinel diff.
    expect(SRC).toContain("drained: drainedReason === 'queue-drained'");
    // The mislabelled token-budget placeholder is gone entirely.
    expect(SRC).not.toContain("budget-exhausted");
  });

  it("treats maxStories as an optional cap (unbounded drain until queue empty by default)", () => {
    // No hard default-1 cap: an omitted maxStories drains the whole queue.
    expect(SRC).not.toContain("A.maxStories || 1");
    expect(SRC).toContain("Infinity");
  });

  it("routes courier model by seam kind (Haiku read-only, Sonnet mutating); dev edits inside its own worktree (Story 8.20)", () => {
    // Couriers relay tool JSON verbatim. The model is chosen by the read-only vs
    // mutating axis (the `retryable` flag): read-only/idempotent seams run on the
    // cheaper Haiku (a garble just re-invokes), while MUTATING seams stay on the
    // more-reliable Sonnet — Haiku garbled exactly such a verdict relay on the first
    // multi-story drain (story 8.13), and a garbled mutating relay pauses the story.
    // A per-call `modelOverride` may force a specific model, bypassing the default tier.
    expect(SRC).toContain("model: modelOverride || (retryable ? 'haiku' : 'sonnet')");
    // Story 8.20: the dev's EDITING SURFACE is its own worktree — the dev agent is
    // spawned with the runtime's per-agent `isolation: 'worktree'` primitive, so two
    // devs against the same repo can never cross-contaminate edits. This is what
    // makes the deferred concurrent dispatch (bmad:8.22) safe by construction.
    expect(SRC).toContain("isolation: 'worktree'");
    // The 8.16 snapshot-baseline/transplant workaround is gone (it was serial-only).
    expect(SRC).not.toContain("snapshotDirtyPaths");
    expect(SRC).not.toContain("baselineDirtyPaths");
    // Crash-recovery reaps stale dev worktrees left by dead sessions (8.20 AC4).
    expect(SRC).toContain("reapStaleWorktrees");
  });

  it("retries the relay only on read-only/idempotent seams (mutating seams pause safely)", () => {
    // The seam helper takes a `retryable` flag (default false) and re-invokes the
    // courier on a garbled (non-JSON) relay.
    expect(SRC).toContain("retryable = false");
    // Read-only / idempotent seams opt in: mint, persona, processDevTranscript.
    expect(SRC).toContain("'mint', true");
    expect(SRC).toContain("'persona:dev', true");
    // Mutating seams (claim / verdict / gate) omit retryable → a garble surfaces as a
    // parse error and the loop pauses that story rather than risk a double-apply.
  });

  it("forces a reliable model for the LARGE persona relays (2026-06-13 startup fix)", () => {
    // buildPersonaSpawnPrompt returns the full role system prompt — the only large
    // verbatim payload in the drain, and it grows as the team accrues knowledge entries.
    // Haiku could not reliably emit it through StructuredOutput (it printed the answer as
    // plain text and threw, killing the run at startup), so both persona seams pass an
    // explicit modelOverride past the swallow arg. Assert both opt out of the cheap tier.
    expect(SRC).toContain("'persona:dev', true, false, 'opus'");
    expect(SRC).toContain("'persona:reviewer', true, false, 'opus'");
  });
});

// ---------------------------------------------------------------------------
// Review fix-now batch (2026-06-11) — structural anchors for the three
// workflow-level fixes. The drain script can't be unit-executed here, so these
// assert the load-bearing tokens are present (same approach as the suite above).
// ---------------------------------------------------------------------------

describe("review fix-now batch — drain workflow anchors", () => {
  it("B2: a rework-exhausted story lands in the blocked bucket (never vanishes)", () => {
    // After the rework loop falls through without a green verdict, the story must
    // be pushed to `blocked` with a `rework-exhausted` reason — not silently
    // dropped from every result bucket.
    expect(SRC).toContain("rework-exhausted");
    expect(SRC).toMatch(/verdict\?\.next !== 'done-ready-for-merge'/);
  });

  it("D5: spawning with an empty persona fails loud (no unguarded agent)", () => {
    // An empty dev/reviewer persona would drop the evidence-only discipline; the
    // drain must throw rather than spawn an unguarded agent.
    expect(SRC).toContain("empty generalist-dev persona");
    expect(SRC).toContain("empty generalist-reviewer persona");
    expect(SRC).toMatch(/if \(!devPersona\.trim\(\)\) throw/);
    expect(SRC).toMatch(/if \(!reviewerPersona\.trim\(\)\) throw/);
  });

  it("B4: a declared-dependency hold surfaces WAITING, not a clean drain", () => {
    // The drain must recognise the new claimNextStory outcome and log WAITING so a
    // queue held by an unmerged declared dependency is not reported as drained.
    expect(SRC).toContain("waiting-on-unmerged-dependency");
  });
});

// ---------------------------------------------------------------------------
// Story native:01KTKK3HQYNFS1M1ZR9TG02G1F — AC2 + AC3 structural-anchor tests.
//
// AC2: the drain reads each claimed story's persisted lane and sets the dev/reviewer
//      model and review depth from resolveBuildPlan before spawning the dev,
//      defaulting to the current tier when lane is absent.
//
// AC3: the dev's pre-PR build+test gate (runDevTerminalAction) and the merge gate
//      (runAutoMergeGate) call sites are unchanged — the cheap path sits entirely
//      in front of the unchanged hard gates.
// ---------------------------------------------------------------------------

describe("Story native:01KTKK3HQYNFS1M1ZR9TG02G1F — AC2: resolveBuildPlan wired in the drain", () => {
  it("calls resolveBuildPlan as a seam after each claim (structural anchor)", () => {
    // The drain must invoke resolveBuildPlan via the CLI seam to read the
    // persisted lane from the manifest and return the build plan.
    expect(SRC).toContain("resolveBuildPlan");
  });

  it("passes manifestPath to resolveBuildPlan so the lane is read from the manifest", () => {
    // The seam call must pass manifestPath so the tool reads the persisted lane.
    expect(SRC).toMatch(/resolveBuildPlan.*manifestPath/s);
  });

  it("applies resolveBuildPlan's devReviewerModel to the dev agent call", () => {
    // The dev agent() call must use the per-story model (agentModel, from the build plan),
    // not a hardcoded 'sonnet' or the global execModel directly.
    expect(SRC).toContain("agentModel");
    // The dev spawn carries model: agentModel (not model: execModel directly).
    expect(SRC).toContain("model: agentModel");
  });

  it("applies resolveBuildPlan's devReviewerModel to the reviewer agent call", () => {
    // Both dev AND reviewer agent() calls must use agentModel (AC2: both affected).
    // The SRC contains exactly one reference to model: agentModel per dev call
    // and one per reviewer call — assert it appears at least twice.
    const occurrences = (SRC.match(/model: agentModel/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("passes reviewDepth to the reviewer so a fast-lane story gets a light review", () => {
    // The reviewer's prompt is constructed with a reviewDepthNote derived from reviewDepth.
    expect(SRC).toContain("reviewDepth");
    expect(SRC).toContain("reviewDepthNote");
    // The light-review text is injected into the reviewer's prompt.
    expect(SRC).toContain("LIGHT (fast-lane story)");
  });

  it("defaults to the current tier when lane is absent (fail-soft seam, backwards-compatible)", () => {
    // When resolveBuildPlan returns a garbled relay or no devReviewerModel, the
    // drain falls back to storyModel=null and uses execModel (the run-level default).
    // This keeps full backwards compatibility with existing launch scripts.
    expect(SRC).toContain("storyModel = null");
    // agentModel is computed as storyModel || execModel — the fallback chain.
    expect(SRC).toContain("storyModel || execModel");
  });

  it("resolveBuildPlan seam is retryable (read-only / idempotent)", () => {
    // Like other read-only seams (mint, persona, etc.), the build-plan seam opts in
    // to retryable=true so a garbled relay re-invokes (no mutation risk).
    // The seam call label starts with 'build-plan:' and the third arg is true.
    // The workflow uses backtick template literals for the label arg.
    expect(SRC).toMatch(/build-plan:.*`,\s*true/);
  });
});

describe("Story native:01KTKK3HQYNFS1M1ZR9TG02G1F — AC3: hard gates unchanged by fast-lane routing", () => {
  it("runDevTerminalAction call site is unchanged (still uses the same seam label pattern)", () => {
    // The hard pre-PR gate (runDevTerminalAction) is invoked by the DEV subagent
    // via the CLI prompt — the drain's prompt string still references it unchanged.
    expect(SRC).toContain("runDevTerminalAction");
  });

  it("runAutoMergeGate call site is unchanged (seam label 'gate:')", () => {
    // The merge gate seam label 'gate:<ref>' is present — the gate call site is unmodified.
    // The workflow uses backtick template literals for the label arg.
    expect(SRC).toContain("gate:${ref}");
  });

  it("runDevTerminalAction is still in the dev prompt (the dev calls it, not the drain)", () => {
    // The drain passes runDevTerminalAction to the dev subagent via prompt text —
    // the instruction is still there verbatim.
    expect(SRC).toContain("node ${CLI} runDevTerminalAction");
  });

  it("runAutoMergeGate is still called as a seam after a green verdict", () => {
    // The gate seam is still called unconditionally on a green verdict.
    expect(SRC).toContain("node ${CLI} runAutoMergeGate");
  });

  it("the cheap path (fast-lane model + light review) sits before the unchanged hard gates", () => {
    // resolveBuildPlan is called AFTER claim but BEFORE dev spawn (which is before
    // processDevTranscript, verdict, and gate). The script must contain both
    // resolveBuildPlan and runAutoMergeGate with the gate appearing after.
    const rpIdx = SRC.indexOf("resolveBuildPlan");
    const gateIdx = SRC.indexOf("node ${CLI} runAutoMergeGate");
    expect(rpIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(rpIdx);
  });
});
