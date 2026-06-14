/**
 * Stateless CLI shim over the flow tool functions (Story 8.4; spike-proven 2026-05-29).
 *
 * Purpose: invoke the existing MCP tool *logic* as one-shot processes, with NO
 * persistent MCP server in the loop. Each invocation runs a tool function over
 * the filesystem and exits — so the cascade-SIGTERM (which only kills a
 * long-lived stdio server child sitting in the host's process group) cannot
 * occur by construction. Consumed by the spike `drain` workflow's seam-agents,
 * which shell out to this CLI and read the JSON it prints.
 *
 * Usage:
 *   node dist/cli.js <toolName> --json '<argsJSON>'
 *   node dist/cli.js <toolName> '<argsJSON>'        # positional fallback
 *   node dist/cli.js mintSessionUlid                # no-arg tools
 *
 * Always prints a single JSON line to stdout. On success: the tool's structured
 * result (non-serialisable fields such as a returned cleanup() closure are
 * dropped by JSON.stringify). On failure: {"error":{...}} and a non-zero exit
 * (2 for a typed DomainError, 1 otherwise, 64/65 for usage errors).
 *
 * This is the one-shot seam transport the stateless `drain` workflow's seam-agents
 * shell out to — no persistent MCP server on the drain path. Reuses every tool
 * function unchanged; see plugins/flow/mcp-server/src/tools/register.ts for the
 * same functions wired to the MCP transport (interactive skills still use that).
 */

import { DomainError } from "./errors.js";
import { getStatus } from "./tools/get-status.js";
import { openCycle } from "./tools/open-cycle.js";
import { gatherRetroInputs } from "./tools/gather-retro-inputs.js";
import { mintSessionUlid } from "./tools/mint-session-ulid.js";
import { drainPhaseStart, drainPhaseDone } from "./tools/drain-phase-progress.js";
import { scanSources } from "./tools/scan-sources.js";
import { createSmokeScratchRepo } from "./tools/create-smoke-scratch-repo.js";
import { instantiatePersona } from "./tools/instantiate-persona.js";
import { writeNativeStory } from "./tools/write-native-story.js";
import { bmadToNativeIngestTool } from "./tools/bmad-to-native-ingest.js";
import { buildPersonaSpawnPrompt } from "./tools/build-persona-spawn-prompt.js";
import { listClaimableTodos } from "./tools/list-claimable-todos.js";
import { readBacklogInventory } from "./tools/read-backlog-inventory.js";
import { claimNextStory } from "./tools/claim-next-story.js";
import { processDevTranscript } from "./tools/process-dev-transcript.js";
import { runDevTerminalAction } from "./tools/run-dev-terminal-action.js";
import { runReviewerSession } from "./tools/run-reviewer-session.js";
import { postReviewerComments } from "./tools/post-reviewer-comments.js";
import { processReviewerTranscript } from "./tools/process-reviewer-transcript.js";
import { applyReviewerLabels } from "./tools/apply-reviewer-labels.js";
import { runAutoMergeGate } from "./tools/run-auto-merge-gate.js";
import { completeStory } from "./tools/complete-story.js";
import { getTeamSnapshot } from "./tools/get-team-snapshot.js";
import { processReviewerYield } from "./tools/process-reviewer-yield.js";
import { scanOrphanedInProgress } from "./tools/scan-orphaned-in-progress.js";
import { reattachOrphan } from "./tools/reattach-orphan.js";
import { blockOrphanNoTranscript } from "./tools/block-orphan-no-transcript.js";
import { reapStaleWorktrees } from "./tools/reap-stale-worktrees.js";
import { markStoryReady } from "./tools/mark-story-ready.js";
import { guardCleanRoot } from "./tools/guard-clean-root.js";
import { writeLensVerdict, aggregateJudgePanel } from "./tools/judge-panel.js";
import { adjudicateQualityLead } from "./tools/quality-lead-adjudicate.js";
import { recordAgentFriction } from "./tools/record-agent-friction.js";
import { resolveLensRoles } from "./tools/resolve-lens-roles.js";
import { recordReviewerLesson } from "./tools/record-reviewer-lesson.js";
import { readReviewerLesson } from "./tools/read-reviewer-lesson.js";
import { recordStoryRetro } from "./tools/record-story-retro.js";
import { recallLesson } from "./tools/recall-lesson.js";
import { classifyStoryLane } from "./tools/classify-story-lane.js";
import { resolveJudgePlan } from "./tools/resolve-judge-plan.js";
import { resolveBuildPlan } from "./tools/resolve-build-plan.js";
import { discardDraft } from "./tools/discard-draft.js";

