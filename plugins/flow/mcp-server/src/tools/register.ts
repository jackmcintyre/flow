import { z } from "zod";
import { DomainError } from "../errors.js";
import { getPluginRoot } from "../lib/plugin-root.js";
import type { AiEngineeringTeamServer } from "../server.js";
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
import { bmadToNativeIngestTool } from "./bmad-to-native-ingest.js";
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
import { resolveLensRoles } from "./resolve-lens-roles.js";
import { recallLesson } from "./recall-lesson.js";

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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
      },
      required: ["targetRepoRoot"],
    },
    handler: async (args) => {
      const root = z.string().min(1).parse(args.targetRepoRoot);
      const report = await getStatus({ targetRepoRoot: root });
      return {
        content: [{ type: "text" as const, text: renderStatus(report) }],
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
      },
      required: ["targetRepoRoot"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string" },
      },
      required: ["role"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "role"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "role"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        domain: { type: "string" },
      },
      required: ["targetRepoRoot", "domain"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
      },
      required: ["targetRepoRoot"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "role"],
    },
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
      "Return a typed snapshot of the hired team — roles, domains, fire counts from telemetry, recent persona-knowledge entries. Used by /flow:team (FR108, NFR28). Pure file reads; no LLM in the loop.",
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        knowledgeLimit: { type: "number" },
      },
      required: ["targetRepoRoot"],
    },
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
      "draft.authored telemetry event. Used by the planner subagent (/flow:plan) and the author " +
      "subagent (/flow:author) (Story 3.4 / 9.2).",
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        title: { type: "string" },
        // Story 10.2 — the narrative is a structured { role, want, so_that }.
        narrative: {
          type: "object",
          properties: {
            role: { type: "string" },
            want: { type: "string" },
            so_that: { type: "string" },
          },
          required: ["role", "want", "so_that"],
        },
        acceptance_criteria: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              kind: { type: "string", enum: ["integration", "unit"] },
              // Story 10.1 — required per-AC verification directive.
              verification: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["vitest", "artifact"] },
                  target: { type: "string" },
                },
                required: ["type", "target"],
              },
            },
            required: ["text", "kind", "verification"],
          },
        },
        // Story 10.2 — ≥1 task, each mapped to ≥1 AC id.
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              ac_refs: { type: "array", items: { type: "string" } },
            },
            required: ["text", "ac_refs"],
          },
        },
        // Story 10.2 — ≥1 repo-relative cited source path.
        cited_sources: { type: "array", items: { type: "string" } },
        implementation_notes: { type: "string" },
        depends_on: { type: "array", items: { type: "string" } },
        sessionUlid: { type: "string" },
      },
      required: [
        "targetRepoRoot",
        "title",
        "narrative",
        "acceptance_criteria",
        "tasks",
        "cited_sources",
        "depends_on",
      ],
    },
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

  // Story 10.5 — bmadToNativeIngest: the one-off, one-way BMad → native ingest
  // seam. The enrich step is LLM-assisted, so it lives in the orchestrating
  // /flow:ingest skill, which drafts a §3 enrichment per BMad story and passes
  // the drafts here keyed by source `bmad:<ref>`. The tool runs the
  // deterministic Tier-0 gate + native write over them: a passing draft is
  // written to .flow/native-stories/<ULID>.md (reusing the shared native-write
  // internal WITHOUT the WrongAdapterError guard, so it works while bmad is
  // still the active adapter); a draft that fails Tier-0 — or a source with no
  // supplied draft — is surfaced in the fix-up report, never silently dropped.
  // Read-only over the BMad backlog; re-runs dedupe by the recorded provenance
  // citation.
  server.registerTool({
    name: "bmadToNativeIngest",
    description:
      "One-off, one-way BMad → native ingest (Story 10.5). Reads the live BMad backlog, " +
      "gates each operator-supplied enriched draft (keyed by source bmad:<ref>) through the " +
      "deterministic Tier-0 validator, and writes survivors to .flow/native-stories/<ULID>.md " +
      "(works while adapter: bmad is still active — you ingest first, cut over second). " +
      "Read-only and non-destructive over BMad; re-runs dedupe by a recorded provenance citation. " +
      "Returns a report where written + needs_fix_up + skipped == input_count — nothing is ever " +
      "silently dropped. A draft that fails Tier-0, or a source with no supplied draft, is surfaced " +
      "for human fix-up with the failed check id(s).",
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        // Enriched §3 drafts keyed by the source `bmad:<epic>.<story>` ref. The
        // model (the /flow:ingest skill) authors these; the tool only gates+writes.
        drafts: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              title: { type: "string" },
              narrative: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  want: { type: "string" },
                  so_that: { type: "string" },
                },
                required: ["role", "want", "so_that"],
              },
              acceptance_criteria: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    kind: { type: "string", enum: ["integration", "unit"] },
                    verification: {
                      type: "object",
                      properties: {
                        type: { type: "string", enum: ["vitest", "artifact"] },
                        target: { type: "string" },
                      },
                      required: ["type", "target"],
                    },
                  },
                  required: ["text", "kind", "verification"],
                },
              },
              tasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    ac_refs: { type: "array", items: { type: "string" } },
                  },
                  required: ["text", "ac_refs"],
                },
              },
              cited_sources: { type: "array", items: { type: "string" } },
              implementation_notes: { type: "string" },
              depends_on: { type: "array", items: { type: "string" } },
            },
            required: [
              "title",
              "narrative",
              "acceptance_criteria",
              "tasks",
              "cited_sources",
              "depends_on",
            ],
          },
        },
      },
      required: ["targetRepoRoot", "drafts"],
    },
    handler: async (args) => {
      try {
        const result = await bmadToNativeIngestTool(args);
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        pendingStories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              narrative: { type: "string" },
              acceptance_criteria: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    kind: { type: "string", enum: ["integration", "unit"] },
                  },
                  required: ["text", "kind"],
                },
              },
              implementation_notes: { type: "string" },
              depends_on: { type: "array", items: { type: "string" } },
              ship_gate: { type: "boolean" },
              state_mutating: { type: ["boolean", "string"] },
            },
            required: [
              "title",
              "narrative",
              "acceptance_criteria",
              "depends_on",
              "ship_gate",
              "state_mutating",
            ],
          },
        },
      },
      required: ["targetRepoRoot", "pendingStories"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        ref: { type: "string" },
      },
      required: ["targetRepoRoot", "ref"],
    },
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
      "The drain claims an item only once it is dependency-ready AND marked ready. " +
      "Writes the manifest in-place (no state-directory move); no-op if the flag " +
      "already holds the requested value; raises NotAnEligibleBacklogItemError for " +
      "anything that is not an un-claimed to-do/ item.",
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        ref: { type: "string" },
        ready: { type: "boolean" },
        sessionUlid: { type: "string" },
      },
      required: ["targetRepoRoot", "ref", "ready"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        ref: { type: "string" },
        includeSpecText: { type: "boolean" },
      },
      required: ["targetRepoRoot"],
    },
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
      "MalformedExecutionManifestError surfaces verbatim. Used by the /flow:board skill.",
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
      },
      required: ["targetRepoRoot"],
    },
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

  // Story 4.1 — claimStory: atomic claim (FR17), dependency check (FR18), hand-edit guard (FR14a).
  server.registerTool({
    name: "claimStory",
    description:
      "Atomically claim a story for dev work (FR17) — moves manifest from to-do/ to in-progress/, stamps claimed_by with the caller's session ULID, refuses if any depends_on ref is not in done/ (FR18) or if the in-progress manifest has been hand-edited (FR14a). Story 4.1.",
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        ref: { type: "string" },
        sessionUlid: { type: "string" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "ref", "sessionUlid"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        ref: { type: "string" },
        sessionUlid: { type: "string" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "ref", "sessionUlid"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        ref: { type: "string" },
        payload: { type: "object" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "ref", "payload"],
    },
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
  // the binding verdict). The drain then forwards that lesson onto the done
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        ref: { type: "string" },
        lesson: { type: "object" },
      },
      required: ["targetRepoRoot", "sessionUlid", "ref", "lesson"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        isoTimestamp: { type: "string" },
        proposals: { type: "array" },
        cycleWindow: {
          // null or { from, to } — surfaced as plain object so the JSON-schema
          // hint isn't too tight; Zod inside the handler is the real gate.
          type: ["object", "null"],
        },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "isoTimestamp", "proposals"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        proposalId: { type: "string" },
        confirm: { type: "boolean" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "proposalId"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
      },
      required: ["targetRepoRoot"],
    },
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
    inputSchema: {
      type: "object",
      properties: {},
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
      },
      required: ["targetRepoRoot"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "role"],
    },
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
    inputSchema: {
      type: "object",
      properties: { targetRepoRoot: { type: "string" } },
      required: ["targetRepoRoot"],
    },
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
  // The SKILL.md prose calls this in a loop until queue-drained or
  // waiting-on-in-progress is returned.
  server.registerTool({
    name: "claimNextStory",
    description:
      "Claim the next ready story from the backlog for the current session. " +
      "Returns { next: 'spawn-dev', ref, title, manifestPath, chatLog } when a story is claimed, " +
      "{ next: 'queue-drained', chatLog } when both to-do/ and in-progress/ are empty, or " +
      "{ next: 'waiting-on-in-progress', chatLog } when todos exist but all are deps-blocked. " +
      "Story 4.3b.",
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
      },
      required: ["targetRepoRoot", "sessionUlid"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        ref: { type: "string" },
        devTranscript: { type: "string" },
      },
      required: ["targetRepoRoot", "sessionUlid", "ref", "devTranscript"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        ref: { type: "string" },
        manifestPath: { type: "string" },
      },
      required: ["targetRepoRoot", "sessionUlid", "ref", "manifestPath"],
    },
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
      "Returns { ok: true, branch, commitSha, prUrl } on success. Story 4.4.",
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        ref: { type: "string" },
        title: { type: "string" },
        type: { type: "string" },
        body: { type: "string" },
        summary: { type: "string" },
        manifestPath: { type: "string" },
        sessionUlid: { type: "string" },
        base: { type: "string" },
      },
      required: [
        "targetRepoRoot",
        "ref",
        "title",
        "type",
        "body",
        "summary",
        "manifestPath",
        "sessionUlid",
      ],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        ref: { type: "string" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "sessionUlid", "ref"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        ref: { type: "string" },
        verdictOverride: { type: "string", enum: ["reviewer-failure"] },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "sessionUlid", "ref"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        ref: { type: "string" },
        fromRole: { type: "string" },
        reviewerTranscript: { type: "string" },
        manifestPath: { type: "string" },
      },
      required: ["targetRepoRoot", "sessionUlid", "ref", "fromRole", "reviewerTranscript", "manifestPath"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        ref: { type: "string" },
        prNumber: { type: "number" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "sessionUlid", "ref", "prNumber"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        pluginRoot: { type: "string" },
        storyId: { type: "string" },
        changedPaths: { type: "array", items: { type: "string" } },
        commitMessages: { type: "array", items: { type: "string" } },
        diffSize: { type: "number" },
      },
      required: ["targetRepoRoot", "pluginRoot", "storyId", "changedPaths", "commitMessages", "diffSize"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        lastNVerdicts: { type: "number" },
      },
      required: ["targetRepoRoot"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        agent: { type: "string" },
        storyId: { type: "string" },
        data: {
          type: "object",
          properties: {
            skill_name: { type: "string" },
            skill_path: { type: "string" },
            skill_version: { type: "string" },
            skill_scope: { type: "string", enum: ["project", "persona", "plugin"] },
            invocation_source: {
              type: "string",
              enum: ["user-slash-command", "agent-call"],
            },
          },
          required: [
            "skill_name",
            "skill_path",
            "skill_version",
            "skill_scope",
            "invocation_source",
          ],
        },
      },
      required: ["targetRepoRoot", "sessionUlid", "agent", "data"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        window: { type: "number" },
      },
      required: ["targetRepoRoot"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        parentDir: { type: "string" },
      },
      required: ["label"],
    },
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
      "so the gate's stdout stays JSON-only and the drain seam cannot break. " +
      "Story 4.10b.",
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        prNumber: { type: "number" },
        ref: { type: "string" },
        sessionUlid: { type: "string" },
        thresholdOverride: { type: "number" },
        lastNVerdictsOverride: { type: "number" },
        dryRun: { type: "boolean" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "prNumber", "ref", "sessionUlid"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
      },
      required: ["targetRepoRoot", "sessionUlid"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        ref: { type: "string" },
        currentSessionUlid: { type: "string" },
      },
      required: ["targetRepoRoot", "ref", "currentSessionUlid"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        ref: { type: "string" },
        staleUlid: { type: "string" },
      },
      required: ["targetRepoRoot", "ref", "staleUlid"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        ref: { type: "string" },
        lens: { type: "string", enum: [...LENS_NAMES] },
        role: { type: "string" },
        pass: { type: "boolean" },
        missed: { type: "string" },
      },
      required: ["targetRepoRoot", "sessionUlid", "ref", "lens", "role", "pass", "missed"],
    },
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
  // Called by the /flow:judge skill AFTER it has spawned one judge per lens (each
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        draft: {
          type: "object",
          properties: {
            ref: { type: "string" },
            title: { type: "string" },
            specText: { type: "string" },
            changedPaths: { type: "array", items: { type: "string" } },
            commitMessages: { type: "array", items: { type: "string" } },
            diffSize: { type: "number" },
          },
          required: ["ref", "title", "specText"],
        },
        lensRoles: { type: "object" },
        tier0: { type: "string", enum: ["pass", "fail"] },
      },
      required: ["targetRepoRoot", "sessionUlid", "draft"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        sessionUlid: { type: "string" },
        ref: { type: "string" },
        panel: {
          type: "object",
          properties: {
            tier0: { type: "string", enum: ["pass", "fail"] },
            lenses: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  lens: { type: "string", enum: [...LENS_NAMES] },
                  role: { type: "string" },
                  pass: { type: "boolean" },
                  missed: { type: "string" },
                },
                required: ["lens", "role", "pass", "missed"],
              },
            },
          },
          required: ["tier0", "lenses"],
        },
        round: { type: "number" },
        k: { type: "number" },
      },
      required: ["targetRepoRoot", "sessionUlid", "ref", "panel"],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        agent: { type: "string" },
        story_id: { type: "string" },
        session_id: { type: "string" },
        kind: { type: "string" },
        expected: { type: "string" },
        observed: { type: "string" },
        role: { type: "string" },
      },
      required: ["targetRepoRoot", "agent", "session_id", "kind", "expected", "observed"],
    },
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

  // Story native:01KT2Q51E24XKMM4YEF0ADRKNG — resolveLensRoles: read-only auto-staffing
  // seam. Enumerates the live hired roster (same source as getTeamSnapshot) and returns
  // the deterministic lens→role binding via resolveLensRoleBinding (bipartite matching).
  // Registered here (MCP) AND in the CLI TOOLS map so it is callable on the no-MCP
  // drain/gate path: node dist/cli.js resolveLensRoles --json '{"targetRepoRoot":"..."}'.
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
      "Read-only: does NOT mutate state. Used by both the interactive /flow:judge skill and " +
      "the unattended gate-1.workflow.js (via the CLI seam) so no operator ever hand-picks " +
      "judge assignments.",
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
      },
      required: ["targetRepoRoot"],
    },
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

  // Story native:01KT6QEWY794ZY0DH6JHQFWG6V — recallLesson: on-demand full-lesson read.
  // Agents receive a compact one-line index of their role's lessons in the briefing
  // (built by buildPersonaSpawnPrompt). When an agent wants the full body of a specific
  // lesson, it calls this tool with the id from the index.
  // Read-only — never writes disk. Used by generalist-dev and generalist-reviewer.
  server.registerTool({
    name: "recallLesson",
    description:
      "Return the full body of one lesson from a role's Knowledge section by id " +
      "(Story native:01KT6QEWY794ZY0DH6JHQFWG6V). Agents receive a one-line index " +
      "of their lessons in their briefing (built by buildPersonaSpawnPrompt) and call " +
      "this tool when they need the full detail of a specific lesson. " +
      "Returns { found: true, id, kind, applies_when, detail, source_ref? } when the " +
      "id matches an entry in the role's Knowledge section, or { found: false } when " +
      "no entry has the given id. " +
      "Throws PersonaFileNotFoundError when the persona file is absent. " +
      "Read-only — never writes to disk.",
    inputSchema: {
      type: "object",
      properties: {
        targetRepoRoot: { type: "string" },
        role: { type: "string" },
        id: { type: "string" },
      },
      required: ["targetRepoRoot", "role", "id"],
    },
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
}
