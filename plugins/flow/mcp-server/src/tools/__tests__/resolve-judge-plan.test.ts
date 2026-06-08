/**
 * Unit tests for `resolveJudgePlan`.
 *
 * Story native:01KTKK2Y73EDDAXK470EZ3MHQ8
 *
 * Covers AC1–AC3:
 * - AC1: full lane (or absent) → five-lens tiering, byte-identical no-regression pin.
 * - AC2: fast lane + detector_confirmed_dead=false → single Structure+Verifiability
 *   lens on Sonnet, no Opus lenses spawned.
 * - AC3: fast lane + detector_confirmed_dead=true → skip=true (auto-bless path).
 */

import { describe, expect, it } from "vitest";
import {
  resolveJudgePlan,
  JudgePlanSchema,
  FULL_LENS_MODEL,
  FULL_LENSES,
  FAST_LENS_NAME,
} from "../resolve-judge-plan.js";

// ---------------------------------------------------------------------------
// AC1: full lane (or absent) returns five-lens tiering unchanged (regression pin)
// ---------------------------------------------------------------------------

describe("AC1: full lane — byte-identical five-lens tiering (no-regression pin)", () => {
  it("lane=full returns skip=false with all five lenses and correct per-lens models", () => {
    const plan = resolveJudgePlan({ storyId: "native:test-ac1-full", lane: "full" });
    expect(plan.skip).toBe(false);
    expect(plan.lenses).toEqual(["structure", "verifiability", "discipline", "domain", "considered"]);
    expect(plan.perLensModel).toEqual({
      structure: "sonnet",
      discipline: "sonnet",
      verifiability: "opus",
      domain: "opus",
      considered: "opus",
    });
  });

  it("absent lane (undefined) defaults to full — same as lane=full (conservative default)", () => {
    const planFull = resolveJudgePlan({ storyId: "native:test-ac1-full-explicit", lane: "full" });
    const planAbsent = resolveJudgePlan({ storyId: "native:test-ac1-full-absent" });
    expect(planAbsent).toEqual(planFull);
  });

  it("Structure and Discipline lenses run on Sonnet", () => {
    const plan = resolveJudgePlan({ storyId: "native:test-ac1-sonnet", lane: "full" });
    expect(plan.perLensModel["structure"]).toBe("sonnet");
    expect(plan.perLensModel["discipline"]).toBe("sonnet");
  });

  it("Verifiability, Domain, and Considered lenses run on Opus", () => {
    const plan = resolveJudgePlan({ storyId: "native:test-ac1-opus", lane: "full" });
    expect(plan.perLensModel["verifiability"]).toBe("opus");
    expect(plan.perLensModel["domain"]).toBe("opus");
    expect(plan.perLensModel["considered"]).toBe("opus");
  });

  it("full plan contains exactly five lenses", () => {
    const plan = resolveJudgePlan({ storyId: "native:test-ac1-count", lane: "full" });
    expect(plan.lenses).toHaveLength(5);
  });

  it("full plan has no Opus lenses under Structure or Discipline", () => {
    const plan = resolveJudgePlan({ storyId: "native:test-ac1-no-opus-cheap", lane: "full" });
    const opusLenses = plan.lenses.filter((l) => plan.perLensModel[l] === "opus");
    expect(opusLenses).not.toContain("structure");
    expect(opusLenses).not.toContain("discipline");
  });

  it("full plan perLensModel is byte-identical to FULL_LENS_MODEL export (regression pin)", () => {
    const plan = resolveJudgePlan({ storyId: "native:test-ac1-regression", lane: "full" });
    expect(plan.perLensModel).toEqual(FULL_LENS_MODEL);
  });

  it("full plan lenses array equals FULL_LENSES export (regression pin)", () => {
    const plan = resolveJudgePlan({ storyId: "native:test-ac1-lenses-pin", lane: "full" });
    expect(plan.lenses).toEqual(FULL_LENSES);
  });

  it("full plan passes JudgePlanSchema strict validation", () => {
    const plan = resolveJudgePlan({ storyId: "native:test-ac1-schema", lane: "full" });
    const parsed = JudgePlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
  });

  it("detector_confirmed_dead=true is ignored on full lane (full always fans out)", () => {
    const planNormal = resolveJudgePlan({ storyId: "native:test-ac1-dead-ignored", lane: "full", detector_confirmed_dead: false });
    const planDead = resolveJudgePlan({ storyId: "native:test-ac1-dead-ignored-2", lane: "full", detector_confirmed_dead: true });
    // Both must return the same full five-lens plan.
    expect(planDead).toEqual(planNormal);
    expect(planDead.skip).toBe(false);
    expect(planDead.lenses).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// AC2: fast lane + detector_confirmed_dead=false → single cheap Sonnet lens
// ---------------------------------------------------------------------------

describe("AC2: fast lane — single Structure+Verifiability Sonnet lens, no Opus", () => {
  it("lane=fast + detector_confirmed_dead=false returns skip=false with one lens", () => {
    const plan = resolveJudgePlan({
      storyId: "native:test-ac2-fast",
      lane: "fast",
      detector_confirmed_dead: false,
    });
    expect(plan.skip).toBe(false);
    expect(plan.lenses).toHaveLength(1);
    expect(plan.lenses[0]).toBe(FAST_LENS_NAME);
  });

  it("fast lane single lens is 'structure+verifiability'", () => {
    const plan = resolveJudgePlan({
      storyId: "native:test-ac2-lens-name",
      lane: "fast",
      detector_confirmed_dead: false,
    });
    expect(plan.lenses).toEqual([FAST_LENS_NAME]);
  });

  it("fast lane lens runs on Sonnet model", () => {
    const plan = resolveJudgePlan({
      storyId: "native:test-ac2-sonnet",
      lane: "fast",
      detector_confirmed_dead: false,
    });
    expect(plan.perLensModel[FAST_LENS_NAME]).toBe("sonnet");
  });

  it("fast lane spawns NO Opus lenses", () => {
    const plan = resolveJudgePlan({
      storyId: "native:test-ac2-no-opus",
      lane: "fast",
      detector_confirmed_dead: false,
    });
    const opusLenses = plan.lenses.filter((l) => plan.perLensModel[l] === "opus");
    expect(opusLenses).toHaveLength(0);
  });

  it("fast lane (absent detector_confirmed_dead) defaults to false → single lens", () => {
    const planExplicit = resolveJudgePlan({
      storyId: "native:test-ac2-explicit",
      lane: "fast",
      detector_confirmed_dead: false,
    });
    const planDefault = resolveJudgePlan({
      storyId: "native:test-ac2-default",
      lane: "fast",
      // detector_confirmed_dead absent
    });
    expect(planDefault.skip).toBe(false);
    expect(planDefault.lenses).toEqual(planExplicit.lenses);
    expect(planDefault.perLensModel).toEqual(planExplicit.perLensModel);
  });

  it("fast plan passes JudgePlanSchema strict validation", () => {
    const plan = resolveJudgePlan({
      storyId: "native:test-ac2-schema",
      lane: "fast",
      detector_confirmed_dead: false,
    });
    const parsed = JudgePlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3: fast lane + detector_confirmed_dead=true → skip=true (auto-bless)
// ---------------------------------------------------------------------------

describe("AC3: fast + detector_confirmed_dead — skip=true, auto-bless path", () => {
  it("lane=fast + detector_confirmed_dead=true returns skip=true", () => {
    const plan = resolveJudgePlan({
      storyId: "native:test-ac3-skip",
      lane: "fast",
      detector_confirmed_dead: true,
    });
    expect(plan.skip).toBe(true);
  });

  it("skip=true plan has empty lenses array", () => {
    const plan = resolveJudgePlan({
      storyId: "native:test-ac3-empty-lenses",
      lane: "fast",
      detector_confirmed_dead: true,
    });
    expect(plan.lenses).toEqual([]);
  });

  it("skip=true plan has empty perLensModel", () => {
    const plan = resolveJudgePlan({
      storyId: "native:test-ac3-empty-model",
      lane: "fast",
      detector_confirmed_dead: true,
    });
    expect(plan.perLensModel).toEqual({});
  });

  it("skip=true plan passes JudgePlanSchema strict validation", () => {
    const plan = resolveJudgePlan({
      storyId: "native:test-ac3-schema",
      lane: "fast",
      detector_confirmed_dead: true,
    });
    const parsed = JudgePlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
  });

  it("full lane + detector_confirmed_dead=true does NOT skip (full always fans out)", () => {
    const plan = resolveJudgePlan({
      storyId: "native:test-ac3-full-no-skip",
      lane: "full",
      detector_confirmed_dead: true,
    });
    expect(plan.skip).toBe(false);
    expect(plan.lenses).toHaveLength(5);
  });
});
