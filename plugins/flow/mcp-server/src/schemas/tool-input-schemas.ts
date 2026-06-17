/**
 * Shared tool input schemas — the single source of truth for each tool's
 * input contract (Story native:01KV45Y13EQYVZP98PR8A9F40P).
 *
 * Both the MCP transport (`register.ts`) and the CLI transport (`cli.ts`)
 * import from this module so neither can silently diverge on what a tool
 * accepts or rejects. Each exported object is a plain JSON Schema fragment
 * (`{ type: "object", properties: {...}, required: [...] }`) matching the
 * shape the MCP `inputSchema` field expects.
 *
 * Design constraints:
 *   - This module MUST NOT import from tool implementations (no circular deps).
 *   - The MCP server exports the `inputSchema` values verbatim to MCP clients.
 *   - The CLI transport uses `required` arrays for entry-point validation.
 *   - Constants derived from other schema modules (e.g. LENS_NAMES) are
 *     inlined here to keep this module import-free of tool code.
 */

/** JSON Schema shape used for each tool's input contract. */
export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Inlined constants (avoid circular deps by not importing from tool modules)
// ---------------------------------------------------------------------------

/** The five Tier-1 rubric lens names (mirrors LENS_NAMES in schemas/lens-verdict.ts). */
const LENS_NAMES_TUPLE = [
  "structure",
  "verifiability",
  "discipline",
  "domain",
  "considered",
] as const;

// ---------------------------------------------------------------------------
// Tool input schemas — one per registered tool, alphabetical order
// ---------------------------------------------------------------------------

export const acceptProposalInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    proposalId: { type: "string" },
    confirm: { type: "boolean" },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "proposalId"],
};

export const adjudicateQualityLeadInputSchema: ToolInputSchema = {
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
              lens: { type: "string", enum: [...LENS_NAMES_TUPLE] },
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
};

export const aggregateJudgePanelInputSchema: ToolInputSchema = {
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
};

export const applyReviewerLabelsInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    sessionUlid: { type: "string" },
    ref: { type: "string" },
    verdictOverride: { type: "string", enum: ["reviewer-failure"] },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "sessionUlid", "ref"],
};

export const blockOrphanNoTranscriptInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    ref: { type: "string" },
    staleUlid: { type: "string" },
  },
  required: ["targetRepoRoot", "ref", "staleUlid"],
};

export const buildPersonaSpawnPromptInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "role"],
};

export const claimNextStoryInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    sessionUlid: { type: "string" },
  },
  required: ["targetRepoRoot", "sessionUlid"],
};

export const claimStoryInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    ref: { type: "string" },
    sessionUlid: { type: "string" },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "ref", "sessionUlid"],
};

export const classifyRiskTierInputSchema: ToolInputSchema = {
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
};

export const classifyStoryLaneInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    storyId: { type: "string" },
    risk_tier: { type: "string", enum: ["low", "medium", "high"] },
    cited_sources: { type: "array", items: { type: "string" } },
    lane_hint: { type: "string", enum: ["fast", "full"] },
  },
  required: ["storyId"],
};

export const completeStoryInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    ref: { type: "string" },
    sessionUlid: { type: "string" },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "ref", "sessionUlid"],
};

export const computeAgreementInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    lastNVerdicts: { type: "number" },
  },
  required: ["targetRepoRoot"],
};

export const computeSkillEffectivenessInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    window: { type: "number" },
  },
  required: ["targetRepoRoot"],
};

export const createSmokeScratchRepoInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
    parentDir: { type: "string" },
  },
  required: ["label"],
};

export const discardDraftInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    ref: { type: "string" },
  },
  required: ["targetRepoRoot", "ref"],
};

export const gatherRetroInputsInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
  },
  required: ["targetRepoRoot"],
};

export const getBacklogDashboardInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
  },
  required: ["targetRepoRoot"],
};

export const getStatusInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
  },
  required: ["targetRepoRoot"],
};

export const getTeamSnapshotInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    knowledgeLimit: { type: "number" },
  },
  required: ["targetRepoRoot"],
};

export const instantiatePersonaInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "role"],
};

export const listClaimableTodosInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
  },
  required: ["targetRepoRoot"],
};

export const lookupRoleByDomainInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    domain: { type: "string" },
  },
  required: ["targetRepoRoot", "domain"],
};

export const markStoryReadyInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    ref: { type: "string" },
    ready: { type: "boolean" },
    sessionUlid: { type: "string" },
  },
  required: ["targetRepoRoot", "ref", "ready"],
};

export const markWithdrawnInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    ref: { type: "string" },
  },
  required: ["targetRepoRoot", "ref"],
};

export const mintSessionUlidInputSchema: ToolInputSchema = {
  type: "object",
  properties: {},
};

export const openCycleInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    sessionUlid: { type: "string" },
  },
  required: ["targetRepoRoot"],
};

export const postReviewerCommentsInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    sessionUlid: { type: "string" },
    ref: { type: "string" },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "sessionUlid", "ref"],
};

