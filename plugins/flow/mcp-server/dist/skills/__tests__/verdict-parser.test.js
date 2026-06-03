/**
 * Unit tests for `parseVerdict` — Story 4.3 Task 8.2.
 *
 * Covers every bullet under § Verdict parser invariants in the behavioural
 * contract at:
 * `_bmad-output/implementation-artifacts/4-3-dev-reviewer-handoff-reviewer-spawn-and-rework-signal.md § Verdict parser invariants`
 *
 * All tests are pure (no IO).
 */
import { describe, expect, it } from "vitest";
import { parseVerdict, VERDICT_SENTINELS } from "../verdict-parser.js";
// ---------------------------------------------------------------------------
// Happy path — each sentinel
// ---------------------------------------------------------------------------
describe("parseVerdict — happy path", () => {
    it("READY FOR MERGE on last line → { ok: true, sentinel: 'READY FOR MERGE' }", () => {
        const transcript = `Some review content.\n**Verdict: READY FOR MERGE**`;
        expect(parseVerdict(transcript)).toEqual({
            ok: true,
            sentinel: "READY FOR MERGE",
        });
    });
    it("NEEDS CHANGES on last line → { ok: true, sentinel: 'NEEDS CHANGES' }", () => {
        const transcript = `**Verdict: NEEDS CHANGES**`;
        expect(parseVerdict(transcript)).toEqual({
            ok: true,
            sentinel: "NEEDS CHANGES",
        });
    });
    it("BLOCKED on last line → { ok: true, sentinel: 'BLOCKED' }", () => {
        const transcript = `Review done.\n**Verdict: BLOCKED**`;
        expect(parseVerdict(transcript)).toEqual({
            ok: true,
            sentinel: "BLOCKED",
        });
    });
    it("NEEDS CHANGES with bracket trailer → captures details", () => {
        const transcript = `**Verdict: NEEDS CHANGES** [2 issues, 0 questions]`;
        expect(parseVerdict(transcript)).toEqual({
            ok: true,
            sentinel: "NEEDS CHANGES",
            details: "2 issues, 0 questions",
        });
    });
    it("READY FOR MERGE with bracket trailer → captures details", () => {
        const transcript = `**Verdict: READY FOR MERGE** [lgtm]`;
        expect(parseVerdict(transcript)).toEqual({
            ok: true,
            sentinel: "READY FOR MERGE",
            details: "lgtm",
        });
    });
    it("BLOCKED with bracket trailer → captures details", () => {
        const transcript = `**Verdict: BLOCKED** [reviewer-grammar-error]`;
        expect(parseVerdict(transcript)).toEqual({
            ok: true,
            sentinel: "BLOCKED",
            details: "reviewer-grammar-error",
        });
    });
    it("bracket trailer with empty content [] → captures empty string as details", () => {
        const transcript = `**Verdict: NEEDS CHANGES** []`;
        expect(parseVerdict(transcript)).toEqual({
            ok: true,
            sentinel: "NEEDS CHANGES",
            details: "",
        });
    });
    it("bracket trailer with unicode content → captures details", () => {
        const transcript = `**Verdict: NEEDS CHANGES** [こんにちは]`;
        expect(parseVerdict(transcript)).toEqual({
            ok: true,
            sentinel: "NEEDS CHANGES",
            details: "こんにちは",
        });
    });
    it("trailing whitespace after the verdict line is tolerated", () => {
        const transcript = `**Verdict: READY FOR MERGE**   `;
        expect(parseVerdict(transcript)).toEqual({
            ok: true,
            sentinel: "READY FOR MERGE",
        });
    });
    it("trailing newlines after verdict line are tolerated (last non-empty still matches)", () => {
        const transcript = `**Verdict: NEEDS CHANGES**\n\n   \n`;
        expect(parseVerdict(transcript)).toEqual({
            ok: true,
            sentinel: "NEEDS CHANGES",
        });
    });
    it("VERDICT_SENTINELS array contains all three values", () => {
        expect(VERDICT_SENTINELS).toContain("READY FOR MERGE");
        expect(VERDICT_SENTINELS).toContain("NEEDS CHANGES");
        expect(VERDICT_SENTINELS).toContain("BLOCKED");
        expect(VERDICT_SENTINELS).toHaveLength(3);
    });
});
// ---------------------------------------------------------------------------
// Paraphrases that MUST fail (from § Verdict parser invariants)
// ---------------------------------------------------------------------------
describe("parseVerdict — paraphrases → drift or unknown-sentinel", () => {
    it("missing ** bolding → drift", () => {
        const transcript = `Verdict: READY FOR MERGE`;
        expect(parseVerdict(transcript)).toEqual({ ok: false, reason: "drift" });
    });
    it("hyphenated READY-FOR-MERGE → drift", () => {
        const transcript = `**Verdict: READY-FOR-MERGE**`;
        expect(parseVerdict(transcript)).toEqual({ ok: false, reason: "drift" });
    });
    it("lowercase sentinel → drift", () => {
        const transcript = `**Verdict: ready for merge**`;
        expect(parseVerdict(transcript)).toEqual({ ok: false, reason: "drift" });
    });
    it("unrecognised sentinel APPROVED → drift (regex fails)", () => {
        const transcript = `**Verdict: APPROVED**`;
        expect(parseVerdict(transcript)).toEqual({ ok: false, reason: "drift" });
    });
    it("only one asterisk on each side → drift", () => {
        const transcript = `*Verdict: READY FOR MERGE*`;
        expect(parseVerdict(transcript)).toEqual({ ok: false, reason: "drift" });
    });
    it("verdict embedded in prose line → drift (line anchor)", () => {
        const transcript = `My verdict: **Verdict: READY FOR MERGE** is the result.`;
        expect(parseVerdict(transcript)).toEqual({ ok: false, reason: "drift" });
    });
});
// ---------------------------------------------------------------------------
// Empty / all-whitespace transcript
// ---------------------------------------------------------------------------
describe("parseVerdict — empty / whitespace transcript → empty", () => {
    it("empty string → { ok: false, reason: 'empty' }", () => {
        expect(parseVerdict("")).toEqual({ ok: false, reason: "empty" });
    });
    it("only newlines → { ok: false, reason: 'empty' }", () => {
        expect(parseVerdict("\n\n\n")).toEqual({ ok: false, reason: "empty" });
    });
    it("only spaces → { ok: false, reason: 'empty' }", () => {
        expect(parseVerdict("   \n   ")).toEqual({ ok: false, reason: "empty" });
    });
});
// ---------------------------------------------------------------------------
// Last-line semantics
// ---------------------------------------------------------------------------
describe("parseVerdict — last-line semantics", () => {
    it("verdict sentinel mid-transcript with unrelated last line → drift", () => {
        const transcript = [
            "This looks good.",
            "**Verdict: READY FOR MERGE**",
            "Actually, wait, I have one more comment.",
        ].join("\n");
        expect(parseVerdict(transcript)).toEqual({ ok: false, reason: "drift" });
    });
    it("verdict on second-to-last line, whitespace last → matches (last non-empty)", () => {
        const transcript = `**Verdict: READY FOR MERGE**\n   `;
        expect(parseVerdict(transcript)).toEqual({
            ok: true,
            sentinel: "READY FOR MERGE",
        });
    });
});
