/**
 * Stateless CLI shim over the flow tool functions (Story 8.4; spike-proven 2026-05-29).
 *
 * Purpose: invoke the existing MCP tool *logic* as one-shot processes, with NO
 * persistent MCP server in the loop. Each invocation runs a tool function over
 * the filesystem and exits — so the cascade-SIGTERM (which only kills a
 * long-lived stdio server child sitting in the host's process group) cannot
 * occur by construction. Consumed by the spike `run` workflow's seam-agents,
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
 * This is the one-shot seam transport the stateless `run` workflow's seam-agents
 * shell out to — no persistent MCP server on the run path. Reuses every tool
 * function unchanged; see plugins/flow/mcp-server/src/tools/register.ts for the
 * same functions wired to the MCP transport (interactive skills still use that).
 */

import { DomainError } from "./errors.js";
import { TOOL_INPUT_SCHEMAS } from "./schemas/tool-input-schemas.js";
import { getStatus } from "./tools/get-status.js";
import { openCycle } from "./tools/open-cycle.js";
import { gatherRetroInputs } from "./tools/gather-retro-inputs.js";
import { mintSessionUlid } from "./tools/mint-session-ulid.js";
import { runPhaseStart, runPhaseDone } from "./tools/run-phase-progress.js";
import { scanSources } from "./tools/scan-sources.js";
import { createSmokeScratchRepo } from "./tools/create-smoke-scratch-repo.js";
import { instantiatePersona } from "./tools/instantiate-persona.js";
import { writeNativeStory } from "./tools/write-native-story.js";

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
import { recordMaintainerFeedback } from "./tools/record-maintainer-feedback.js";
import { reviewMaintainerInbox } from "./tools/review-maintainer-inbox.js";
import { dismissMaintainerFeedback } from "./tools/dismiss-maintainer-feedback.js";
import { resolveLensRoles } from "./tools/resolve-lens-roles.js";
import { resolveRunSlot } from "./tools/resolve-run-slot.js";
import { recordReviewerLesson } from "./tools/record-reviewer-lesson.js";
import { readReviewerLesson } from "./tools/read-reviewer-lesson.js";
import { recordStoryRetro } from "./tools/record-story-retro.js";
import { recordDevLesson } from "./tools/record-dev-lesson.js";
import { readDevLesson } from "./tools/read-dev-lesson.js";
import { recallLesson } from "./tools/recall-lesson.js";
import { classifyStoryLane } from "./tools/classify-story-lane.js";
import { resolveJudgePlan } from "./tools/resolve-judge-plan.js";
import { resolveBuildPlan } from "./tools/resolve-build-plan.js";
import { discardDraft } from "./tools/discard-draft.js";
import { blockStory } from "./tools/block-story.js";
import { extractNativeStoryAcs } from "./tools/extract-native-story-acs.js";
import { captureSkillInvoke } from "./tools/capture-skill-invoke.js";
import { autoAbsorbProposalFile } from "./tools/auto-absorb-retro-proposals.js";
import { readCatalogue } from "./tools/read-catalogue.js";
import { summariseRetroProposal } from "./tools/summarise-retro-proposal.js";
import { analyzeTeamFit } from "./tools/analyze-team-fit.js";
import { unhirePersona } from "./tools/unhire-persona.js";
import { refreshPersona } from "./tools/refresh-persona.js";
import { matchStorySpecialist } from "./tools/match-story-specialist.js";
import { recordSpecialistEngagement } from "./tools/record-specialist-engagement.js";
import { checkGitRemote } from "./tools/check-git-remote.js";
import { resolveRunBase } from "./tools/resolve-run-base.js";

// Each tool is a pure fn(opts) -> result|Promise<result>. `any` here is
// deliberate: the shim is a transport-agnostic courier and the tool functions
// validate their own inputs (mirroring register.ts's parse->call->serialise).
type ToolFn = (args: any) => unknown | Promise<unknown>;

