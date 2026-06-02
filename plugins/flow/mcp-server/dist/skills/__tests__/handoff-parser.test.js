/**
 * Unit tests for `parseHandoff` — Story 4.3 Task 8.1.
 *
 * Covers every bullet under § Handoff parser invariants in the behavioural
 * contract at:
 * `_bmad-output/implementation-artifacts/4-3-dev-reviewer-handoff-reviewer-spawn-and-rework-signal.md § Handoff parser invariants`
 *
 * All tests are pure (no IO).
 */
import { describe, expect, it } from "vitest";
import { parseHandoff, HANDOFF_PHRASE_TEMPLATE } from "../handoff-parser.js";
const STORY_REF = "01J9P0K2N3MZX0YV4S5RTQ4ABC";
const EXPECTED_PHRASE = `Handoff to reviewer — story ${STORY_REF} ready for review.`;
// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe("parseHandoff — happy path", () => {
    it("exact phrase, exact ref on last non-empty line → { ok: true }", () => {
        const transcript = `Some work was done.\n${EXPECTED_PHRASE}`;
        expect(parseHandoff(transcript, STORY_REF)).toEqual({ ok: true });
    });
    it("phrase is the only line → { ok: true }", () => {
        expect(parseHandoff(EXPECTED_PHRASE, STORY_REF)).toEqual({ ok: true });
    });
    it("trailing newlines after the phrase are tolerated (last non-empty line still matches)", () => {
        const transcript = `${EXPECTED_PHRASE}\n\n   \n`;
        expect(parseHandoff(transcript, STORY_REF)).toEqual({ ok: true });
    });
    it("trailing whitespace on the handoff line is trimmed before comparison", () => {
        const transcript = `${EXPECTED_PHRASE}   `;
        expect(parseHandoff(transcript, STORY_REF)).toEqual({ ok: true });
    });
    it("multi-line transcript ending with the exact phrase → { ok: true }", () => {
        const transcript = [
            "Line one",
            "Line two",
            "Line three",
            EXPECTED_PHRASE,
        ].join("\n");
        expect(parseHandoff(transcript, STORY_REF)).toEqual({ ok: true });
    });
});
// ---------------------------------------------------------------------------
// Paraphrases that MUST fail (from § Handoff parser invariants)
// ---------------------------------------------------------------------------
describe("parseHandoff — paraphrases → drift", () => {
    it('extra "the" before reviewer → drift', () => {
        const drift = `Handoff to the reviewer — story ${STORY_REF} ready for review.`;
        expect(parseHandoff(drift, STORY_REF)).toEqual({ ok: false, reason: "drift" });
    });
    it("en-dash instead of em-dash → drift", () => {
        const drift = `Handoff to reviewer – story ${STORY_REF} ready for review.`;
        expect(parseHandoff(drift, STORY_REF)).toEqual({ ok: false, reason: "drift" });
    });
    it("hyphen instead of em-dash → drift", () => {
        const drift = `Handoff to reviewer - story ${STORY_REF} ready for review.`;
        expect(parseHandoff(drift, STORY_REF)).toEqual({ ok: false, reason: "drift" });
    });
    it("exclamation mark instead of period → drift", () => {
        const drift = `Handoff to reviewer — story ${STORY_REF} ready for review!`;
        expect(parseHandoff(drift, STORY_REF)).toEqual({ ok: false, reason: "drift" });
    });
    it("lowercase first word → drift", () => {
        const drift = `handoff to reviewer — story ${STORY_REF} ready for review.`;
        expect(parseHandoff(drift, STORY_REF)).toEqual({ ok: false, reason: "drift" });
    });
    it("literal <story-id> placeholder NOT substituted → drift", () => {
        // The unsubstituted template itself is one flavour of drift.
        const drift = HANDOFF_PHRASE_TEMPLATE;
        expect(parseHandoff(drift, STORY_REF)).toEqual({ ok: false, reason: "drift" });
    });
    it("wrong ref in the phrase → drift", () => {
        const wrongRef = "01DIFFERENTREF0000000000001";
        const drift = `Handoff to reviewer — story ${wrongRef} ready for review.`;
        expect(parseHandoff(drift, STORY_REF)).toEqual({ ok: false, reason: "drift" });
    });
    it("phrase with an extra word appended → drift", () => {
        const drift = `${EXPECTED_PHRASE} Thanks!`;
        expect(parseHandoff(drift, STORY_REF)).toEqual({ ok: false, reason: "drift" });
    });
});
// ---------------------------------------------------------------------------
// Empty / all-whitespace transcript
// ---------------------------------------------------------------------------
describe("parseHandoff — empty / whitespace transcript → empty", () => {
    it("empty string → { ok: false, reason: 'empty' }", () => {
        expect(parseHandoff("", STORY_REF)).toEqual({ ok: false, reason: "empty" });
    });
    it("only newlines → { ok: false, reason: 'empty' }", () => {
        expect(parseHandoff("\n\n\n", STORY_REF)).toEqual({ ok: false, reason: "empty" });
    });
    it("only spaces → { ok: false, reason: 'empty' }", () => {
        expect(parseHandoff("   \n   ", STORY_REF)).toEqual({ ok: false, reason: "empty" });
    });
});
// ---------------------------------------------------------------------------
// Last-line semantics
// ---------------------------------------------------------------------------
describe("parseHandoff — last-line semantics", () => {
    it("handoff phrase appears mid-transcript but last line is different → drift", () => {
        const transcript = [
            "Starting work.",
            EXPECTED_PHRASE,
            "Actually, wait — one more thing.",
        ].join("\n");
        expect(parseHandoff(transcript, STORY_REF)).toEqual({ ok: false, reason: "drift" });
    });
    it("handoff phrase appears on multiple lines but last non-empty is different → drift", () => {
        const transcript = [
            EXPECTED_PHRASE,
            EXPECTED_PHRASE,
            "See you on the other side.",
        ].join("\n");
        expect(parseHandoff(transcript, STORY_REF)).toEqual({ ok: false, reason: "drift" });
    });
});
