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
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { PersonaFileMalformedError, PersonaFileNotFoundError } from "../errors.js";
import { readTeamTelemetryStats } from "../lib/team-stats.js";
import { TeamSnapshotSchema, } from "../schemas/team-snapshot.js";
import { readPersona } from "./read-persona.js";
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
export async function getTeamSnapshot(opts) {
    const { targetRepoRoot } = opts;
    const knowledgeLimit = opts.knowledgeLimit ?? 3;
    const teamDir = path.join(targetRepoRoot, "team");
    // Step 2: absent team directory → empty snapshot.
    let dirEntries;
    try {
        dirEntries = await fs.readdir(teamDir);
    }
    catch (err) {
        if (isEnoent(err)) {
            const stats = await readTeamTelemetryStats({ targetRepoRoot });
            return TeamSnapshotSchema.parse({
                roles: [],
                knowledgeLimit,
                malformedTelemetryLines: stats.malformedLines,
                malformedTelemetryFiles: stats.malformedFiles,
            });
        }
        throw err;
    }
    // Step 3: filter to valid role directories.
    const SKIP_DIRS = new Set(["custom", "_archived"]);
    const roleIds = [];
    for (const entry of dirEntries) {
        // Skip special directories and hidden entries (e.g. `.git`, `.DS_Store`).
        if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
            continue;
        }
        // Must be a directory.
        let stat;
        try {
            stat = await fs.stat(path.join(teamDir, entry));
        }
        catch {
            continue;
        }
        if (!stat.isDirectory()) {
            continue;
        }
        // Candidate role: PERSONA.md existence is verified lazily by readPersona
        // to avoid a TOCTOU race between an fs.access check and the actual read.
        // PersonaFileNotFoundError is caught in the per-role try/catch below.
        roleIds.push(entry);
    }
    // Step 4: lexicographic sort (output stability independent of readdir order).
    roleIds.sort();
    // Step 5: aggregate telemetry once.
    const stats = await readTeamTelemetryStats({ targetRepoRoot });
    // Step 6: per-role persona reads.
    const roles = [];
    for (const role of roleIds) {
        try {
            const persona = await readPersona({ targetRepoRoot, role });
            const knowledge = extractKnowledgeEntries(persona.sections.Knowledge, knowledgeLimit);
            roles.push({
                state: "ok",
                role,
                domain: persona.domain,
                fireCount: stats.fireCountsByAgent[role] ?? 0,
                knowledge,
            });
        }
        catch (err) {
            if (err instanceof PersonaFileMalformedError) {
                roles.push({
                    state: "error",
                    role,
                    error: err.message,
                });
            }
            else if (err instanceof PersonaFileNotFoundError) {
                // File was deleted between readdir and readPersona (TOCTOU). Skip with
                // a warning-level note rather than crashing the entire snapshot.
                console.warn(`[getTeamSnapshot] persona file for '${role}' vanished mid-snapshot — skipping`);
            }
            else {
                throw err;
            }
        }
    }
    // Step 7: validate assembled snapshot.
    return TeamSnapshotSchema.parse({
        roles,
        knowledgeLimit,
        malformedTelemetryLines: stats.malformedLines,
        malformedTelemetryFiles: stats.malformedFiles,
    });
}
/**
 * Sentinel prefix for structured lesson blocks embedded in the Knowledge section.
 *
 * Each structured lesson is serialised as:
 *   <!-- lesson:json {"id":"...","kind":"...","applies_when":"...","detail":"...","failure_class":"...","source_ref":"...","source_pr":"...","learned_at":"..."} -->
 *
 * The comment wrapper keeps the file human-readable while being unambiguously
 * distinguishable from legacy flat `- bullet` entries during migration parsing.
 */
