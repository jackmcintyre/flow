import { z } from "zod";
import { DomainError } from "../errors.js";
import { getPluginRoot } from "../lib/plugin-root.js";
import type { AiEngineeringTeamServer } from "../server.js";
import {
  analyzeTeamFitInputSchema,
  acceptProposalInputSchema,
  adjudicateQualityLeadInputSchema,
  aggregateJudgePanelInputSchema,
  applyReviewerLabelsInputSchema,
  blockOrphanNoTranscriptInputSchema,
  buildPersonaSpawnPromptInputSchema,
  claimNextStoryInputSchema,
  claimStoryInputSchema,
  classifyRiskTierInputSchema,
  classifyStoryLaneInputSchema,
  completeStoryInputSchema,
  computeAgreementInputSchema,
  computeSkillEffectivenessInputSchema,
  createSmokeScratchRepoInputSchema,
  discardDraftInputSchema,
  gatherRetroInputsInputSchema,
  getBacklogDashboardInputSchema,
  getHelpAdviceInputSchema,
  getStatusInputSchema,
  getTeamSnapshotInputSchema,
  initWorkspaceInputSchema,
  instantiatePersonaInputSchema,
  listClaimableTodosInputSchema,
  lookupRoleByDomainInputSchema,
  markStoryReadyInputSchema,
  markWithdrawnInputSchema,
  mintSessionUlidInputSchema,
  openCycleInputSchema,
  postReviewerCommentsInputSchema,
  processDevTranscriptInputSchema,
  processReviewerTranscriptInputSchema,
  processReviewerYieldInputSchema,
  readBacklogInventoryInputSchema,
  readCatalogueInputSchema,
  readCustomRoleInputSchema,
  readPersonaInputSchema,
  readRepoSignalsInputSchema,
  reattachOrphanInputSchema,
  recallLessonInputSchema,
  requeueBlockedStoryInputSchema,
  recordAgentFrictionInputSchema,
  recordMaintainerFeedbackInputSchema,
  reviewMaintainerInboxInputSchema,
  dismissMaintainerFeedbackInputSchema,
  recordReviewerLessonInputSchema,
  recordSkillInvokeInputSchema,
  recordStoryRetroInputSchema,
  resolveBuildPlanInputSchema,
  resolveJudgePlanInputSchema,
  resolveLensRolesInputSchema,
  resolveRunSlotInputSchema,
  runAutoMergeGateInputSchema,
  runDevTerminalActionInputSchema,
  runReviewerSessionInputSchema,
  scanOrphanedInProgressInputSchema,
  scanSourcesInputSchema,
  summariseRetroProposalInputSchema,
  validatePlannerBacklogInputSchema,
  unhirePersonaInputSchema,
  writeLensVerdictInputSchema,
  writeNativeStoryInputSchema,
  writeRetroProposalInputSchema,
  matchStorySpecialistInputSchema,
  recordSpecialistEngagementInputSchema,
} from "../schemas/tool-input-schemas.js";
import { buildPersonaSpawnPrompt } from "./build-persona-spawn-prompt.js";
import { claimStory } from "./claim-story.js";
import { completeStory } from "./complete-story.js";
import { recordStoryRetro } from "./record-story-retro.js";
import { recordReviewerLesson } from "./record-reviewer-lesson.js";
import { writeRetroProposal } from "./write-retro-proposal.js";
import { acceptProposal } from "./accept-proposal.js";
import { gatherRetroInputs } from "./gather-retro-inputs.js";
import { listClaimableTodos } from "./list-claimable-todos.js";
import { mintSessionUlid } from "./mint-session-ulid.js";
import {
  getBacklogDashboard,
  renderBacklogDashboard,
} from "./render-backlog-dashboard.js";
import { getStatus, renderStatus } from "./get-status.js";
import { initWorkspace, renderInitWorkspace } from "./init-workspace.js";
import { openCycle } from "./open-cycle.js";
import { getTeamSnapshot, renderTeamSnapshot } from "./get-team-snapshot.js";
import { instantiatePersona } from "./instantiate-persona.js";
import { lookupRoleByDomain } from "./lookup-role-by-domain.js";
import { markWithdrawn } from "./mark-withdrawn.js";
import { markStoryReady } from "./mark-story-ready.js";
import { readBacklogInventory } from "./read-backlog-inventory.js";
import { readCatalogue } from "./read-catalogue.js";
import { readCustomRole } from "./read-custom-role.js";
import { readPersona } from "./read-persona.js";
import { readRepoSignals } from "./read-repo-signals.js";
import { scanSources, renderScanResult } from "./scan-sources.js";
import { validatePlannerBacklog } from "./validate-planner-backlog.js";
import { writeNativeStory } from "./write-native-story.js";

import { claimNextStory } from "./claim-next-story.js";
import { processDevTranscript } from "./process-dev-transcript.js";
import { processReviewerTranscript } from "./process-reviewer-transcript.js";
import { runDevTerminalAction } from "./run-dev-terminal-action.js";
import { runReviewerSession } from "./run-reviewer-session.js";
import { postReviewerComments } from "./post-reviewer-comments.js";
import { applyReviewerLabels } from "./apply-reviewer-labels.js";
import { processReviewerYield } from "./process-reviewer-yield.js";
import { classifyRiskTier } from "./classify-risk-tier.js";
import { computeAgreement, AgreementMetricResultSchema } from "./compute-agreement.js";
import { recordSkillInvoke } from "./record-skill-invoke.js";
import {
  computeSkillEffectiveness,
  SkillEffectivenessResultSchema,
} from "./compute-skill-effectiveness.js";
import { runAutoMergeGate, AutoMergeGateResultSchema } from "./run-auto-merge-gate.js";
import { createSmokeScratchRepo } from "./create-smoke-scratch-repo.js";
import { scanOrphanedInProgress } from "./scan-orphaned-in-progress.js";
import { reattachOrphan } from "./reattach-orphan.js";
import { blockOrphanNoTranscript } from "./block-orphan-no-transcript.js";
import { writeLensVerdict, aggregateJudgePanel, DEFAULT_LENS_ROLES } from "./judge-panel.js";
import { LENS_NAMES, PanelVerdictSchema } from "../schemas/lens-verdict.js";
import { adjudicateQualityLead, DEFAULT_ADJUDICATION_K } from "./quality-lead-adjudicate.js";
import { recordAgentFriction } from "./record-agent-friction.js";
import { recordMaintainerFeedback } from "./record-maintainer-feedback.js";
import { renderFeedbackLinkBlock } from "./build-feedback-issue-url.js";
import type { MaintainerFeedbackItem } from "../schemas/maintainer-feedback.js";
import {
  reviewMaintainerInbox,
  composeStoredItemIssueTitle,
  composeStoredItemIssueBody,
} from "./review-maintainer-inbox.js";
import { dismissMaintainerFeedback } from "./dismiss-maintainer-feedback.js";
import { resolveLensRoles } from "./resolve-lens-roles.js";
import { resolveRunSlot } from "./resolve-run-slot.js";
import { recallLesson } from "./recall-lesson.js";
import { classifyStoryLane } from "./classify-story-lane.js";
import { resolveJudgePlan } from "./resolve-judge-plan.js";
import { resolveBuildPlan } from "./resolve-build-plan.js";
import { summariseRetroProposal } from "./summarise-retro-proposal.js";
import { discardDraft } from "./discard-draft.js";
import { requeueBlockedStory } from "./requeue-blocked-story.js";
import { getHelpAdvice, renderHelpAdvice } from "./help-advisor.js";
import { analyzeTeamFit } from "./analyze-team-fit.js";
import { unhirePersona } from "./unhire-persona.js";
import { matchStorySpecialist } from "./match-story-specialist.js";
import { recordSpecialistEngagement } from "./record-specialist-engagement.js";

/**
 * Tool-registration seam. Every future story that ships an MCP tool
 * appends a `server.registerTool({...})` call here, keeping `server.ts`
 * free of tool-specific imports.
 *
 * Wired into `index.ts` (the stdio entrypoint) after `createServer()`
 * but BEFORE `server.connect(transport)`. NOT called from `createServer`
 * itself — the smoke test (`acceptance.test.ts` AC3) asserts that a
 * bare `createServer()` registers zero tools.
 */