// Each tool is a pure fn(opts) -> result|Promise<result>. `any` here is
// deliberate: the shim is a transport-agnostic courier and the tool functions
// validate their own inputs (mirroring register.ts's parse->call->serialise).
type ToolFn = (args: any) => unknown | Promise<unknown>;

const TOOLS: Record<string, ToolFn> = {
  getStatus,
  // Story native:01KT484NY4HCBPBTT6VEY1Q0CS — open a new work cycle. Exposed on
  // the CLI seam so the drain / skill workflows can open a cycle without a
  // persistent MCP session. `gatherRetroInputs` is registered alongside it so
  // the no-MCP retro path can gather the (now cycle-scoped) bundle one-shot.
  openCycle,
  gatherRetroInputs,
  mintSessionUlid,
  drainPhaseStart,
  drainPhaseDone,
  scanSources,
  createSmokeScratchRepo,
  instantiatePersona,
  writeNativeStory,
  bmadToNativeIngestTool,
  buildPersonaSpawnPrompt,
  listClaimableTodos,
  readBacklogInventory,
  claimNextStory,
  processDevTranscript,
  runDevTerminalAction,
  runReviewerSession,
  postReviewerComments,
  processReviewerTranscript,
  applyReviewerLabels,
  runAutoMergeGate,
  completeStory,
  getTeamSnapshot,
  processReviewerYield,
  scanOrphanedInProgress,
  reattachOrphan,
  blockOrphanNoTranscript,
  reapStaleWorktrees,
  // Story 9.1 readiness brake (the "bless" mutation). The drain runs MCP-free, so
  // blessing the next story needed a hand-written `node` helper until this was a
  // first-class CLI seam (Epic 10 drain fix-plan, Fix 1). Now `/flow:ready` and the
  // cutover scan→bless step round-trip through the same one-shot transport.
  markStoryReady,
  // Epic 10 drain fix-plan, Fix 2b — clean-root guard. The drain calls this after
  // each story to detect (and non-destructively stash) any dev edits that leaked
  // into the shared root checkout under bgIsolation:'none', so the next worktree
  // is cut from a clean base.
  guardCleanRoot,
  // Story native:01KT1MP7TR651TAGVJ6EZSR589 — gate-1 judge panel tools (AC5).
  // The three panel tools are registered here so they are callable via the CLI
  // seam (node dist/cli.js toolName --json) from the gate-1.workflow.js and from
  // the /flow:judge skill's seam-agents. Each accepts a plain options object so the
  // existing CLI shim fn(args) pattern applies unchanged.
  writeLensVerdict,
  aggregateJudgePanel,
  adjudicateQualityLead,
  // Story native:01KT2RAXBSQ91Y80Z51DD26KPX — friction-signal write seam.
  // Registered here so drain-path agents (seam-agents running node dist/cli.js)
  // can emit friction events without a persistent MCP server in the loop.
  recordAgentFriction,
  // Story native:01KT2Q51E24XKMM4YEF0ADRKNG — read-only lens→role resolver (FU2).
  // Callable on the no-MCP drain/gate path: node dist/cli.js resolveLensRoles --json
  // '{"targetRepoRoot":"..."}'. Returns { lensRoles, hiredRoles }. gate-1.workflow.js
  // calls this instead of the previously hard-coded lensRoles block.
  resolveLensRoles,
  // Story native:01KT6GSV8KTTKKHPRGEJWJAGZV — learning-loop producer.
  // recordReviewerLesson is the CAPTURE seam: the reviewer (a no-MCP drain-path
  // seam-agent) calls it via `node dist/cli.js recordReviewerLesson --json` to
  // merge one reusable lesson onto the per-ref reviewer-result.json.
  // recordStoryRetro is the FORWARD seam: the drain reads that captured lesson and
  // attaches it to the done manifest (`node dist/cli.js recordStoryRetro --json`)
  // before the merge gate runs. readReviewerLesson is the read side of FORWARD —
  // a thin read-only seam returning { lesson } off the reviewer-result.json so the
  // drain knows whether (and what) to forward. All three must be on the CLI seam
  // because the drain runs MCP-free.
  recordReviewerLesson,
  readReviewerLesson,
  recordStoryRetro,
  // Story native:01KT6QEWY794ZY0DH6JHQFWG6V — on-demand lesson recall.
  // buildPersonaSpawnPrompt now emits a one-line index; agents call this
  // to retrieve the full detail body of a specific lesson by id.
  recallLesson,
  // Story native:01KTKJXP6DWN5YHKVG96DH16V0 — pre-judge lane classifier.
  // Pure deterministic function: classifies a story into 'fast' or 'full'
  // from its execution-manifest signals before the costly judge panel runs.
  // Callable on the no-MCP drain/gate path: node dist/cli.js classifyStoryLane
  // --json '{"storyId":"...","risk_tier":"low","cited_sources":[...]}'.
  classifyStoryLane,
  // Story native:01KTKK2Y73EDDAXK470EZ3MHQ8 — fast-lane judge plan resolver.
  // Pure deterministic function: maps (lane, detector_confirmed_dead) → a lens
  // plan { skip, lenses, perLensModel }. Keeps the load-bearing decision in a
  // tool result (not workflow JS) so it is unit-testable without the Workflow
  // runtime. Callable on the no-MCP gate path:
  //   node dist/cli.js resolveJudgePlan --json '{"storyId":"...","lane":"fast"}'
  resolveJudgePlan,
  // Story native:01KTKK3HQYNFS1M1ZR9TG02G1F — fast-lane build plan resolver.
  // Pure deterministic function: maps a story's lane → { devReviewerModel,
  // reviewDepth }. fast → haiku + light review; full/absent → sonnet + full
  // review (no-regression pin). When manifestPath is provided, reads the
  // lane from the persisted execution manifest written at scan time.
  // Callable on the no-MCP drain path:
  //   node dist/cli.js resolveBuildPlan --json '{"storyId":"...","manifestPath":"..."}'
  resolveBuildPlan,
  // Story native:01KTZKHJ1KDYKGXR20FZ15Y4WB — discard an un-claimed native draft.
  // Removes BOTH the to-do/ execution manifest AND the .flow/native-stories/<ULID>.md
  // source draft so a later projection pass cannot re-materialise the item.
  // Callable on the no-MCP seam:
  //   node dist/cli.js discardDraft --json '{"targetRepoRoot":"...","ref":"native:..."}'
  discardDraft,
};

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj ?? null) + "\n");
}