export const processDevTranscriptInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    sessionUlid: { type: "string" },
    ref: { type: "string" },
    devTranscript: { type: "string" },
  },
  required: ["targetRepoRoot", "sessionUlid", "ref", "devTranscript"],
};

export const processReviewerTranscriptInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    sessionUlid: { type: "string" },
    ref: { type: "string" },
    manifestPath: { type: "string" },
  },
  required: ["targetRepoRoot", "sessionUlid", "ref", "manifestPath"],
};

export const processReviewerYieldInputSchema: ToolInputSchema = {
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
};

export const readBacklogInventoryInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    ref: { type: "string" },
    includeSpecText: { type: "boolean" },
  },
  required: ["targetRepoRoot"],
};

export const readCatalogueInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    role: { type: "string" },
  },
  required: ["role"],
};

export const readCustomRoleInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "role"],
};

export const readPersonaInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "role"],
};

export const readRepoSignalsInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
  },
  required: ["targetRepoRoot"],
};

export const reattachOrphanInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    ref: { type: "string" },
    currentSessionUlid: { type: "string" },
  },
  required: ["targetRepoRoot", "ref", "currentSessionUlid"],
};

export const recallLessonInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    role: { type: "string" },
    id: { type: "string" },
  },
  required: ["targetRepoRoot", "role", "id"],
};

export const recordMaintainerFeedbackInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    item: {
      type: "object",
      properties: {
        problem: { type: "string" },
        tool_area: { type: "string" },
        trigger: { type: "string" },
        suggested_direction: { type: "string" },
      },
      required: ["problem", "tool_area", "trigger"],
    },
  },
  required: ["targetRepoRoot", "item"],
};

export const reviewMaintainerInboxInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
  },
  required: ["targetRepoRoot"],
};

export const recordAgentFrictionInputSchema: ToolInputSchema = {
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
};

export const recordReviewerLessonInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    sessionUlid: { type: "string" },
    ref: { type: "string" },
    lesson: { type: "object" },
  },
  required: ["targetRepoRoot", "sessionUlid", "ref", "lesson"],
};

export const recordSkillInvokeInputSchema: ToolInputSchema = {
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
};

export const recordStoryRetroInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    ref: { type: "string" },
    payload: { type: "object" },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "ref", "payload"],
};

export const resolveBuildPlanInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    storyId: { type: "string" },
    lane: { type: "string", enum: ["fast", "full"] },
    manifestPath: { type: "string" },
  },
  required: ["storyId"],
};

export const resolveJudgePlanInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    storyId: { type: "string" },
    lane: { type: "string", enum: ["fast", "full"] },
    detector_confirmed_dead: { type: "boolean" },
  },
  required: ["storyId"],
};

export const resolveLensRolesInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
  },
  required: ["targetRepoRoot"],
};

export const runAutoMergeGateInputSchema: ToolInputSchema = {
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
};

export const runDevTerminalActionInputSchema: ToolInputSchema = {
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
    buildTestTimeoutMs: {
      type: "number",
      description:
        "Per-run time budget (milliseconds) for the build/test gates. " +
        "Defaults to 1 200 000 (20 min). Set to 0 to disable the budget.",
    },
    howToTestWalkthrough: {
      type: "string",
      description:
        "Developer-authored ordered by-hand walk-through of exercising the " +
        "actual feature in the running product, ending with the reviewer " +
        "performing the real end-user action. Rendered verbatim in the PR's " +
        "'How to check it yourself' section. When absent or empty, an honest " +
        "'no walk-through was provided' fallback is emitted instead — never " +
        "the per-AC criteria/test list, never fabricated steps.",
    },
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
};

export const runReviewerSessionInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    sessionUlid: { type: "string" },
    ref: { type: "string" },
    prNumber: { type: "number" },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "sessionUlid", "ref", "prNumber"],
};

export const scanOrphanedInProgressInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    sessionUlid: { type: "string" },
  },
  required: ["targetRepoRoot", "sessionUlid"],
};

export const scanSourcesInputSchema: ToolInputSchema = {
  type: "object",
  properties: { targetRepoRoot: { type: "string" } },
  required: ["targetRepoRoot"],
};

export const summariseRetroProposalInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    absPath: {
      type: "string",
      description:
        "Absolute path to the retro-proposal markdown file (.flow/retro-proposals/<ISO>.md).",
    },
  },
  required: ["absPath"],
};

export const validatePlannerBacklogInputSchema: ToolInputSchema = {
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
};

export const writeLensVerdictInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    sessionUlid: { type: "string" },
    ref: { type: "string" },
    lens: { type: "string", enum: [...LENS_NAMES_TUPLE] },
    role: { type: "string" },
    pass: { type: "boolean" },
    missed: { type: "string" },
  },
  required: ["targetRepoRoot", "sessionUlid", "ref", "lens", "role", "pass", "missed"],
};

