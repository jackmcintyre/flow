/**
 * Unit tests for `isClaimable` predicate — Story 3.6 Task 4.2.
 *
 * The predicate is pure (no I/O) and lives in `state/manifest-state-machine.ts`
 * next to the other state-machine primitives so Epic 5's claim path imports it
 * from one place.
 *
 * Four deterministic cases per AC4 branch (h).
 */

import { describe, expect, it } from "vitest";
import type { ExecutionManifest } from "../src/schemas/execution-manifest.js";
import { isClaimable } from "../src/state/manifest-state-machine.js";

/** Minimal valid manifest fixture. Only status and withdrawn vary per test. */
function makeManifest(overrides: { status: ExecutionManifest["status"]; withdrawn: boolean }): ExecutionManifest {
  return {
    ref: "bmad:1.1",
    status: overrides.status,
    adapter: "bmad",
    source_path: "stories/1-1-test.md",
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "AC text", kind: "integration" }],
    title: "Test story",
    narrative: "As a user I want this so that it works.",
    withdrawn: overrides.withdrawn,
  };
}

describe("isClaimable — Story 3.6 Task 4.2 unit tests", () => {
  it("returns true when withdrawn:false and status:to-do", () => {
    const manifest = makeManifest({ status: "to-do", withdrawn: false });
    expect(isClaimable(manifest)).toBe(true);
  });

  it("returns false when withdrawn:true and status:to-do", () => {
    const manifest = makeManifest({ status: "to-do", withdrawn: true });
    expect(isClaimable(manifest)).toBe(false);
  });

  it("returns false when withdrawn:false and status:blocked", () => {
    const manifest = makeManifest({ status: "blocked", withdrawn: false });
    expect(isClaimable(manifest)).toBe(false);
  });

  it("returns false when withdrawn:true and status:blocked", () => {
    const manifest = makeManifest({ status: "blocked", withdrawn: true });
    expect(isClaimable(manifest)).toBe(false);
  });
});
