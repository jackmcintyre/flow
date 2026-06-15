/**
 * Regression tests — Story native:01KV45Y13EQYVZP98PR8A9F40P (AC2).
 *
 * Confirms that extracting inline schemas into a shared module (the AC1 refactor)
 * did NOT change any tool's input contract. These tests compare the required[]
 * arrays and property key sets from the shared schema module against a
 * hard-coded baseline that was transcribed from register.ts before the refactor.
 *
 * The baseline is intentionally verbose — it encodes the "before" state so that
 * a future accidental change to the shared module fails a named, readable test
 * rather than being silent.
 *
 * Tests here are purely structural (no filesystem, no tool execution).
 */

import { describe, expect, it } from "vitest";
import {
  TOOL_INPUT_SCHEMAS,
  type ToolInputSchema,
} from "../../schemas/tool-input-schemas.js";

// ---------------------------------------------------------------------------
// Baseline: required[] and property keys for each tool as they were before
// the refactor (transcribed from register.ts inline schemas).
// ---------------------------------------------------------------------------

interface Baseline {
  required: string[];
  properties: string[];
}

const BASELINE: Record<string, Baseline> = {
  acceptProposal: {
    required: ["targetRepoRoot", "proposalId"],
    properties: ["targetRepoRoot", "proposalId", "confirm", "role"],
  },
  adjudicateQualityLead: {
    required: ["targetRepoRoot", "sessionUlid", "ref", "panel"],
    properties: ["targetRepoRoot", "sessionUlid", "ref", "panel", "round", "k"],
  },
  aggregateJudgePanel: {
    required: ["targetRepoRoot", "sessionUlid", "draft"],
    properties: ["targetRepoRoot", "sessionUlid", "draft", "lensRoles", "tier0"],
  },
  applyReviewerLabels: {
    required: ["targetRepoRoot", "sessionUlid", "ref"],
    properties: ["targetRepoRoot", "sessionUlid", "ref", "verdictOverride", "role"],
  },
  blockOrphanNoTranscript: {
    required: ["targetRepoRoot", "ref", "staleUlid"],
    properties: ["targetRepoRoot", "ref", "staleUlid"],
  },
  buildPersonaSpawnPrompt: {
    required: ["targetRepoRoot", "role"],
    properties: ["targetRepoRoot", "role"],
  },
  claimNextStory: {
    required: ["targetRepoRoot", "sessionUlid"],
    properties: ["targetRepoRoot", "sessionUlid"],
  },
  claimStory: {
    required: ["targetRepoRoot", "ref", "sessionUlid"],
    properties: ["targetRepoRoot", "ref", "sessionUlid", "role"],
  },
  classifyRiskTier: {
    required: ["targetRepoRoot", "pluginRoot", "storyId", "changedPaths", "commitMessages", "diffSize"],
    properties: ["targetRepoRoot", "pluginRoot", "storyId", "changedPaths", "commitMessages", "diffSize"],
  },
  classifyStoryLane: {
    required: ["storyId"],
    properties: ["storyId", "risk_tier", "cited_sources", "lane_hint"],
  },
  completeStory: {
    required: ["targetRepoRoot", "ref", "sessionUlid"],
    properties: ["targetRepoRoot", "ref", "sessionUlid", "role"],
  },
  computeAgreement: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot", "lastNVerdicts"],
  },
  computeSkillEffectiveness: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot", "window"],
  },
  createSmokeScratchRepo: {
    required: ["label"],
    properties: ["label", "parentDir"],
  },
  discardDraft: {
    required: ["targetRepoRoot", "ref"],
    properties: ["targetRepoRoot", "ref"],
  },
  gatherRetroInputs: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot"],
  },
  getBacklogDashboard: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot"],
  },
  getStatus: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot"],
  },
  getTeamSnapshot: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot", "knowledgeLimit"],
  },
  instantiatePersona: {
    required: ["targetRepoRoot", "role"],
    properties: ["targetRepoRoot", "role"],
  },
  listClaimableTodos: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot"],
  },
  lookupRoleByDomain: {
    required: ["targetRepoRoot", "domain"],
    properties: ["targetRepoRoot", "domain"],
  },
  markStoryReady: {
    required: ["targetRepoRoot", "ref", "ready"],
    properties: ["targetRepoRoot", "ref", "ready", "sessionUlid"],
  },
  markWithdrawn: {
    required: ["targetRepoRoot", "ref"],
    properties: ["targetRepoRoot", "ref"],
  },
  mintSessionUlid: {
    required: [],
    properties: [],
  },
  openCycle: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot", "sessionUlid"],
  },
  postReviewerComments: {
    required: ["targetRepoRoot", "sessionUlid", "ref"],
    properties: ["targetRepoRoot", "sessionUlid", "ref", "role"],
  },
  processDevTranscript: {
    required: ["targetRepoRoot", "sessionUlid", "ref", "devTranscript"],
    properties: ["targetRepoRoot", "sessionUlid", "ref", "devTranscript"],
  },
  processReviewerTranscript: {
    required: ["targetRepoRoot", "sessionUlid", "ref", "manifestPath"],
    properties: ["targetRepoRoot", "sessionUlid", "ref", "manifestPath"],
  },
  processReviewerYield: {
    required: ["targetRepoRoot", "sessionUlid", "ref", "fromRole", "reviewerTranscript", "manifestPath"],
    properties: ["targetRepoRoot", "sessionUlid", "ref", "fromRole", "reviewerTranscript", "manifestPath"],
  },
  readBacklogInventory: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot", "ref", "includeSpecText"],
  },
  readCatalogue: {
    required: ["role"],
    properties: ["role"],
  },
  readCustomRole: {
    required: ["targetRepoRoot", "role"],
    properties: ["targetRepoRoot", "role"],
  },
  readPersona: {
    required: ["targetRepoRoot", "role"],
    properties: ["targetRepoRoot", "role"],
  },
  readRepoSignals: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot"],
  },
  reattachOrphan: {
    required: ["targetRepoRoot", "ref", "currentSessionUlid"],
    properties: ["targetRepoRoot", "ref", "currentSessionUlid"],
  },
  recallLesson: {
    required: ["targetRepoRoot", "role", "id"],
    properties: ["targetRepoRoot", "role", "id"],
  },
  recordAgentFriction: {
    required: ["targetRepoRoot", "agent", "session_id", "kind", "expected", "observed"],
    properties: ["targetRepoRoot", "agent", "story_id", "session_id", "kind", "expected", "observed", "role"],
  },
  recordReviewerLesson: {
    required: ["targetRepoRoot", "sessionUlid", "ref", "lesson"],
    properties: ["targetRepoRoot", "sessionUlid", "ref", "lesson"],
  },
  recordSkillInvoke: {
    required: ["targetRepoRoot", "sessionUlid", "agent", "data"],
    properties: ["targetRepoRoot", "sessionUlid", "agent", "storyId", "data"],
  },
  recordStoryRetro: {
    required: ["targetRepoRoot", "ref", "payload"],
    properties: ["targetRepoRoot", "ref", "payload", "role"],
  },
  resolveBuildPlan: {
    required: ["storyId"],
    properties: ["storyId", "lane", "manifestPath"],
  },
  resolveJudgePlan: {
    required: ["storyId"],
    properties: ["storyId", "lane", "detector_confirmed_dead"],
  },
  resolveLensRoles: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot"],
  },
  runAutoMergeGate: {
    required: ["targetRepoRoot", "prNumber", "ref", "sessionUlid"],
    properties: [
      "targetRepoRoot", "prNumber", "ref", "sessionUlid",
      "thresholdOverride", "lastNVerdictsOverride", "dryRun", "role",
    ],
  },
  runDevTerminalAction: {
    required: [
      "targetRepoRoot", "ref", "title", "type", "body", "summary",
      "manifestPath", "sessionUlid",
    ],
    properties: [
      "targetRepoRoot", "ref", "title", "type", "body", "summary",
      "manifestPath", "sessionUlid", "base", "buildTestTimeoutMs",
    ],
  },
  runReviewerSession: {
    required: ["targetRepoRoot", "sessionUlid", "ref", "prNumber"],
    properties: ["targetRepoRoot", "sessionUlid", "ref", "prNumber", "role"],
  },
  scanOrphanedInProgress: {
    required: ["targetRepoRoot", "sessionUlid"],
    properties: ["targetRepoRoot", "sessionUlid"],
  },
  scanSources: {
    required: ["targetRepoRoot"],
    properties: ["targetRepoRoot"],
  },
  summariseRetroProposal: {
    required: ["absPath"],
    properties: ["absPath"],
  },
  validatePlannerBacklog: {
    required: ["targetRepoRoot", "pendingStories"],
    properties: ["targetRepoRoot", "pendingStories"],
  },
  writeLensVerdict: {
    required: ["targetRepoRoot", "sessionUlid", "ref", "lens", "role", "pass", "missed"],
    properties: ["targetRepoRoot", "sessionUlid", "ref", "lens", "role", "pass", "missed"],
  },
  writeNativeStory: {
    required: [
      "targetRepoRoot", "title", "narrative", "acceptance_criteria",
      "tasks", "cited_sources", "depends_on",
    ],
    properties: [
      "targetRepoRoot", "title", "narrative", "acceptance_criteria",
      "tasks", "cited_sources", "implementation_notes", "files_touched",
      "definition_of_done", "risk_reasoning", "depends_on", "sessionUlid",
    ],
  },
  writeRetroProposal: {
    required: ["targetRepoRoot", "isoTimestamp", "proposals"],
    properties: ["targetRepoRoot", "isoTimestamp", "proposals", "cycleWindow", "role"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortedKeys(schema: ToolInputSchema): string[] {
  return Object.keys(schema.properties ?? {}).sort();
}

function sortedRequired(schema: ToolInputSchema): string[] {
  return [...(schema.required ?? [])].sort();
}

// ---------------------------------------------------------------------------
// Regression suite
// ---------------------------------------------------------------------------

describe("Tool input schemas are unchanged after refactor (regression)", () => {
  it("TOOL_INPUT_SCHEMAS contains exactly the tools in the baseline", () => {
    const schemaKeys = new Set(Object.keys(TOOL_INPUT_SCHEMAS));
    const baselineKeys = new Set(Object.keys(BASELINE));

    const inSchemaNotBaseline = [...schemaKeys].filter((k) => !baselineKeys.has(k));
    const inBaselineNotSchema = [...baselineKeys].filter((k) => !schemaKeys.has(k));

    expect(
      inSchemaNotBaseline,
      `Tools in schema but not baseline: ${inSchemaNotBaseline.join(", ")}`,
    ).toHaveLength(0);

    expect(
      inBaselineNotSchema,
      `Tools in baseline but not schema: ${inBaselineNotSchema.join(", ")}`,
    ).toHaveLength(0);
  });

  for (const [toolName, baseline] of Object.entries(BASELINE)) {
    describe(toolName, () => {
      it("required[] is unchanged", () => {
        const schema = TOOL_INPUT_SCHEMAS[toolName];
        expect(schema, `Schema missing for ${toolName}`).toBeDefined();
        expect(sortedRequired(schema!)).toEqual([...baseline.required].sort());
      });

      it("properties keys are unchanged", () => {
        const schema = TOOL_INPUT_SCHEMAS[toolName];
        expect(schema, `Schema missing for ${toolName}`).toBeDefined();
        expect(sortedKeys(schema!)).toEqual([...baseline.properties].sort());
      });
    });
  }
});
