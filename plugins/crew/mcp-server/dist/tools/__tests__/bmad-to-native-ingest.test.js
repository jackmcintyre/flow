/**
 * Tests for the BMad → native ingest seam — Story 10.5.
 *
 * The ingest reads the live BMad backlog (read-only), enriches each story to the
 * §3 native shape via an INJECTED stub enricher (so the gate behaviour is
 * deterministic — no live model call), gates each enriched draft on the
 * completed Tier-0 validator (Story 10.3), writes survivors to
 * `.crew/native-stories/<ULID>.md`, and returns a fix-up report for the rest.
 *
 * Coverage:
 *   AC1 — integration: enrich-or-surface, never silently drop. A signal-carrying
 *         story is written + parses + clears Tier-0; an un-enrichable story is
 *         surfaced in the fix-up report with the failed check id(s); the source
 *         BMad story is untouched; written + needs_fix_up + skipped == input.
 *   AC2 — unit: the ingest writes native files while BMad is still the active
 *         adapter (no WrongAdapterError guard); config.yaml stays adapter: bmad.
 *   AC3 — unit: one-way, non-destructive, re-run-safe. The source backlog is
 *         byte-for-byte unchanged; a re-run dedupes by provenance (skip, not a
 *         fresh ULID).
 *   AC4 — unit: enrichment is LLM-assisted but the accept/reject decision is
 *         deterministic — a hollow draft the stub produces is rejected by the
 *         Tier-0 gate, not written.
 *
 * Fixture pattern mirrors scan-sources.test.ts / write-native-story.test.ts:
 * a minimal BMad-adapter workspace in a fresh tmpdir.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { parseNativeStory } from "../../adapters/native/parse-native-story.js";
import { validateStoryAgainstDiscipline } from "../../validators/planning-discipline.js";
import { resolveDisciplinePaths } from "../../validators/discipline-resolvability.js";
import { resetBmadAdapter } from "../../adapters/bmad/index.js";
import { bmadToNativeIngest, bmadToNativeIngestTool, } from "../bmad-to-native-ingest.js";
const STORIES_REL = "_bmad-output/planning-artifacts/stories";
let scratch;
let root;
let storiesDir; // BMad source stories
let nativeDir; // .crew/native-stories
async function listNativeFiles() {
    try {
        return (await fs.readdir(nativeDir)).filter((f) => f.endsWith(".md"));
    }
    catch {
        return [];
    }
}
/** Seed a BMad source story file under the stories root. */
async function seedBmadStory(filename, body) {
    const abs = path.join(root, STORIES_REL, filename);
    await atomicWriteFile(abs, body);
    return abs;
}
/** Seed a repo-relative file so a Tier-0 T0-5/T0-6 resolvability check passes. */
async function seedFile(relPath) {
    await atomicWriteFile(path.join(root, relPath), "// seeded for resolvability\n");
}
/** A canonical, signal-carrying BMad story body (epic 1, story 1). */
function bmadStoryBody(epic, story, title) {
    return [
        `# Story ${epic}.${story}: ${title}`,
        ``,
        `Status: ready-for-dev`,
        ``,
        `## Story`,
        ``,
        `As a developer,`,
        `I want a typed parser,`,
        `so that fields cannot drift.`,
        ``,
        `## Acceptance Criteria`,
        ``,
        `**AC1 (integration):**`,
        `**Given** a state, **When** an action, **Then** an outcome.`,
        ``,
        `## Dev Notes`,
        ``,
        `Some implementation guidance for the developer.`,
        ``,
    ].join("\n");
}
/**
 * A deterministic stub enricher that produces a Tier-0-CLEAN §3 draft for every
 * BMad story. The two `vitest:`/`artifact:` targets and the cited source resolve
 * because the fixture seeds them. Provenance is appended by the ingest itself.
 */