const TOOLS: Record<string, ToolFn> = {
  getStatus,
  // Story native:01KT484NY4HCBPBTT6VEY1Q0CS — open a new work cycle. Exposed on
  // the CLI seam so the run / skill workflows can open a cycle without a
  // persistent MCP session. `gatherRetroInputs` is registered alongside it so
  // the no-MCP retro path can gather the (now cycle-scoped) bundle one-shot.
  openCycle,
  gatherRetroInputs,
  mintSessionUlid,
  runPhaseStart,
  runPhaseDone,
  scanSources,
  createSmokeScratchRepo,
  instantiatePersona,
  writeNativeStory,
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
  // Story 9.1 readiness brake (the "bless" mutation). The run runs MCP-free, so
  // blessing the next story needed a hand-written `node` helper until this was a
  // first-class CLI seam (Epic 10 run fix-plan, Fix 1). Now `/flow:ready` and the
  // cutover scan→bless step round-trip through the same one-shot transport.
  markStoryReady,
  // Epic 10 run fix-plan, Fix 2b — clean-root guard. The run calls this after
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
  // Registered here so run-path agents (seam-agents running node dist/cli.js)
  // can emit friction events without a persistent MCP server in the loop.
  recordAgentFriction,
  // Story native:01KV7FHZ41Z6CFPABW1B8J38BV — maintainer feedback capture seam.
  // Any role on the team (or the retrospective) can call this when it hits a
  // structural limitation of the tool itself. The item lands in a maintainer-only
  // inbox (.flow/maintainer-inbox/) that the team never reads to drive its own
  // behaviour. Items accumulate as distinct timestamped JSON files.
  //   node dist/cli.js recordMaintainerFeedback --json
  //     '{"targetRepoRoot":"...","item":{"problem":"...","tool_area":"...","trigger":"..."}}'
  recordMaintainerFeedback,
  // Story native:01KV9QR3VK11RDD1ZDPVJ7SEYA — reviewMaintainerInbox: on-demand review
  // of stored maintainer-feedback items. Reads .flow/maintainer-inbox/ and returns each
  // item with a pre-filled GitHub new-issue URL. Empty inbox returns emptyInbox:true.
  // Read-only; accessible via the CLI seam so skills can surface it without a persistent
  // MCP session.
  //   node dist/cli.js reviewMaintainerInbox --json '{"targetRepoRoot":"..."}'
  reviewMaintainerInbox,
  // Story native:01KVDXX (surface-maintainer-findings-in-run) — dismissMaintainerFeedback:
  // archive one inbox item by id so it stops re-surfacing in the /flow:run closing summary.
  // Idempotent no-op on a missing/already-dismissed id; throws on a malformed id. Exposed on
  // the no-MCP run path so the run skill can dismiss without a persistent MCP session.
  //   node dist/cli.js dismissMaintainerFeedback --json '{"targetRepoRoot":"...","id":"..."}'
  dismissMaintainerFeedback,
  // Story native:01KT2Q51E24XKMM4YEF0ADRKNG — read-only lens→role resolver (FU2).
  // Callable on the no-MCP run/gate path: node dist/cli.js resolveLensRoles --json
  // '{"targetRepoRoot":"..."}'. Returns { lensRoles, hiredRoles }. gate-1.workflow.js
  // calls this instead of the previously hard-coded lensRoles block.
  resolveLensRoles,
  // Story native:01KVPQS1DVJE41KNG065D6X1X7 — dynamic builder/reviewer slot resolver.
  // Reads the live hired roster and returns the role that fills the requested run job
  // slot (build or review). The generalist default wins when present and qualified;
  // otherwise the single other qualified role wins. Throws RunSlotUnstaffedError when
  // no qualified role exists — the run halts cleanly instead of guessing.
  // Callable on the no-MCP run path:
  //   node dist/cli.js resolveRunSlot --json '{"targetRepoRoot":"...","job":"build"}'
  resolveRunSlot,
  // Story native:01KT6GSV8KTTKKHPRGEJWJAGZV — learning-loop producer.
  // recordReviewerLesson is the CAPTURE seam: the reviewer (a no-MCP run-path
  // seam-agent) calls it via `node dist/cli.js recordReviewerLesson --json` to
  // merge one reusable lesson onto the per-ref reviewer-result.json.
  // recordStoryRetro is the FORWARD seam: the run reads that captured lesson and
  // attaches it to the done manifest (`node dist/cli.js recordStoryRetro --json`)
  // before the merge gate runs. readReviewerLesson is the read side of FORWARD —
  // a thin read-only seam returning { lesson } off the reviewer-result.json so the
  // run knows whether (and what) to forward. All three must be on the CLI seam
  // because the run runs MCP-free.
  recordReviewerLesson,
  readReviewerLesson,
  recordStoryRetro,
  // Story native:01KTAWXSVFEDNRCZDNG76PJ1BD — builder lesson capture seam.
  // recordDevLesson is the CAPTURE seam: the dev (a no-MCP run-path agent)
  // calls it via `node dist/cli.js recordDevLesson --json` to write one reusable
  // lesson onto the per-ref dev-result.json BEFORE emitting the handoff phrase.
  // readDevLesson is the read side of FORWARD — a thin read-only seam returning
  // { lesson } off the dev-result.json so the run knows whether (and what)
  // to forward to the done manifest alongside the reviewer lesson.
  // Both must be on the CLI seam because the run runs MCP-free.
  recordDevLesson,
  readDevLesson,
  // Story native:01KT6QEWY794ZY0DH6JHQFWG6V — on-demand lesson recall.
  // buildPersonaSpawnPrompt now emits a one-line index; agents call this
  // to retrieve the full detail body of a specific lesson by id.
  recallLesson,
  // Story native:01KTKJXP6DWN5YHKVG96DH16V0 — pre-judge lane classifier.
  // Pure deterministic function: classifies a story into 'fast' or 'full'
  // from its execution-manifest signals before the costly judge panel runs.
  // Callable on the no-MCP run/gate path: node dist/cli.js classifyStoryLane
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
  // Callable on the no-MCP run path:
  //   node dist/cli.js resolveBuildPlan --json '{"storyId":"...","manifestPath":"..."}'
  resolveBuildPlan,
  // Story native:01KTZKHJ1KDYKGXR20FZ15Y4WB — discard an un-claimed native draft.
  // Removes BOTH the to-do/ execution manifest AND the .flow/native-stories/<ULID>.md
  // source draft so a later projection pass cannot re-materialise the item.
  // Callable on the no-MCP seam:
  //   node dist/cli.js discardDraft --json '{"targetRepoRoot":"...","ref":"native:..."}'
  discardDraft,
  // fix/run-isolation-coordination-honesty — blockStory: the live run's
  // "give up on this story" seam. Moves a story THIS session owns from
  // in-progress/ to blocked/ with a give-up reason, so an abandoned story stops
  // counting as live work and the queue can run (the non-termination fix).
  //   node dist/cli.js blockStory --json '{"targetRepoRoot":"...","ref":"native:...","sessionUlid":"...","blockedBy":"worker-threw"}'
  blockStory,
  // Story native:01KT6QGBWP7KJDVMHQK3MEKDXP — inline AC extraction for native stories.
  // Called by the run BEFORE spawning the builder worktree, so the builder receives
  // its ACs inline and never needs to resolve a .flow/native-stories path from within
  // its isolated work copy (.flow is gitignored — not present in builder worktrees).
  //   node dist/cli.js extractNativeStoryAcs --json '{"targetRepoRoot":"...","ref":"native:01KT..."}'
  extractNativeStoryAcs,
  // Story native:01KV4610DTPJJR5E5JJN7P235D — deterministic skill.invoke capture.
  // Called by the flow plugin's PreToolUse hook on the `Skill` tool (hooks/hooks.json
  // → scripts/skill-invoke-hook.sh). Takes the raw Claude Code hook payload, derives
  // the skill.invoke data (skill name from tool_input.skill), and funnels it through
  // recordSkillInvoke. FAIL-SOFT: never throws — returns { recorded, reason }.
  //   <hook stdin> | node dist/cli.js captureSkillInvoke --json "$PAYLOAD"
  captureSkillInvoke,
  // Story native:01KV2Z67850XWWQV0AY2N05JSX — auto-absorb note-tier retro proposals.
  // Called by the run's post-retro step after the retro-analyst writes its
  // proposals. Reads the proposal file by timestamp, filters to note-tier
  // persona-append proposals, and applies them autonomously (up to the per-run
  // ceiling; higher-stakes proposals stay pending for the operator).
  // Fail-soft: never throws — returns { absorbed, pending, absorbedIds, errors }.
  //   node dist/cli.js autoAbsorbProposalFile --json
  //     '{"targetRepoRoot":"...","proposalFileTimestamp":"2026-06-15T10:00:00.000Z"}'
  autoAbsorbProposalFile,
  // Story native:01KV2ZF0B74KKKHS1JQ4075N9T — unattended auto-retro in the run.
  // The run spawns the retro-analyst subagent after the queue empties. To build the
  // analyst's system prompt, it calls readCatalogue via this seam rather than reading
  // the catalogue file in-workflow (the Workflow runtime does not have fs access).
  // pluginRoot is the root of the flow plugin directory (NOT the target repo root).
  //   node dist/cli.js readCatalogue --json '{"pluginRoot":"...","role":"retro-analyst"}'
  readCatalogue,
  // Story native:01KV7DH3KM2Q2F5ZQ5WX558KHG — run closing summary retro block.
  // Called by the run after the unattended auto-retro fires, on the 'ran' path when
  // pendingCount > 0. Reads the proposal file and returns a structured summary of
  // pending (non-auto-absorbed) recommendations for the operator to act on.
  // Read-only / idempotent → safe to call from a read-only seam.
  //   node dist/cli.js summariseRetroProposal --json '{"absPath":"..."}'
  summariseRetroProposal,
  // Story native:01KVFAF2T7DPJ5T18PQ534D7XM — analyzeTeamFit: backlog + telemetry-grounded
  // hire / unhire / gap recommendations. Reads the live roster, backlog (risk tier +
  // spec text), and telemetry; returns { hire, unhire, gaps } where every item carries
  // the concrete evidence that triggered it. All rules are deterministic (no LLM).
  //   node dist/cli.js analyzeTeamFit --json '{"targetRepoRoot":"..."}'
  analyzeTeamFit,
  // Story native:01KVF66HWKXCM7GYNRR9YJFKB2 — unhirePersona: safely set aside a
  // teammate reversibly. Archives team/<role>/PERSONA.md under team/_archived/ and
  // refuses if the removal would leave the judge panel unable to staff all five lenses
  // (uses the bipartite matcher — not a head-count). Idempotent on already-archived.
  //   node dist/cli.js unhirePersona --json '{"targetRepoRoot":"...","role":"<role>"}'
  unhirePersona,
  // Story native:01KVS0YFNNFWFDP2EJT10FMV08 — refreshPersona: re-materialise an
  // existing hired persona from the current catalogue, preserving its hired_at
  // timestamp and accrued ## Knowledge section. Works even at the minimum roster
  // (no unhire needed). Throws PersonaFileNotFoundError when the role is not hired.
  //   node dist/cli.js refreshPersona --json '{"targetRepoRoot":"...","role":"<role>"}'
  refreshPersona,
  // Story native:01KVPSZ14HH48J9NEH7N6S6QDR — matchStorySpecialist: derive the
  // specialist to auto-engage for a story from its cited-source paths matched against
  // hired specialists' declared capabilities.path_patterns. Returns { role, domain }
  // on match, { role: null, domain: null } on no-match (generalists-only). Read-only.
  //   node dist/cli.js matchStorySpecialist \
  //     --json '{"targetRepoRoot":"...","manifestPath":"..."}'
  matchStorySpecialist,
  // Story native:01KVPSZ14HH48J9NEH7N6S6QDR — recordSpecialistEngagement: write
  // engaged_specialist onto the in-progress manifest to record participation.
  //   node dist/cli.js recordSpecialistEngagement \
  //     --json '{"targetRepoRoot":"...","ref":"native:...","sessionUlid":"...","specialistRole":"<role>"}'
  recordSpecialistEngagement,
  // Story native:01KVS0ZW2GYSN25VC45GWNA4MG — checkGitRemote: check whether the
  // target repo has at least one configured git remote. Used by the run pre-flight
  // checklist so a missing remote is surfaced before any story is claimed or built.
  //   node dist/cli.js checkGitRemote --json '{"targetRepoRoot":"..."}'
  checkGitRemote,
  // Story native:01KVS1150C7H9HCGG07Y0XBT98 — resolveRunBase: resolve the current
  // local HEAD and detect config divergence between local HEAD and origin/<base>.
  // Used by the run pre-flight checklist: when local HEAD has committed tracked-config
  // (team/, docs/standards.md) that origin/<base> lacks, the run fails loud rather
  // than silently sourcing config from one commit and code from another.
  //   node dist/cli.js resolveRunBase --json '{"targetRepoRoot":"...","baseBranch":"main"}'
  resolveRunBase,
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

  // Entry-point required-field validation using the shared input contract
  // (Story native:01KV45Y13EQYVZP98PR8A9F40P). Tools absent from the schema
  // map are CLI-only (run internals) and bypass this check — their own
  // implementations handle validation.
  const schema = TOOL_INPUT_SCHEMAS[tool];
  if (schema !== undefined && typeof args === "object" && args !== null) {
    const missing = (schema.required ?? []).filter(
      (k) => !Object.prototype.hasOwnProperty.call(args as object, k),
    );
    if (missing.length > 0) {
      emit({
        error: {
          kind: "missing-required-fields",
          tool,
          missing,
          required: schema.required,
        },
      });
      process.exit(65);
    }
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
