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
import {
  TeamSnapshotSchema,
  type TeamSnapshot,
  type TeamSnapshotRole,
} from "../schemas/team-snapshot.js";
import { readPersona } from "./read-persona.js";

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
export async function getTeamSnapshot(
  opts: GetTeamSnapshotOptions,
): Promise<TeamSnapshot> {
  const { targetRepoRoot } = opts;
  const knowledgeLimit = opts.knowledgeLimit ?? 3;
  const teamDir = path.join(targetRepoRoot, "team");

  // Step 2: absent team directory → empty snapshot.
  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(teamDir);
  } catch (err) {
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
  const roleIds: string[] = [];

  for (const entry of dirEntries) {
    // Skip special directories and hidden entries (e.g. `.git`, `.DS_Store`).
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
      continue;
    }

    // Must be a directory.
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path.join(teamDir, entry));
    } catch {
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
  const roles: TeamSnapshotRole[] = [];
  for (const role of roleIds) {
    try {
      const persona = await readPersona({ targetRepoRoot, role });
      const knowledge = extractKnowledgeEntries(
        persona.sections.Knowledge,
        knowledgeLimit,
      );
      roles.push({
        state: "ok",
        role,
        domain: persona.domain,
        fireCount: stats.fireCountsByAgent[role] ?? 0,
        knowledge,
      });
    } catch (err) {
      if (err instanceof PersonaFileMalformedError) {
        roles.push({
          state: "error",
          role,
          error: err.message,
        });
      } else if (err instanceof PersonaFileNotFoundError) {
        // File was deleted between readdir and readPersona (TOCTOU). Skip with
        // a warning-level note rather than crashing the entire snapshot.
        console.warn(`[getTeamSnapshot] persona file for '${role}' vanished mid-snapshot — skipping`);
      } else {
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
 * Extract top-level Markdown bullet entries from the `## Knowledge` body.
 *
 * Rules (per AC specification / Task 4.4):
 *  - Only lines matching `/^-\s+(.+?)\s*$/` (top-level `^- `) are entries.
 *  - Indented bullets and continuation lines are skipped.
 *  - The leading `- ` and surrounding whitespace are stripped (capture group 1).
 *  - Returns the last `limit` entries in reverse file order (most-recent first).
 *
 * Exported for unit testing.
 */
export function extractKnowledgeEntries(
  knowledgeBody: string,
  limit: number,
): string[] {
  const entries: string[] = [];

  for (const line of knowledgeBody.split("\n")) {
    // Top-level bullet: must start at column 0 with `- ` (no leading whitespace).
    // Capture the trimmed content after `- `.
    const match = /^-\s+(.+?)\s*$/.exec(line);
    if (match) {
      entries.push(match[1]!);
    }
    // All other lines (blank, indented, continuation) are skipped.
  }

  // Last `limit` entries, reversed (bottom-most first = most-recently-appended).
  return entries.slice(-limit).reverse();
}

/**
 * Pure formatter — no IO, no clock. Produces the operator-facing text block
 * per AC1's deterministic shape. Returns a string with NO trailing newline.
 *
 * The MCP handler wraps the return value in `{ type: "text", text }`.
 */
export function renderTeamSnapshot(snapshot: TeamSnapshot): string {
  const { roles, knowledgeLimit, malformedTelemetryLines, malformedTelemetryFiles } =
    snapshot;
  const lines: string[] = [];

  // Header.
  lines.push(`flow team — ${roles.length} role(s)`);
  lines.push("");

  if (roles.length === 0) {
    lines.push(
      "No hired roles found. Run /flow:hire to hire a project-shaped team, or /flow:skip-hiring to hire the default roster.",
    );
  } else {
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i]!;

      // Role id header (no indent).
      lines.push(role.role);

      if (role.state === "error") {
        lines.push(`  error: ${role.error}`);
      } else {
        // OK stanza.
        lines.push(`  domain:      ${role.domain}`);
        lines.push(`  fire count:  ${role.fireCount}`);
        lines.push(`  knowledge (last ${knowledgeLimit}):`);

        if (role.knowledge.length === 0) {
          lines.push("    (no entries)");
        } else {
          for (const entry of role.knowledge) {
            lines.push(`    - ${entry}`);
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
    lines.push(
      `(${malformedTelemetryLines} malformed telemetry line(s) skipped across ${malformedTelemetryFiles} file(s))`,
    );
  }

  return lines.join("\n");
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
