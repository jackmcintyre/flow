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
/**
 * Input schema for `writeNativeStory`. Mirrors the four-section native-story
 * body shape (Story 3.4 Task 4.1).
 */
export const WriteNativeStoryInputSchema = z.object({
    targetRepoRoot: z.string().min(1),
    title: z.string().min(1),
    narrative: z.string().min(1),
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
    implementation_notes: z.string().optional(),
    depends_on: z.array(z.string()),
    /**
     * Session id for the `draft.authored` telemetry envelope. Optional — the
     * author subagent / `/crew:author` skill passes its orchestration session
     * ULID when available; defaults to a stable operator marker so the event
     * still validates when authored interactively. (Story 9.2)
     */
    sessionUlid: z.string().min(1).optional(),
});
/**
 * Render a native-story file body from validated inputs.
 *
 * Produces the canonical four-section order:
 *   1. `## Narrative`
 *   2. `## Acceptance Criteria`
 *   3. `## Implementation Notes` (omitted if empty/absent)
 *   4. `## Dependencies`
 */
export function renderNativeStoryBody(input) {
    const lines = [`# ${input.title}`, ""];
    // ## Narrative
    lines.push("## Narrative", "");
    lines.push(input.narrative);
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
    // ## Implementation Notes (optional)
    if (input.implementation_notes && input.implementation_notes.trim().length > 0) {
        lines.push("## Implementation Notes", "");
        lines.push(input.implementation_notes.trim());
        lines.push("");
    }
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
 * Write a new native-story file under `<targetRepoRoot>/.crew/native-stories/`.
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
    // Generate a fresh ULID.
    const newUlid = generateUlid();
    const storiesDir = path.join(targetRepoRoot, ".crew", "native-stories");
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
    const candidate = inputToSourceStory(input, ref, absPath);
    const disciplineResult = validateStoryAgainstDiscipline(candidate);
    if ("kind" in disciplineResult && disciplineResult.kind === "discipline-violation") {
        throw new DisciplineViolationError({
            violations: disciplineResult.violations,
        });
    }
    // Render the body.
    const body = renderNativeStoryBody(input);
    // Round-trip validation — throws MalformedNativeStoryError if the rendered
    // body would not parse back cleanly. This ensures the file on disk always
    // conforms to the schema.
    parseNativeStory(absPath, body);
    // Write atomically via atomicWriteFile: writes to <absPath>.tmp first, then
    // renames to <absPath> in a single fs.rename(2) syscall — atomic on the same
    // filesystem (Task 4.5). The `.crew/native-stories/` path is non-canonical
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
            agent: "author",
            story_id: ref,
            data: { ref, title: input.title },
        },
    });
    return { ref, path: absPath };
}
/**
 * Build a `SourceStory` from `WriteNativeStoryInput` for the fail-closed
 * discipline gate. The `source_hash` is computed over the rendered body so it
 * is stable and non-empty; `raw_frontmatter` carries the ref/title so the
 * validator's self-reference exclusion works against the real minted ref.
 *
 * Story 9.2.
 */
function inputToSourceStory(input, ref, absPath) {
    return {
        ref,
        title: input.title,
        narrative: input.narrative,
        acceptance_criteria: input.acceptance_criteria,
        depends_on: input.depends_on,
        implementation_notes: input.implementation_notes,
        raw_path: absPath,
        raw_frontmatter: { title: input.title, ref },
        source_hash: createHash("sha256").update(renderNativeStoryBody(input)).digest("hex"),
    };
}