export function registerAllTools(server: AiEngineeringTeamServer): void {
  server.registerTool({
    name: "getStatus",
    description:
      "Return a typed status report for the resolved target repo (plugin version, adapter, standards-doc state, cycle).",
    inputSchema: getStatusInputSchema,
    handler: async (args) => {
      const root = z.string().min(1).parse(args.targetRepoRoot);
      const report = await getStatus({ targetRepoRoot: root });
      return {
        content: [{ type: "text" as const, text: renderStatus(report) }],
      };
    },
  });

  // Story native:flow-init — initWorkspace: first-run scaffolder for /flow:init.
  // Idempotently writes an explicit .flow/config.yaml (default adapter: native),
  // the .flow/state/ lanes, .flow/native-stories/ (native), and seeds
  // docs/standards.md from the shipped template. The explicit config is what
  // makes a story-less fresh repo resolvable (no adapter can auto-detect one).
  // Never overwrites existing files. Runs at operator authority (no role gate).
  server.registerTool({
    name: "initWorkspace",
    description:
      "Scaffold a fresh target repo into a Flow workspace (idempotent). Writes an " +
      "explicit .flow/config.yaml (default adapter: native) — which breaks the fresh-repo " +
      "deadlock where no adapter can auto-detect without existing stories — creates the " +
      ".flow/state/{to-do,in-progress,blocked,done}/ lanes (and .flow/native-stories/ on " +
      "native), and seeds docs/standards.md from the shipped template when absent. Never " +
      "overwrites existing files. Returns a rendered scaffold summary plus a how-it-works " +
      "orientation and the recommended next step. Used by /flow:init.",
    inputSchema: initWorkspaceInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          adapter: z.enum(["native", "bmad"]).default("native"),
        })
        .parse(args);
      const result = await initWorkspace({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: parsed.targetRepoRoot,
        adapter: parsed.adapter,
        mcpToolContext: { toolName: "initWorkspace", role: "operator" },
      });
      return {
        content: [{ type: "text" as const, text: renderInitWorkspace(result) }],
      };
    },
  });

  // Story native:01KT484NY4HCBPBTT6VEY1Q0CS — openCycle: open a new work cycle.
  // Mints a cycle ULID, archives the prior cycle's record (done manifests, retro
  // proposals, telemetry summary) under .flow/cycle-archive/ when one is active,
  // overwrites .flow/cycle-state.json with the new cycle, and emits one
  // cycle.opened telemetry event. After this, getStatus reports the new ULID and
  // gatherRetroInputs scopes its bundle to work after opened_at.
  server.registerTool({
    name: "openCycle",
    description:
      "Open a new work cycle (Story native:01KT484NY4HCBPBTT6VEY1Q0CS). Mints a fresh " +
      "cycle ULID, archives the prior cycle's record (done manifests, retro proposals, " +
      "telemetry summary) under .flow/cycle-archive/<prior-ulid>-<iso>.yaml BEFORE the " +
      "window resets when a cycle is active, overwrites .flow/cycle-state.json with the " +
      "new cycle, and emits exactly one cycle.opened telemetry event. After it returns, " +
      "getStatus reports the new ULID instead of 'none' and gatherRetroInputs scopes its " +
      "bundle to work completed at or after the new cycle's opened_at. Returns " +
      "{ cycleUlid, openedAt, priorCycleUlid, archivePath }.",
    inputSchema: openCycleInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1).optional(),
        })
        .parse(args);
      try {
        const result = await openCycle(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 2.3 — persona machinery (FR82, FR83, FR89, FR93, FR99).
  server.registerTool({
    name: "readCatalogue",
    description:
      "Read a catalogue role file from plugins/flow/catalogue/ and return its parsed frontmatter and body sections (FR82, FR83).",
    inputSchema: readCatalogueInputSchema,
    handler: async (args) => {
      const parsed = z.object({ role: z.string().min(1) }).parse(args);
      const result = await readCatalogue({
        pluginRoot: getPluginRoot(),
        role: parsed.role,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });

  server.registerTool({
    name: "instantiatePersona",
    description:
      "Materialise a persona file at <target-repo>/team/<role>/PERSONA.md by copying the catalogue verbatim and stamping hired_at + catalogue_version; refuses on existing persona (FR89).",
    inputSchema: instantiatePersonaInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          role: z.string().min(1),
        })
        .parse(args);
      const result = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: parsed.targetRepoRoot,
        role: parsed.role,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });

  server.registerTool({
    name: "readPersona",
    description:
      "Read a persona file at <target-repo>/team/<role>/PERSONA.md and return parsed frontmatter + body sections (FR93).",
    inputSchema: readPersonaInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          role: z.string().min(1),
        })
        .parse(args);
      const result = await readPersona(parsed);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });

  server.registerTool({
    name: "lookupRoleByDomain",
    description:
      "Exact-match a domain string against hired personas' domain frontmatter; returns { role } or { role: null } (FR99).",
    inputSchema: lookupRoleByDomainInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          domain: z.string().min(1),
        })
        .parse(args);
      const result = await lookupRoleByDomain(parsed);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });

  // Story 2.4 — repo signal read for the hiring manager (FR85).
  server.registerTool({
    name: "readRepoSignals",
    description:
      "Return a typed RepoSignals payload (languages, layout, README excerpt, recent commit titles, dependency manifests) for the resolved target repo. Used by /hire (FR85).",
    inputSchema: readRepoSignalsInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({ targetRepoRoot: z.string().min(1) })
        .parse(args);
      const result = await readRepoSignals({
        targetRepoRoot: parsed.targetRepoRoot,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });

  // Story 2.5 — manual escape hatch for operator-authored custom roles
  // (FR92). Parses <target-repo>/team/custom/<role>.md against the same
  // CatalogueRoleSchema as a shipped catalogue file.
  server.registerTool({
    name: "readCustomRole",
    description:
      "Read an operator-authored custom role file from <target-repo>/team/custom/<role>.md and return its parsed CatalogueRole. Used by /hire to support the FR92 manual escape hatch.",
    inputSchema: readCustomRoleInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          role: z.string().min(1),
        })
        .parse(args);
      const result = await readCustomRole({
        targetRepoRoot: parsed.targetRepoRoot,
        role: parsed.role,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });

  // Story 2.6 — team snapshot (FR108, NFR28). Pure file reads; no LLM
  // in the loop. Used by /flow:team.
  server.registerTool({
    name: "getTeamSnapshot",
    description:
      "Return a typed snapshot of the hired team — roles, domains, fire counts from telemetry, recent persona-knowledge entries. Used by /flow:dashboard (FR108, NFR28). Pure file reads; no LLM in the loop.",
    inputSchema: getTeamSnapshotInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          knowledgeLimit: z.number().int().positive().optional(),
        })
        .parse(args);
      const snapshot = await getTeamSnapshot(parsed);
      return {
        content: [{ type: "text" as const, text: renderTeamSnapshot(snapshot) }],
      };
    },
  });

  // Story 3.4 — writeNativeStory: write a new native-story file under
  // `<targetRepoRoot>/.flow/native-stories/<ULID>.md`. Invoked by the
  // planner subagent (spawned by /flow:plan) in native-adapter workspaces.
  // The tool refuses with WrongAdapterError if the active adapter is not
  // 'native', providing a runtime guard for the BMad-branch Behavioural
  // contract clause.
  server.registerTool({
    name: "writeNativeStory",
    description:
      "Write a new native-adapter story file under <targetRepoRoot>/.flow/native-stories/<ULID>.md. " +
      "Refuses with WrongAdapterError if the active adapter is not 'native'. " +
      "Fail-closed discipline gate (Story 9.2): refuses with DisciplineViolationError and writes " +
      "nothing if the candidate violates an authoring-time planning-discipline rule (e.g. a " +
      "state-mutating story with no integration AC). On a successful write, emits exactly one " +
      "draft.authored telemetry event. Used by the planner subagent and the author " +
      "subagent, both behind /flow:plan (Story 3.4 / 9.2).",
    inputSchema: writeNativeStoryInputSchema,
    handler: async (args) => {
      try {
        const result = await writeNativeStory(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 3.5 — validatePlannerBacklog: planning-discipline pre-write gate for
  // the planner subagent. The planner MUST call this before every
  // `writeNativeStory` invocation and before emitting the locked handoff phrase.
  // Native-adapter workspaces only (throws WrongAdapterError for BMad).
  server.registerTool({
    name: "validatePlannerBacklog",
    description:
      "Validate a batch of pending native stories against planning-discipline rules before writing. " +
      "Returns { ok: true } on pass or { ok: false; violations } on any failure. " +
      "The planner MUST call this before every writeNativeStory and before emitting the handoff phrase. " +
      "Throws WrongAdapterError if the active adapter is not 'native' (Story 3.5).",
    inputSchema: validatePlannerBacklogInputSchema,
    handler: async (args) => {
      try {
        const result = await validatePlannerBacklog(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 3.6 — markWithdrawn: mark an execution manifest withdrawn (FR78).
  // External-adapter discard path. Native discard uses writeNativeStory with
  // a revert/deprecate story instead.
  server.registerTool({
    name: "markWithdrawn",
    description:
      "Mark an execution manifest withdrawn (FR78). External-adapter discard path. Native discard uses writeNativeStory with a revert/deprecate story instead.",
    inputSchema: markWithdrawnInputSchema,
    handler: async (args) => {
      try {
        const result = await markWithdrawn(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 9.1 — markStoryReady: the operator readiness brake (Epic 9 intake
  // cockpit). Flips the `ready` flag on an un-claimed backlog manifest; the
  // claim path admits an item only when it is BOTH deps-ready AND `ready`.
  // No-op when the flag already holds the value; NotAnEligibleBacklogItemError
  // when the ref is not an un-claimed backlog item.
  server.registerTool({
    name: "markStoryReady",
    description:
      "Set the operator `ready` flag on an un-claimed backlog item (Story 9.1). " +
      "The run claims an item only once it is dependency-ready AND marked ready. " +
      "Writes the manifest in-place (no state-directory move); no-op if the flag " +
      "already holds the requested value; raises NotAnEligibleBacklogItemError for " +
      "anything that is not an un-claimed to-do/ item.",
    inputSchema: markStoryReadyInputSchema,
    handler: async (args) => {
      try {
        const result = await markStoryReady(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 3.6 (HIGH-1 fix) — readBacklogInventory: build the backlog inventory
  // server-side so the /flow:plan skill does not need to glob filesystem paths
  // via the Read tool. Returns typed { mode, backlog_inventory } JSON consumed
  // by the planner skill's <initial-context> block.
  // MalformedExecutionManifestError (and other parseExecutionManifest errors)
  // surface verbatim to the skill (not caught here).
  server.registerTool({
    name: "readBacklogInventory",
    description:
      "Build the backlog inventory for the target repo server-side (Story 3.6). " +
      "Returns { mode: 'first-run'|'re-open', backlog_inventory: [{ref, title, state, withdrawn, ready, depsReady}] }. " +
      "Scans all four state directories and (on native) the native-stories dir. " +
      "Optional `ref` returns only the matching entry; optional `includeSpecText` enriches each returned entry with `specText` + `riskTier` (used by the gate-1 judge workflow). " +
      "MalformedExecutionManifestError surfaces verbatim. " +
      "Used by the /flow:plan skill to derive re-open mode and assemble <initial-context>.",
    inputSchema: readBacklogInventoryInputSchema,
    handler: async (args) => {
      try {
        const result = await readBacklogInventory(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 9.5 — getBacklogDashboard: the cockpit read surface. Reads the live
  // backlog inventory once (the only IO) and renders a grouped-by-epic view
  // with each item's state, readiness (Story 9.1 flag), and claimability
  // (deps-ready AND ready, un-withdrawn to-do). Read-only — mutates nothing;
  // mirrors the getStatus getter/renderStatus pure-render split. The dashboard
  // is generated output, never a hand-maintained list.
  // MalformedExecutionManifestError surfaces verbatim (not caught here).
  server.registerTool({
    name: "getBacklogDashboard",
    description:
      "Render the outstanding backlog as grouped-by-epic tables generated from live state (Story 9.5). " +
      "Read-only — reads the backlog inventory and returns text grouping each item by epic with its " +
      "state, readiness (the Story 9.1 ready flag), and claimability (dependency-satisfied AND ready, " +
      "an un-withdrawn to-do item). Never mutates state and never writes a file. " +
      "MalformedExecutionManifestError surfaces verbatim. Used by the /flow:dashboard skill.",
    inputSchema: getBacklogDashboardInputSchema,
    handler: async (args) => {
      const root = z.string().min(1).parse(args.targetRepoRoot);
      try {
        const snapshot = await getBacklogDashboard({ targetRepoRoot: root });
        return {
          content: [
            { type: "text" as const, text: renderBacklogDashboard(snapshot) },
          ],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KVEHE5XNBHKVVZ624GPAW9FF — getHelpAdvice: context-aware
  // next-action advisor for the /flow:help skill. Reads live project state
  // (team presence, backlog readiness, in-progress builds) and returns the
  // single best next action for the operator right now. Pure file reads;
  // no LLM, no network, no mutation.
  server.registerTool({
    name: "getHelpAdvice",
    description:
      "Return a context-aware next-action recommendation grounded in the live project state " +
      "(Story native:01KVEHE5XNBHKVVZ624GPAW9FF). " +
      "Reads team presence, backlog readiness, and in-progress build counts; " +
      "returns the single best next action for the operator right now with the " +
      "command that performs it. " +
      "Pure file reads — no LLM, no network, no mutation. Used by /flow:help.",
    inputSchema: getHelpAdviceInputSchema,
    handler: async (args) => {
      const root = z.string().min(1).parse(args.targetRepoRoot);
      const advice = await getHelpAdvice({ targetRepoRoot: root });
      return {
        content: [{ type: "text" as const, text: renderHelpAdvice(advice) }],
      };
    },
  });

  // Story native:01KVFAF2T7DPJ5T18PQ534D7XM — analyzeTeamFit: backlog + telemetry-grounded
  // hire / unhire / gap recommendations. Reads the live roster, backlog (risk tier +
  // spec text), and telemetry; returns concrete hire / unhire / gap items where every
  // recommendation carries the evidence (story refs, stall counts) that triggered it.
  // All detection rules are deterministic (no LLM). Used by /flow:hire and /flow:retro.
  server.registerTool({
    name: "analyzeTeamFit",
    description:
      "Analyse the live roster, backlog, and telemetry and produce hire / unhire / gap " +
      "recommendations grounded in real evidence (Story native:01KVFAF2T7DPJ5T18PQ534D7XM). " +
      "Returns { hire: [{role, reason, evidence}], unhire: [{role, reason, evidence}], " +
      "gaps: [{domain, signal}] }. " +
      "All detection rules are deterministic — no LLM, no network, no mutation.",
    inputSchema: analyzeTeamFitInputSchema,
    handler: async (args) => {
      const root = z.string().min(1).parse(args.targetRepoRoot);
      // Pass the resolved plugin root so the handler can enumerate the full
      // built-in catalogue when building the dynamic role set.
      const result = await analyzeTeamFit({ targetRepoRoot: root, pluginRoot: getPluginRoot() });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  });

  // Story native:01KVF66HWKXCM7GYNRR9YJFKB2 — unhirePersona: safely set aside a
  // teammate reversibly. Moves team/<role>/PERSONA.md to team/_archived/<role>/PERSONA.md,
  // stamping archived_at. Refuses if removal would leave the quality-grading panel
  // unable to staff all five lens slots (reuses the judge panel's bipartite matcher).
  // Idempotent: already-archived → no-op; absent-from-both → RoleNotHiredError.
  server.registerTool({
    name: "unhirePersona",
    description:
      "Safely set aside a teammate reversibly (Story native:01KVF66HWKXCM7GYNRR9YJFKB2). " +
      "Moves team/<role>/PERSONA.md to team/_archived/<role>/PERSONA.md, stamping archived_at. " +
      "Refuses with UnhireBelowJudgeMinimumError if removal would leave the quality-grading " +
      "panel unable to staff all five distinct lens reviewer slots — the guard uses the same " +
      "bipartite matcher as the judge panel, NOT a hardcoded head-count. " +
      "Idempotent: role already archived → { status: 'already-archived' } (no-op, no error). " +
      "Role absent from both live team and archive → RoleNotHiredError. " +
      "Returns { status: 'archived', archivedPath, archivedAt } on success.",
    inputSchema: unhirePersonaInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          role: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await unhirePersona(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.1 — claimStory: atomic claim (FR17), dependency check (FR18), hand-edit guard (FR14a).
  server.registerTool({
    name: "claimStory",
    description:
      "Atomically claim a story for dev work (FR17) — moves manifest from to-do/ to in-progress/, stamps claimed_by with the caller's session ULID, refuses if any depends_on ref is not in done/ (FR18) or if the in-progress manifest has been hand-edited (FR14a). Story 4.1.",
    inputSchema: claimStoryInputSchema,
    handler: async (args) => {
      try {
        const parsed = z
          .object({
            targetRepoRoot: z.string().min(1),
            ref: z.string().min(1),
            sessionUlid: z.string().min(1),
            role: z.string().optional(),
          })
          .parse(args);
        const result = await claimStory(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.1 — completeStory: atomic complete (FR19), claimant check (AC4), hand-edit guard (FR14a).
  server.registerTool({
    name: "completeStory",
    description:
      "Atomically complete a claimed story (FR19) — moves manifest from in-progress/ to done/, preserves claimed_by, refuses if the caller's session ULID does not match the manifest's claimed_by (WrongClaimantError) or if the in-progress manifest has been hand-edited (FR14a). Story 4.1.",
    inputSchema: completeStoryInputSchema,
    handler: async (args) => {
      try {
        const parsed = z
          .object({
            targetRepoRoot: z.string().min(1),
            ref: z.string().min(1),
            sessionUlid: z.string().min(1),
            role: z.string().optional(),
          })
          .parse(args);
        const result = await completeStory(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 6.1 — recordStoryRetro: attach structured retro entries (lessons[],
  // failure_class, duration_seconds) to a done/ manifest after story completion.
  // Reviewer-side tool. State-guards against to-do/, blocked/, in-progress/
  // (post-completion concern). FR11, FR55.
  server.registerTool({
    name: "recordStoryRetro",
    description:
      "Attach structured retro entries (lessons[], failure_class, duration_seconds) " +
      "to a done/ manifest after story completion. Reviewer-side tool (Story 6.1, FR11, FR55). " +
      "Refuses with StoryNotInDoneStateError when the manifest lives in to-do/, blocked/, " +
      "or in-progress/. Throws ManifestNotFoundError when the ref does not exist anywhere. " +
      "Throws MalformedStoryRetroPayloadError when the payload fails schema validation " +
      "(closed kind enum, pitfall requires failure_class, etc.).",
    inputSchema: recordStoryRetroInputSchema,
    handler: async (args) => {
      try {
        const parsed = z
          .object({
            targetRepoRoot: z.string().min(1),
            ref: z.string().min(1),
            payload: z.unknown(),
            role: z.string().optional(),
          })
          .parse(args);
        const result = await recordStoryRetro(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KT6GSV8KTTKKHPRGEJWJAGZV — recordReviewerLesson: the
  // learning-loop CAPTURE seam. The reviewer calls this at most once, AFTER its
  // mandatory runReviewerSession call, ONLY when the review surfaced one reusable
  // lesson. It validates the lesson against the existing LessonSchema and MERGES
  // only the `lesson` field onto the per-ref reviewer-result.json (never clobbering
  // the binding verdict). The run then forwards that lesson onto the done
  // manifest via recordStoryRetro before the merge gate runs.
  server.registerTool({
    name: "recordReviewerLesson",
    description:
      "Merge one reusable retro lesson onto the per-ref reviewer-result.json " +
      "(Story native:01KT6GSV8KTTKKHPRGEJWJAGZV — learning-loop producer). Call AFTER " +
      "runReviewerSession, at most once, ONLY when the review taught a reusable lesson. " +
      "Validates `lesson` against the existing LessonSchema (closed kind enum: pitfall|" +
      "pattern|tool-quirk|discipline; pitfall requires failure_class). Merges only the " +
      "lesson field — never clobbers recommendedVerdict, acResults, or any other field. " +
      "Throws MalformedStoryRetroPayloadError on a bad lesson; ReviewerResultFileMissingError " +
      "when no reviewer-result.json exists (runReviewerSession was not called first). " +
      "Idempotent: merging the same lesson twice writes a byte-identical file.",
    inputSchema: recordReviewerLessonInputSchema,
    handler: async (args) => {
      try {
        const parsed = z
          .object({
            targetRepoRoot: z.string().min(1),
            sessionUlid: z.string().min(1),
            ref: z.string().min(1),
            lesson: z.unknown(),
          })
          .parse(args);
        const result = await recordReviewerLesson(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 6.3 — writeRetroProposal: emit a single immutable retro-proposal
  // markdown file at <target-repo>/.flow/retro-proposals/<isoTimestamp>.md.
  // Carries a YAML frontmatter block (source of truth for apply-time
  // re-validation in Epic 6b) plus an operator-readable rendered body.
  // Refuses collisions — proposals are immutable artifacts keyed by ISO
  // timestamp. FR58, FR59.
  server.registerTool({
    name: "writeRetroProposal",
    description:
      "Write a single immutable retro-proposal markdown file under " +
      "<target-repo>/.flow/retro-proposals/<isoTimestamp>.md. The file carries a YAML " +
      "frontmatter block (validated via RetroProposalFileSchema; source of truth for " +
      "Epic 6b apply-time re-validation) plus a rendered Markdown body with one H2 per " +
      "proposal. Refuses collisions with RetroProposalAlreadyExistsError (proposals are " +
      "immutable). Refuses malformed payloads with MalformedRetroProposalError — closed " +
      "discriminated union over seven types (rule, rule-retirement, skill-create, " +
      "skill-revise, skill-supersede, skill-retire, team-change). Story 6.3 (FR58, FR59).",
    inputSchema: writeRetroProposalInputSchema,
    handler: async (args) => {
      try {
        const parsed = z
          .object({
            targetRepoRoot: z.string().min(1),
            isoTimestamp: z.string().min(1),
            proposals: z.array(z.unknown()),
            cycleWindow: z
              .object({ from: z.string(), to: z.string() })
              .strict()
              .nullable()
              .optional(),
            role: z.string().optional(),
          })
          .parse(args);
        const result = await writeRetroProposal(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 6.4 — acceptProposal: the /accept-proposal <id> diff-then-confirm gate
  // (FR61, NFR10). Two-phase, deterministic seam: a preview call (confirm absent)
  // returns the handler's diff with NO mutation; a confirm call (confirm: true)
  // runs the registered handler, commits the handler's changed paths + the
  // proposal-file `applied` stamp in a single git-wrapper commit, emits one
  // retro.proposal.applied telemetry event, and returns the sha. Re-running an
  // already-applied id is an idempotent no-op (already-applied). In Story 6.4
  // the production handler registry is EMPTY — every kind fails closed with
  // ProposalKindNotApplicableYetError (the first real handler ships in Story 6.5).
  server.registerTool({
    name: "acceptProposal",
    description:
      "The /accept-proposal <id> diff-then-confirm gate (Story 6.4, FR61, NFR10). " +
      "Two-phase, deterministic: called without confirm it returns { status: 'preview', diff } " +
      "with NO file write, commit, or telemetry; called with confirm:true it runs the registered " +
      "per-kind apply handler, commits the handler's changed paths + the proposal-file `applied` " +
      "stamp in a SINGLE git-wrapper commit, emits one retro.proposal.applied telemetry event, " +
      "and returns { status: 'applied', appliedSha, idempotencyKey }. Re-running an already-applied " +
      "id (even with confirm:true) is an idempotent no-op returning { status: 'already-applied', " +
      "appliedSha, appliedAt } — no handler call, no write, no commit, no telemetry. " +
      "Throws ProposalNotFoundError (id matched no proposal across all files), " +
      "AmbiguousProposalIdError (id matched in two files — a bug, ids are unique), and " +
      "ProposalKindNotApplicableYetError (no registered handler for the kind — fail-closed; in " +
      "Story 6.4 the production registry is empty so every kind fails closed). Story 6.4.",
    inputSchema: acceptProposalInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          proposalId: z.string().min(1),
          confirm: z.boolean().optional(),
          role: z.string().optional(),
        })
        .parse(args);
      try {
        const result = await acceptProposal(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 6.2 — gatherRetroInputs: assemble the deterministic input bundle the
  // /flow:retro skill hands to the retro-analyst subagent. Pure read across the
  // cycle's done manifests, telemetry, prior proposals, and (when present) the
  // rule registry. No writes, no network. FR56.
  server.registerTool({
    name: "gatherRetroInputs",
    description:
      "Assemble the deterministic retro input bundle for the /flow:retro skill " +
      "(Story 6.2, FR56). Returns { doneManifests, telemetrySummary, priorProposals, " +
      "ruleRegistry }: every done/ manifest (alphabetical, parseExecutionManifest-validated; " +
      "MalformedExecutionManifestError propagates), every telemetry event for the current " +
      "cycle window (malformed lines skipped + counted as telemetrySummary.skipped_count), " +
      "prior retro-proposal paths { path, iso_timestamp } sorted ascending (contents NOT " +
      "loaded), and the parsed docs/discipline-rules.yaml registry (or null when absent — " +
      "absence is not an error). Pure read; no writes, no network.",
    inputSchema: gatherRetroInputsInputSchema,
    handler: async (args) => {
      try {
        const parsed = z
          .object({ targetRepoRoot: z.string().min(1) })
          .parse(args);
        const result = await gatherRetroInputs(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.2 — mintSessionUlid: pure ULID minting for the /flow:start skill.
  // The skill MUST NOT ask the LLM to generate a ULID — this tool delegates
  // minting to the `ulid` npm package so the result is deterministic.
  // The dev subagent's permissions/generalist-dev.yaml MUST NOT include this
  // tool — the subagent does not mint ULIDs.
  server.registerTool({
    name: "mintSessionUlid",
    description:
      "Mint a fresh session ULID for a /flow:start invocation. Pure — no IO. " +
      "Called once per /flow:start invocation; the returned ULID is re-used for " +
      "every claimStory call in that session. Story 4.2.",
    inputSchema: mintSessionUlidInputSchema,
    handler: async (_args) => {
      const result = mintSessionUlid();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });

  // Story 4.2 — listClaimableTodos: enumerate claimable to-do manifests for
  // the /flow:start skill's pre-scan pass. Returns sorted (alphabetical ref)
  // candidates with dep-readiness computed server-side. The dev subagent's
  // permissions/generalist-dev.yaml MUST NOT include this tool — it is
  // /flow:start-only.
  server.registerTool({
    name: "listClaimableTodos",
    description:
      "Enumerate claimable to-do manifests for the /flow:start claim-spawn loop. " +
      "Returns { todos: ClaimableCandidate[], inProgressCount: number } where todos " +
      "are filtered by isClaimable, sorted alphabetically by ref, and annotated with " +
      "depsReady (true iff all depends_on refs are in done/). Story 4.2.",
    inputSchema: listClaimableTodosInputSchema,
    handler: async (args) => {
      const parsed = z.object({ targetRepoRoot: z.string().min(1) }).parse(args);
      try {
        const result = await listClaimableTodos({ targetRepoRoot: parsed.targetRepoRoot });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.2 — buildPersonaSpawnPrompt: assemble the system prompt for a
  // dev-subagent spawn. Reads the persona file once per call; the /flow:start
  // skill calls this once per spawn. Centralises assembly so a future
  // persona-format change updates one place. The dev subagent's
  // permissions/generalist-dev.yaml MUST NOT include this tool — the subagent
  // does not assemble its own prompt; the orchestrator does.
  server.registerTool({
    name: "buildPersonaSpawnPrompt",
    description:
      "Assemble the system-prompt text for a dev-subagent spawn. Reads " +
      "<targetRepoRoot>/team/<role>/PERSONA.md exactly once per call, concatenates " +
      "the five required sections (Domain, Mandate, Out of mandate, Prompt, Knowledge) " +
      "plus a Locked phrases sentinel block. Returns { systemPrompt: string }. " +
      "Propagates PersonaFileNotFoundError if the team persona is absent. Story 4.2.",
    inputSchema: buildPersonaSpawnPromptInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          role: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await buildPersonaSpawnPrompt(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 3.2 — scan-sources: project source stories into to-do/ manifests.
  //
  // Convention note: the MCP tool name follows the camelCase convention
  // (`scanSources`, matching `getStatus`, `readCatalogue`, etc.). The epic
  // AC text uses the kebab-case identifier `scan-sources` informally — it is
  // readable English in prose, not the wire-level tool name. The skill
  // (`/flow:scan`) hides both forms from the operator.
  //
  // Permission note: `/flow:scan` invokes this tool without `_meta.role`
  // (matching `/flow:status`'s pattern), so the role-gate at server.ts is
  // bypassed and the tool runs at operator authority. When Story 3.4 lands
  // the planner subagent, its permission spec at
  // `plugins/flow/catalogue/permissions/planner.yaml` must list `scanSources`
  // in `tools_allow`. That edit belongs to Story 3.4.
  server.registerTool({
    name: "scanSources",
    description:
      "Project the active adapter's source stories into execution manifests under <target-repo>/.flow/state/to-do/<ref>.yaml. Idempotent on re-scan; refreshes source_hash for manifests still in to-do/. Used by /<plugin>:scan (Story 3.2).",
    inputSchema: scanSourcesInputSchema,
    handler: async (args) => {
      const parsed = z.object({ targetRepoRoot: z.string().min(1) }).parse(args);
      try {
        const result = await scanSources({ targetRepoRoot: parsed.targetRepoRoot });
        return { content: [{ type: "text" as const, text: renderScanResult(result) }] };
      } catch (err) {
        if (err instanceof DomainError) {
          return { content: [{ type: "text" as const, text: err.message }], isError: true };
        }
        throw err;
      }
    },
  });

  // Story 4.3b — claimNextStory: single-iteration outer claim-loop step.
  // The SKILL.md prose calls this in a loop until queue-emptied or
  // waiting-on-in-progress is returned.
  server.registerTool({
    name: "claimNextStory",
    description:
      "Claim the next ready story from the backlog for the current session. " +
      "Returns { next: 'spawn-dev', ref, title, manifestPath, chatLog } when a story is claimed, " +
      "{ next: 'queue-emptied', chatLog } when both to-do/ and in-progress/ are empty, or " +
      "{ next: 'waiting-on-in-progress', chatLog } when todos exist but all are deps-blocked. " +
      "Story 4.3b.",
    inputSchema: claimNextStoryInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await claimNextStory(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.3b — processDevTranscript: parse the dev subagent's final transcript.
  // The SKILL.md prose calls this after capturing the dev Task tool's return value.
  server.registerTool({
    name: "processDevTranscript",
    description:
      "Parse the dev subagent's final transcript for the verbatim handoff phrase. " +
      "Returns { next: 'spawn-reviewer', reviewerPrompt, chatLog } on a valid handoff, or " +
      "{ next: 'done-blocked-handoff-grammar', chatLog } on grammar drift (stamps blocked_by in the manifest). " +
      "MUST be called with the verbatim full transcript — no summarisation. Story 4.3b.",
    inputSchema: processDevTranscriptInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
          ref: z.string().min(1),
          devTranscript: z.string(),
        })
        .parse(args);
      try {
        const result = await processDevTranscript(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.3b / Story 4.6 revision 2 — processReviewerTranscript:
  // Reads `reviewer-result.json` written by `runReviewerSession` and routes
  // on its `recommendedVerdict` field. The `reviewerTranscript` parameter has
  // been DROPPED — the reviewer's chat is no longer the verdict transport.
  server.registerTool({
    name: "processReviewerTranscript",
    description:
      "Read the persisted reviewer-result.json (written by runReviewerSession) and route on its recommendedVerdict. " +
      "Returns { next: 'done-ready-for-merge', completed: true, chatLog } on READY FOR MERGE (calls completeStory internally), " +
      "{ next: 'done-blocked-reviewer-needs-changes', chatLog } on NEEDS CHANGES (stamps blocked_by), " +
      "{ next: 'done-blocked-reviewer-blocked', chatLog } on BLOCKED (stamps blocked_by). " +
      "Throws ReviewerFirstCallSkippedError (stamps blocked_by: reviewer-no-session-result) when reviewer-result.json is absent — " +
      "the reviewer subagent skipped the mandatory runReviewerSession first call (Story 5.21 seam). " +
      "Story 4.3b / Story 4.6 revision 2 / Story 5.21.",
    inputSchema: processReviewerTranscriptInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
          ref: z.string().min(1),
          manifestPath: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await processReviewerTranscript(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.4 — runDevTerminalAction: dev subagent terminal action (branch, commit, push, PR).
  server.registerTool({
    name: "runDevTerminalAction",
    description:
      "Dev subagent terminal action: creates a story branch, commits in conventional-commits format, " +
      "pushes to origin, and opens a PR via gh pr create with a machine-readable body (story link, ACs " +
      "checklist mirrored from the spec) followed by a free-form summary. " +
      "Refuses --no-verify, --force, --force-with-lease unconditionally. " +
      "Returns { ok: true, branch, commitSha, prUrl } on success. Story 4.4. " +
      "buildTestTimeoutMs: optional per-run time budget (ms) for the build/test gates; " +
      "defaults to 20 min. A hung or crawling build that exceeds the budget is terminated " +
      "and reported as a build failure with a clear timed-out reason. " +
      "(Story native:01KTN5E6T75XKDX8A0SGBVPRYS)",
    inputSchema: runDevTerminalActionInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          ref: z.string().min(1),
          title: z.string().min(1),
          type: z.string().min(1),
          body: z.string(),
          summary: z.string(),
          manifestPath: z.string().min(1),
          sessionUlid: z.string().min(1),
          base: z.string().min(1).optional(),
          buildTestTimeoutMs: z.number().nonnegative().optional(),
        })
        .parse(args);
      try {
        const result = await runDevTerminalAction(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.6b — postReviewerComments: posts the reviewer's verdict as a PR review.
  // Reads reviewer-result.json, composes summary body + inline comments deterministically,
  // and POSTs a single gh api review. Invoked from SKILL.md prose AFTER reviewer Task
  // returns and BEFORE processReviewerTranscript runs.
  server.registerTool({
    name: "postReviewerComments",
    description:
      "Read the persisted reviewer-result.json (written by runReviewerSession) and post a PR review " +
      "with a deterministic summary body and zero-or-more inline comments. " +
      "Returns { next: 'skipped-no-session-result', postedReviewId: null } when the file is absent, " +
      "or { next: 'posted', postedReviewId, inlineCommentCount, verdictLine } on success. " +
      "All composition is deterministic (no LLM step). Story 4.6b.",
    inputSchema: postReviewerCommentsInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
          ref: z.string().min(1),
          role: z.string().optional(),
        })
        .parse(args);
      try {
        const result = await postReviewerComments(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.8 — applyReviewerLabels: applies GitHub labels to a PR after a reviewer pass.
  // Reads reviewer-result.json, resolves owner/repo, and calls gh api POST /labels.
  // Always applies `reviewed-by-agent`; also applies `needs-human` on non-green verdicts.
  // Accepts `verdictOverride: "reviewer-failure"` for use in the SKILL.md error handler.
  server.registerTool({
    name: "applyReviewerLabels",
    description:
      "Apply GitHub labels to the PR after a completed reviewer cycle. " +
      "Always applies `reviewed-by-agent`; also applies `needs-human` on NEEDS CHANGES, BLOCKED, or reviewer-failure verdicts. " +
      "Returns { next: 'skipped-no-session-result' } when reviewer-result.json is absent, " +
      "or { next: 'applied', labelsApplied: string[] } on success. " +
      "Propagates GhRecoverableError, GhApiResponseShapeError, and ReviewerResultFileMalformedError uncaught. " +
      "Story 4.8 (FR36, FR37, FR38).",
    inputSchema: applyReviewerLabelsInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
          ref: z.string().min(1),
          verdictOverride: z.literal("reviewer-failure").optional(),
          role: z.string().optional(),
        })
        .parse(args);
      try {
        const result = await applyReviewerLabels(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.11 — processReviewerYield: parse the reviewer subagent's transcript
  // for the verbatim locked yield phrase and route the review to the appropriate
  // hired specialist. Called by SKILL.md prose BEFORE postReviewerComments /
  // processReviewerTranscript. Returns a discriminated next: value. Story 4.11.
  server.registerTool({
    name: "processReviewerYield",
    description:
      "Parse the reviewer subagent's transcript for the verbatim locked yield phrase " +
      "`This sits in <domain>'s domain — handing off.` and route the review to the appropriate " +
      "hired specialist. " +
      "Returns { next: 'no-yield', chatLog } (common path — pass through to existing flow), " +
      "{ next: 'spawn-specialist-reviewer', toRole, specialistPrompt, chatLog } on a successful yield, " +
      "{ next: 'done-blocked-routing-failure', chatLog } when no hired role matches the domain " +
      "(stamps blocked_by: routing-failure on the manifest), or " +
      "{ next: 'done-blocked-routing-self-yield', chatLog } when the yielder named its own domain " +
      "(stamps blocked_by: routing-self-yield). " +
      "Emits a yield.handoff telemetry event on the success branch only (FR103, NFR29). " +
      "NOT in subagent allowlists — called by SKILL.md prose only. Story 4.11.",
    inputSchema: processReviewerYieldInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
          ref: z.string().min(1),
          fromRole: z.string().min(1),
          reviewerTranscript: z.string(),
          manifestPath: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await processReviewerYield(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.6 — runReviewerSession: composite tool for the reviewer subagent.
  // Performs the three mandatory reads (source story → PR diff → standards)
  // in fixed sequential order, runs every AC via the applicability classifier,
  // and returns ReviewerSessionResult carrying structured acResults.
  server.registerTool({
    name: "runReviewerSession",
    description:
      "Composite reviewer-session tool. Reads the source story (via active adapter), " +
      "the PR diff (via gh pr diff), and docs/standards.md in fixed sequential order. " +
      "Runs every AC against the applicability classifier (artifact-check, vitest, or manual-check-required). " +
      "Derives a `recommendedVerdict` literal (READY FOR MERGE | NEEDS CHANGES | BLOCKED) from acResults " +
      "and persists the full ReviewerSessionResult to " +
      "`<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/reviewer-result.json` as a side-effect before returning. " +
      "Returns ReviewerSessionResult with sourceStory, prDiff, standards, standardsByCriterionId, acResults, and recommendedVerdict. " +
      "All read and execution errors propagate uncaught. MUST be the reviewer persona's FIRST action. Story 4.6.",
    inputSchema: runReviewerSessionInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
          ref: z.string().min(1),
          prNumber: z.number().int().positive(),
          role: z.string().optional(),
        })
        .parse(args);
      try {
        const result = await runReviewerSession(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.9b — risk-tier classifier (FR40a, Pattern §11).
  server.registerTool({
    name: "classifyRiskTier",
    description:
      "Classify a PR's risk tier from its diff signals (changed paths, commit messages, diff size) using the " +
      "loaded risk-tiering spec (Story 4.9). Returns the Pattern §11 output shape: " +
      "{ story_id, tier: low|medium|high, matched_rule, evidence: { paths, change_types, diff_size } }. " +
      "Walks rules in high→medium→low order (highest-tier-wins). Falls back to 'medium' with matched_rule='fallback' " +
      "when no rule matches. Propagates MalformedRiskTieringSpecError and ShippedRiskTieringDefaultMissingError verbatim. " +
      "In v1, this tool is called internally by runReviewerSession; it is exposed as an MCP tool for future direct callers. " +
      "Story 4.9b.",
    inputSchema: classifyRiskTierInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          pluginRoot: z.string().min(1),
          storyId: z.string().min(1),
          changedPaths: z.array(z.string()),
          commitMessages: z.array(z.string()),
          diffSize: z.number().int().nonnegative(),
        })
        .parse(args);
      try {
        const result = await classifyRiskTier(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 4.10 — computeAgreement: rolling reviewer-verdict vs human-merge-action
  // agreement ratio. Reads all *.jsonl files under <targetRepoRoot>/.flow/telemetry/,
  // joins reviewer.verdict and reviewer.verdict.merge_action events by (pr_number,
  // session_id), and returns a deterministic { ratio, distribution, window_size,
  // sample_size, ... } shape or null on insufficient data. (FR67, NFR24)
  // v1 callers: Story 4.10b's auto-merge gate (internal import, same pattern as
  // classifyRiskTier). NOT in subagent allowlists in v1.
  server.registerTool({
    name: "computeAgreement",
    description:
      "Compute the rolling reviewer-verdict vs human-merge-action agreement ratio (FR67, NFR24). " +
      "Reads every *.jsonl file under <targetRepoRoot>/.flow/telemetry/, joins reviewer.verdict and " +
      "reviewer.verdict.merge_action events by (pr_number, session_id), excludes reviewer-failure verdicts " +
      "and still-open merge actions, sorts newest-first by verdict ts, takes the first lastNVerdicts pairs. " +
      "Returns { ratio, distribution, window_size, sample_size, skipped_unresolved, skipped_excluded, malformed_lines } " +
      "or null when resolved-pair count < lastNVerdicts (insufficient data). " +
      "Throws AgreementWindowInvalidError on invalid lastNVerdicts (0, negative, non-integer). " +
      "Story 4.10.",
    inputSchema: computeAgreementInputSchema,
    handler: async (args) => {
      const parsed = {
        targetRepoRoot: args.targetRepoRoot as string,
        lastNVerdicts: args.lastNVerdicts as number | undefined,
      };
      try {
        const result = await computeAgreement(parsed);
        // Validate return shape before surfacing (round-trip guard)
        if (result !== null) {
          AgreementMetricResultSchema.parse(result);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 6.8 — recordSkillInvoke: the SINGLE write-path for the skill.invoke
  // telemetry event. Validates the data payload (closed enums on skill_scope /
  // invocation_source — an unknown value is rejected, never coerced) and emits
  // exactly one skill.invoke event via logTelemetryEvent. Called by the skill
  // capture seam (an instrumented flow SKILL.md first-step on the fallback path).
  // Grouped with the telemetry/retro-path tools (computeAgreement). (Story 6.8)
  server.registerTool({
    name: "recordSkillInvoke",
    description:
      "Single write-path for the skill.invoke telemetry event (Story 6.8). " +
      "Validates { skill_name, skill_path, skill_version, skill_scope, invocation_source } — " +
      "skill_scope (project|persona|plugin) and invocation_source (user-slash-command|agent-call) " +
      "are CLOSED enums; an unknown value raises MalformedSkillInvokeInputError and writes nothing. " +
      "Emits exactly one skill.invoke event via the telemetry logger (which stamps ts). " +
      "Returns { recorded: true } on success. Touches no .flow/state manifest.",
    inputSchema: recordSkillInvokeInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
          agent: z.string().min(1),
          storyId: z.string().min(1).optional(),
          data: z.unknown(),
        })
        .parse(args);
      try {
        const result = await recordSkillInvoke({
          targetRepoRoot: parsed.targetRepoRoot,
          sessionUlid: parsed.sessionUlid,
          agent: parsed.agent,
          storyId: parsed.storyId,
          data: parsed.data,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 6.8 — computeSkillEffectiveness: pure, deterministic, no-LLM helper
  // (the skill-side analogue of computeAgreement). Reads skill.invoke events
  // under <targetRepoRoot>/.flow/telemetry/, joins each to a later READY FOR
  // MERGE reviewer.verdict in the same story flow, and reports per-skill
  // invoke_count, useful_fire_count, and effectiveness_ratio. Always returns a
  // result shape (empty per_skill map on no data — never null, never throws on
  // empty/malformed input); throws only SkillEffectivenessWindowInvalidError on
  // an invalid window. Consumed by the retro analyst's retirement criterion.
  // Grouped with the telemetry/retro-path tools. (Story 6.8)
  server.registerTool({
    name: "computeSkillEffectiveness",
    description:
      "Compute per-skill effectiveness from skill.invoke events joined to downstream " +
      "READY FOR MERGE reviewer verdicts (Story 6.8). Reads every *.jsonl under " +
      "<targetRepoRoot>/.flow/telemetry/, sorts skill.invoke events newest-first, takes " +
      "the first `window` (default 50), and for each skill reports invoke_count, " +
      "useful_fire_count (invocations followed by a same-session/same-story READY FOR MERGE), " +
      "and effectiveness_ratio (useful/invoke, 0 not NaN). Returns " +
      "{ per_skill, window_size, sample_size, malformed_lines } — an empty per_skill map on " +
      "no data (never null, never an error on empty/malformed input). Malformed JSONL lines " +
      "are skipped and counted. Throws SkillEffectivenessWindowInvalidError on an invalid window.",
    inputSchema: computeSkillEffectivenessInputSchema,
    handler: async (args) => {
      const parsed = {
        targetRepoRoot: args.targetRepoRoot as string,
        window: args.window as number | undefined,
      };
      try {
        const result = await computeSkillEffectiveness(parsed);
        // Validate return shape before surfacing (round-trip guard).
        SkillEffectivenessResultSchema.parse(result);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 1.13 — createSmokeScratchRepo: create a disposable smoke-harness
  // scratch repo seeded with git init + empty commit + minimal
  // .flow/config.yaml + .flow/standards.md. Used by the /flow:smoke skill
  // as the first checkpoint step (AC1).
  server.registerTool({
    name: "createSmokeScratchRepo",
    description:
      "Create a disposable smoke-harness scratch repo seeded with git init + empty commit + minimal .flow/config.yaml + .flow/standards.md. Used by the /flow:smoke skill as the first checkpoint step.",
    inputSchema: createSmokeScratchRepoInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({ label: z.string().min(1), parentDir: z.string().min(1).optional() })
        .parse(args);
      const result = await createSmokeScratchRepo(parsed);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ scratchRoot: result.scratchRoot }) },
        ],
      };
    },
  });

  // Story 4.10b — runAutoMergeGate: auto-merge gate for done-ready-for-merge PRs.
  // Reads done/<ref>.yaml for risk_tier, computeAgreement for the rolling ratio,
  // workspace config for the threshold, then either calls `gh pr merge --squash
  // --delete-branch` (auto-merge) or applies the `needs-human` label (pause).
  // Manual-merge override is preserved by structural omission in SKILL.md — gate
  // is ONLY invoked under the done-ready-for-merge branch. (FR40, FR41, FR42)
  server.registerTool({
    name: "runAutoMergeGate",
    description:
      "Auto-merge gate for a PR that has reached done-ready-for-merge (FR40/FR41/FR42). " +
      "Reads done/<ref>.yaml for risk_tier, computeAgreement for the rolling agreement ratio, " +
      "and workspace config plugin.agreement_threshold (default 0.8). " +
      "Decision: low + met-threshold → gh pr merge --squash --delete-branch; " +
      "all other branches → gh api POST /labels with needs-human. " +
      "dryRun:true skips the gh shell-out. " +
      "Throws AutoMergeGateThresholdInvalidError on invalid thresholdOverride. " +
      "An operational gh failure (merge refused, label API hiccup, missing permission) NEVER throws: " +
      "it folds into a clean pause-needs-human result (reason merge-failed on the merge path) with the cause in chatLog, " +
      "so the gate's stdout stays JSON-only and the run seam cannot break. " +
      "Story 4.10b.",
    inputSchema: runAutoMergeGateInputSchema,
    handler: async (args) => {
      const parsed = {
        targetRepoRoot: args.targetRepoRoot as string,
        prNumber: args.prNumber as number,
        ref: args.ref as string,
        sessionUlid: args.sessionUlid as string,
        thresholdOverride: args.thresholdOverride as number | undefined,
        lastNVerdictsOverride: args.lastNVerdictsOverride as number | undefined,
        dryRun: args.dryRun as boolean | undefined,
        role: args.role as string | undefined,
      };
      try {
        const result = await runAutoMergeGate(parsed);
        AutoMergeGateResultSchema.parse(result);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 5.11 — scanOrphanedInProgress: pure read-only scan of in-progress/
  // for manifests whose claimed_by ULID differs from the current session ULID.
  // Returns orphans in alphabetical ref order. No write side-effects.
  server.registerTool({
    name: "scanOrphanedInProgress",
    description:
      "Scan <targetRepoRoot>/.flow/state/in-progress/ for manifests whose claimed_by ULID " +
      "is defined and does not match sessionUlid. Returns orphans in alphabetical ref order, " +
      "each with hasTranscript flag indicating whether the Story 5.10 transcript file exists. " +
      "Pure read-only — no write side-effects. Story 5.11.",
    inputSchema: scanOrphanedInProgressInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await scanOrphanedInProgress(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 5.11 — reattachOrphan: atomic claimed_by rewrite for the
  // transcript-present orphan-recovery path. Rewrites manifest.claimed_by
  // from stale ULID to currentSessionUlid. Throws NotAnOrphanError on race.
  server.registerTool({
    name: "reattachOrphan",
    description:
      "Reattach an orphaned in-progress manifest to the current session by rewriting " +
      "claimed_by from the stale ULID to currentSessionUlid. Used by the transcript-present " +
      "path of the orphan-recovery branch in /flow:start. " +
      "Throws NotAnOrphanError when claimed_by already matches currentSessionUlid (race). " +
      "Throws ManifestNotFoundError when the ref is absent from in-progress/. Story 5.11.",
    inputSchema: reattachOrphanInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          ref: z.string().min(1),
          currentSessionUlid: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await reattachOrphan(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 5.11 — blockOrphanNoTranscript: atomic move + blocked_by stamp for the
  // no-transcript orphan-recovery path. Moves manifest from in-progress/ to
  // blocked/ and stamps blocked_by: orphan-no-transcript.
  server.registerTool({
    name: "blockOrphanNoTranscript",
    description:
      "Handle an orphaned in-progress manifest with no persisted transcript by moving it " +
      "from in-progress/ to blocked/ and stamping blocked_by: orphan-no-transcript. " +
      "Used by the no-transcript path of the orphan-recovery branch in /flow:start. " +
      "Throws ManifestNotFoundError when the ref is absent from in-progress/. Story 5.11.",
    inputSchema: blockOrphanNoTranscriptInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          ref: z.string().min(1),
          staleUlid: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await blockOrphanNoTranscript(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 9.3 — writeLensVerdict: each judge subagent's deterministic verdict
  // write seam (gate 1, Tier 1). Validates a {lens, role, pass, missed} verdict
  // (the empty-`missed` guard fails AT WRITE TIME) and atomically writes it to
  // the per-lens result file the panel reads. The judge's reasoning is free;
  // only this projection is load-bearing — exactly the reviewer's posture.
  server.registerTool({
    name: "writeLensVerdict",
    description:
      "Write a single judge's per-lens verdict to its deterministic result file (Story 9.3, gate 1 Tier 1). " +
      "Validates { lens, role, pass, missed } against LensVerdictSchema — a fail with an empty `missed` is " +
      "rejected at write time (a malformed verdict never reaches disk). Writes atomically to " +
      "<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/<ref>/judge-<lens>.json. " +
      "Returns { resultFilePath }. Each lens judge calls this once; the panel reads the file back " +
      "(deterministic-seam discipline — the panel consumes files, never transcripts).",
    inputSchema: writeLensVerdictInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
          ref: z.string().min(1),
          lens: z.enum(LENS_NAMES),
          role: z.string().min(1),
          pass: z.boolean(),
          missed: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await writeLensVerdict(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 9.3 — aggregateJudgePanel: the panel-aggregation half of gate 1 Tier 1.
  // Called by the /flow:ready skill (judge-on-approve) AFTER it has spawned one judge per lens (each
  // from a distinct role) and each judge has written its verdict via writeLensVerdict.
  // Classifies the draft's risk tier (selects the Considered bar), reads the five
  // per-lens files (never transcripts), assembles + validates the PanelVerdict, and
  // emits one panel.graded telemetry event. Writes NO readiness flag / manifest —
  // adjudication is Story 9.4's call. Fails loudly (LensJudgeUnavailableError /
  // DuplicateLensJudgeError / LensVerdictFileMalformedError) rather than reporting a
  // clean sweep when a lens is missing, a role is shared, or a verdict file is bad.
  server.registerTool({
    name: "aggregateJudgePanel",
    description:
      "Aggregate the five per-lens judge verdict files into a single PanelVerdict (Story 9.3, gate 1 Tier 1). " +
      "Validates the lens→role binding (one DISTINCT role per lens — lens diversity is structural), classifies " +
      "the draft's risk tier via classifyRiskTier to select the Considered-lens bar, reads the five " +
      "judge-<lens>.json files written by writeLensVerdict (deterministic-seam: files, never transcripts), and " +
      "assembles { tier0, lenses } validated against PanelVerdictSchema (exactly five entries, one per lens). " +
      "Emits one panel.graded telemetry event. Returns { riskTier, verdict }. Writes NOTHING to the readiness " +
      "flag or any manifest — that decision is Story 9.4's. Throws LensJudgeUnavailableError (a lens has no " +
      "role), DuplicateLensJudgeError (a role is shared across lenses), and LensVerdictFileMalformedError (a " +
      "verdict file is absent / unparseable / fails schema / disagrees on lens|role).",
    inputSchema: aggregateJudgePanelInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
          draft: z
            .object({
              ref: z.string().min(1),
              title: z.string().min(1),
              specText: z.string(),
              changedPaths: z.array(z.string()).optional(),
              commitMessages: z.array(z.string()).optional(),
              diffSize: z.number().int().nonnegative().optional(),
            })
            .strict(),
          lensRoles: z.record(z.string(), z.string()).optional(),
          tier0: z.enum(["pass", "fail"]).optional(),
        })
        .parse(args);
      try {
        const result = await aggregateJudgePanel({
          targetRepoRoot: parsed.targetRepoRoot,
          sessionUlid: parsed.sessionUlid,
          draft: parsed.draft,
          lensRoles: { ...DEFAULT_LENS_ROLES, ...(parsed.lensRoles ?? {}) } as typeof DEFAULT_LENS_ROLES,
          ...(parsed.tier0 !== undefined ? { tier0: parsed.tier0 } : {}),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story 9.4 — adjudicateQualityLead: the adjudication half of gate 1 (the
  // Quality Lead). Synthesises the Story 9.3 PanelVerdict via the rubric §5 rule:
  // all five lenses pass → `ready` (blesses the draft through Story 9.1's
  // markStoryReady brake — never a direct manifest write); any lens fails →
  // `rework` (returns the failed `missed` strings, draft stays not-ready); a split
  // that persists after K rounds (default 2) → `escalate` (to the operator with an
  // escalation_reason, draft stays not-ready — never auto-pass a close call).
  // Persists the AdjudicationVerdict alongside the panel's per-lens files and emits
  // one quality.adjudicated telemetry event (even on `ready` — the judge-the-judge
  // input for the calibration loop).
  server.registerTool({
    name: "adjudicateQualityLead",
    description:
      "Synthesise a Story 9.3 PanelVerdict into a Quality-Lead decision (Story 9.4, gate 1 adjudication). " +
      "Applies the rubric §5 rule: all five lenses pass → `ready` (blesses via the Story 9.1 markStoryReady " +
      "brake — never a direct manifest write); any lens fails → `rework` (returns the failed `missed` strings, " +
      "draft stays not-ready); a split that persists after K rounds (default 2) → `escalate` (to the operator " +
      "with a populated escalation_reason, draft stays not-ready — never auto-pass a close call). Persists the " +
      "AdjudicationVerdict { ref, decision, rationale, escalation_reason?, round } (validated against " +
      "AdjudicationVerdictSchema) to <targetRepoRoot>/.flow/state/sessions/<sessionUlid>/<ref>/adjudication-verdict.json " +
      "— the canonical record the dashboard (9.5) and the calibration loop (judge-the-judge) read. Emits one " +
      "quality.adjudicated telemetry event on every decision. Returns { verdict, verdictFilePath, blessed? }.",
    inputSchema: adjudicateQualityLeadInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          sessionUlid: z.string().min(1),
          ref: z.string().min(1),
          panel: PanelVerdictSchema,
          round: z.number().int().positive().optional(),
          k: z.number().int().positive().optional(),
        })
        .parse(args);
      try {
        const result = await adjudicateQualityLead({
          targetRepoRoot: parsed.targetRepoRoot,
          sessionUlid: parsed.sessionUlid,
          ref: parsed.ref,
          panel: parsed.panel,
          round: parsed.round ?? 1,
          k: parsed.k ?? DEFAULT_ADJUDICATION_K,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KT2RAXBSQ91Y80Z51DD26KPX — recordAgentFriction: persist a
  // structured `agent.friction` telemetry event when an agent compensates for a
  // surprising or broken input. The retro-analyst reads the resulting
  // `recurringFriction` signal from `gatherRetroInputs` at cycle end.
  server.registerTool({
    name: "recordAgentFriction",
    description:
      "Persist a structured agent.friction telemetry event when an agent compensates " +
      "for a surprising or broken input. The event carries a closed-enum kind " +
      "('empty-input' | 'missing-cited-source' | 'forced-fallback' | 'repeated-retry'), " +
      "plus expected and observed strings describing the mismatch. " +
      "gatherRetroInputs groups these events by kind and surfaces kinds with count >= 2 as " +
      "recurringFriction in the retro bundle, so the retro-analyst can draft a fix proposal " +
      "for a seam that agents are silently compensating for. " +
      "Story native:01KT2RAXBSQ91Y80Z51DD26KPX.",
    inputSchema: recordAgentFrictionInputSchema,
    handler: async (args) => {
      try {
        const result = await recordAgentFriction(args as Parameters<typeof recordAgentFriction>[0]);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KV7FHZ41Z6CFPABW1B8J38BV — recordMaintainerFeedback: capture seam for
  // structured maintainer-feedback items. Any role on the team (or the retrospective) can
  // call this when it hits a structural limitation of the tool itself. The item lands in a
  // maintainer-only inbox (.flow/maintainer-inbox/) that the team never reads to drive its
  // own behaviour. Items accumulate as distinct files — nothing is overwritten.
  //
  // Story native:01KV7XXKZ0TBPYETZP2X81T40S — when gh is available and the repo identity
  // resolves, the result also includes a pre-filled GitHub new-issue URL so the operator can
  // open it immediately to review and submit the issue themselves. Nothing is ever filed
  // automatically; the link works for any user and opens GitHub's own form.
  server.registerTool({
    name: "recordMaintainerFeedback",
    description:
      "Record a structured feedback item about a structural limitation of the tool itself " +
      "into a maintainer-only inbox (.flow/maintainer-inbox/). " +
      "Required fields: problem (what is wrong), tool_area (which part of the tool), " +
      "trigger (which role/phase/story surfaced it). Optional: suggested_direction. " +
      "Items accumulate as distinct timestamped JSON files — nothing is overwritten. " +
      "The write touches ONLY .flow/maintainer-inbox/ and leaves the team's working state " +
      "and backlog byte-unchanged (AC1). Refuses to store incomplete items (AC2). " +
      "On success, also returns a pre-filled GitHub new-issue URL (issueUrl) when gh is " +
      "available — the operator can open it immediately to review and submit as themselves; " +
      "nothing is ever filed automatically (Story native:01KV7XXKZ0TBPYETZP2X81T40S). " +
      "Story native:01KV7FHZ41Z6CFPABW1B8J38BV.",
    inputSchema: recordMaintainerFeedbackInputSchema,
    handler: async (args) => {
      try {
        const parsed = {
          targetRepoRoot: (args as { targetRepoRoot: string }).targetRepoRoot,
          item: (args as { item: unknown }).item,
        };
        const result = await recordMaintainerFeedback(parsed);
        // Surface the issueUrl prominently when present so the operator
        // can see and follow it immediately in their live session.
        // Emit all three fallback paths: markdown hyperlink, plain bare URL,
        // and a ready-to-run gh issue create command (Story native:01KVEZQKWPH8V627QJSAF5F4E6).
        const linkBlock =
          result.issueUrl !== undefined && result.issueTitle !== undefined && result.issueBody !== undefined
            ? renderFeedbackLinkBlock(result.issueUrl, result.issueTitle, result.issueBody)
            : null;
        const responseText =
          linkBlock !== null
            ? JSON.stringify({
                ...result,
                _message: `Feedback captured. Open or file the GitHub issue:\n${linkBlock}`,
              })
            : JSON.stringify(result);
        return {
          content: [{ type: "text" as const, text: responseText }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KV9QR3VK11RDD1ZDPVJ7SEYA — reviewMaintainerInbox: on-demand review of
  // stored maintainer-feedback items. Reads all files from .flow/maintainer-inbox/ and
  // returns each valid item with a pre-filled GitHub new-issue URL the operator can open
  // to review and submit as themselves — nothing is ever filed automatically. Empty inbox
  // returns { emptyInbox: true, items: [] } (no blank or malformed URL). Read-only.
  server.registerTool({
    name: "reviewMaintainerInbox",
    description:
      "On-demand review of the maintainer-only inbox " +
      "(Story native:01KV9QR3VK11RDD1ZDPVJ7SEYA). Reads all files from " +
      ".flow/maintainer-inbox/ (written by recordMaintainerFeedback) and returns each " +
      "stored item with a pre-filled GitHub new-issue URL (title: '[<tool_area>] <problem>', " +
      "body: labelled sections with problem, suggested direction, and trigger). The link " +
      "opens GitHub's own new-issue form so the operator can review and submit as themselves — " +
      "nothing is ever filed automatically, and the link is a plain web URL with no gh CLI " +
      "dependency. When the inbox is empty, returns { emptyInbox: true, items: [] }. " +
      "When gh is unavailable, items are still listed without issueUrl (fail-soft). " +
      "Malformed inbox files are skipped and counted in malformedCount. Read-only.",
    inputSchema: reviewMaintainerInboxInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({ targetRepoRoot: z.string().min(1) })
        .parse(args);
      const result = await reviewMaintainerInbox({
        targetRepoRoot: parsed.targetRepoRoot,
      });

      if (result.emptyInbox) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...result,
                _message:
                  "The maintainer inbox is empty — no feedback items are waiting.",
              }),
            },
          ],
        };
      }

      // Build a human-readable summary alongside the structured payload.
      // Each item's link block contains all three fallback paths: markdown
      // hyperlink, plain bare URL, and a gh issue create command
      // (Story native:01KVEZQKWPH8V627QJSAF5F4E6).
      const summaryLines: string[] = [
        `Maintainer inbox — ${result.items.length} item${result.items.length === 1 ? "" : "s"}:`,
      ];
      for (const [i, item] of result.items.entries()) {
        summaryLines.push(
          `\n[${i + 1}] ${item.tool_area}: ${item.problem.slice(0, 120)}`,
        );
        if (item.issueUrl) {
          // The inbox item carries the same required fields as MaintainerFeedbackItem;
          // the cast is safe for the title/body composers.
          const title = composeStoredItemIssueTitle(item as unknown as MaintainerFeedbackItem);
          const body = composeStoredItemIssueBody(item as unknown as MaintainerFeedbackItem);
          const linkBlock = renderFeedbackLinkBlock(item.issueUrl, title, body);
          if (linkBlock !== null) {
            summaryLines.push(`    ${linkBlock.split("\n").join("\n    ")}`);
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...result,
              _message: summaryLines.join("\n"),
            }),
          },
        ],
      };
    },
  });

  // Story native:01KVDXX (surface-maintainer-findings-in-run) — dismissMaintainerFeedback:
  // archive one stored maintainer-feedback item the operator will NOT file, so it stops
  // re-surfacing in every /flow:run closing summary. Moves the matching .json file into
  // .flow/maintainer-inbox/dismissed/ (content intact). reviewMaintainerInbox naturally
  // ignores the dismissed/ subdir (it reads only top-level .json files). Idempotent — a
  // missing/already-dismissed id is a clean no-op. Throws on a malformed (non-ULID) id.
  server.registerTool({
    name: "dismissMaintainerFeedback",
    description:
      "Dismiss (archive) one stored maintainer-feedback item by its ULID id so it stops " +
      "re-appearing in the /flow:run closing summary. Moves the matching file from " +
      ".flow/maintainer-inbox/ into .flow/maintainer-inbox/dismissed/ — the file content " +
      "is preserved (archive, not delete) and reviewMaintainerInbox no longer returns it. " +
      "Idempotent: dismissing an unknown or already-dismissed id is a clean no-op " +
      "(dismissed:false, noop:true), never an error. Refuses a malformed (non-ULID) id. " +
      "The move touches ONLY .flow/maintainer-inbox/ and leaves the team's working state " +
      "and backlog byte-unchanged. Story native:01KVDXX.",
    inputSchema: dismissMaintainerFeedbackInputSchema,
    handler: async (args) => {
      try {
        const parsed = z
          .object({
            targetRepoRoot: z.string().min(1),
            id: z.string().min(1),
          })
          .parse(args);
        const result = await dismissMaintainerFeedback({
          targetRepoRoot: parsed.targetRepoRoot,
          id: parsed.id,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KT2Q51E24XKMM4YEF0ADRKNG — resolveLensRoles: read-only auto-staffing
  // seam. Enumerates the live hired roster (same source as getTeamSnapshot) and returns
  // the deterministic lens→role binding via resolveLensRoleBinding (bipartite matching).
  // Registered here (MCP) AND in the CLI TOOLS map so it is callable on the no-MCP
  // run/gate path: node dist/cli.js resolveLensRoles --json '{"targetRepoRoot":"..."}'.
  // Throws LensJudgeUnavailableError when the roster cannot staff all five distinct judges.
  server.registerTool({
    name: "resolveLensRoles",
    description:
      "Resolve the deterministic lens→role binding from the live hired roster (Story FU2). " +
      "Reads <targetRepoRoot>/team/ to enumerate hired roles (same source as getTeamSnapshot), " +
      "then runs maximum bipartite matching (Kuhn's algorithm) with per-lens ordered candidate " +
      "preference lists to assign all five lenses to five DISTINCT hired roles — preferring a " +
      "specialist for a lens when one is on the team. Returns { lensRoles, hiredRoles }. " +
      "Throws LensJudgeUnavailableError (naming the first uncovered lens) when the roster is " +
      "too small or too narrow to staff all five distinct judges. " +
      "Read-only: does NOT mutate state. Used by both the interactive /flow:ready skill (judge-on-approve) and " +
      "the unattended gate-1.workflow.js (via the CLI seam) so no operator ever hand-picks " +
      "judge assignments.",
    inputSchema: resolveLensRolesInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await resolveLensRoles({ targetRepoRoot: parsed.targetRepoRoot });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KVPQS1DVJE41KNG065D6X1X7 — resolveRunSlot: deterministic run-slot
  // resolver. Enumerates the live hired roster, reads each role's declared
  // `capabilities.run_jobs`, and returns the role that should fill the requested
  // slot (build or review). The generalist default (generalist-dev / generalist-reviewer)
  // wins when present and qualified; otherwise the single other qualified role wins.
  // Throws RunSlotUnstaffedError (naming the slot) when no qualified role exists.
  // Registered here (MCP) AND in the CLI TOOLS map so it is callable on the no-MCP
  // run path: node dist/cli.js resolveRunSlot --json '{"targetRepoRoot":"...","job":"build"}'.
  server.registerTool({
    name: "resolveRunSlot",
    description:
      "Resolve the role that fills a run job slot (build or review) from the live hired roster " +
      "(Story native:01KVPQS1DVJE41KNG065D6X1X7). Reads <targetRepoRoot>/team/ to enumerate " +
      "hired roles, checks each role's declared capabilities.run_jobs, and returns the qualified " +
      "role for the slot. The generalist default (generalist-dev for build, generalist-reviewer " +
      "for review) wins whenever it is present and qualified. Returns { role, isDefault }. " +
      "Throws RunSlotUnstaffedError (naming the slot) when no hired role qualifies. " +
      "Read-only: does NOT mutate state.",
    inputSchema: resolveRunSlotInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          job: z.enum(["build", "review"]),
        })
        .parse(args);
      try {
        const result = await resolveRunSlot(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KT6QEWY794ZY0DH6JHQFWG6V — recallLesson: on-demand full-body
  // retrieval of a single structured lesson from a role's Knowledge section.
  //
  // The companion to buildPersonaSpawnPrompt's one-line index. After briefing,
  // an agent sees only `[<id>] <kind> — <applies_when>` per lesson; when it
  // needs the full detail of a specific lesson it calls this tool with the id.
  // Returns { found: true, lesson: { id, kind, applies_when, detail, ... } }
  // or { found: false, lesson: null } on a soft miss (lesson pruned / stale id).
  // Throws PersonaFileNotFoundError when the persona file is absent.
  server.registerTool({
    name: "recallLesson",
    description:
      "Retrieve the full body of one structured lesson from a role's ## Knowledge section by id " +
      "(Story native:01KT6QEWY794ZY0DH6JHQFWG6V). The agent's briefing contains a compact " +
      "one-line index (`[id] kind — applies_when`); call this with the id to get the full " +
      "lesson detail, kind, failure_class, source_ref, source_pr, and learned_at. " +
      "Returns { found: true, lesson: {...} } when found, or { found: false, lesson: null } " +
      "when the id is unknown (soft miss — never throws on a missing lesson). " +
      "Throws PersonaFileNotFoundError when team/<role>/PERSONA.md is absent. " +
      "Read-only: never mutates state.",
    inputSchema: recallLessonInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          role: z.string().min(1),
          id: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await recallLesson(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KTKJXP6DWN5YHKVG96DH16V0 — classifyStoryLane: pure deterministic
  // lane classifier over execution-manifest signals. Returns { lane: 'fast'|'full',
  // matched_rule, evidence } before the costly judge panel is invoked, so trivial
  // low-risk work can take a cheaper path. Conservative by design: any missing
  // signal, any elevated risk tier, or any security-sensitive cited source forces
  // 'full'. The author's optional lane_hint is downgrade-only ('fast' hint honoured
  // only if the classifier independently returns 'fast'; 'full' hint always wins).
  // Pure: no I/O, no LLM, no spec load. The post-build classifyRiskTier on the real
  // diff is the safety backstop; this is a cost optimisation, not a safety control.
  server.registerTool({
    name: "classifyStoryLane",
    description:
      "Classify a story into a cost lane ('fast' or 'full') from its execution-manifest signals " +
      "(Story native:01KTKJXP6DWN5YHKVG96DH16V0). " +
      "Pure deterministic function — no I/O, no LLM. " +
      "'fast' requires ALL of: risk_tier='low' AND ≤3 cited_sources AND a safe change intent " +
      "(docs-only, tests-only, or additive-only). " +
      "ANY high/medium risk_tier, security-sensitive cited source, absent risk_tier, " +
      "or ambiguous signals forces 'full' — an unknown story is never cheapened. " +
      "The optional lane_hint is downgrade-only: a 'fast' hint is honoured only if the " +
      "classifier independently returns 'fast'; a 'full' hint always wins. " +
      "Returns { lane, matched_rule, evidence: { risk_tier, cited_sources_count, security_paths, author_hint } }. " +
      "The post-build classifyRiskTier on the real diff remains the safety backstop.",
    inputSchema: classifyStoryLaneInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          storyId: z.string().min(1),
          risk_tier: z.enum(["low", "medium", "high"]).optional(),
          cited_sources: z.array(z.string().min(1)).optional(),
          lane_hint: z.enum(["fast", "full"]).optional(),
        })
        .parse(args);
      const result = classifyStoryLane(parsed);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });

  // Story native:01KTKK2Y73EDDAXK470EZ3MHQ8 — resolveJudgePlan: pure deterministic
  // judge-plan resolver. Maps (lane, detector_confirmed_dead) to a lens plan
  // { skip, lenses, perLensModel } before the costly judge panel is invoked.
  // - full/absent → five-lens tiering verbatim (byte-identical to the current LENS_MODEL).
  // - fast → one combined Structure+Verifiability lens on Sonnet (no Opus).
  // - fast + detector_confirmed_dead=true → { skip: true } (auto-bless bypass).
  // The load-bearing decision lives here (not in gate-1.workflow.js or agent prose)
  // so it is unit-testable without the Workflow runtime.
  server.registerTool({
    name: "resolveJudgePlan",
    description:
      "Resolve the judge lens plan from (lane, detector_confirmed_dead) before the judge panel runs " +
      "(Story native:01KTKK2Y73EDDAXK470EZ3MHQ8). " +
      "Pure deterministic function — no I/O, no LLM. " +
      "full/absent → { skip: false, lenses: [5-lens array], perLensModel: { Structure+Discipline=sonnet, Verif+Domain+Considered=opus } }. " +
      "fast → { skip: false, lenses: ['structure+verifiability'], perLensModel: { 'structure+verifiability': 'sonnet' } }. " +
      "fast + detector_confirmed_dead=true → { skip: true, lenses: [], perLensModel: {} } (auto-bless bypass — merge gate remains the safety net). " +
      "Returns { skip, lenses, perLensModel }.",
    inputSchema: resolveJudgePlanInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          storyId: z.string().min(1),
          lane: z.enum(["fast", "full"]).optional(),
          detector_confirmed_dead: z.boolean().optional(),
        })
        .parse(args);
      const result = resolveJudgePlan(parsed);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });

  // Story native:01KTKK3HQYNFS1M1ZR9TG02G1F — resolveBuildPlan: pure deterministic
  // build-plan resolver. Maps a story's lane → { devReviewerModel, reviewDepth }.
  // - fast  → cheap model (haiku) + light review
  // - full/absent → current Sonnet default + full review (no-regression pin)
  // When manifestPath is provided, reads the lane from the persisted execution
  // manifest (written at scan time by classifyStoryLane). The load-bearing
  // decision lives here (not in run.workflow.js or agent prose) so it is
  // unit-testable without the Workflow runtime. Callable on the no-MCP run path:
  //   node dist/cli.js resolveBuildPlan --json '{"storyId":"...","manifestPath":"..."}'
  server.registerTool({
    name: "resolveBuildPlan",
    description:
      "Resolve the build plan (dev/reviewer model + review depth) from a story's lane " +
      "(Story native:01KTKK3HQYNFS1M1ZR9TG02G1F). " +
      "fast -> { devReviewerModel: 'haiku', reviewDepth: 'light' }. " +
      "full/absent -> { devReviewerModel: 'sonnet', reviewDepth: 'full' } (no-regression pin). " +
      "When manifestPath is provided, reads the lane from the persisted execution manifest " +
      "(written at scan time by classifyStoryLane); pass lane directly for a pure no-I/O call. " +
      "The dev's pre-PR build+test gate (runDevTerminalAction) and merge gate (runAutoMergeGate) " +
      "are unchanged -- the cheaper path sits entirely in front of the same hard gates. " +
      "Returns { devReviewerModel, reviewDepth }.",
    inputSchema: resolveBuildPlanInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          storyId: z.string().min(1),
          lane: z.enum(["fast", "full"]).optional(),
          manifestPath: z.string().min(1).optional(),
        })
        .parse(args);
      const result = await resolveBuildPlan(parsed);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });

  // Story native:01KTZGEW6TSC6M84P9KJ7FD96S — summariseRetroProposal: read-only
  // summary tool for the /flow:retro skill. After the retro-analyst subagent
  // emits the locked handoff phrase 'Handoff to operator — retro proposal ready
  // for review at <path>', the skill calls this tool on that path to obtain a
  // structured per-proposal summary for inline rendering.
  //
  // The tool reads the file, splits its YAML frontmatter, parses it through
  // parseRetroProposalFile (the same canonical reader locate-proposal.ts uses),
  // and returns { absPath, totalCount, noProposals, proposals[] } where each
  // proposal entry carries { type, rationale, id }. No writes, no network.
  // This ensures the inline summary and the file cannot disagree — both derive
  // from the same frontmatter source of truth.
  server.registerTool({
    name: "summariseRetroProposal",
    description:
      "Read-only summary tool for the /flow:retro skill " +
      "(Story native:01KTZGEW6TSC6M84P9KJ7FD96S). Accepts the absolute path of a " +
      "retro-proposal file written by writeRetroProposal, reads its YAML frontmatter, " +
      "parses it through the canonical parseRetroProposalFile, and returns a structured " +
      "per-proposal summary for inline rendering. Returns { absPath, totalCount, " +
      "noProposals, proposals: [{ type, rationale, id }] }. When noProposals is true " +
      "the skill MUST render a plain 'no recommended changes this cycle' statement. " +
      "No writes, no mutations — strictly read-only. " +
      "Throws MalformedRetroProposalError if the file's frontmatter fails schema validation.",
    inputSchema: summariseRetroProposalInputSchema,
    handler: async (args) => {
      try {
        const parsed = z
          .object({ absPath: z.string().min(1) })
          .parse(args);
        const result = await summariseRetroProposal(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err.name, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KTZKHJ1KDYKGXR20FZ15Y4WB — discardDraft: first-class discard
  // of an un-built parked native draft (AC1–AC4). Removes BOTH the to-do/
  // execution manifest AND the underlying .flow/native-stories/<ULID>.md source
  // file in one guarded action so a later projection pass cannot re-materialise
  // the item. Refuses anything that is not an un-claimed, un-withdrawn native
  // to-do draft with the typed NotAnEligibleDraftError. Already-absent refs
  // are a clean no-op (idempotent). Used by the /flow:ready skill's discard
  // action (AC4) — the skill calls this tool and never touches files itself.
  server.registerTool({
    name: "discardDraft",
    description:
      "Discard an un-claimed native draft parked in the backlog " +
      "(Story native:01KTZKHJ1KDYKGXR20FZ15Y4WB). Removes BOTH the to-do/ execution " +
      "manifest AND the underlying .flow/native-stories/<ULID>.md source draft in one " +
      "guarded action, so a later scanSources pass cannot re-materialise the item. " +
      "Refuses with NotAnEligibleDraftError when the ref is claimed/in-progress/done/" +
      "blocked (not-in-to-do), already withdrawn, belongs to a non-native adapter " +
      "(wrong-adapter), or does not exist AND is not just absent (not-found). " +
      "When the ref is absent from every state directory the action is a clean no-op " +
      "(returns { removed:false, noop:true }) — idempotent on double-call. " +
      "Used by the /flow:ready skill; the skill never deletes files or runs git itself.",
    inputSchema: discardDraftInputSchema,
    handler: async (args) => {
      try {
        const parsed = z
          .object({
            targetRepoRoot: z.string().min(1),
            ref: z.string().min(1),
          })
          .parse(args);
        const result = await discardDraft(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KVN6ASCWXAHZ0FF7YRFKJECC — requeueBlockedStory: the inverse
  // of blockStory. Moves a genuinely blocked story back into the to-do (buildable)
  // queue with its block cleared, so the next run can claim and build it normally.
  // This is the missing supported escape path from the blocked state — before this
  // tool the only exit was hand-editing files the rules forbid. Refuses with
  // NotABlockedStoryError when the ref is not in blocked/ (not-found, to-do,
  // in-progress, or done). The move is a single rename(2) syscall (NFR8) so a
  // successful requeue leaves exactly one copy in to-do/ and none in blocked/.
  // Used by the /flow:run recovery surface and by operators via the CLI.
  server.registerTool({
    name: "requeueBlockedStory",
    description:
      "Move a genuinely blocked story back into the buildable to-do queue " +
      "(Story native:01KVN6ASCWXAHZ0FF7YRFKJECC). The inverse of blockStory: " +
      "renames blocked/<ref>.yaml → to-do/<ref>.yaml (single rename syscall, NFR8), " +
      "then rewrites the manifest to clear blocked_by, claimed_by, and reset status " +
      "to 'to-do', so the next claimNextStory call sees a normal claimable item. " +
      "Refuses with NotABlockedStoryError when the ref is not in blocked/ — including " +
      "not-found, to-do, in-progress, or done. A successful requeue provably leaves " +
      "exactly one copy of the manifest (in to-do/) and none in blocked/.",
    inputSchema: requeueBlockedStoryInputSchema,
    handler: async (args) => {
      try {
        const parsed = z
          .object({
            targetRepoRoot: z.string().min(1),
            ref: z.string().min(1),
          })
          .parse(args);
        const result = await requeueBlockedStory(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KVPSZ14HH48J9NEH7N6S6QDR — matchStorySpecialist: derive the
  // specialist to auto-engage for a story from its cited-source paths matched
  // against hired specialists' declared path_patterns. Returns { role, domain }
  // for the matched specialist, or { role: null, domain: null } when no specialist's
  // patterns match (generalists-only, unchanged from today). Read-only / fail-soft.
  server.registerTool({
    name: "matchStorySpecialist",
    description:
      "Derive the specialist to auto-engage for a story by matching its cited-source " +
      "paths against hired specialists' declared capabilities.path_patterns. " +
      "Returns { role, domain } when a match is found, or { role: null, domain: null } " +
      "when no specialist's patterns match (generalists-only). Read-only / fail-soft. " +
      "Story native:01KVPSZ14HH48J9NEH7N6S6QDR.",
    inputSchema: matchStorySpecialistInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          manifestPath: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await matchStorySpecialist(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });

  // Story native:01KVPSZ14HH48J9NEH7N6S6QDR — recordSpecialistEngagement: write
  // engaged_specialist onto the in-progress execution manifest, recording that the
  // named specialist was auto-engaged for this story alongside the generalists.
  server.registerTool({
    name: "recordSpecialistEngagement",
    description:
      "Write engaged_specialist: <roleId> onto the in-progress execution manifest " +
      "to record that the named specialist was auto-engaged for this story alongside " +
      "the generalists. Idempotent on repeat. Not a state-machine transition — " +
      "the manifest stays in in-progress/. Story native:01KVPSZ14HH48J9NEH7N6S6QDR.",
    inputSchema: recordSpecialistEngagementInputSchema,
    handler: async (args) => {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          ref: z.string().min(1),
          sessionUlid: z.string().min(1),
          specialistRole: z.string().min(1),
        })
        .parse(args);
      try {
        const result = await recordSpecialistEngagement(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  });
}
