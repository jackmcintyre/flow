/**
 * Unit tests for `resolveBuildPlan`.
 *
 * Story native:01KTKK3HQYNFS1M1ZR9TG02G1F — AC1
 *
 * Covers the lane → { devReviewerModel, reviewDepth } mapping:
 * - fast lane  → cheap model (haiku) + light review
 * - full lane  → current Sonnet default + full review
 * - absent lane → full defaults (no-regression pin for substantial work)
 */

import { describe, expect, it } from "vitest";
import {
  resolveBuildPlan,
  BuildPlanSchema,
  FAST_LANE_MODEL,
  FULL_LANE_MODEL,
  FAST_REVIEW_DEPTH,
  FULL_REVIEW_DEPTH,
} from "../resolve-build-plan.js";

// ---------------------------------------------------------------------------
// fast lane → cheap model + light review
// ---------------------------------------------------------------------------

describe("AC1: fast lane — cheap model tier + light review", () => {
  it("lane=fast returns devReviewerModel=haiku + reviewDepth=light", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-fast-basic", lane: "fast" });
    expect(plan.devReviewerModel).toBe("haiku");
    expect(plan.reviewDepth).toBe("light");
  });

  it("fast lane devReviewerModel equals FAST_LANE_MODEL constant (regression pin)", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-fast-constant", lane: "fast" });
    expect(plan.devReviewerModel).toBe(FAST_LANE_MODEL);
  });

  it("fast lane reviewDepth equals FAST_REVIEW_DEPTH constant (regression pin)", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-fast-depth-pin", lane: "fast" });
    expect(plan.reviewDepth).toBe(FAST_REVIEW_DEPTH);
  });

  it("fast lane is cheaper than full lane — haiku not sonnet", async () => {
    const fast = await resolveBuildPlan({ storyId: "native:test-fast-cheaper", lane: "fast" });
    expect(fast.devReviewerModel).not.toBe("sonnet");
    expect(fast.devReviewerModel).not.toBe("opus");
  });

  it("fast lane review is lighter than full lane — 'light' not 'full'", async () => {
    const fast = await resolveBuildPlan({ storyId: "native:test-fast-lighter", lane: "fast" });
    expect(fast.reviewDepth).toBe("light");
    expect(fast.reviewDepth).not.toBe("full");
  });

  it("fast plan passes BuildPlanSchema strict validation", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-fast-schema", lane: "fast" });
    const parsed = BuildPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// full lane → Sonnet default + full review (no-regression pin)
// ---------------------------------------------------------------------------

describe("AC1: full lane — Sonnet default + full review (no-regression pin)", () => {
  it("lane=full returns devReviewerModel=sonnet + reviewDepth=full", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-full-basic", lane: "full" });
    expect(plan.devReviewerModel).toBe("sonnet");
    expect(plan.reviewDepth).toBe("full");
  });

  it("full lane devReviewerModel equals FULL_LANE_MODEL constant (regression pin)", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-full-constant", lane: "full" });
    expect(plan.devReviewerModel).toBe(FULL_LANE_MODEL);
  });

  it("full lane reviewDepth equals FULL_REVIEW_DEPTH constant (regression pin)", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-full-depth-pin", lane: "full" });
    expect(plan.reviewDepth).toBe(FULL_REVIEW_DEPTH);
  });

  it("full plan passes BuildPlanSchema strict validation", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-full-schema", lane: "full" });
    const parsed = BuildPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
  });

  it("full lane model is 'sonnet' — unchanged from today's default (no-regression pin)", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-full-sonnet-pin", lane: "full" });
    // This is the EXACT model the drain has used since FU6 — must not change.
    expect(plan.devReviewerModel).toBe("sonnet");
  });

  it("full lane reviewDepth is 'full' — unchanged from today's behaviour (no-regression pin)", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-full-review-pin", lane: "full" });
    expect(plan.reviewDepth).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// absent lane → full defaults (conservative, no-regression pin)
// ---------------------------------------------------------------------------

describe("AC1: absent lane defaults to full — no-regression pin for substantial work", () => {
  it("absent lane (undefined) returns the same plan as lane=full", async () => {
    const planFull = await resolveBuildPlan({ storyId: "native:test-absent-explicit", lane: "full" });
    const planAbsent = await resolveBuildPlan({ storyId: "native:test-absent-undefined" });
    expect(planAbsent).toEqual(planFull);
  });

  it("absent lane defaults to Sonnet model (conservative — unknown story is never cheapened)", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-absent-conservative" });
    expect(plan.devReviewerModel).toBe("sonnet");
  });

  it("absent lane defaults to full review depth", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-absent-full-review" });
    expect(plan.reviewDepth).toBe("full");
  });

  it("absent plan passes BuildPlanSchema strict validation", async () => {
    const plan = await resolveBuildPlan({ storyId: "native:test-absent-schema" });
    const parsed = BuildPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fast ≠ full — the two plans are distinct
// ---------------------------------------------------------------------------

describe("fast and full plans are distinct (no accidental aliasing)", () => {
  it("fast and full plans have different devReviewerModel", async () => {
    const fast = await resolveBuildPlan({ storyId: "native:test-distinct-model", lane: "fast" });
    const full = await resolveBuildPlan({ storyId: "native:test-distinct-model-2", lane: "full" });
    expect(fast.devReviewerModel).not.toBe(full.devReviewerModel);
  });

  it("fast and full plans have different reviewDepth", async () => {
    const fast = await resolveBuildPlan({ storyId: "native:test-distinct-depth", lane: "fast" });
    const full = await resolveBuildPlan({ storyId: "native:test-distinct-depth-2", lane: "full" });
    expect(fast.reviewDepth).not.toBe(full.reviewDepth);
  });
});
