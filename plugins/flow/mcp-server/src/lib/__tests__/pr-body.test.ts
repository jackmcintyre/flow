/**
 * Unit tests for pr-body.ts utilities.
 * Covers: buildBranchSlug, wrapCommitBody, composeCommitSubject, composePrBody.
 * (Story 4.4 Task 3.3 / AC3b / AC3d)
 */
import { describe, expect, it } from "vitest";
import {
  buildBranchSlug,
  wrapCommitBody,
  composeCommitSubject,
  composePrBody,
} from "../pr-body.js";
import { BranchSlugUnrenderableError } from "../../errors.js";

// ---------------------------------------------------------------------------
// buildBranchSlug (AC3b fixture inputs)
// ---------------------------------------------------------------------------

describe("buildBranchSlug", () => {
  it("AC3b fixture 1: basic ref and title", () => {
    const result = buildBranchSlug({
      ref: "4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action",
      title: "Dev subagent git push and gh pr create terminal action",
    });
    // ref-slug = "4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action"
    // title-slug (raw): "dev-subagent-git-push-and-gh-pr-create-terminal-action" → trimmed to 40 chars
    const titleSlug40 = "dev-subagent-git-push-and-gh-pr-create-t";
    expect(result).toBe(
      `story/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action-${titleSlug40}`,
    );
  });

  it("AC3b fixture 2: title with punctuation, uppercase, runs of whitespace", () => {
    const result = buildBranchSlug({
      ref: "1-2-auth",
      title: "  User   Auth!! Token   Handling  ",
    });
    // title after toLower + replace non-a-z0-9 + collapse + strip = "user-auth-token-handling"
    // trimmed to 40 chars = "user-auth-token-handling" (< 40, no trim needed)
    expect(result).toBe("story/1-2-auth-user-auth-token-handling");
  });

  it("AC3b fixture 3: title with Unicode chars", () => {
    const result = buildBranchSlug({
      ref: "2-1-setup",
      title: "Setup für Ärger — résumé",
    });
    // Non-ASCII becomes hyphens → "setup-f-r-rger-r-sum-" → collapse → "setup-f-r-rger-r-sum"
    // (unicode chars replaced by single - each, then collapsed)
    expect(result).toMatch(/^story\/2-1-setup-/);
    // Must have at least one alphanumeric
    const parts = result.split("story/2-1-setup-");
    const titlePart = parts[1] ?? "";
    expect(/[a-z0-9]/.test(titlePart)).toBe(true);
  });

  it("AC3b: title slug is trimmed to 40 chars", () => {
    const longTitle =
      "This is a very very very very very long story title that exceeds forty characters";
    const result = buildBranchSlug({ ref: "1-1-x", title: longTitle });
    const afterPrefix = result.slice("story/1-1-x-".length);
    expect(afterPrefix.length).toBeLessThanOrEqual(40);
  });

  it("throws BranchSlugUnrenderableError when title has no alphanumeric after slug", () => {
    // Title of purely non-ASCII/punctuation might yield all hyphens → no alpha
    // We can fake this with a title like "---" which normalises to ""
    expect(() =>
      buildBranchSlug({ ref: "1-1-x", title: "!!!---!!!" }),
    ).toThrow(BranchSlugUnrenderableError);
  });

  it("result always starts with story/", () => {
    const result = buildBranchSlug({ ref: "4-1-claim", title: "Claim story" });
    expect(result).toMatch(/^story\//);
  });

  it("result matches ^story/[a-z0-9-]+$ for normal input", () => {
    const result = buildBranchSlug({ ref: "4-1-claim", title: "Claim story" });
    expect(result).toMatch(/^story\/[a-z0-9-]+$/);
  });
});

// ---------------------------------------------------------------------------
// wrapCommitBody (AC3d cases)
// ---------------------------------------------------------------------------

describe("wrapCommitBody", () => {
  it("leaves lines ≤72 chars unchanged", () => {
    const body = "Short line.";
    expect(wrapCommitBody(body)).toBe("Short line.");
  });

  it("AC3d: wraps a 200-char line at the nearest space before 72", () => {
    // Build a line > 72 chars with spaces at known positions
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`);
    const longLine = words.join(" ");
    expect(longLine.length).toBeGreaterThan(72);

    const result = wrapCommitBody(longLine);
    const resultLines = result.split("\n");
    for (const l of resultLines) {
      // No URL, so each output line must be ≤72 chars
      expect(l.length).toBeLessThanOrEqual(72);
    }
  });

  it("AC3d: leaves a line with a 100-char URL untouched", () => {
    const longUrl = "https://github.com/owner/repo/pull/" + "x".repeat(70);
    expect(longUrl.length).toBeGreaterThan(72);
    const result = wrapCommitBody(longUrl);
    expect(result).toBe(longUrl);
  });

  it("preserves newlines in multi-line body", () => {
    const body = "First line.\nSecond line.\nThird line.";
    const result = wrapCommitBody(body);
    expect(result).toBe("First line.\nSecond line.\nThird line.");
  });

  it("wraps multiple long lines independently", () => {
    const word = "averylongword";
    // Two lines each > 72 chars with spaces
    const line1 = Array(7).fill(word).join(" "); // 7*13 + 6 = 97 chars
    const line2 = Array(8).fill(word).join(" ");
    const body = `${line1}\n${line2}`;
    const result = wrapCommitBody(body);
    const resultLines = result.split("\n");
    // All non-URL lines must be ≤72 chars
    for (const l of resultLines) {
      if (!/https?:\/\//.test(l)) {
        expect(l.length).toBeLessThanOrEqual(72);
      }
    }
  });

  it("respects custom width", () => {
    const body = "word1 word2 word3 word4 word5 word6 word7 word8";
    const result = wrapCommitBody(body, 20);
    const lines = result.split("\n");
    for (const l of lines) {
      if (!/https?:\/\//.test(l)) {
        expect(l.length).toBeLessThanOrEqual(20);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// composeCommitSubject
// ---------------------------------------------------------------------------

describe("composeCommitSubject", () => {
  it("composes the expected format", () => {
    const result = composeCommitSubject({
      type: "feat",
      ref: "4-4-terminal-action",
      title: "Dev subagent terminal action",
    });
    expect(result).toBe("feat(4-4-terminal-action): Dev subagent terminal action");
  });
});

// ---------------------------------------------------------------------------
// composePrBody
// ---------------------------------------------------------------------------

describe("composePrBody", () => {
  it("includes the machine block anchors", () => {
    const body = composePrBody({
      ref: "4-4",
      specPath: "_bmad-output/implementation-artifacts/4-4.md",
      acs: [
        { index: 1, firstLine: "Given a finished implementation" },
        { index: 2, firstLine: "Given the dev subagent permission spec" },
      ],
      summary: "This PR implements the terminal action.",
    });
    expect(body).toContain("<!-- flow:pr:machine -->");
    expect(body).toContain("<!-- /flow:pr:machine -->");
  });

  it("includes story ref and spec path", () => {
    const body = composePrBody({
      ref: "4-4",
      specPath: "implementation-artifacts/4-4.md",
      acs: [],
      summary: "Summary",
    });
    expect(body).toContain("Story: 4-4");
    expect(body).toContain("Spec: implementation-artifacts/4-4.md");
  });

  it("includes ACs checklist with unchecked boxes", () => {
    const body = composePrBody({
      ref: "4-4",
      specPath: "spec.md",
      acs: [
        { index: 1, firstLine: "First AC" },
        { index: 3, firstLine: "Third AC" },
      ],
      summary: "Summary",
    });
    expect(body).toContain("- [ ] AC1: First AC");
    expect(body).toContain("- [ ] AC3: Third AC");
  });

  it("includes free-form summary after the machine block", () => {
    const summary = "This PR does something important.";
    const body = composePrBody({
      ref: "4-4",
      specPath: "spec.md",
      acs: [{ index: 1, firstLine: "AC text" }],
      summary,
    });
    // Summary appears after the machine block
    const machineEndIdx = body.indexOf("<!-- /flow:pr:machine -->");
    const afterMachine = body.slice(machineEndIdx);
    expect(afterMachine).toContain("\n\n");
    expect(body).toContain(summary);
  });

  // -------------------------------------------------------------------------
  // AC1: Five-section approver summary leads the PR body
  // -------------------------------------------------------------------------

  it("AC1: PR body leads with the five-section approver summary before the machine block", () => {
    const body = composePrBody({
      ref: "native:01KV05C86B",
      specPath: ".flow/native-stories/01KV05C86B.md",
      acs: [
        { index: 1, firstLine: "Given the team finishes a story", coveringCheck: "plugins/flow/mcp-server/src/lib/__tests__/pr-body.test.ts" },
        { index: 2, firstLine: "Given the PR description leads with the approver summary" },
      ],
      summary: "Extends composePrBody with a five-section approver summary.",
      title: "Lead every pull request with a plain-language approver summary",
      narrative: "As a technical but non-developer approver, I want every pull request to open with a fixed, plain-language summary.",
      riskTier: "medium",
    });

    // The five section headings must appear in order before the machine block.
    const machineIdx = body.indexOf("<!-- flow:pr:machine -->");
    const whatChangedIdx = body.indexOf("## What changed");
    const whyIdx = body.indexOf("## Why");
    const howToCheckIdx = body.indexOf("## How to check it yourself");
    const riskIdx = body.indexOf("## Risk and blast radius");
    const evidenceIdx = body.indexOf("## Evidence");

    // All five sections exist.
    expect(whatChangedIdx).toBeGreaterThanOrEqual(0);
    expect(whyIdx).toBeGreaterThanOrEqual(0);
    expect(howToCheckIdx).toBeGreaterThanOrEqual(0);
    expect(riskIdx).toBeGreaterThanOrEqual(0);
    expect(evidenceIdx).toBeGreaterThanOrEqual(0);

    // Sections appear before the machine block.
    expect(whatChangedIdx).toBeLessThan(machineIdx);
    expect(whyIdx).toBeLessThan(machineIdx);
    expect(howToCheckIdx).toBeLessThan(machineIdx);
    expect(riskIdx).toBeLessThan(machineIdx);
    expect(evidenceIdx).toBeLessThan(machineIdx);

    // Sections appear in the correct order.
    expect(whatChangedIdx).toBeLessThan(whyIdx);
    expect(whyIdx).toBeLessThan(howToCheckIdx);
    expect(howToCheckIdx).toBeLessThan(riskIdx);
    expect(riskIdx).toBeLessThan(evidenceIdx);
    expect(evidenceIdx).toBeLessThan(machineIdx);
  });

  it("AC1: PR body leads with the body starting at the first approver summary section", () => {
    const body = composePrBody({
      ref: "native:01KV05C86B",
      specPath: ".flow/native-stories/01KV05C86B.md",
      acs: [{ index: 1, firstLine: "AC text" }],
      summary: "Summary",
      title: "Story title",
      narrative: "Story narrative",
      riskTier: "low",
    });

    // Body must start with the approver summary (the first non-blank line
    // is the "## What changed" heading).
    expect(body.trimStart()).toMatch(/^## What changed/);
  });

  it("AC1: What changed section includes story title and AC summaries", () => {
    const body = composePrBody({
      ref: "4-4",
      specPath: "spec.md",
      acs: [
        { index: 1, firstLine: "First acceptance criterion" },
        { index: 2, firstLine: "Second acceptance criterion" },
      ],
      summary: "Summary",
      title: "My story title",
      narrative: "As a user I want this feature.",
    });
    expect(body).toContain("My story title");
    expect(body).toContain("First acceptance criterion");
    expect(body).toContain("Second acceptance criterion");
  });

  it("AC1: Why section includes the story narrative", () => {
    const narrative = "As a technical but non-developer approver, I want every pull request to open with a fixed summary.";
    const body = composePrBody({
      ref: "4-4",
      specPath: "spec.md",
      acs: [{ index: 1, firstLine: "AC text" }],
      summary: "Summary",
      title: "Title",
      narrative,
    });
    const whyIdx = body.indexOf("## Why");
    const howIdx = body.indexOf("## How to check it yourself");
    const whySection = body.slice(whyIdx, howIdx);
    expect(whySection).toContain(narrative);
  });

  it("AC1: Risk and blast radius section includes the risk tier", () => {
    const body = composePrBody({
      ref: "4-4",
      specPath: "spec.md",
      acs: [{ index: 1, firstLine: "AC text" }],
      summary: "Summary",
      riskTier: "medium",
    });
    const riskIdx = body.indexOf("## Risk and blast radius");
    const evidenceIdx = body.indexOf("## Evidence");
    const riskSection = body.slice(riskIdx, evidenceIdx);
    expect(riskSection).toContain("medium");
  });

  it("AC1: Evidence section maps each AC to its covering check", () => {
    const body = composePrBody({
      ref: "4-4",
      specPath: "spec.md",
      acs: [
        { index: 1, firstLine: "First AC", coveringCheck: "src/lib/__tests__/foo.test.ts" },
        { index: 2, firstLine: "Second AC", coveringCheck: "src/lib/__tests__/bar.test.ts" },
      ],
      summary: "Summary",
    });
    const evidenceIdx = body.indexOf("## Evidence");
    const machineIdx = body.indexOf("<!-- flow:pr:machine -->");
    const evidenceSection = body.slice(evidenceIdx, machineIdx);
    expect(evidenceSection).toContain("src/lib/__tests__/foo.test.ts");
    expect(evidenceSection).toContain("src/lib/__tests__/bar.test.ts");
  });

  it("AC1: Evidence section states the pre-PR build-and-test gate passed", () => {
    const body = composePrBody({
      ref: "4-4",
      specPath: "spec.md",
      acs: [{ index: 1, firstLine: "AC text" }],
      summary: "Summary",
    });
    const evidenceIdx = body.indexOf("## Evidence");
    const machineIdx = body.indexOf("<!-- flow:pr:machine -->");
    const evidenceSection = body.slice(evidenceIdx, machineIdx);
    expect(evidenceSection.toLowerCase()).toContain("build-and-test gate passed");
  });

  // -------------------------------------------------------------------------
  // AC2: Machine-readable detail block and free-form summary remain below
  // -------------------------------------------------------------------------

  it("AC2: machine-readable block travels below the approver summary", () => {
    const body = composePrBody({
      ref: "4-4",
      specPath: "spec.md",
      acs: [{ index: 1, firstLine: "AC text" }],
      summary: "Summary",
      title: "Title",
      narrative: "Narrative",
      riskTier: "low",
    });

    const evidenceIdx = body.indexOf("## Evidence");
    const machineStartIdx = body.indexOf("<!-- flow:pr:machine -->");
    const machineEndIdx = body.indexOf("<!-- /flow:pr:machine -->");

    // Machine block exists and is below the last approver section.
    expect(machineStartIdx).toBeGreaterThan(evidenceIdx);
    expect(machineEndIdx).toBeGreaterThan(machineStartIdx);
  });

  it("AC2: free-form summary travels below the machine block", () => {
    const summary = "Free-form developer summary text.";
    const body = composePrBody({
      ref: "4-4",
      specPath: "spec.md",
      acs: [{ index: 1, firstLine: "AC text" }],
      summary,
      title: "Title",
      narrative: "Narrative",
    });

    const machineEndIdx = body.indexOf("<!-- /flow:pr:machine -->");
    const summaryIdx = body.indexOf(summary);

    // Free-form summary is after the machine block.
    expect(summaryIdx).toBeGreaterThan(machineEndIdx);
  });

  it("AC2: approver summary does not remove the ACs checklist from the machine block", () => {
    const body = composePrBody({
      ref: "4-4",
      specPath: "spec.md",
      acs: [
        { index: 1, firstLine: "First AC", coveringCheck: "test.ts" },
        { index: 2, firstLine: "Second AC" },
      ],
      summary: "Summary",
      title: "Title",
      narrative: "Narrative",
    });

    // Machine block still has the unchecked AC boxes.
    const machineStartIdx = body.indexOf("<!-- flow:pr:machine -->");
    const machineEndIdx = body.indexOf("<!-- /flow:pr:machine -->");
    const machineSection = body.slice(machineStartIdx, machineEndIdx + "<!-- /flow:pr:machine -->".length);
    expect(machineSection).toContain("- [ ] AC1: First AC");
    expect(machineSection).toContain("- [ ] AC2: Second AC");
  });

  // -------------------------------------------------------------------------
  // Backward-compatibility: optional fields absent
  // -------------------------------------------------------------------------

  it("still renders all five section headings when optional fields are absent", () => {
    const body = composePrBody({
      ref: "4-4",
      specPath: "spec.md",
      acs: [{ index: 1, firstLine: "AC text" }],
      summary: "Summary",
    });
    expect(body).toContain("## What changed");
    expect(body).toContain("## Why");
    expect(body).toContain("## How to check it yourself");
    expect(body).toContain("## Risk and blast radius");
    expect(body).toContain("## Evidence");
  });
});

// ---------------------------------------------------------------------------
// composePrBody — honest acceptance criteria & verification (native:01KV4R2Q)
// ---------------------------------------------------------------------------

describe("composePrBody — honest ACs and verification (native:01KV4R2Q)", () => {
  const LONG_AC =
    "**Given** a criterion that runs to several sentences well beyond one hundred " +
    "and twenty characters, **When** the build loop opens the PR, **Then** the " +
    "approver sees the complete assertion, not a clipped first line.";

  it("AC1: renders the full criterion text in BOTH the approver summary and the machine block", () => {
    expect(LONG_AC.length).toBeGreaterThan(120);
    const body = composePrBody({
      ref: "native:01KV4R2Q",
      specPath: ".flow/native-stories/01KV4R2Q.md",
      acs: [
        {
          index: 1,
          firstLine: LONG_AC,
          coveringCheck: "src/lib/__tests__/pr-body.test.ts",
          verificationType: "vitest",
        },
      ],
      summary: "Summary",
      title: "Title",
      narrative: "Narrative",
      riskTier: "medium",
    });
    const machineIdx = body.indexOf("<!-- flow:pr:machine -->");
    // Full text appears in the approver summary (above the machine block)...
    expect(body.slice(0, machineIdx)).toContain(LONG_AC);
    // ...and verbatim in the machine block checklist.
    expect(body.slice(machineIdx)).toContain(`- [ ] AC1: ${LONG_AC}`);
  });

  it("AC2: a runnable (vitest) target gets a real Run instruction; a state-location (artifact) target shows criterion text alone with no automated-check claim", () => {
    const body = composePrBody({
      ref: "native:01KV4R2Q",
      specPath: "spec.md",
      acs: [
        {
          index: 1,
          firstLine: "Given a runnable check",
          coveringCheck: "src/lib/__tests__/foo.test.ts",
          verificationType: "vitest",
        },
        {
          index: 2,
          firstLine: "Given a state-location check",
          coveringCheck: ".flow/state/done/",
          verificationType: "artifact",
        },
      ],
      summary: "Summary",
      title: "Title",
      narrative: "Narrative",
      riskTier: "low",
    });
    const how = body.slice(
      body.indexOf("## How to check it yourself"),
      body.indexOf("## Risk and blast radius"),
    );
    // Runnable AC1 keeps a real Run instruction.
    expect(how).toContain("AC1: Run `src/lib/__tests__/foo.test.ts`");
    // Non-runnable AC2 shows the criterion text alone — never "Run `.flow/state/done/`".
    expect(how).toContain("AC2: Given a state-location check");
    expect(how).not.toContain("Run `.flow/state/done/`");
    // The old false blanket "covered by an automated check" claim is gone.
    expect(body).not.toContain("covered by an automated check");
  });

  it("AC2: Evidence labels a runnable target as an automated test and a state-location target as not", () => {
    const body = composePrBody({
      ref: "native:01KV4R2Q",
      specPath: "spec.md",
      acs: [
        { index: 1, firstLine: "Runnable", coveringCheck: "foo.test.ts", verificationType: "vitest" },
        { index: 2, firstLine: "State location", coveringCheck: ".flow/state/done/", verificationType: "artifact" },
      ],
      summary: "Summary",
    });
    const evidence = body.slice(
      body.indexOf("## Evidence"),
      body.indexOf("<!-- flow:pr:machine -->"),
    );
    expect(evidence).toContain("AC1 → `foo.test.ts` (automated test)");
    expect(evidence).toContain("AC2 → verify at `.flow/state/done/` (not an automated test)");
  });

  it("AC2: an absent verification type defaults to non-runnable (no Run instruction)", () => {
    const body = composePrBody({
      ref: "native:01KV4R2Q",
      specPath: "spec.md",
      acs: [{ index: 1, firstLine: "Given no recorded type", coveringCheck: "some/path" }],
      summary: "Summary",
    });
    const how = body.slice(
      body.indexOf("## How to check it yourself"),
      body.indexOf("## Risk and blast radius"),
    );
    expect(how).toContain("AC1: Given no recorded type");
    expect(how).not.toContain("Run `some/path`");
  });

  it("AC3: the Risk section makes no fixed blanket safety claim", () => {
    const body = composePrBody({
      ref: "native:01KV4R2Q",
      specPath: "spec.md",
      acs: [{ index: 1, firstLine: "AC text", coveringCheck: "x.test.ts", verificationType: "vitest" }],
      summary: "Summary",
      riskTier: "medium",
    });
    // The old unconditional boilerplate is gone.
    expect(body).not.toContain(
      "does not modify shared state, database schemas, or authentication paths",
    );
    // Replaced with a neutral "review the diff" framing.
    const risk = body.slice(
      body.indexOf("## Risk and blast radius"),
      body.indexOf("## Evidence"),
    );
    expect(risk.toLowerCase()).toContain("review the diff");
  });

  it("AC4: a hand-written free-form summary is passed through verbatim, unaltered", () => {
    const handWritten =
      "## My own notes\nThis section was written by hand and must survive untouched.";
    const body = composePrBody({
      ref: "native:01KV4R2Q",
      specPath: "spec.md",
      acs: [{ index: 1, firstLine: "AC text", coveringCheck: "x.test.ts", verificationType: "vitest" }],
      summary: handWritten,
    });
    expect(body).toContain(handWritten);
  });
});
