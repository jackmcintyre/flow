import { createHash } from "node:crypto";
import * as path from "node:path";
import { ulid as generateUlid } from "ulid";
import { z } from "zod";
import { DisciplineViolationError, WrongAdapterError } from "../errors.js";
import { parseNativeStory } from "../adapters/native/parse-native-story.js";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { logTelemetryEvent } from "../lib/logger.js";
import { resolveWorkspace } from "../state/workspace-resolver.js";
import { validateStoryAgainstDiscipline } from "../validators/planning-discipline.js";
import { resolveDisciplinePaths } from "../validators/discipline-resolvability.js";
/**
 * Input schema for `writeNativeStory`. Mirrors the four-section native-story
 * body shape (Story 3.4 Task 4.1).
 */
export const WriteNativeStoryInputSchema = z.object({
    targetRepoRoot: z.string().min(1),
    title: z.string().min(1),
    /**
     * Story 10.2 — the narrative is now a structured `{ role, want, so_that }`
     * object. REQUIRED on the native write path (mirrors the `verification`
     * precedent from 10.1). `renderNativeStoryBody` emits the canonical
     * "As a {role}, I want {want}, so that {so_that}." sentence and
     * `parseNativeStory` parses exactly that grammar back, closing the round-trip.
     */
    narrative: z.object({
        role: z.string().min(1),
        want: z.string().min(1),
        so_that: z.string().min(1),
    }),
    acceptance_criteria: z
        .array(z.object({
        text: z.string().min(1),
        kind: z.enum(["integration", "unit"]),
        /**
         * Story 10.1 — every native AC carries a structured verification
         * directive. REQUIRED on the native write path (mirrors the
         * three-site `kind` enum precedent: parser, this schema, manifest
         * schema). `target` is non-empty; resolvability of the path is the
         * 10.3 T0-6 check, not enforced here.
         */
        verification: z.object({
            type: z.enum(["vitest", "artifact"]),
            target: z.string().min(1),
        }),
    }))
        .min(1),
    /**
     * Story 10.2 — implementation tasks. REQUIRED on the native write path: ≥1
     * task, each carrying ≥1 `ac_refs` (e.g. `["AC1", "AC3"]`). The pre-write
     * round-trip through `parseNativeStory` additionally rejects a task whose
     * `ac_ref` dangles (names an AC the story does not declare). Whole-story
     * T0-1 enforcement at scan time is Story 10.3.
     */
    tasks: z
        .array(z.object({
        text: z.string().min(1),
        ac_refs: z.array(z.string().min(1)).min(1),
    }))
        .min(1),
    /**
     * Story 10.2 — repo-relative source paths cited by the story. REQUIRED on the
     * native write path: ≥1 path. That each path *resolves on disk* is T0-5
     * (Story 10.3) — not enforced here.
     */
    cited_sources: z.array(z.string().min(1)).min(1),
    implementation_notes: z.string().optional(),
    /**
     * Story 10.8 — three OPTIONAL build-ready fields. When omitted by the author,
     * a non-empty build-time default is substituted so the rendered
     * `## Implementation Notes` always carries all three `###` sub-sections.
     */
    files_touched: z.string().optional(),
    definition_of_done: z.string().optional(),
    risk_reasoning: z.string().optional(),
    depends_on: z.array(z.string()),
    /**
     * Session id for the `draft.authored` telemetry envelope. Optional — the
     * author subagent / `/flow:author` skill passes its orchestration session
     * ULID when available; defaults to a stable operator marker so the event
     * still validates when authored interactively. (Story 9.2)
     */
    sessionUlid: z.string().min(1).optional(),
});
// ---------------------------------------------------------------------------
// Story 10.8 — build-ready block defaults
// ---------------------------------------------------------------------------
/** Default text for the Files-touched sub-section when the author omits it. */
const DEFAULT_FILES_TOUCHED = "To be completed by dev — list new files (`NEW`) and updated files (`UPDATE`) here before opening the PR.";
/** Default text for the Definition-of-Done sub-section when the author omits it. */
const DEFAULT_DEFINITION_OF_DONE = [
    "- [ ] All ACs met.",
    "- [ ] `pnpm build` green from `plugins/flow/mcp-server` before the PR.",
    "- [ ] `pnpm test` green (all tests passing).",
    "- [ ] `dist/` rebuilt and committed in the same change (CI fails on `src`/`dist` drift).",
    "- [ ] PR opened against `main` with CI green.",
].join("\n");
/** Default text for the risk-reasoning sub-section when the author omits it. */
const DEFAULT_RISK_REASONING = "No elevated risk identified — confirm at dev time. Highest-risk failure mode: TBD by dev.";
// ---------------------------------------------------------------------------
/**
 * Render the canonical narrative sentence from the structured parts (Story
 * 10.2). `parseNativeStory` parses exactly this grammar back into
 * `narrative_struct`, so the render here is the single source of the round-trip
 * contract.
 */
