/**
 * `getTeamSnapshot` — compose `readPersona` over every hired role, aggregate
 * telemetry fire counts via `readTeamTelemetryStats`, and return a fully
 * typed `TeamSnapshot` (Story 2.6 / FR108 / NFR28).
 *
 * Design rationale (see story § Design rationale):
 *  - A single MCP call (not N per-role calls from the skill body).
 *  - Pure file reads — no `Task` spawn, no LLM, no network IO, no `execa`.
 *  - The renderer (`renderTeamSnapshot`) is a pure function so the output
 *    format is independently testable.
 *  - The MCP handler returns the rendered text (not JSON) so the skill body
 *    can print verbatim per Task 5.6 step 3.
 */
import { type KnowledgeEntry, type TeamSnapshot } from "../schemas/team-snapshot.js";
export interface GetTeamSnapshotOptions {
    targetRepoRoot: string;
    /** Defaults to 3 per FR108 ("recent persona-knowledge entries"). */
    knowledgeLimit?: number;
}
/**
 * Compose hired-role personas + telemetry stats into a `TeamSnapshot`.
 *
 * Algorithm (do not deviate — AC specification):
 *  1. Compute `teamDir = <targetRepoRoot>/team`.
 *  2. On ENOENT: return empty snapshot with telemetry stats (telemetry
 *     may still exist pre-hire).
 *  3. Filter readdir entries: skip `custom`, `_archived`, hidden dirs.
 *     For each surviving directory, verify `<role>/PERSONA.md` exists.
 *  4. Sort surviving role-ids lexicographically.
 *  5. Call `readTeamTelemetryStats` once; cache the result.
 *  6. For each role: `readPersona` → ok stanza or error stanza on
 *     `PersonaFileMalformedError`. Other errors propagate.
 *  7. Validate the assembled snapshot against `TeamSnapshotSchema`.
 */
export declare function getTeamSnapshot(opts: GetTeamSnapshotOptions): Promise<TeamSnapshot>;
/**
 * Extract structured knowledge entries from the `## Knowledge` body.
 *
 * Two-pass algorithm (Story native:01KT6Q8PSDZQKM57VFRHFJ3RP4):
 *
 *  Pass 1 — structured blocks:
 *    Lines matching `<!-- lesson:json {...} -->` are parsed as JSON. If
 *    valid, they are included as `KnowledgeEntry` objects. Invalid JSON
 *    is silently skipped (best-effort migration safety).
 *
 *  Pass 2 — flat-bullet migration:
 *    Lines matching `/^-\s+(.+?)\s*$/` that are NOT lesson blocks are
 *    migrated to `KnowledgeEntry` with `kind: "pattern"` and
 *    `applies_when` equal to the bullet text (provenance unknown).
 *
 *  Order: structured entries are collected first (in file order), then
 *  flat-bullet migrations. All entries are then taken as `slice(-limit)`
 *  reversed (bottom-most = most recently appended = shown first).
 *
 * Exported for unit testing.
 */
export declare function extractKnowledgeEntries(knowledgeBody: string, limit: number): KnowledgeEntry[];
/**
 * Pure formatter — no IO, no clock. Produces the operator-facing text block
 * per AC1's deterministic shape. Returns a string with NO trailing newline.
 *
 * The MCP handler wraps the return value in `{ type: "text", text }`.
 */
export declare function renderTeamSnapshot(snapshot: TeamSnapshot): string;