const cleanEnricher = (story) => ({
    title: story.title,
    narrative: { role: "developer", want: "a typed parser", so_that: "fields cannot drift" },
    acceptance_criteria: [
        {
            text: "**Given** a state, **When** an action, **Then** an outcome.",
            kind: "integration",
            verification: { type: "vitest", target: "src/__tests__/ingested.test.ts" },
        },
    ],
    tasks: [{ text: "Implement the change", ac_refs: ["AC1"] }],
    cited_sources: ["src/parser.ts"],
    implementation_notes: story.implementation_notes,
    depends_on: [],
});
beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "crew-bmad-ingest-"));
    root = path.join(scratch, "workspace");
    storiesDir = path.join(root, STORIES_REL);
    nativeDir = path.join(root, ".crew", "native-stories");
    await fs.mkdir(storiesDir, { recursive: true });
    await fs.mkdir(nativeDir, { recursive: true });
    // BMad-adapter config — config.yaml stays adapter: bmad (AC2).
    await atomicWriteFile(path.join(root, ".crew", "config.yaml"), `adapter: bmad\nadapter_config:\n  stories_root: ${STORIES_REL}\n`);
    // Seed the resolvable paths the clean enricher cites/references.
    await seedFile("src/parser.ts");
    // Reset the BMad adapter's per-process bound context between tests so the
    // ref-index does not leak across tmpdirs.
    resetBmadAdapter();
});
afterEach(async () => {
    resetBmadAdapter();
    await fs.rm(scratch, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// AC1 — enrich-or-surface, never silently drop (integration)
// ---------------------------------------------------------------------------
describe("bmadToNativeIngest AC1 — every input is accounted for", () => {
    it("enriches a signal-carrying story to a Tier-0-clearing native file, surfaces an un-enrichable one, drops nothing", async () => {
        const goodSrc = await seedBmadStory("1-1-good-story.md", bmadStoryBody(1, 1, "Good story"));
        const badSrc = await seedBmadStory("1-2-bad-story.md", bmadStoryBody(1, 2, "Bad story"));
        const goodBefore = await fs.readFile(goodSrc, "utf8");
        const badBefore = await fs.readFile(badSrc, "utf8");
        // Enricher: clean draft for bmad:1.1; a hollow draft (no cited sources) for
        // bmad:1.2 so the Tier-0 gate rejects it. Provenance is appended by the
        // ingest, so the bad draft fails specifically on the missing/unresolvable
        // verification target rather than cited-sources — we make the bad draft cite
        // a NON-existent artifact target so T0-6 fails deterministically.
        const enrich = (story) => {
            if (story.ref === "bmad:1.1")
                return cleanEnricher(story);
            return {
                title: story.title,
                narrative: { role: "developer", want: "a thing", so_that: "value" },
                acceptance_criteria: [
                    {
                        text: "**Given** a state, **When** an action, **Then** an outcome.",
                        kind: "integration",
                        // An artifact target that does NOT resolve on disk → T0-6 fails.
                        verification: { type: "artifact", target: "build/does-not-exist.json" },
                    },
                ],
                tasks: [{ text: "Do it", ac_refs: ["AC1"] }],
                cited_sources: ["src/parser.ts"],
                depends_on: [],
            };
        };
        const report = await bmadToNativeIngest({ targetRepoRoot: root }, enrich);
        // (a) The good story was written and clears Tier-0 on re-parse.
        expect(report.written).toHaveLength(1);
        expect(report.written[0].source_ref).toBe("bmad:1.1");
        const writtenPath = report.written[0].path;
        const reparsed = parseNativeStory(writtenPath, await fs.readFile(writtenPath, "utf8"));
        const pure = validateStoryAgainstDiscipline(reparsed);
        expect("kind" in pure && pure.kind === "discipline-violation").toBe(false);
        expect(await resolveDisciplinePaths(reparsed, root)).toHaveLength(0);
        // (b) The bad story was NOT written; it is surfaced with a named Tier-0 check.
        expect(report.needs_fix_up).toHaveLength(1);
        expect(report.needs_fix_up[0].source_ref).toBe("bmad:1.2");
        expect(report.needs_fix_up[0].failed_checks).toContain("unresolvable-verification-target");
        // Exactly one native file landed (the good one).
        expect(await listNativeFiles()).toHaveLength(1);
        // The source BMad stories are byte-for-byte untouched.
        expect(await fs.readFile(goodSrc, "utf8")).toBe(goodBefore);
        expect(await fs.readFile(badSrc, "utf8")).toBe(badBefore);
        // The observable spine: written + needs_fix_up + skipped == input_count.
        expect(report.input_count).toBe(2);
        expect(report.written.length + report.needs_fix_up.length + report.skipped.length).toBe(report.input_count);
    });
});
// ---------------------------------------------------------------------------
// AC2 — writes native files while BMad is still the active adapter (unit)
// ---------------------------------------------------------------------------
describe("bmadToNativeIngest AC2 — no active-adapter guard", () => {
    it("writes to .crew/native-stories/ with config.yaml still set to adapter: bmad", async () => {
        await seedBmadStory("1-1-good-story.md", bmadStoryBody(1, 1, "Good story"));
        const report = await bmadToNativeIngest({ targetRepoRoot: root }, cleanEnricher);
        // The write succeeded even though the active adapter is bmad (not native).
        expect(report.source_adapter).toBe("bmad");
        expect(report.written).toHaveLength(1);
        const files = await listNativeFiles();
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.md$/);
        // config.yaml is unchanged — still bmad.
        const cfg = await fs.readFile(path.join(root, ".crew", "config.yaml"), "utf8");
        expect(cfg).toMatch(/adapter:\s*bmad/);
    });
});
// ---------------------------------------------------------------------------
// AC3 — one-way, non-destructive, re-run-safe (unit)
// ---------------------------------------------------------------------------
describe("bmadToNativeIngest AC3 — non-destructive + idempotent re-run", () => {
    it("re-running dedupes by provenance — the already-ingested story is skipped, not re-written with a new ULID", async () => {
        const src = await seedBmadStory("1-1-good-story.md", bmadStoryBody(1, 1, "Good story"));
        const srcBefore = await fs.readFile(src, "utf8");
        // First run writes one native story.
        const first = await bmadToNativeIngest({ targetRepoRoot: root }, cleanEnricher);
        expect(first.written).toHaveLength(1);
        expect(first.skipped).toHaveLength(0);
        const firstUlidFiles = await listNativeFiles();
        expect(firstUlidFiles).toHaveLength(1);
        const firstNativeRef = first.written[0].native_ref;
        // Second run over the same backlog: the story is already ingested → skipped,
        // NOT re-written with a fresh ULID.
        const second = await bmadToNativeIngest({ targetRepoRoot: root }, cleanEnricher);
        expect(second.written).toHaveLength(0);
        expect(second.skipped).toHaveLength(1);
        expect(second.skipped[0].source_ref).toBe("bmad:1.1");
        // No new file appeared (still exactly one), and it is the SAME ULID.
        const afterFiles = await listNativeFiles();
        expect(afterFiles).toEqual(firstUlidFiles);
        expect(second.skipped[0].existing_native_path).toContain(firstNativeRef.replace("native:", ""));
        // The source BMad story is still byte-for-byte untouched after two runs.
        expect(await fs.readFile(src, "utf8")).toBe(srcBefore);
        // Every input still accounted for on the re-run.
        expect(second.written.length + second.needs_fix_up.length + second.skipped.length).toBe(second.input_count);
    });
    it("records the originating bmad:<ref> source path as provenance on each emitted native story", async () => {
        await seedBmadStory("1-1-good-story.md", bmadStoryBody(1, 1, "Good story"));
        const report = await bmadToNativeIngest({ targetRepoRoot: root }, cleanEnricher);
        const writtenPath = report.written[0].path;
        const reparsed = parseNativeStory(writtenPath, await fs.readFile(writtenPath, "utf8"));
        // The BMad source file path is recorded as a cited source (the provenance
        // marker the re-run dedupes on and the migration audits by).
        expect(reparsed.cited_sources).toContain(`${STORIES_REL}/1-1-good-story.md`);
    });
});
// ---------------------------------------------------------------------------
// AC4 — enrichment is LLM-assisted, the gate is the deterministic sole arbiter
// ---------------------------------------------------------------------------
describe("bmadToNativeIngest AC4 — Tier-0 gate is the sole arbiter", () => {
    it("rejects a hollow enrichment (plausible prose, no cited sources) at the gate, not the enricher — nothing written", async () => {
        await seedBmadStory("1-1-hollow.md", bmadStoryBody(1, 1, "Hollow"));
        // A plausible-looking draft the LLM might emit — but it cites NO sources, a
        // Tier-0 T0-5 violation. (The ingest appends the provenance citation, so to
        // make this test prove the gate rejects a hollow draft we cite a
        // non-resolving path; provenance alone would otherwise satisfy T0-5.)
        const hollowEnricher = (story) => ({
            title: story.title,
            narrative: { role: "developer", want: "a thing", so_that: "value" },
            acceptance_criteria: [
                {
                    text: "**Given** a state, **When** an action, **Then** an outcome.",
                    kind: "integration",
                    verification: { type: "vitest", target: "src/__tests__/x.test.ts" },
                },
            ],
            tasks: [{ text: "Do it", ac_refs: ["AC1"] }],
            // Cites a path that does not resolve on disk → T0-5 unresolvable-cited-source.
            cited_sources: ["src/this/does/not/exist.ts"],
            depends_on: [],
        });
        const report = await bmadToNativeIngest({ targetRepoRoot: root }, hollowEnricher);
        expect(report.written).toHaveLength(0);
        expect(report.needs_fix_up).toHaveLength(1);
        expect(report.needs_fix_up[0].failed_checks).toContain("unresolvable-cited-source");
        // Fail-closed: nothing on disk.
        expect(await listNativeFiles()).toHaveLength(0);
    });
    it("rejects an enrichment whose task references a non-existent AC (T0-1), nothing written", async () => {
        await seedBmadStory("1-1-dangling.md", bmadStoryBody(1, 1, "Dangling"));
        const danglingEnricher = (story) => ({
            title: story.title,
            narrative: { role: "developer", want: "a thing", so_that: "value" },
            acceptance_criteria: [
                {
                    text: "**Given** a state, **When** an action, **Then** an outcome.",
                    kind: "integration",
                    verification: { type: "vitest", target: "src/__tests__/x.test.ts" },
                },
            ],
            // AC9 dangles — the draft declares only AC1.
            tasks: [{ text: "Do it", ac_refs: ["AC9"] }],
            cited_sources: ["src/parser.ts"],
            depends_on: [],
        });
        const report = await bmadToNativeIngest({ targetRepoRoot: root }, danglingEnricher);
        expect(report.written).toHaveLength(0);
        expect(report.needs_fix_up).toHaveLength(1);
        expect(report.needs_fix_up[0].failed_checks).toContain("task-ac-ref-unresolved");
        expect(await listNativeFiles()).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// Transport wrapper — the registered MCP/CLI entry point (drafts keyed by ref)
// ---------------------------------------------------------------------------
describe("bmadToNativeIngestTool — transport-shaped drafts map", () => {
    it("gates + writes supplied drafts and surfaces a source with no supplied draft", async () => {
        await seedBmadStory("1-1-supplied.md", bmadStoryBody(1, 1, "Supplied"));
        await seedBmadStory("1-2-missing.md", bmadStoryBody(1, 2, "Missing draft"));
        const report = await bmadToNativeIngestTool({
            targetRepoRoot: root,
            drafts: {
                // Only bmad:1.1 gets a draft; bmad:1.2 is left for fix-up.
                "bmad:1.1": {
                    title: "Supplied",
                    narrative: { role: "developer", want: "a typed parser", so_that: "fields cannot drift" },
                    acceptance_criteria: [
                        {
                            text: "**Given** a state, **When** an action, **Then** an outcome.",
                            kind: "integration",
                            verification: { type: "vitest", target: "src/__tests__/supplied.test.ts" },
                        },
                    ],
                    tasks: [{ text: "Implement", ac_refs: ["AC1"] }],
                    cited_sources: ["src/parser.ts"],
                    depends_on: [],
                },
            },
        });
        expect(report.written).toHaveLength(1);
        expect(report.written[0].source_ref).toBe("bmad:1.1");
        expect(report.needs_fix_up).toHaveLength(1);
        expect(report.needs_fix_up[0].source_ref).toBe("bmad:1.2");
        expect(report.needs_fix_up[0].failed_checks).toContain("ingest-error");
        // Every input accounted for.
        expect(report.written.length + report.needs_fix_up.length + report.skipped.length).toBe(report.input_count);
    });
});