const LESSON_BLOCK_PREFIX = "<!-- lesson:json ";
const LESSON_BLOCK_SUFFIX = " -->";
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
export function extractKnowledgeEntries(knowledgeBody, limit) {
    const structured = [];
    const migrated = [];
    for (const line of knowledgeBody.split("\n")) {
        const trimmed = line.trimStart();
        // Structured lesson block: <!-- lesson:json {...} -->
        if (trimmed.startsWith(LESSON_BLOCK_PREFIX) &&
            trimmed.endsWith(LESSON_BLOCK_SUFFIX)) {
            const jsonStr = trimmed
                .slice(LESSON_BLOCK_PREFIX.length, trimmed.length - LESSON_BLOCK_SUFFIX.length)
                .trim();
            try {
                const raw = JSON.parse(jsonStr);
                if (raw !== null &&
                    typeof raw === "object" &&
                    "kind" in raw &&
                    "applies_when" in raw &&
                    "detail" in raw) {
                    const obj = raw;
                    const entry = {
                        kind: obj["kind"],
                        applies_when: String(obj["applies_when"]),
                        detail: String(obj["detail"]),
                        ...(typeof obj["source_ref"] === "string" && obj["source_ref"].length > 0
                            ? { source_ref: obj["source_ref"] }
                            : {}),
                    };
                    structured.push(entry);
                }
            }
            catch {
                // Invalid JSON in lesson block — skip silently (best-effort).
            }
            continue;
        }
        // Flat-bullet migration: top-level `- text` lines.
        const match = /^-\s+(.+?)\s*$/.exec(line);
        if (match) {
            migrated.push({
                kind: "pattern",
                applies_when: match[1],
                detail: match[1],
            });
        }
        // All other lines (blank, indented, continuation) are skipped.
    }
    // Combine structured (first) then flat-migrated, take last `limit` in file order,
    // then reverse so bottom-most (most-recently-appended) is first.
    const all = [...structured, ...migrated];
    return all.slice(-limit).reverse();
}
/**
 * Pure formatter — no IO, no clock. Produces the operator-facing text block
 * per AC1's deterministic shape. Returns a string with NO trailing newline.
 *
 * The MCP handler wraps the return value in `{ type: "text", text }`.
 */
export function renderTeamSnapshot(snapshot) {
    const { roles, knowledgeLimit, malformedTelemetryLines, malformedTelemetryFiles } = snapshot;
    const lines = [];
    // Header.
    lines.push(`flow team — ${roles.length} role(s)`);
    lines.push("");
    if (roles.length === 0) {
        lines.push("No hired roles found. Run /flow:hire to hire a project-shaped team, or /flow:skip-hiring to hire the default roster.");
    }
    else {
        for (let i = 0; i < roles.length; i++) {
            const role = roles[i];
            // Role id header (no indent).
            lines.push(role.role);
            if (role.state === "error") {
                lines.push(`  error: ${role.error}`);
            }
            else {
                // OK stanza.
                lines.push(`  domain:      ${role.domain}`);
                lines.push(`  fire count:  ${role.fireCount}`);
                lines.push(`  knowledge (last ${knowledgeLimit}):`);
                if (role.knowledge.length === 0) {
                    lines.push("    (no entries)");
                }
                else {
                    for (const entry of role.knowledge) {
                        // Format: `kind | applies_when [source_ref]`
                        const provenance = entry.source_ref != null ? ` [${entry.source_ref}]` : "";
                        lines.push(`    - ${entry.kind} | ${entry.applies_when}${provenance}`);
                    }
                }
            }
            // Blank line between role stanzas, but NOT after the last one.
            if (i < roles.length - 1) {
                lines.push("");
            }
        }
    }
    // Malformed-line annotation (omit entirely if count is zero).
    if (malformedTelemetryLines > 0) {
        lines.push("");
        lines.push(`(${malformedTelemetryLines} malformed telemetry line(s) skipped across ${malformedTelemetryFiles} file(s))`);
    }
    return lines.join("\n");
}
function isEnoent(err) {
    return (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT");
}
