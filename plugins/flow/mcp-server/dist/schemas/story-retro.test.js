/**
 * Schema tests for `StructuredLessonSchema` — Story native:01KT6Q8PSDZQKM57VFRHFJ3RP4.
 *
 * AC3 (unit): a structured lesson entry with kind pitfall and a missing
 *   failure_class field fails validation — matching the existing LessonSchema
 *   contract that failure_class is required when kind is "pitfall".
 *
 * Also covers:
 *   - Happy-path round-trips for each LESSON_KIND.
 *   - Required-field rejections (id, kind, applies_when, detail, learned_at).
 *   - Unknown-key rejection (.strict()).
 *   - The pitfall+failure_class contract (AC3).
 */
import { describe, expect, it } from "vitest";
import { LESSON_KINDS, LessonSchema, StructuredLessonSchema, } from "./story-retro.js";
// ---------------------------------------------------------------------------
// Constants / fixtures
// ---------------------------------------------------------------------------
// Real ULIDs are 26 chars in Crockford base32 (A–Z 0–9 minus I L O U).
const ULID = "01HZRETR0000000000000000A1";
const ISO = "2026-06-04T12:00:00.000Z";
const VALID_PATTERN = {
    id: ULID,
    kind: "pattern",
    applies_when: "When opening a PR after completing story work",
    detail: "Always run the full build and test suite green before opening the PR.",
    learned_at: ISO,
};
const VALID_PITFALL = {
    id: ULID,
    kind: "pitfall",
    applies_when: "When rebasing a story branch",
    detail: "Run git fetch before rebasing to avoid silently dropping sibling commits.",
    failure_class: "stale-rebase-base",
    learned_at: ISO,
};
// ---------------------------------------------------------------------------
// Happy-path round-trips
// ---------------------------------------------------------------------------
describe("StructuredLessonSchema — happy-path round-trips", () => {
    for (const kind of LESSON_KINDS) {
        it(`parses a valid lesson with kind="${kind}"`, () => {
            const input = {
                ...VALID_PATTERN,
                kind,
                // pitfall requires failure_class
                ...(kind === "pitfall" ? { failure_class: "some-failure" } : {}),
            };
            const result = StructuredLessonSchema.safeParse(input);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.kind).toBe(kind);
            }
        });
    }
    it("parses a lesson with optional source_ref", () => {
        const result = StructuredLessonSchema.safeParse({
            ...VALID_PATTERN,
            source_ref: "native:01KT6Q8PSDZQKM57VFRHFJ3RP4",
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.source_ref).toBe("native:01KT6Q8PSDZQKM57VFRHFJ3RP4");
        }
    });
    it("parses a lesson with optional source_pr", () => {
        const result = StructuredLessonSchema.safeParse({
            ...VALID_PATTERN,
            source_pr: "https://github.com/jackmcintyre/crew/pull/286",
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.source_pr).toBe("https://github.com/jackmcintyre/crew/pull/286");
        }
    });
    it("parses a pitfall with failure_class (valid pitfall)", () => {
        const result = StructuredLessonSchema.safeParse(VALID_PITFALL);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.kind).toBe("pitfall");
            expect(result.data.failure_class).toBe("stale-rebase-base");
        }
    });
});
// ---------------------------------------------------------------------------
// AC3 — pitfall without failure_class MUST fail validation
// ---------------------------------------------------------------------------
describe("AC3 — pitfall without failure_class fails validation (LessonSchema contract)", () => {
    it("StructuredLessonSchema rejects a pitfall with a missing failure_class", () => {
        const { failure_class: _omit, ...withoutFailureClass } = VALID_PITFALL;
        void _omit;
        const result = StructuredLessonSchema.safeParse(withoutFailureClass);
        expect(result.success).toBe(false);
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join("."));
            expect(paths).toContain("failure_class");
        }
    });
    it("the error message names failure_class as the offending path", () => {
        const { failure_class: _omit, ...withoutFailureClass } = VALID_PITFALL;
        void _omit;
        const result = StructuredLessonSchema.safeParse(withoutFailureClass);
        expect(result.success).toBe(false);
        if (!result.success) {
            const issue = result.error.issues.find((i) => i.path.join(".") === "failure_class");
            expect(issue).toBeDefined();
            expect(issue.message).toMatch(/required.*pitfall|pitfall.*required/i);
        }
    });
    it("a pattern lesson with no failure_class is accepted (failure_class is only required for pitfall)", () => {
        // This test is the mirror of AC3: failure_class is NOT required for non-pitfall kinds.
        const result = StructuredLessonSchema.safeParse({
            ...VALID_PATTERN,
            kind: "pattern",
            // Deliberately no failure_class.
        });
        expect(result.success).toBe(true);
    });
    it("LessonSchema (existing contract) also rejects pitfall without failure_class — the contracts are aligned", () => {
        // AC3 explicitly says the StructuredLessonSchema matches the existing
        // LessonSchema contract. Assert both reject the same invalid input.
        const invalidPitfall = {
            kind: "pitfall",
            text: "some pitfall lesson",
            // missing failure_class
        };
        const lessonResult = LessonSchema.safeParse(invalidPitfall);
        expect(lessonResult.success).toBe(false);
        const structuredResult = StructuredLessonSchema.safeParse({
            id: ULID,
            kind: "pitfall",
            applies_when: "some condition",
            detail: "some pitfall lesson",
            learned_at: ISO,
            // missing failure_class
        });
        expect(structuredResult.success).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// Required-field rejections
// ---------------------------------------------------------------------------
describe("StructuredLessonSchema — required field rejections", () => {
    it("rejects a lesson missing id", () => {
        const { id: _omit, ...rest } = VALID_PATTERN;
        void _omit;
        expect(StructuredLessonSchema.safeParse(rest).success).toBe(false);
    });
    it("rejects a lesson with a malformed id (not a ULID)", () => {
        expect(StructuredLessonSchema.safeParse({ ...VALID_PATTERN, id: "not-a-ulid" }).success).toBe(false);
    });
    it("rejects a lesson missing kind", () => {
        const { kind: _omit, ...rest } = VALID_PATTERN;
        void _omit;
        expect(StructuredLessonSchema.safeParse(rest).success).toBe(false);
    });
    it("rejects a lesson with an unknown kind", () => {
        expect(StructuredLessonSchema.safeParse({ ...VALID_PATTERN, kind: "advice" }).success).toBe(false);
    });
    it("rejects a lesson missing applies_when", () => {
        const { applies_when: _omit, ...rest } = VALID_PATTERN;
        void _omit;
        expect(StructuredLessonSchema.safeParse(rest).success).toBe(false);
    });
    it("rejects a lesson with an empty applies_when", () => {
        expect(StructuredLessonSchema.safeParse({ ...VALID_PATTERN, applies_when: "" }).success).toBe(false);
    });
    it("rejects a lesson missing detail", () => {
        const { detail: _omit, ...rest } = VALID_PATTERN;
        void _omit;
        expect(StructuredLessonSchema.safeParse(rest).success).toBe(false);
    });
    it("rejects a lesson missing learned_at", () => {
        const { learned_at: _omit, ...rest } = VALID_PATTERN;
        void _omit;
        expect(StructuredLessonSchema.safeParse(rest).success).toBe(false);
    });
    it("rejects a lesson with a non-UTC learned_at (offset form)", () => {
        expect(StructuredLessonSchema.safeParse({
            ...VALID_PATTERN,
            learned_at: "2026-06-04T12:00:00+02:00",
        }).success).toBe(false);
    });
    it("rejects unknown top-level keys (.strict())", () => {
        expect(StructuredLessonSchema.safeParse({
            ...VALID_PATTERN,
            extra_field: "not allowed",
        }).success).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// StructuredLesson type is the inferred z.infer<typeof StructuredLessonSchema>
// (static shape check — caught at compile time, not runtime)
// ---------------------------------------------------------------------------
describe("StructuredLesson type — structural invariants", () => {
    it("LESSON_KINDS is the same closed enum reused by StructuredLessonSchema", () => {
        // The schema reuses LESSON_KINDS from LessonSchema; any addition to
        // LESSON_KINDS automatically extends StructuredLessonSchema too.
        for (const kind of LESSON_KINDS) {
            const result = StructuredLessonSchema.safeParse({
                ...VALID_PATTERN,
                kind,
                ...(kind === "pitfall" ? { failure_class: "some-failure" } : {}),
            });
            expect(result.success, `kind "${kind}" should be valid`).toBe(true);
        }
    });
});
