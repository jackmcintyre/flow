/**
 * Unit tests for `compose-reviewer-summary.ts` — Story 4.6b Task 3.3.
 *
 * Tests every branch of `composeVerdictLine` (one test per closed-table row,
 * plus the UnreachableBlockedReasonError path) and `composeSummaryBody`
 * (structural assertions on section headings, per-AC formatting, standards,
 * manual-checks section).
 */

import { describe, expect, it } from "vitest";
import { composeVerdictLine, composeSummaryBody } from "../compose-reviewer-summary.js";
import type { ComposeSummaryBodyVersionInfo } from "../compose-reviewer-summary.js";
import { UnreachableBlockedReasonError } from "../../errors.js";
import type { ReviewerResultFileShape } from "../read-reviewer-result-file.js";
import type { AcResult } from "../../tools/run-reviewer-session.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_REF = "native:01J9TEST0000000000000000000";

const BASE_VERSION_INFO: ComposeSummaryBodyVersionInfo = {
  standardsVersion: "1.2.3",
  pluginVersion: "0.1.0",
};

function makeArtifactPass(index: number): AcResult {
  return {
    index,
    tag: null,
    applicability: "runnable-artifact-check",
    artifactPath: `artifact-${index}.txt`,
    status: "pass",
    reason: `artifact-${index}.txt exists`,
  };
}

function makeArtifactFail(index: number): AcResult {
  return {
    index,
    tag: null,
    applicability: "runnable-artifact-check",
    artifactPath: `missing-${index}.txt`,
    status: "fail",
    reason: `artifact: missing-${index}.txt — ENOENT`,
  };
}

function makeManualCheck(index: number): AcResult {
  return {
    index,
    tag: null,
    applicability: "manual-check-required",
    reason: `Operator must verify AC${index} manually.`,
  };
}

function makeResultFile(
  verdict: "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED",
  acResults: Record<number, AcResult> = {},
  standards: Record<string, { name: string; what: string }> = {},
  standardsVersion = "1.2.3",
): ReviewerResultFileShape {
  return {
    sessionUlid: "01HZTEST00000000SESSION",
    ref: BASE_REF,
    recommendedVerdict: verdict,
    acResults,
    standardsByCriterionId: standards as ReviewerResultFileShape["standardsByCriterionId"],
    sourceStoryRef: BASE_REF,
    prNumber: 42,
    standardsVersion,
  };
}

// ---------------------------------------------------------------------------
// composeVerdictLine tests
// ---------------------------------------------------------------------------

describe("composeVerdictLine", () => {
  it('READY FOR MERGE → exact string **Verdict: READY FOR MERGE**', () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) });
    expect(composeVerdictLine(result)).toBe("**Verdict: READY FOR MERGE**");
  });

  it("NEEDS CHANGES with 1 failing, 0 manual → [1 issues, 0 questions]", () => {
    const result = makeResultFile("NEEDS CHANGES", { 1: makeArtifactFail(1) });
    expect(composeVerdictLine(result)).toBe("**Verdict: NEEDS CHANGES** [1 issues, 0 questions]");
  });

  it("NEEDS CHANGES with 2 failing, 0 manual → [2 issues, 0 questions]", () => {
    const result = makeResultFile("NEEDS CHANGES", {
      1: makeArtifactFail(1),
      2: makeArtifactFail(2),
    });
    expect(composeVerdictLine(result)).toBe("**Verdict: NEEDS CHANGES** [2 issues, 0 questions]");
  });

  it("NEEDS CHANGES with 0 failing, 1 manual → [0 issues, 1 questions]", () => {
    // NEEDS CHANGES with a manual-check-required entry (unusual but valid if any AC also failed)
    const result = makeResultFile("NEEDS CHANGES", {
      1: makeArtifactFail(1),
      2: makeManualCheck(2),
    });
    expect(composeVerdictLine(result)).toBe("**Verdict: NEEDS CHANGES** [1 issues, 1 questions]");
  });

  it("BLOCKED with empty acResults → [no ACs declared]", () => {
    const result = makeResultFile("BLOCKED", {});
    expect(composeVerdictLine(result)).toBe("**Verdict: BLOCKED** [no ACs declared]");
  });

  it("BLOCKED with manual-check-required AC → [manual checks required]", () => {
    const result = makeResultFile("BLOCKED", { 1: makeManualCheck(1) });
    expect(composeVerdictLine(result)).toBe("**Verdict: BLOCKED** [manual checks required]");
  });

  it("BLOCKED with non-empty acResults and no manual-check-required → throws UnreachableBlockedReasonError", () => {
    // This is the out-of-band-mutation path — BLOCKED but with only passing ACs.
    const result = makeResultFile("BLOCKED", { 1: makeArtifactPass(1) });
    expect(() => composeVerdictLine(result)).toThrow(UnreachableBlockedReasonError);
  });
});

// ---------------------------------------------------------------------------
// composeSummaryBody tests
// ---------------------------------------------------------------------------