export function renderNarrativeSentence(narrative) {
    return `As a ${narrative.role}, I want ${narrative.want}, so that ${narrative.so_that}.`;
}
/**
 * Render a native-story file body from validated inputs.
 *
 * Produces the canonical section order:
 *   1. `## Narrative`
 *   2. `## Acceptance Criteria`
 *   3. `## Tasks`
 *   4. `## Cited Sources`
 *   5. `## Implementation Notes` (omitted if empty/absent)
 *   6. `## Dependencies`
 */
export function renderNativeStoryBody(input) {
    const lines = [`# ${input.title}`, ""];
    // ## Narrative — the canonical "As a … I want … so that …" sentence (10.2).
    lines.push("## Narrative", "");
    lines.push(renderNarrativeSentence(input.narrative));
    lines.push("");
    // ## Acceptance Criteria
    lines.push("## Acceptance Criteria", "");
    for (let i = 0; i < input.acceptance_criteria.length; i++) {
        const ac = input.acceptance_criteria[i];
        const tag = ac.kind === "integration" ? " (integration)" : "";
        lines.push(`**AC${i + 1}${tag}:**`);
        lines.push(ac.text);
        // Story 10.1 — emit the per-AC verification directive as a single line
        // directly under the AC body. `parseNativeStory` consumes exactly this
        // shape (`<type>: <target>`), closing the render→parse round-trip.
        lines.push(`${ac.verification.type}: ${ac.verification.target}`);
        lines.push("");
    }
    // ## Tasks — Story 10.2. Each task renders as `- <text> (AC: 1, 3)`;
    // `parseNativeStory` consumes exactly this shape into `{ text, ac_refs }`.
    // The numeric ref is recovered from the `AC<n>` id.
    lines.push("## Tasks", "");
    for (const task of input.tasks) {
        const nums = task.ac_refs.map((r) => r.replace(/^AC/i, "")).join(", ");
        lines.push(`- ${task.text} (AC: ${nums})`);
    }
    lines.push("");
    // ## Cited Sources — Story 10.2. Bullet list of repo-relative paths.
    lines.push("## Cited Sources", "");
    for (const src of input.cited_sources) {
        lines.push(`- ${src}`);
    }
    lines.push("");
    // ## Implementation Notes — Story 10.8: always emitted, carrying three
    // build-ready `###` sub-sections. Each sub-section uses the author-supplied
    // value when present, or a non-empty build-time default when absent. Any
    // free-form `implementation_notes` prose provided by the author is prepended
    // before the sub-sections. The section is always non-empty because the
    // defaults guarantee it.
    // NOTE: renderImplementationNotesBody is defined AFTER this function (below),
    // but TypeScript hoists function declarations; this call is safe.
    lines.push("## Implementation Notes", "");
    lines.push(renderImplementationNotesBody(input));
    lines.push("");
    // ## Dependencies
    // Story 5.13: also emit a `Depends on: <refs>` prose line above the section
    // so that the deps-drift gate in scanSources finds prose and manifest in agreement.
    lines.push("## Dependencies", "");
    if (input.depends_on.length > 0) {
        // Prose line mirrors the ## Dependencies section — keeps scan-sources drift gate happy.
        lines.push(`Depends on: ${input.depends_on.join(", ")}`, "");
        for (const dep of input.depends_on) {
            lines.push(`- ${dep}`);
        }
    }
    lines.push("");
    return lines.join("\n");
}
/**
 * Write a new native-story file under `<targetRepoRoot>/.flow/native-stories/`.
 *
 * Steps:
 *   1. Resolve workspace; throw `WrongAdapterError` if not `native`.
 *   2. Generate a fresh ULID.
 *   3. Render the four-section body.
 *   4. Round-trip through `parseNativeStory()` — throw if invalid.
 *   5. Write atomically (`.tmp` + rename).
 *   6. Return `{ ref, path }`.
 *
 * @see _bmad-output/implementation-artifacts/3-4-native-adapter-planner-subagent-and-plan-skill.md § Task 4
 */
