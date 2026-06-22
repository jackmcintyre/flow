/**
 * Schema extension tests for the telemetry event types.
 *
 * Story 4.12 Task 8.4 — original three event types:
 *   (f) Schema-strict assertions: unknown extra key in data fails (5f)
 *   (g) Round-trip parseability: all new event types parse cleanly (5g)
 *
 * Story native:01KVP72SR857S3RY7CMQ8E2BK6 AC2 — `story.blocked` event:
 *   Asserts the event validates AND persists (a real entry is readable back
 *   from the JSONL file after a block), proving the non-fatal backstop guard
 *   cannot silently swallow a schema-validation failure from an unregistered
 *   type.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TelemetryEventSchema,
  ReviewerVerdictEventSchema,
  ReviewerVerdictMergeActionEventSchema,
  DevBudgetExceededEventSchema,
  YieldHandoffEventSchema,
  StoryBlockedEventSchema,
} from "../telemetry-events.js";
import { logTelemetryEvent } from "../../lib/logger.js";

const BASE_TS = "2026-05-26T12:00:00.000Z";
const BASE_FIELDS = {
  ts: BASE_TS,
  session_id: "SESSION-SCHEMA-TEST",
  agent: "generalist-reviewer",
};

// ---------------------------------------------------------------------------
// ReviewerVerdictEventSchema
// ---------------------------------------------------------------------------

describe("ReviewerVerdictEventSchema", () => {
  it("accepts a valid reviewer.verdict event", () => {
    const result = ReviewerVerdictEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict",
      story_id: "bmad:4.12",
      data: {
        pr_number: 42,
        verdict: "READY FOR MERGE",
        standards_version: "1.0.0",
        plugin_version: "0.5.3",
        timed_out: false,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts reviewer-failure verdict with timed_out: true", () => {
    const result = ReviewerVerdictEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict",
      data: {
        pr_number: 7,
        verdict: "reviewer-failure",
        standards_version: "2.1.0",
        plugin_version: "1.0.0",
        timed_out: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown extra key in data (.strict())", () => {
    const result = ReviewerVerdictEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict",
      data: {
        pr_number: 42,
        verdict: "NEEDS CHANGES",
        standards_version: "1.0.0",
        plugin_version: "0.5.3",
        timed_out: false,
        extra_field: "should-fail",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra key at event level (.strict())", () => {
    const result = ReviewerVerdictEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict",
      data: {
        pr_number: 42,
        verdict: "BLOCKED",
        standards_version: "1.0.0",
        plugin_version: "0.5.3",
        timed_out: false,
      },
      extra_top_level: "bad",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid verdict literal", () => {
    const result = ReviewerVerdictEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict",
      data: {
        pr_number: 42,
        verdict: "APPROVED",
        standards_version: "1.0.0",
        plugin_version: "0.5.3",
        timed_out: false,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects standards_version that is not semver", () => {
    const result = ReviewerVerdictEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict",
      data: {
        pr_number: 42,
        verdict: "READY FOR MERGE",
        standards_version: "v1.0",
        plugin_version: "0.5.3",
        timed_out: false,
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReviewerVerdictMergeActionEventSchema
// ---------------------------------------------------------------------------

describe("ReviewerVerdictMergeActionEventSchema", () => {
  it("accepts a valid reviewer.verdict.merge_action event", () => {
    const result = ReviewerVerdictMergeActionEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict.merge_action",
      story_id: "bmad:4.10",
      data: {
        pr_number: 55,
        merge_action: "merged",
        resolved_at: "2026-05-26T11:00:00.000Z",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown extra key in data (.strict())", () => {
    const result = ReviewerVerdictMergeActionEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict.merge_action",
      data: {
        pr_number: 55,
        merge_action: "merged",
        resolved_at: "2026-05-26T11:00:00.000Z",
        extra: "bad",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UTC resolved_at", () => {
    const result = ReviewerVerdictMergeActionEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict.merge_action",
      data: {
        pr_number: 55,
        merge_action: "merged",
        resolved_at: "2026-05-26T11:00:00+01:00",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid merge_action", () => {
    const result = ReviewerVerdictMergeActionEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict.merge_action",
      data: {
        pr_number: 55,
        merge_action: "force-pushed",
        resolved_at: "2026-05-26T11:00:00.000Z",
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DevBudgetExceededEventSchema
// ---------------------------------------------------------------------------

describe("DevBudgetExceededEventSchema", () => {
  it("accepts a valid dev.budget_exceeded event", () => {
    const result = DevBudgetExceededEventSchema.safeParse({
      ...BASE_FIELDS,
      agent: "generalist-dev",
      type: "dev.budget_exceeded",
      story_id: "bmad:1.2",
      data: {
        cumulative_runtime_ms: 1_800_000,
        budget_ms: 1_800_000,
        triggering_invocation_runtime_ms: 600_000,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown extra key in data (.strict())", () => {
    const result = DevBudgetExceededEventSchema.safeParse({
      ...BASE_FIELDS,
      agent: "generalist-dev",
      type: "dev.budget_exceeded",
      story_id: "bmad:1.2",
      data: {
        cumulative_runtime_ms: 1_800_000,
        budget_ms: 1_800_000,
        triggering_invocation_runtime_ms: 600_000,
        extra_field: "bad",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative cumulative_runtime_ms", () => {
    const result = DevBudgetExceededEventSchema.safeParse({
      ...BASE_FIELDS,
      agent: "generalist-dev",
      type: "dev.budget_exceeded",
      data: {
        cumulative_runtime_ms: -1,
        budget_ms: 1_800_000,
        triggering_invocation_runtime_ms: 600_000,
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Discriminated union: TelemetryEventSchema
// ---------------------------------------------------------------------------

describe("TelemetryEventSchema discriminated union — new types", () => {
  it("routes reviewer.verdict to the correct schema branch", () => {
    const result = TelemetryEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict",
      data: {
        pr_number: 1,
        verdict: "READY FOR MERGE",
        standards_version: "1.0.0",
        plugin_version: "0.5.0",
        timed_out: false,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("reviewer.verdict");
    }
  });

  it("routes reviewer.verdict.merge_action to the correct schema branch", () => {
    const result = TelemetryEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "reviewer.verdict.merge_action",
      data: {
        pr_number: 2,
        merge_action: "closed-unmerged",
        resolved_at: "2026-05-26T10:00:00.000Z",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("reviewer.verdict.merge_action");
    }
  });

  it("routes dev.budget_exceeded to the correct schema branch", () => {
    const result = TelemetryEventSchema.safeParse({
      ...BASE_FIELDS,
      agent: "generalist-dev",
      type: "dev.budget_exceeded",
      story_id: "bmad:1.1",
      data: {
        cumulative_runtime_ms: 2_000_000,
        budget_ms: 1_800_000,
        triggering_invocation_runtime_ms: 300_000,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("dev.budget_exceeded");
    }
  });

  it("routes yield.handoff to the correct schema branch", () => {
    const result = TelemetryEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "yield.handoff",
      story_id: "native:01HZTEST",
      data: {
        from_role: "generalist-reviewer",
        to_role: "security-specialist",
        domain: "authentication authorization and secret handling",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("yield.handoff");
    }
  });

  it("rejects an unknown event type", () => {
    const result = TelemetryEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "unknown.event",
      data: {},
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// YieldHandoffEventSchema
// ---------------------------------------------------------------------------

describe("YieldHandoffEventSchema", () => {
  it("accepts a valid yield.handoff event", () => {
    const result = YieldHandoffEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "yield.handoff",
      story_id: "native:01HZTEST",
      data: {
        from_role: "generalist-reviewer",
        to_role: "security-specialist",
        domain: "authentication authorization and secret handling",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown extra key in data (.strict())", () => {
    const result = YieldHandoffEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "yield.handoff",
      data: {
        from_role: "generalist-reviewer",
        to_role: "security-specialist",
        domain: "authentication authorization and secret handling",
        extra_field: "bad",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra key at event level (.strict())", () => {
    const result = YieldHandoffEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "yield.handoff",
      data: {
        from_role: "generalist-reviewer",
        to_role: "security-specialist",
        domain: "authentication authorization and secret handling",
      },
      extra_top_level: "bad",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty string for from_role", () => {
    const result = YieldHandoffEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "yield.handoff",
      data: {
        from_role: "",
        to_role: "security-specialist",
        domain: "authentication authorization and secret handling",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty string for to_role", () => {
    const result = YieldHandoffEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "yield.handoff",
      data: {
        from_role: "generalist-reviewer",
        to_role: "",
        domain: "authentication authorization and secret handling",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty string for domain", () => {
    const result = YieldHandoffEventSchema.safeParse({
      ...BASE_FIELDS,
      type: "yield.handoff",
      data: {
        from_role: "generalist-reviewer",
        to_role: "security-specialist",
        domain: "",
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StoryBlockedEventSchema — Story native:01KVP72SR857S3RY7CMQ8E2BK6 AC2
// ---------------------------------------------------------------------------

describe("StoryBlockedEventSchema", () => {
  it("accepts a valid story.blocked event", () => {
    const result = StoryBlockedEventSchema.safeParse({
      ...BASE_FIELDS,
      agent: "orchestrator",
      type: "story.blocked",
      story_id: "native:01KTEST0000000000000000000",
      data: {
        ref: "native:01KTEST0000000000000000000",
        blocked_by: "worker-threw",
        block_detail: "Cannot read properties of undefined (reading 'prUrl')",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown extra key in data (.strict())", () => {
    const result = StoryBlockedEventSchema.safeParse({
      ...BASE_FIELDS,
      agent: "orchestrator",
      type: "story.blocked",
      data: {
        ref: "native:01KTEST0000000000000000000",
        blocked_by: "worker-threw",
        block_detail: "some error",
        extra_field: "bad",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty string for ref", () => {
    const result = StoryBlockedEventSchema.safeParse({
      ...BASE_FIELDS,
      agent: "orchestrator",
      type: "story.blocked",
      data: {
        ref: "",
        blocked_by: "worker-threw",
        block_detail: "some error",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty string for block_detail", () => {
    const result = StoryBlockedEventSchema.safeParse({
      ...BASE_FIELDS,
      agent: "orchestrator",
      type: "story.blocked",
      data: {
        ref: "native:01KTEST0000000000000000000",
        blocked_by: "worker-threw",
        block_detail: "",
      },
    });
    expect(result.success).toBe(false);
  });

  it("routes story.blocked through TelemetryEventSchema discriminated union", () => {
    const result = TelemetryEventSchema.safeParse({
      ...BASE_FIELDS,
      agent: "orchestrator",
      type: "story.blocked",
      story_id: "native:01KTEST0000000000000000000",
      data: {
        ref: "native:01KTEST0000000000000000000",
        blocked_by: "worker-threw",
        block_detail: "some error detail",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("story.blocked");
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 durable-persist integration — story.blocked event writes to JSONL and
// reads back, proving the non-fatal guard cannot silently swallow a missing
// registration (Story native:01KVP72SR857S3RY7CMQ8E2BK6 AC2).
// ---------------------------------------------------------------------------

describe("story.blocked — validate-and-persist (AC2)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-story-blocked-ac2-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("AC2 — story.blocked event validates and persists in the JSONL activity history", async () => {
    const ref = "native:01KAC2TEST00000000000000000";
    const sessionId = "01TESTAC2SESSION000000000000";
    const blockedBy = "worker-threw";
    const blockDetail = "Unexpected error: Cannot read properties of undefined";

    // Emit via logTelemetryEvent (the same path emitStoryBlocked uses).
    await logTelemetryEvent({
      targetRepoRoot: tmpRoot,
      event: {
        type: "story.blocked",
        session_id: sessionId,
        agent: "orchestrator",
        story_id: ref,
        data: { ref, blocked_by: blockedBy, block_detail: blockDetail },
      },
    });

    // Read the JSONL file back — must contain a valid, parseable entry.
    const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
    const files = await fs.readdir(telemetryDir);
    expect(files.length).toBe(1);

    const jsonlPath = path.join(telemetryDir, files[0]!);
    const raw = await fs.readFile(jsonlPath, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    // The persisted line must parse back as a valid story.blocked event.
    const parsed = JSON.parse(lines[0]!) as unknown;
    const validated = TelemetryEventSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data.type).toBe("story.blocked");
      if (validated.data.type === "story.blocked") {
        expect(validated.data.data.ref).toBe(ref);
        expect(validated.data.data.blocked_by).toBe(blockedBy);
        expect(validated.data.data.block_detail).toBe(blockDetail);
        expect(validated.data.story_id).toBe(ref);
      }
    }
  });

  it("AC2 — a telemetry.invalid entry (not story.blocked) is written when type is unregistered, exposing silent-swallow failure mode", async () => {
    // This test documents the failure mode the implementation must close:
    // if story.blocked were NOT registered in the union, logTelemetryEvent
    // would write a telemetry.invalid event (not the intended entry) and throw
    // TelemetryEventInvalidError — which emitStoryBlocked's catch block swallows,
    // leaving the activity history with a failure marker instead of the real entry.
    // The AC2 test above proves we are on the SUCCESS path (real entry present).
    // This companion test proves the FAILURE path so the distinction is explicit.
    const sessionId = "01TESTFAILPATH000000000000";

    // Intentionally emit an unregistered type to trigger the failure path.
    await expect(
      logTelemetryEvent({
        targetRepoRoot: tmpRoot,
        event: {
          type: "unknown.unregistered.type" as "story.blocked", // force the wrong type
          session_id: sessionId,
          agent: "orchestrator",
          data: { ref: "native:x", blocked_by: "worker-threw", block_detail: "detail" },
        },
      }),
    ).rejects.toThrow();

    // The JSONL file exists and holds a telemetry.invalid entry, not the intended type.
    const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
    const files = await fs.readdir(telemetryDir);
    expect(files.length).toBe(1);
    const raw = await fs.readFile(path.join(telemetryDir, files[0]!), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as { type: string };
    expect(parsed.type).toBe("telemetry.invalid");
  });
});
