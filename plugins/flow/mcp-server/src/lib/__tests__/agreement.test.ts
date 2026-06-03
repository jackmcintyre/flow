/**
 * Unit tests for `isAgreement` — the 6-cell truth table (Story 4.10 AC1c).
 */

import { describe, it, expect } from "vitest";
import { isAgreement } from "../agreement.js";

describe("isAgreement — truth table", () => {
  it("READY FOR MERGE + merged → true", () => {
    expect(isAgreement("READY FOR MERGE", "merged")).toBe(true);
  });

  it("READY FOR MERGE + closed-unmerged → false", () => {
    expect(isAgreement("READY FOR MERGE", "closed-unmerged")).toBe(false);
  });

  it("NEEDS CHANGES + merged → false", () => {
    expect(isAgreement("NEEDS CHANGES", "merged")).toBe(false);
  });

  it("NEEDS CHANGES + closed-unmerged → true", () => {
    expect(isAgreement("NEEDS CHANGES", "closed-unmerged")).toBe(true);
  });

  it("BLOCKED + merged → false", () => {
    expect(isAgreement("BLOCKED", "merged")).toBe(false);
  });

  it("BLOCKED + closed-unmerged → true", () => {
    expect(isAgreement("BLOCKED", "closed-unmerged")).toBe(true);
  });
});