describe("composeSummaryBody", () => {
  it("READY FOR MERGE with pass ACs — footer marker is absolute last line", () => {
    const result = makeResultFile("READY FOR MERGE", {
      1: makeArtifactPass(1),
      2: makeArtifactPass(2),
    });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    const lines = body.split("\n");
    expect(lines.at(-1)).toBe(`<!-- crew:verdict:${BASE_VERSION_INFO.pluginVersion}:${BASE_REF} -->`);
  });

  it("READY FOR MERGE with pass ACs — verdict line appears before version line and footer", () => {
    const result = makeResultFile("READY FOR MERGE", {
      1: makeArtifactPass(1),
      2: makeArtifactPass(2),
    });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    const verdictPos = body.indexOf("**Verdict: READY FOR MERGE**");
    const versionPos = body.indexOf("`standards_version:");
    const footerPos = body.indexOf("<!-- crew:verdict:");
    expect(verdictPos).toBeGreaterThan(-1);
    expect(verdictPos).toBeLessThan(versionPos);
    expect(versionPos).toBeLessThan(footerPos);
  });

  it("NEEDS CHANGES with failing AC — footer marker is absolute last line", () => {
    const result = makeResultFile("NEEDS CHANGES", { 1: makeArtifactFail(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    const lines = body.split("\n");
    expect(lines.at(-1)).toBe(`<!-- crew:verdict:${BASE_VERSION_INFO.pluginVersion}:${BASE_REF} -->`);
  });

  it("NEEDS CHANGES with failing AC — verdict line contains expected text", () => {
    const result = makeResultFile("NEEDS CHANGES", { 1: makeArtifactFail(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("**Verdict: NEEDS CHANGES** [1 issues, 0 questions]");
  });

  it("body has # Reviewer summary heading with the ref", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain(`# Reviewer summary — ${BASE_REF}`);
  });

  it("body has ## Acceptance criteria section heading", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("## Acceptance criteria");
  });

  it("body has ## Standards check section heading", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("## Standards check");
  });

  it("no ACs → AC section emits '_No ACs declared in the source story.'", () => {
    const result = makeResultFile("BLOCKED", {});
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("_No ACs declared in the source story._");
  });

  it("no standards criteria → emits '_No standards criteria declared.'", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) }, {});
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("_No standards criteria declared._");
  });

  it("with standards criteria → emits each criterion name and what", () => {
    const standards = {
      "story-aligned": { name: "story-aligned", what: "Maps ACs to diff hunks." },
    };
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) }, standards);
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("story-aligned");
    expect(body).toContain("Maps ACs to diff hunks.");
  });

  it("no manual-check-required ACs → no 'Manual checks' section", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).not.toContain("## Manual checks required before merge");
  });

  it("with manual-check-required ACs → emits '## Manual checks required before merge' section", () => {
    const result = makeResultFile("BLOCKED", { 1: makeManualCheck(1), 2: makeManualCheck(2) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("## Manual checks required before merge");
    expect(body).toContain("AC1: Operator must verify AC1 manually.");
    expect(body).toContain("AC2: Operator must verify AC2 manually.");
  });

  it("passing AC → ✅ emoji", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("✅");
  });

  it("failing AC → ❌ emoji", () => {
    const result = makeResultFile("NEEDS CHANGES", { 1: makeArtifactFail(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("❌");
  });

  it("manual-check-required AC → ⚠️ emoji", () => {
    const result = makeResultFile("BLOCKED", { 1: makeManualCheck(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("⚠️");
  });

  it("ACs emitted in numeric-index order", () => {
    const result = makeResultFile("NEEDS CHANGES", {
      3: makeArtifactFail(3),
      1: makeArtifactPass(1),
      2: makeArtifactPass(2),
    });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    const ac1Pos = body.indexOf("**AC1**");
    const ac2Pos = body.indexOf("**AC2**");
    const ac3Pos = body.indexOf("**AC3**");
    expect(ac1Pos).toBeLessThan(ac2Pos);
    expect(ac2Pos).toBeLessThan(ac3Pos);
  });

  it("BLOCKED with no ACs — verdict line is in body and footer marker is last", () => {
    const result = makeResultFile("BLOCKED", {});
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("**Verdict: BLOCKED** [no ACs declared]");
    const lines = body.split("\n");
    expect(lines.at(-1)).toBe(`<!-- crew:verdict:${BASE_VERSION_INFO.pluginVersion}:${BASE_REF} -->`);
  });

  it("BLOCKED with manual-check-required — verdict line is in body and footer marker is last", () => {
    const result = makeResultFile("BLOCKED", { 1: makeManualCheck(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("**Verdict: BLOCKED** [manual checks required]");
    const lines = body.split("\n");
    expect(lines.at(-1)).toBe(`<!-- crew:verdict:${BASE_VERSION_INFO.pluginVersion}:${BASE_REF} -->`);
  });

  // ---------------------------------------------------------------------------
  // Story 4.7: Version block and footer marker tests
  // ---------------------------------------------------------------------------

  it("version line contains standards_version and plugin_version literal tokens", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain("standards_version:");
    expect(body).toContain("plugin_version:");
  });

  it("version line appears verbatim with backtick code-spans and middle-dot separator", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain(
      "`standards_version: 1.2.3` · `plugin_version: 0.1.0`",
    );
  });

  it("footer marker is absolute last line (split-and-at check)", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body.split("\n").at(-1)).toBe(
      `<!-- crew:verdict:${BASE_VERSION_INFO.pluginVersion}:${BASE_REF} -->`,
    );
  });

  it("footer marker ref matches result.ref verbatim", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    expect(body).toContain(`<!-- crew:verdict:0.1.0:${BASE_REF} -->`);
  });

  it("empty standardsVersion renders (unknown) in version line", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) }, {}, "");
    const body = composeSummaryBody(result, { standardsVersion: "", pluginVersion: "0.1.0" });
    expect(body).toContain("`standards_version: (unknown)`");
  });

  it("verdict line position < version line position < footer marker position", () => {
    const result = makeResultFile("READY FOR MERGE", { 1: makeArtifactPass(1) });
    const body = composeSummaryBody(result, BASE_VERSION_INFO);
    const verdictPos = body.indexOf("**Verdict:");
    const versionPos = body.indexOf("`standards_version:");
    const footerPos = body.indexOf("<!-- crew:verdict:");
    expect(verdictPos).toBeLessThan(versionPos);
    expect(versionPos).toBeLessThan(footerPos);
  });
});
