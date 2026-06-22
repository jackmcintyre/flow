/**
 * Story 8.5 — run workflow structural integrity.
 *
 * The stateless run runs under the Workflow primitive (`export const meta`,
 * top-level `await`/`return`), so it cannot be unit-executed here. This file
 * is a structure/integrity anchor: the script parses, declares its meta,
 * accounts for every ref in a structured return (no-silent-failures surface),
 * and preserves load-bearing architectural decisions that are cheap to verify
 * at the source level.
 *
 * **End-to-end orchestration behaviour** is now exercised in
 * `tests/run-workflow-e2e.test.ts` — that test actually runs the workflow
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
const RUN = path.resolve(HERE, "..", "..", "workflows", "internal", "run.workflow.js");
const SRC = readFileSync(RUN, "utf8");

describe("Story 8.5 — run workflow integrity", () => {
  it("parses as a Workflow-runtime script (export/meta/top-level await+return)", () => {
    // Wrap the body in an async fn so top-level await/return are valid for parse.
    const wrapped = "(async()=>{" + SRC.replace("export const meta", "const meta") + "})()";
    expect(() => new vm.Script(wrapped)).not.toThrow();
  });

  it("declares meta.name = flow-run with a run phase", () => {
    expect(SRC).toMatch(/export const meta\s*=/);
    expect(SRC).toContain("name: 'flow-run'");
    expect(SRC).toContain("title: 'run'");
  });

  it("accounts for every ref in a structured return (no silent failures)", () => {
    // The return object shape is the no-silent-failures contract: every story
    // lands in exactly one bucket. Keep this check — it verifies the shape at
    // the source level AND is not otherwise covered by the e2e smoke (the e2e
    // proves the runtime enforces it; this proves the fields are defined in the
    // return statement, which is a distinct regression surface).
    for (const field of ["completed", "merged", "pausedForHuman", "blocked", "runReason"]) {
      expect(SRC).toContain(field);
    }
  });

  // NOTE: "wires the load-bearing seam tools via the one-shot CLI" and
  // "switches on the verified seam discriminants" were pure shape assertions —
  // they checked that token strings exist in the source but proved nothing about
  // whether the tools are actually called or the discriminants are actually
  // handled. Those checks have been removed in favour of run-workflow-e2e.test.ts,
  // which actually claims a story, drives it through the loop, and asserts a broken
  // seam is detected — something a source-text string search cannot do.

  it("classifies run exits with explicit reasons (no budget-exhausted mislabel)", () => {
    // The happy unattended path keys off the real claimNextStory empty-queue signal.
    expect(SRC).toContain("queue-emptied");
    // Hitting the optional cap is its OWN named exit, not a queue state.
    expect(SRC).toContain("max-stories-reached");
    // `queueEmptied` is the positive full-empty signal, not the old sentinel diff.
    expect(SRC).toContain("queueEmptied: runReason === 'queue-emptied'");
    // The mislabelled token-budget placeholder is gone entirely.
    expect(SRC).not.toContain("budget-exhausted");
  });

  it("treats maxStories as an optional cap (unbounded run until queue empty by default)", () => {
    // No hard default-1 cap: an omitted maxStories empties the whole queue.
    expect(SRC).not.toContain("A.maxStories || 1");
    expect(SRC).toContain("Infinity");
  });

  it("routes courier model by seam kind (Haiku read-only, Sonnet mutating); dev edits inside its own worktree (Story 8.20)", () => {
    // Couriers relay tool JSON verbatim. The model is chosen by the read-only vs
    // mutating axis (the `retryable` flag): read-only/idempotent seams run on the
    // cheaper Haiku (a garble just re-invokes), while MUTATING seams stay on the
    // more-reliable Sonnet — Haiku garbled exactly such a verdict relay on the first
    // multi-story run (story 8.13), and a garbled mutating relay pauses the story.
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
    // verbatim payload in the run, and it grows as the team accrues knowledge entries.
    // Haiku could not reliably emit it through StructuredOutput (it printed the answer as
    // plain text and threw, killing the run at startup), so both persona seams pass an
    // explicit modelOverride past the swallow arg. Assert both opt out of the cheap tier.
    expect(SRC).toContain("'persona:dev', true, false, 'opus'");
    expect(SRC).toContain("'persona:reviewer', true, false, 'opus'");
  });
});

// ---------------------------------------------------------------------------
// Review fix-now batch (2026-06-11) — structural anchors for the three
// workflow-level fixes. The run script can't be unit-executed here, so these
// assert the load-bearing tokens are present (same approach as the suite above).
// ---------------------------------------------------------------------------

describe("review fix-now batch — run workflow anchors", () => {
  it("B2: a rework-exhausted story lands in the blocked bucket (never vanishes)", () => {
    // After the rework loop falls through without a green verdict, the story must
    // be pushed to `blocked` with a `rework-exhausted` reason — not silently
    // dropped from every result bucket.
    expect(SRC).toContain("rework-exhausted");
    expect(SRC).toMatch(/verdict\?\.next !== 'done-ready-for-merge'/);
  });

  it("D5: spawning with an empty persona fails loud (no unguarded agent)", () => {
    // An empty dev/reviewer persona would drop the evidence-only discipline; the
    // run must throw rather than spawn an unguarded agent.
    // Story native:01KVPQS1DVJE41KNG065D6X1X7: the role name is now dynamic (devRole /
    // reviewerRole) so the error text uses a template literal — check the pattern rather
    // than a literal role name.
    expect(SRC).toContain("refusing to spawn dev without its discipline rules");
    expect(SRC).toContain("refusing to spawn reviewer without its discipline rules");
    expect(SRC).toMatch(/if \(!devPersona\.trim\(\)\) throw/);
    expect(SRC).toMatch(/if \(!reviewerPersona\.trim\(\)\) throw/);
  });

  it("B4: a declared-dependency hold surfaces WAITING, not a clean empty", () => {
    // The run must recognise the new claimNextStory outcome and log WAITING so a
    // queue held by an unmerged declared dependency is not reported as emptied.
    expect(SRC).toContain("waiting-on-unmerged-dependency");
  });
});

// ---------------------------------------------------------------------------
// Story native:01KTKK3HQYNFS1M1ZR9TG02G1F — AC2 + AC3 structural-anchor tests.
//
// AC2: the run reads each claimed story's persisted lane and sets the dev/reviewer
//      model and review depth from resolveBuildPlan before spawning the dev,
//      defaulting to the current tier when lane is absent.
//
// AC3: the dev's pre-PR build+test gate (runDevTerminalAction) and the merge gate
//      (runAutoMergeGate) call sites are unchanged — the cheap path sits entirely
//      in front of the unchanged hard gates.
// ---------------------------------------------------------------------------

describe("Story native:01KTKK3HQYNFS1M1ZR9TG02G1F — AC2: resolveBuildPlan wired in the run", () => {
  it("calls resolveBuildPlan as a seam after each claim (structural anchor)", () => {
    // The run must invoke resolveBuildPlan via the CLI seam to read the
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
    // run falls back to storyModel=null and uses execModel (the run-level default).
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
    // via the CLI prompt — the run's prompt string still references it unchanged.
    expect(SRC).toContain("runDevTerminalAction");
  });

  it("runAutoMergeGate call site is unchanged (seam label 'gate:')", () => {
    // The merge gate seam label 'gate:<ref>' is present — the gate call site is unmodified.
    // The workflow uses backtick template literals for the label arg.
    expect(SRC).toContain("gate:${ref}");
  });

  it("runDevTerminalAction is still in the dev prompt (the dev calls it, not the run)", () => {
    // The run passes runDevTerminalAction to the dev subagent via prompt text —
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

// ---------------------------------------------------------------------------
// Story native:01KVPQS1DVJE41KNG065D6X1X7 — AC1, AC2, AC3: dynamic slot resolution.
//
// AC1: the run calls resolveRunSlot for BOTH slots at startup, before fetching
//      persona prompts; the resolved roles are used for buildPersonaSpawnPrompt.
//      On a default team this is always generalist-dev + generalist-reviewer.
//
// AC2: the resolved role is threaded into buildPersonaSpawnPrompt so a non-default
//      qualified role's persona is briefed instead of the generalist.
//
// AC3: when resolveRunSlot returns an error or no role, the run throws with a
//      clear message naming the unstaffed slot.
// ---------------------------------------------------------------------------

describe("Story native:01KVPQS1DVJE41KNG065D6X1X7 — AC1/AC2/AC3: dynamic run slot resolution", () => {
  it("AC1: calls resolveRunSlot for both the build and review slots before fetching persona prompts", () => {
    // The run must invoke resolveRunSlot via the CLI seam for each slot.
    // The 'slot:build' and 'slot:review' labels are structural anchors.
    expect(SRC).toContain("resolveRunSlot");
    expect(SRC).toContain("'slot:build'");
    expect(SRC).toContain("'slot:review'");
  });

  it("AC1: resolveRunSlot for build is called with job:'build' and review with job:'review'", () => {
    // The CLI args must pass the correct job to each seam call.
    expect(SRC).toContain("job: 'build'");
    expect(SRC).toContain("job: 'review'");
  });

  it("AC1/AC2: buildPersonaSpawnPrompt for dev uses the resolved devRole (not a literal 'generalist-dev')", () => {
    // The run must thread the resolved role into buildPersonaSpawnPrompt.
    // devRole is used, NOT the literal 'generalist-dev'.
    expect(SRC).toContain("role: devRole");
    // The literal 'generalist-dev' must NOT appear as a hardcoded role arg in
    // buildPersonaSpawnPrompt calls (it is still fine in error messages, but NOT
    // in the seam call that selects the persona).
    // We check by looking for the pattern that would hard-wire the persona:
    // buildPersonaSpawnPrompt --json '...role: 'generalist-dev''
    // The seam call template uses J() which serialises an object — so we look
    // for the literal JSON key-value that would hard-code it.
    expect(SRC).not.toContain(`role: 'generalist-dev'`);
  });

  it("AC1/AC2: buildPersonaSpawnPrompt for reviewer uses the resolved reviewerRole (not a literal 'generalist-reviewer')", () => {
    // The resolved role is used, NOT the literal 'generalist-reviewer'.
    expect(SRC).toContain("role: reviewerRole");
    expect(SRC).not.toContain(`role: 'generalist-reviewer'`);
  });

  it("AC1: resolveRunSlot for build slot is called before the persona seams (structural order)", () => {
    // The slot resolver must precede persona assembly — it determines WHICH persona to fetch.
    const slotIdx = SRC.indexOf("'slot:build'");
    const personaIdx = SRC.indexOf("'persona:dev'");
    expect(slotIdx).toBeGreaterThan(-1);
    expect(personaIdx).toBeGreaterThan(-1);
    expect(personaIdx).toBeGreaterThan(slotIdx);
  });

  it("AC3: the run throws when resolveRunSlot returns no role for the build slot", () => {
    // The run must fail loud on a missing/garbled resolveRunSlot result — naming
    // the build slot — instead of silently falling back or guessing.
    expect(SRC).toContain("resolveRunSlot failed for the build slot");
  });

  it("AC3: the run throws when resolveRunSlot returns no role for the review slot", () => {
    // Same guard for the review slot.
    expect(SRC).toContain("resolveRunSlot failed for the review slot");
  });

  it("AC2: runReviewerSession uses reviewerRole (not a literal 'generalist-reviewer')", () => {
    // The reviewer session seam must pass the resolved role, not a hard-coded string.
    expect(SRC).toContain("role: reviewerRole");
  });
});

// ---------------------------------------------------------------------------
// Story native:01KVPSZ14HH48J9NEH7N6S6QDR — AC3: custom specialist treated
// identically to a built-in specialist.
//
// The run's specialist auto-engage path calls matchStorySpecialist and
// recordSpecialistEngagement via CLI seams. The seam call is the same
// regardless of whether the matched role is a built-in or custom-authored one
// (there is no special-casing of role origin in the workflow). This suite
// asserts the structural tokens that prove identical treatment.
// ---------------------------------------------------------------------------

describe("Story native:01KVPSZ14HH48J9NEH7N6S6QDR — AC3: custom specialist treated as built-in", () => {
  it("matchStorySpecialist is called via a retryable CLI seam (same for all roles)", () => {
    // The seam call passes targetRepoRoot + manifestPath. The read-only nature
    // (retryable=true) is the ONLY routing parameter — no role-origin check.
    expect(SRC).toContain("matchStorySpecialist");
    // retryable=true is the third argument to seam() — confirmed by 'true' appearing
    // right after the specialist-match label.
    expect(SRC).toMatch(/specialist-match.*`,\s*true/);
  });

  it("recordSpecialistEngagement is called with the matched role id (no built-in guard)", () => {
    // The workflow uses specialistRole directly from matchStorySpecialist's result
    // to call recordSpecialistEngagement — no filter on role origin.
    expect(SRC).toContain("recordSpecialistEngagement");
    expect(SRC).toContain("specialistRole");
    // The record call passes specialistRole as the value — no special-case check.
    expect(SRC).toMatch(/recordSpecialistEngagement.*specialistRole/s);
  });

  it("the no-match path (null specialist) skips recordSpecialistEngagement — generalists-only unchanged", () => {
    // When matchStorySpecialist returns no role (null/falsy specialistRole), the
    // record seam is not called. The guard checks specialistRole truthiness.
    // The conditional 'if (specialistRole)' is the proof.
    expect(SRC).toMatch(/if\s*\(\s*specialistRole\s*\)/);
  });

  it("specialist engagement is recorded on both the normal and orphan-resume paths", () => {
    // Both the main runWorker loop and the orphan-resume branch record specialist
    // engagement — crash-recovery is unchanged whether or not a specialist was engaged.
    // The resume seam uses a ':resume' label suffix to distinguish it.
    expect(SRC).toContain("specialist-match:${ref}:resume");
    expect(SRC).toContain("record-specialist:${ref}:resume");
    // And the normal path (without :resume).
    expect(SRC).toContain("specialist-match:${ref}`");
    expect(SRC).toContain("record-specialist:${ref}`");
  });

  it("recordSpecialistEngagement failures are swallowed (fail-soft does not block the run)", () => {
    // The record call is wrapped in try/catch and logged — a write failure must
    // not block the story from being built.
    expect(SRC).toMatch(/recordSpecialistEngagement.*\n.*catch/s);
    // The swallowed error is logged, not silently dropped.
    expect(SRC).toContain("recordSpecialistEngagement failed (swallowed):");
  });
});