export async function writeNativeStory(rawInput) {
    const input = WriteNativeStoryInputSchema.parse(rawInput);
    const targetRepoRoot = path.resolve(input.targetRepoRoot);
    // Resolve workspace to confirm the active adapter is `native`.
    const workspace = await resolveWorkspace({ targetRepoRoot });
    if (workspace.activeAdapterName !== "native") {
        throw new WrongAdapterError({
            expectedAdapter: "native",
            actualAdapter: workspace.activeAdapterName,
            targetRepoRoot,
            toolName: "writeNativeStory",
        });
    }
    // Story 10.5 — the render → gate → round-trip → atomic-write internal is
    // shared with the BMad→native ingest seam (`bmadToNativeIngest`). The ONLY
    // difference between the two callers is this active-adapter guard above:
    // `writeNativeStory` requires `native`; the ingest deliberately does NOT (it
    // runs while BMad is still the active adapter — you ingest first, cut over
    // second). Keeping the write body in one place means the two paths can never
    // diverge on what "a Tier-0-clean native story on disk" means.
    return renderGateWriteNativeStory(input, targetRepoRoot);
}
/**
 * The shared native-write internal (Story 10.5): render → discipline-gate →
 * round-trip-parse → atomic-write, mints a fresh ULID, emits the
 * `draft.authored` telemetry event, returns `{ ref, path }`.
 *
 * Deliberately does NOT run the `WrongAdapterError` active-adapter guard — that
 * is `writeNativeStory`'s responsibility, applied before calling here. The BMad
 * → native ingest reuses this directly so it can write native stories while the
 * active adapter is still `bmad` (it ingests first, cuts over second).
 *
 * The Tier-0 gate (`validateStoryAgainstDiscipline` + `resolveDisciplinePaths`)
 * is the SOLE arbiter of whether the candidate is written: a violating candidate
 * throws `DisciplineViolationError` and NOTHING is written (no file, no
 * telemetry). For ingest this is load-bearing — the lossy LLM enrichment cannot
 * smuggle a non-compliant story through; the deterministic gate decides.
 *
 * @param input          a validated `WriteNativeStoryInput`.
 * @param targetRepoRoot the resolved repo root (already `path.resolve`d).
 * @param agent          telemetry `agent` field — "author" for the native write
 *                       path, "ingest" for the BMad→native seam.
 */