function parseInvocation(argv: string[]): { tool: string | undefined; json: string } {
  const tool = argv[2];
  const rest = argv.slice(3);
  const flagIdx = rest.indexOf("--json");
  if (flagIdx !== -1) {
    const val = rest[flagIdx + 1];
    if (val !== undefined) return { tool, json: val };
  }
  const positional = rest.find((a) => !a.startsWith("--"));
  return { tool, json: positional ?? "{}" };
}

async function main(): Promise<void> {
  const { tool, json } = parseInvocation(process.argv);

  if (tool === undefined || !Object.prototype.hasOwnProperty.call(TOOLS, tool)) {
    emit({ error: { kind: "unknown-tool", tool: tool ?? null, known: Object.keys(TOOLS) } });
    process.exit(64);
  }

  let args: unknown;
  try {
    args = JSON.parse(json);
  } catch (err) {
    emit({ error: { kind: "bad-json", detail: (err as Error).message, received: json } });
    process.exit(65);
  }

  const fn = TOOLS[tool] as ToolFn;
  const result = await Promise.resolve(fn(args));
  emit(result);
}

main().catch((err: unknown) => {
  if (err instanceof DomainError) {
    emit({ error: { kind: "domain-error", name: err.name, message: err.message } });
    process.exit(2);
  }
  const e = err as Error;
  emit({ error: { kind: "unexpected", name: e?.name, message: e?.message, stack: e?.stack } });
  process.exit(1);
});
