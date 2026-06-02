/**
 * Unit tests for pr-body.ts utilities.
 * Covers: buildBranchSlug, wrapCommitBody, composeCommitSubject, composePrBody.
 * (Story 4.4 Task 3.3 / AC3b / AC3d)
 */
import { describe, expect, it } from "vitest";
import { buildBranchSlug, wrapCommitBody, composeCommitSubject, composePrBody, } from "../pr-body.js";
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
        expect(result).toBe(`story/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action-${titleSlug40}`);
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
        const longTitle = "This is a very very very very very long story title that exceeds forty characters";
        const result = buildBranchSlug({ ref: "1-1-x", title: longTitle });
        const afterPrefix = result.slice("story/1-1-x-".length);
        expect(afterPrefix.length).toBeLessThanOrEqual(40);
    });
    it("throws BranchSlugUnrenderableError when title has no alphanumeric after slug", () => {
        // Title of purely non-ASCII/punctuation might yield all hyphens → no alpha
        // We can fake this with a title like "---" which normalises to ""
        expect(() => buildBranchSlug({ ref: "1-1-x", title: "!!!---!!!" })).toThrow(BranchSlugUnrenderableError);
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
        expect(body).toContain("<!-- crew:pr:machine -->");
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
    it("includes free-form summary after blank line separator", () => {
        const summary = "This PR does something important.";
        const body = composePrBody({
            ref: "4-4",
            specPath: "spec.md",
            acs: [{ index: 1, firstLine: "AC text" }],
            summary,
        });
        // Summary appears after a blank line following the machine block
        const machineEndIdx = body.indexOf("<!-- /flow:pr:machine -->");
        const afterMachine = body.slice(machineEndIdx);
        expect(afterMachine).toContain("\n\n");
        expect(body).toContain(summary);
    });
});
