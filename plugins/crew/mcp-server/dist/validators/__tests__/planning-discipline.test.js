/**
 * Unit tests for `validators/planning-discipline.ts` (Story 3.5 Task 1.7).
 *
 * All tests are pure — no I/O, no fixtures on disk. `SourceStory` objects
 * are constructed inline.
 */
import { describe, it, expect } from "vitest";
import { validateStoryAgainstDiscipline, validateBacklogAgainstDiscipline, isEnrichedStory, STATE_MUTATING_GLOBS, STATE_MUTATING_TOKEN_RE, } from "../planning-discipline.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Build a Tier-0-COMPLIANT native story by default. Story 10.3 added the pure
 * T0-2 (every AC has a `verification` block) and T0-1 (every task maps to a real
 * AC) checks, gated to native/enriched stories (`native:` ref). The default
 * therefore carries a verification block and one task so a story with no
 * intended violation still passes — individual tests override `acceptance_criteria`
 * / `tasks` to exercise a specific failure.
 *
 * The legacy state-mutating / implicit-depends-on tests pass `ref: "bmad:…"`
 * (or rely on the absent-fields gate) where they want the new checks NOT to
 * fire; tests that exercise the new checks keep the `native:` ref.
 */
function makeStory(overrides = {}) {
    return {
        ref: "native:TESTULIDPLACEHOLDERX01",
        title: "Test story",
        narrative: "As a user, I want something, so that I am happy.",
        acceptance_criteria: [
            {
                text: "Given ... When ... Then ...",
                kind: "unit",
                verification: { type: "vitest", target: "src/__tests__/x.test.ts" },
            },
        ],
        tasks: [{ text: "Do the thing", ac_refs: ["AC1"] }],
        depends_on: [],
        implementation_notes: undefined,
        raw_path: "/fake/path/story.md",
        raw_frontmatter: {},
        source_hash: "a".repeat(64),
        ...overrides,
    };
}
// ---------------------------------------------------------------------------
// STATE_MUTATING_GLOBS / STATE_MUTATING_TOKEN_RE constants
// ---------------------------------------------------------------------------
describe("STATE_MUTATING_GLOBS and STATE_MUTATING_TOKEN_RE are exported constants", () => {
    it("STATE_MUTATING_GLOBS is a non-empty readonly array", () => {
        expect(Array.isArray(STATE_MUTATING_GLOBS)).toBe(true);
        expect(STATE_MUTATING_GLOBS.length).toBeGreaterThan(0);
    });
    it("STATE_MUTATING_TOKEN_RE is a RegExp", () => {
        expect(STATE_MUTATING_TOKEN_RE).toBeInstanceOf(RegExp);
    });
});
// ---------------------------------------------------------------------------
// State-mutating heuristic — positive cases
// ---------------------------------------------------------------------------
describe("validateStoryAgainstDiscipline — state-mutating heuristic positive cases", () => {
    it("detects 'writes state' in implementation_notes via verb+object pattern", () => {
        const story = makeStory({
            implementation_notes: "This tool writes state to disk.",
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({ kind: "discipline-violation" });
        expect(result.kind).toBe("discipline-violation");
    });
    it("detects 'mutates manifest' in narrative via verb+object pattern", () => {
        const story = makeStory({
            narrative: "This story mutates manifest files for the sprint.",
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({ kind: "discipline-violation" });
    });
    it("detects 'scan-sources.ts' path token in implementation_notes", () => {
        const story = makeStory({
            implementation_notes: "Edit scan-sources.ts to add the blocked path.",
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({ kind: "discipline-violation" });
    });
    it("detects '.crew/state/** style path token in implementation_notes", () => {
        const story = makeStory({
            implementation_notes: "Writes to .crew/state/to-do/some-ref.yaml.",
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({ kind: "discipline-violation" });
    });
    it("detects 'sprint-status.yaml' path token in implementation_notes", () => {
        const story = makeStory({
            implementation_notes: "Updates sprint-status.yaml.",
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({ kind: "discipline-violation" });
    });
    it("detects 'write-native-story.ts' in implementation_notes", () => {
        const story = makeStory({
            implementation_notes: "Extends write-native-story.ts.",
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({ kind: "discipline-violation" });
    });
    it("detects 'persists backlog' in AC text", () => {
        const story = makeStory({
            acceptance_criteria: [
                { text: "When the tool persists backlog to disk, the file is written.", kind: "unit" },
            ],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({ kind: "discipline-violation" });
    });
});
// ---------------------------------------------------------------------------
// State-mutating heuristic — negative cases
// ---------------------------------------------------------------------------
describe("validateStoryAgainstDiscipline — state-mutating heuristic negative cases", () => {
    it("pure-doc story with no trigger tokens passes", () => {
        const story = makeStory({
            narrative: "As a reader, I want clear documentation.",
            implementation_notes: "Update the README introduction paragraph.",
            // Carry a verification block so the Story 10.3 T0-2 check (native stories)
            // does not fire — this test isolates the legacy state-mutating heuristic.
            acceptance_criteria: [
                {
                    text: "The docs are readable.",
                    kind: "unit",
                    verification: { type: "vitest", target: "src/__tests__/docs.test.ts" },
                },
            ],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toBe(story); // pass = original object returned
    });
    it("prose mentioning 'state machine' without the verb pattern does NOT trigger", () => {
        const story = makeStory({
            narrative: "As a user I want the state machine diagram in the docs.",
        });
        const result = validateStoryAgainstDiscipline(story);
        // "state machine" does NOT match "\b(mutates?|writes?|...) (state|...)\b"
        // and "state machine" does not match the path globs
        expect(result).toBe(story);
    });
    it("story about 'status page' without mutation verbs passes", () => {
        const story = makeStory({
            narrative: "As an operator I want a status page that shows my sprint.",
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toBe(story);
    });
});
// ---------------------------------------------------------------------------
// Missing-integration-AC check
// ---------------------------------------------------------------------------
describe("validateStoryAgainstDiscipline — missing-integration-AC detection", () => {
    it("state-mutating story without integration AC fails with missing-integration-ac", () => {
        const story = makeStory({
            implementation_notes: "Edit scan-sources.ts to extend the discipline path.",
            acceptance_criteria: [{ text: "The new path is covered by unit tests.", kind: "unit" }],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({
            kind: "discipline-violation",
            violations: expect.arrayContaining([
                expect.objectContaining({ code: "missing-integration-ac" }),
            ]),
        });
    });
    it("state-mutating story WITH an integration AC passes the integration-AC check", () => {
        const story = makeStory({
            implementation_notes: "Edit scan-sources.ts to extend the discipline path.",
            acceptance_criteria: [
                {
                    text: "Unit test coverage.",
                    kind: "unit",
                    verification: { type: "vitest", target: "src/__tests__/a.test.ts" },
                },
                {
                    text: "Integration path exercised end-to-end.",
                    kind: "integration",
                    verification: { type: "vitest", target: "src/__tests__/b.integration.test.ts" },
                },
            ],
        });
        const result = validateStoryAgainstDiscipline(story);
        // No missing-integration-ac violation (may still have other violations)
        if ("kind" in result && result.kind === "discipline-violation") {
            expect(result.violations.some((v) => v.code === "missing-integration-ac")).toBe(false);
        }
        // If the story has no other violations it should pass outright
        expect(result).toBe(story);
    });
    it("non-state-mutating story without integration AC passes", () => {
        const story = makeStory({
            narrative: "As a reader, I want documentation.",
            acceptance_criteria: [
                {
                    text: "Docs are present.",
                    kind: "unit",
                    verification: { type: "vitest", target: "src/__tests__/docs.test.ts" },
                },
            ],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toBe(story);
    });
});
// ---------------------------------------------------------------------------
// stateMutating override
// ---------------------------------------------------------------------------
describe("validateStoryAgainstDiscipline — stateMutating override", () => {
    it("override false suppresses integration-AC check even on a heuristic-positive story", () => {
        const story = makeStory({
            implementation_notes: "Edit scan-sources.ts",
            acceptance_criteria: [
                {
                    text: "Unit tests only.",
                    kind: "unit",
                    verification: { type: "vitest", target: "src/__tests__/a.test.ts" },
                },
            ],
        });
        const result = validateStoryAgainstDiscipline(story, { stateMutating: false });
        expect(result).toBe(story);
    });
    it("override true forces the integration-AC check on a heuristic-negative story", () => {
        const story = makeStory({
            narrative: "As a reader, I want documentation.",
            acceptance_criteria: [{ text: "Docs are present.", kind: "unit" }],
        });
        const result = validateStoryAgainstDiscipline(story, { stateMutating: true });
        expect(result).toMatchObject({
            kind: "discipline-violation",
            violations: expect.arrayContaining([
                expect.objectContaining({ code: "missing-integration-ac" }),
            ]),
        });
    });
});
// ---------------------------------------------------------------------------
// Implicit-depends-on detection
// ---------------------------------------------------------------------------
describe("validateStoryAgainstDiscipline — implicit-depends-on detection", () => {
    it("ref mentioned in narrative but missing from depends_on fails", () => {
        const story = makeStory({
            narrative: "This story builds on bmad:1.3 which provides the foundation.",
            depends_on: [],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({
            kind: "discipline-violation",
            violations: expect.arrayContaining([
                expect.objectContaining({
                    code: "implicit-depends-on",
                    detail: expect.stringContaining("bmad:1.3"),
                }),
            ]),
        });
    });
    it("ref mentioned in narrative AND declared in depends_on passes", () => {
        const story = makeStory({
            narrative: "This story builds on bmad:1.3 which provides the foundation.",
            depends_on: ["bmad:1.3"],
        });
        const result = validateStoryAgainstDiscipline(story);
        // No implicit-depends-on violation expected
        if ("kind" in result && result.kind === "discipline-violation") {
            expect(result.violations.some((v) => v.code === "implicit-depends-on")).toBe(false);
        }
    });
    it("native ref mentioned in AC text but missing from depends_on fails", () => {
        const story = makeStory({
            acceptance_criteria: [
                {
                    text: "Given the output from native:01JX9000000000000000000001, the tool succeeds.",
                    kind: "unit",
                },
            ],
            depends_on: [],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({
            kind: "discipline-violation",
            violations: expect.arrayContaining([
                expect.objectContaining({ code: "implicit-depends-on" }),
            ]),
        });
    });
    it("multiple implicit refs produce multiple DisciplineViolationReason entries", () => {
        const story = makeStory({
            narrative: "Depends on bmad:1.1 and bmad:1.2 for context.",
            depends_on: [],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({ kind: "discipline-violation" });
        if ("violations" in result) {
            const implicitReasonCodes = result.violations.filter((v) => v.code === "implicit-depends-on");
            expect(implicitReasonCodes.length).toBe(2);
        }
    });
    it("story with no cross-story refs passes implicit-depends-on check", () => {
        const story = makeStory({
            narrative: "A standalone story that does not reference anything external.",
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toBe(story);
    });
});
// ---------------------------------------------------------------------------
// validateBacklogAgainstDiscipline — ship-gate check
// ---------------------------------------------------------------------------
describe("validateBacklogAgainstDiscipline — ship-gate detection", () => {
    it("backlog with one ship-gate story passes", () => {
        const stories = [
            makeStory({ raw_frontmatter: { ship_gate: true } }),
            makeStory({ ref: "native:TESTULIDPLACEHOLDERX02" }),
        ];
        const result = validateBacklogAgainstDiscipline(stories, { existingStories: [] });
        expect(result).toEqual([]);
    });
    it("backlog with no ship-gate story fails", () => {
        const stories = [
            makeStory(),
            makeStory({ ref: "native:TESTULIDPLACEHOLDERX02" }),
        ];
        const result = validateBacklogAgainstDiscipline(stories, { existingStories: [] });
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            kind: "discipline-violation",
            violations: [expect.objectContaining({ code: "missing-ship-gate" })],
        });
    });
    it("ship-gate in existingStories satisfies the check", () => {
        const pending = [makeStory()];
        const existing = [
            makeStory({ ref: "native:TESTULIDPLACEHOLDERX02", raw_frontmatter: { ship_gate: true } }),
        ];
        const result = validateBacklogAgainstDiscipline(pending, { existingStories: existing });
        expect(result).toEqual([]);
    });
    it("uses backlogPseudoRef in the violation ref", () => {
        const stories = [makeStory()];
        const result = validateBacklogAgainstDiscipline(stories, {
            existingStories: [],
            backlogPseudoRef: "backlog:my-repo-1234",
        });
        expect(result[0]?.ref).toBe("backlog:my-repo-1234");
    });
    it("defaults backlogPseudoRef to 'backlog:default'", () => {
        const stories = [makeStory()];
        const result = validateBacklogAgainstDiscipline(stories, { existingStories: [] });
        expect(result[0]?.ref).toBe("backlog:default");
    });
    it("single-story validateStoryAgainstDiscipline DOES NOT raise missing-ship-gate", () => {
        const story = makeStory();
        const result = validateStoryAgainstDiscipline(story);
        // If any violation exists it must NOT be missing-ship-gate
        if ("violations" in result) {
            expect(result.violations.every((v) => v.code !== "missing-ship-gate")).toBe(true);
        }
    });
});
// ---------------------------------------------------------------------------
// Story 10.3 AC2 — pure T0-2 (every AC has verification) and T0-1 (every task
//   maps to a real AC), gated to native/enriched stories. A BMad story (or any
//   story whose enriched fields are absent + bmad: ref) is NOT failed by them.
// ---------------------------------------------------------------------------
describe("validateStoryAgainstDiscipline — Story 10.3 T0-2 (every AC has verification)", () => {
    it("native story with an AC missing its verification block fails with missing-verification naming the AC", () => {
        const story = makeStory({
            acceptance_criteria: [
                {
                    text: "AC1 has verification.",
                    kind: "unit",
                    verification: { type: "vitest", target: "src/__tests__/a.test.ts" },
                },
                // Second AC omits verification → T0-2 fires, naming AC2.
                { text: "AC2 omits verification.", kind: "integration" },
            ],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({
            kind: "discipline-violation",
            violations: expect.arrayContaining([
                expect.objectContaining({
                    code: "missing-verification",
                    detail: expect.stringContaining("AC2"),
                }),
            ]),
        });
    });
    it("native story whose every AC has a verification block does not raise missing-verification", () => {
        const story = makeStory(); // default carries a verification block on AC1
        const result = validateStoryAgainstDiscipline(story);
        if ("violations" in result) {
            expect(result.violations.some((v) => v.code === "missing-verification")).toBe(false);
        }
    });
    it("accumulates one missing-verification per offending AC (does not short-circuit)", () => {
        const story = makeStory({
            acceptance_criteria: [
                { text: "AC1 no verification.", kind: "unit" },
                { text: "AC2 no verification.", kind: "unit" },
            ],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({ kind: "discipline-violation" });
        if ("violations" in result) {
            expect(result.violations.filter((v) => v.code === "missing-verification")).toHaveLength(2);
        }
    });
});
describe("validateStoryAgainstDiscipline — Story 10.3 T0-1 (every task maps to a real AC)", () => {
    it("native story with a task whose ac_refs is empty fails with task-ac-ref-unresolved", () => {
        const story = makeStory({
            tasks: [{ text: "Orphan task", ac_refs: [] }],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({
            kind: "discipline-violation",
            violations: expect.arrayContaining([
                expect.objectContaining({ code: "task-ac-ref-unresolved" }),
            ]),
        });
    });
    it("native story with a task referencing a non-existent AC fails, naming the dangling ref", () => {
        const story = makeStory({
            // Story declares AC1 only; task names AC5 which does not resolve.
            tasks: [{ text: "Dangling", ac_refs: ["AC5"] }],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({
            kind: "discipline-violation",
            violations: expect.arrayContaining([
                expect.objectContaining({
                    code: "task-ac-ref-unresolved",
                    detail: expect.stringContaining("AC5"),
                }),
            ]),
        });
    });
    it("native story with no tasks at all fails with task-ac-ref-unresolved", () => {
        const story = makeStory({ tasks: undefined });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toMatchObject({
            kind: "discipline-violation",
            violations: expect.arrayContaining([
                expect.objectContaining({ code: "task-ac-ref-unresolved", field: "tasks" }),
            ]),
        });
    });
    it("native story whose tasks all resolve to declared ACs does not raise task-ac-ref-unresolved", () => {
        const story = makeStory({
            acceptance_criteria: [
                {
                    text: "AC1.",
                    kind: "unit",
                    verification: { type: "vitest", target: "src/__tests__/a.test.ts" },
                },
                {
                    text: "AC2.",
                    kind: "integration",
                    verification: { type: "vitest", target: "src/__tests__/b.test.ts" },
                },
            ],
            tasks: [
                { text: "Task one", ac_refs: ["AC1"] },
                { text: "Task two", ac_refs: ["AC1", "AC2"] },
            ],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toBe(story);
    });
});
describe("validateStoryAgainstDiscipline — Story 10.3 AC2 non-regression: BMad stories are NOT failed by the new checks", () => {
    it("a bmad: story with verification-less ACs and no tasks is NOT failed by T0-1/T0-2", () => {
        // A BMad-shaped SourceStory: bmad: ref, ACs without verification, no tasks,
        // no cited_sources — exactly what the BMad parser produces pre-ingest. The
        // new checks must NOT fire (the live-backlog-outage guard).
        const bmadStory = makeStory({
            ref: "bmad:3.4",
            acceptance_criteria: [
                { text: "**Given** … **When** … **Then** …", kind: "unit" },
                { text: "**Given** … **When** … **Then** …", kind: "integration" },
            ],
            tasks: undefined,
            cited_sources: undefined,
        });
        const result = validateStoryAgainstDiscipline(bmadStory);
        // No 10.3 codes present. (The story may still pass outright — it has an
        // integration AC and no implicit refs — but assert the codes specifically.)
        if ("violations" in result) {
            const codes = result.violations.map((v) => v.code);
            expect(codes).not.toContain("missing-verification");
            expect(codes).not.toContain("task-ac-ref-unresolved");
        }
    });
    it("isEnrichedStory is true only for native: refs", () => {
        expect(isEnrichedStory(makeStory({ ref: "native:01HZDRF000000000000000009A" }))).toBe(true);
        expect(isEnrichedStory(makeStory({ ref: "bmad:1.1" }))).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// DisciplineViolation shape invariants
// ---------------------------------------------------------------------------
describe("DisciplineViolation structural invariants", () => {
    it("violation result has kind, ref, and violations array", () => {
        const story = makeStory({
            implementation_notes: "Edit scan-sources.ts",
            acceptance_criteria: [{ text: "Unit only.", kind: "unit" }],
        });
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toHaveProperty("kind", "discipline-violation");
        expect(result).toHaveProperty("ref");
        expect(result).toHaveProperty("violations");
        if ("violations" in result) {
            expect(Array.isArray(result.violations)).toBe(true);
            expect(result.violations.length).toBeGreaterThan(0);
            for (const v of result.violations) {
                expect(v).toHaveProperty("code");
                expect(v).toHaveProperty("field");
                expect(v).toHaveProperty("detail");
            }
        }
    });
    it("validator NEVER mutates the input story", () => {
        const story = makeStory({
            implementation_notes: "Edit scan-sources.ts",
            acceptance_criteria: [{ text: "Unit only.", kind: "unit" }],
        });
        const refBefore = story.ref;
        validateStoryAgainstDiscipline(story);
        expect(story.ref).toBe(refBefore);
    });
    it("pass returns the exact same object reference", () => {
        const story = makeStory();
        const result = validateStoryAgainstDiscipline(story);
        expect(result).toBe(story);
    });
});