export async function renderGateWriteNativeStory(input, targetRepoRoot, agent = "author") {
    // Generate a fresh ULID.
    const newUlid = generateUlid();
    const storiesDir = path.join(targetRepoRoot, ".flow", "native-stories");
    const absPath = path.join(storiesDir, `${newUlid}.md`);
    const ref = `native:${newUlid}`;
    // Story 9.2 — fail-closed discipline gate.
    //
    // Run the SAME authoring-time discipline validator the planner's pre-write
    // `validatePlannerBacklog` call uses (Story 3.5), now INSIDE the write tool.
    // A violating candidate is refused with a typed `DisciplineViolationError`
    // and NOTHING is written — no native-story file, no telemetry event. The
    // guarantee does not rest on the author subagent remembering to validate
    // first; even a direct write of a violating story is refused here.
    //
    // The candidate is validated against the freshly-minted `ref` so the
    // implicit-depends-on check correctly excludes self-references. The
    // state-mutating heuristic (`isStateMutatingByHeuristic`) is conservative —
    // false positives are acceptable; false negatives are not.
    // Story 10.3 — the write-time gate now runs the FULL Tier-0 set:
    //   - the PURE checks (T0-1 task→AC refs, T0-2 every AC has verification, plus
    //     the legacy state-mutating / implicit-depends-on rules) via
    //     `validateStoryAgainstDiscipline`; and
    //   - the writable-time resolvability (T0-5 cited sources present and
    //     resolving — they are files the author read, so they exist at write — and
    //     the pure part of T0-6, rejecting invented flags / non-path targets) via
    //     `resolveDisciplinePaths`.
    // New-test-file `vitest:` targets are NOT existence-checked at write: the build
    // creates that test file, so requiring it would make every new-test story
    // un-writable (the chicken-and-egg the story's pre-mortem pins). All violations
    // accumulate into one `DisciplineViolationError` so the author fixes in one pass.
    const candidate = inputToSourceStory(input, ref, absPath);
    const pureResult = validateStoryAgainstDiscipline(candidate);
    const violations = "kind" in pureResult && pureResult.kind === "discipline-violation"
        ? [...pureResult.violations]
        : [];
    violations.push(...(await resolveDisciplinePaths(candidate, targetRepoRoot)));
    if (violations.length > 0) {
        throw new DisciplineViolationError({ violations });
    }
    // Render the body.
    const body = renderNativeStoryBody(input);
    // Round-trip validation — throws MalformedNativeStoryError if the rendered
    // body would not parse back cleanly. This ensures the file on disk always
    // conforms to the schema.
    parseNativeStory(absPath, body);
    // Write atomically via atomicWriteFile: writes to <absPath>.tmp first, then
    // renames to <absPath> in a single fs.rename(2) syscall — atomic on the same
    // filesystem (Task 4.5). The `.flow/native-stories/` path is non-canonical
    // so no mcpToolContext is required.
    await atomicWriteFile(absPath, body);
    // Story 9.2 — emit exactly one `draft.authored` telemetry event per written
    // draft. Reached only on the success path (after the discipline gate passed
    // and the file was written); a refused/violating candidate throws above and
    // never reaches this line.
    await logTelemetryEvent({
        targetRepoRoot,
        event: {
            type: "draft.authored",
            session_id: input.sessionUlid ?? "operator",
            agent,
            story_id: ref,
            data: { ref, title: input.title },
        },
    });
    return { ref, path: absPath };
}
/**
 * Render the full `## Implementation Notes` body (without the section header)
 * as it will appear in the written file (Story 10.8). This includes the author's
 * free-form notes (if any) followed by the three build-ready `###` sub-sections,
 * each filled with its default when the author omitted the field.
 *
 * Used both in `renderNativeStoryBody` and in `inputToSourceStory` so the
 * discipline-gate candidate sees the same rendered text the file will contain.
 */
export function renderImplementationNotesBody(input) {
    const parts = [];
    if (input.implementation_notes && input.implementation_notes.trim().length > 0) {
        parts.push(input.implementation_notes.trim());
        parts.push("");
    }
    const filesTouched = (input.files_touched ?? "").trim() || DEFAULT_FILES_TOUCHED;
    parts.push("### Files touched", "", filesTouched, "");
    const dod = (input.definition_of_done ?? "").trim() || DEFAULT_DEFINITION_OF_DONE;
    parts.push("### Definition of Done", "", dod, "");
    const risk = (input.risk_reasoning ?? "").trim() || DEFAULT_RISK_REASONING;
    parts.push("### Risk", "", risk, "");
    return parts.join("\n").trim();
}
/**
 * Build a `SourceStory` from `WriteNativeStoryInput` for the fail-closed
 * discipline gate. The `source_hash` is computed over the rendered body so it
 * is stable and non-empty; `raw_frontmatter` carries the ref/title so the
 * validator's self-reference exclusion works against the real minted ref.
 *
 * Story 9.2. Story 10.8: `implementation_notes` now reflects the full rendered
 * body (author notes + three build-ready sub-sections with defaults) so the
 * discipline gate and round-trip see the same text the written file will contain.
 */
function inputToSourceStory(input, ref, absPath) {
    return {
        ref,
        title: input.title,
        // The discipline validator scans the raw narrative string for implicit
        // depends-on refs, so pass the canonical rendered sentence (10.2).
        narrative: renderNarrativeSentence(input.narrative),
        narrative_struct: input.narrative,
        acceptance_criteria: input.acceptance_criteria,
        depends_on: input.depends_on,
        // Story 10.8: pass the full rendered implementation notes (including the
        // three build-ready sub-sections with their defaults) so the discipline
        // gate sees the same text the file will contain.
        implementation_notes: renderImplementationNotesBody(input),
        tasks: input.tasks,
        cited_sources: input.cited_sources,
        raw_path: absPath,
        raw_frontmatter: { title: input.title, ref },
        source_hash: createHash("sha256").update(renderNativeStoryBody(input)).digest("hex"),
    };
}
