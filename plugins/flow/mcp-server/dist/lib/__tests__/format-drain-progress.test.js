/**
 * Unit tests for `formatDrainProgress` / `formatElapsed` — Story 8.18.
 *
 * AC1: a pure helper formats the drain's per-phase progress lines. For a
 *      representative phase it produces a `start` line and a `done`-with-elapsed
 *      line, and the duration is rendered in a human-readable form. Pure and
 *      deterministic (no mutation, never throws, single line).
 * AC2: the dev-build start line carries an explicit "longest phase" marker so an
 *      operator knows a multi-minute gap there is expected, not a hang. The
 *      marker is present for dev-build and absent for the short phases.
 */
import { describe, expect, it } from "vitest";
import { formatDrainProgress, formatElapsed, LONG_PHASE_MARKER, } from "../format-drain-progress.js";
describe("formatDrainProgress", () => {
    // ── AC1 — start line + done-with-elapsed line for a representative phase ──
    it("produces a start line for a representative phase (bmad ref → local part as handle)", () => {
        // For bmad:8.18 the short handle is "8.18" (local part after the colon).
        expect(formatDrainProgress("bmad:8.18", "review", "start")).toBe("8.18 review: start");
    });
    it("produces a done line that includes the elapsed time", () => {
        const line = formatDrainProgress("bmad:8.18", "review", "done", 4200);
        expect(line).toBe("8.18 review: done in 4.2s");
        expect(line).toContain("done");
        expect(line).toContain("4.2s");
    });
    it("renders the elapsed duration in a human-readable form (start vs done differ)", () => {
        const start = formatDrainProgress("bmad:8.18", "gate", "start");
        const done = formatDrainProgress("bmad:8.18", "gate", "done", 12000);
        expect(start).not.toContain("12");
        expect(done).toContain("12.0s");
        expect(done).not.toBe(start);
    });
    it("ignores elapsedMs for a start transition (only the done line carries it)", () => {
        expect(formatDrainProgress("bmad:8.18", "review", "start", 99999)).toBe("8.18 review: start");
    });
    it("includes the short handle (not the full ref) in both the start and done lines", () => {
        // bmad ref: handle is the local part "8.18"
        expect(formatDrainProgress("bmad:8.18", "review", "start")).toContain("8.18");
        expect(formatDrainProgress("bmad:8.18", "review", "done", 1000)).toContain("8.18");
        // The full ref should NOT appear (short handle only)
        expect(formatDrainProgress("bmad:8.18", "review", "start")).not.toContain("bmad:8.18");
    });
    it("uses first-8-char ULID handle for a native ref", () => {
        const nativeRef = "native:01KT1NR9F6133VHY601SF3BD5N";
        const line = formatDrainProgress(nativeRef, "review", "start");
        // Short handle = first 8 chars of ULID = "01KT1NR9"
        expect(line).toContain("01KT1NR9");
        // The full 26-char ULID should NOT appear
        expect(line).not.toContain("01KT1NR9F6133VHY601SF3BD5N");
        // The full ref should NOT appear
        expect(line).not.toContain(nativeRef);
    });
    it("native ref done line uses short handle", () => {
        const nativeRef = "native:01KT1NR9F6133VHY601SF3BD5N";
        const line = formatDrainProgress(nativeRef, "gate", "done", 5000);
        expect(line).toBe("01KT1NR9 gate: done in 5.0s");
    });
    it("is a single line (contains no newline) for either transition", () => {
        expect(formatDrainProgress("bmad:8.18", "dev-build", "start")).not.toContain("\n");
        expect(formatDrainProgress("bmad:8.18", "dev-build", "done", 600000)).not.toContain("\n");
    });
    it("never throws for any declared phase/transition combination", () => {
        const phases = ["dev-build", "review", "gate"];
        const transitions = ["start", "done"];
        for (const p of phases) {
            for (const t of transitions) {
                expect(() => formatDrainProgress("bmad:8.18", p, t, 1234)).not.toThrow();
            }
        }
    });
    // ── AC2 — dev-build is explicitly marked the longest phase ───────────────
    it("marks the dev-build start line as the longest phase", () => {
        const line = formatDrainProgress("bmad:8.18", "dev-build", "start");
        expect(line).toContain(LONG_PHASE_MARKER);
        expect(line).toBe(`8.18 dev-build: start ${LONG_PHASE_MARKER}`);
    });
    it("does NOT mark the short phases (review, gate) as the longest phase", () => {
        expect(formatDrainProgress("bmad:8.18", "review", "start")).not.toContain(LONG_PHASE_MARKER);
        expect(formatDrainProgress("bmad:8.18", "gate", "start")).not.toContain(LONG_PHASE_MARKER);
    });
    it("does not carry the longest-phase marker on the dev-build DONE line", () => {
        // The marker is a "this will take a while" signal on entry; on the done
        // line the elapsed time speaks for itself, so the marker is not repeated.
        expect(formatDrainProgress("bmad:8.18", "dev-build", "done", 600000)).not.toContain(LONG_PHASE_MARKER);
    });
});
describe("formatElapsed", () => {
    it("renders sub-second durations in milliseconds", () => {
        expect(formatElapsed(0)).toBe("0ms");
        expect(formatElapsed(850)).toBe("850ms");
        expect(formatElapsed(999)).toBe("999ms");
    });
    it("renders seconds with one decimal below a minute", () => {
        expect(formatElapsed(1000)).toBe("1.0s");
        expect(formatElapsed(4200)).toBe("4.2s");
        expect(formatElapsed(59900)).toBe("59.9s");
    });
    it("renders minutes and seconds at or above a minute", () => {
        expect(formatElapsed(60000)).toBe("1m 0s");
        expect(formatElapsed(603000)).toBe("10m 3s");
        expect(formatElapsed(125000)).toBe("2m 5s");
    });
    it("carries a 60s rounding up into the minutes (never renders Nm 60s)", () => {
        // 1m 59.6s rounds the seconds to 60 → must roll over to 2m 0s.
        expect(formatElapsed(119600)).toBe("2m 0s");
    });
    it("clamps negative or non-finite input to zero", () => {
        expect(formatElapsed(-5)).toBe("0ms");
        expect(formatElapsed(Number.NaN)).toBe("0ms");
        expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("0ms");
    });
    it("is pure — does not depend on the wall clock and never throws", () => {
        expect(formatElapsed(4200)).toBe(formatElapsed(4200));
        expect(() => formatElapsed(123456789)).not.toThrow();
    });
});