export const writeNativeStoryInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
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
    files_touched: {
      type: "string",
      description:
        "Build-ready '### Files touched' content: the new (NEW) and updated (UPDATE) files this story creates/changes. Omitting it renders a TBD-by-dev placeholder.",
    },
    definition_of_done: {
      type: "string",
      description:
        "Build-ready '### Definition of Done' content: the checklist of what must be true to ship (ACs met, build/tests green, dist rebuilt and committed, PR green). Omitting it renders a generic default.",
    },
    risk_reasoning: {
      type: "string",
      description:
        "Build-ready '### Risk' content: the highest-risk failure mode for this story and how it is caught. REQUIRED: omitting it or leaving the default placeholder causes the write tool to refuse with a DisciplineViolationError (placeholder-risk). A terse one-liner is enough — name the failure mode and the mitigation.",
    },
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
};

export const writeRetroProposalInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    targetRepoRoot: { type: "string" },
    isoTimestamp: { type: "string" },
    proposals: { type: "array" },
    cycleWindow: {
      type: ["object", "null"],
    },
    role: { type: "string" },
  },
  required: ["targetRepoRoot", "isoTimestamp", "proposals"],
};

// ---------------------------------------------------------------------------
// Convenience map — keyed by tool name, used by both transports
// ---------------------------------------------------------------------------

/**
 * All tool input schemas keyed by their MCP tool name.
 *
 * Consuming code in `register.ts` pulls from here; consuming code in `cli.ts`
 * validates required fields against this map at the entry point.
 */
export const TOOL_INPUT_SCHEMAS: Record<string, ToolInputSchema> = {
  acceptProposal: acceptProposalInputSchema,
  adjudicateQualityLead: adjudicateQualityLeadInputSchema,
  aggregateJudgePanel: aggregateJudgePanelInputSchema,
  applyReviewerLabels: applyReviewerLabelsInputSchema,
  blockOrphanNoTranscript: blockOrphanNoTranscriptInputSchema,
  buildPersonaSpawnPrompt: buildPersonaSpawnPromptInputSchema,
  claimNextStory: claimNextStoryInputSchema,
  claimStory: claimStoryInputSchema,
  classifyRiskTier: classifyRiskTierInputSchema,
  classifyStoryLane: classifyStoryLaneInputSchema,
  completeStory: completeStoryInputSchema,
  computeAgreement: computeAgreementInputSchema,
  computeSkillEffectiveness: computeSkillEffectivenessInputSchema,
  createSmokeScratchRepo: createSmokeScratchRepoInputSchema,
  discardDraft: discardDraftInputSchema,
  gatherRetroInputs: gatherRetroInputsInputSchema,
  getBacklogDashboard: getBacklogDashboardInputSchema,
  getStatus: getStatusInputSchema,
  getTeamSnapshot: getTeamSnapshotInputSchema,
  instantiatePersona: instantiatePersonaInputSchema,
  listClaimableTodos: listClaimableTodosInputSchema,
  lookupRoleByDomain: lookupRoleByDomainInputSchema,
  markStoryReady: markStoryReadyInputSchema,
  markWithdrawn: markWithdrawnInputSchema,
  mintSessionUlid: mintSessionUlidInputSchema,
  openCycle: openCycleInputSchema,
  postReviewerComments: postReviewerCommentsInputSchema,
  processDevTranscript: processDevTranscriptInputSchema,
  processReviewerTranscript: processReviewerTranscriptInputSchema,
  processReviewerYield: processReviewerYieldInputSchema,
  readBacklogInventory: readBacklogInventoryInputSchema,
  readCatalogue: readCatalogueInputSchema,
  readCustomRole: readCustomRoleInputSchema,
  readPersona: readPersonaInputSchema,
  readRepoSignals: readRepoSignalsInputSchema,
  reattachOrphan: reattachOrphanInputSchema,
  recallLesson: recallLessonInputSchema,
  recordAgentFriction: recordAgentFrictionInputSchema,
  recordMaintainerFeedback: recordMaintainerFeedbackInputSchema,
  reviewMaintainerInbox: reviewMaintainerInboxInputSchema,
  recordReviewerLesson: recordReviewerLessonInputSchema,
  recordSkillInvoke: recordSkillInvokeInputSchema,
  recordStoryRetro: recordStoryRetroInputSchema,
  resolveBuildPlan: resolveBuildPlanInputSchema,
  resolveJudgePlan: resolveJudgePlanInputSchema,
  resolveLensRoles: resolveLensRolesInputSchema,
  runAutoMergeGate: runAutoMergeGateInputSchema,
  runDevTerminalAction: runDevTerminalActionInputSchema,
  runReviewerSession: runReviewerSessionInputSchema,
  scanOrphanedInProgress: scanOrphanedInProgressInputSchema,
  scanSources: scanSourcesInputSchema,
  summariseRetroProposal: summariseRetroProposalInputSchema,
  validatePlannerBacklog: validatePlannerBacklogInputSchema,
  writeLensVerdict: writeLensVerdictInputSchema,
  writeNativeStory: writeNativeStoryInputSchema,
  writeRetroProposal: writeRetroProposalInputSchema,
};
