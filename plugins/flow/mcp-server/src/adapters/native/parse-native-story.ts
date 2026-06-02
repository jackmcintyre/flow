import { createHash } from "node:crypto";
import { MalformedNativeStoryError } from "../../errors.js";
import type { AC, NarrativeStruct, SourceStory, Task } from "../adapter.js";

/**
 * Pure native-story parser — no I/O. The caller (the adapter's
 * `listSourceStories`/`readSourceStory`) is responsible for reading the
 * file and passing the bytes in.
 *
 * Native story body shape (Story 3.4):
 *   # <Title>  (required)
 *   ## Narrative   (required)
 *   ## Acceptance Criteria  (required, must have ≥1 parseable AC)
 *   ## Implementation Notes (optional)
 *   ## Dependencies (optional, bullet list of refs)
 *
 * @see _bmad-output/implementation-artifacts/3-4-native-adapter-planner-subagent-and-plan-skill.md § Task 2
 */
export function parseNativeStory(absPath: string, fileContents: string): SourceStory {
  // Normalise CRLF and strip BOM.
  const text = fileContents.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  // H1 — first line matching `# <title>`.
  const h1Idx = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1Idx === -1) {
    throw new MalformedNativeStoryError({
      path: absPath,
      section: "H1",
      reason: "no H1 heading found",
    });
  }
  const h1Line = lines[h1Idx]!;
  const h1Match = /^#\s+(.+?)\s*$/.exec(h1Line);
  if (!h1Match) {
    throw new MalformedNativeStoryError({
      path: absPath,
      section: "H1",
      reason: "H1 heading is empty",
    });
  }
  const title = h1Match[1]!.trim();

  // Split into top-level `## <name>` sections starting after H1.
  const sections = splitTopLevelSections(lines, h1Idx + 1);

  // Narrative (required).
  const narrativeSection = sections.get("Narrative");
  if (!narrativeSection) {
    throw new MalformedNativeStoryError({
      path: absPath,
      section: "## Narrative",
      reason: "missing required '## Narrative' section",
    });
  }
  const narrative = narrativeSection.bodyLines.join("\n").trim();
  // Story 10.2 — the structured narrative `{ role, want, so_that }` parsed from
  // the canonical "As a {role}, I want {want}, so that {so_that}." sentence. The
  // raw `narrative` string above is retained verbatim; this is the structured view.
  const narrative_struct = parseNarrativeStruct(narrative, absPath);

  // Acceptance Criteria (required, ≥1 parseable AC).
  const acSection = sections.get("Acceptance Criteria");
  if (!acSection) {
    throw new MalformedNativeStoryError({
      path: absPath,
      section: "## Acceptance Criteria",
      reason: "missing required '## Acceptance Criteria' section",
    });
  }
  const acceptance_criteria = parseAcceptanceCriteria(acSection.bodyLines, absPath);
  if (acceptance_criteria.length === 0) {
    throw new MalformedNativeStoryError({
      path: absPath,
      section: "## Acceptance Criteria",
      reason: "no parseable AC blocks found under '## Acceptance Criteria'",
    });
  }
  // The set of AC ids this story actually declares, used below to reject a task
  // whose `ac_refs` dangles (names an AC that does not exist in the same story).
  // ACs are parsed in document order, so id = AC<index+1> (mirrors the writer's render).
  const acIds = new Set(acceptance_criteria.map((_, i) => `AC${i + 1}`));

  // Implementation Notes (optional).
  const implSection = sections.get("Implementation Notes");
  const implementation_notes = implSection
    ? implSection.bodyLines.join("\n").trim() || undefined
    : undefined;

  // Tasks (Story 10.2). Parsed when present: each bullet `- <text> (AC: 1, 3)`
  // becomes `{ text, ac_refs: ["AC1", "AC3"] }`. Fail-closed on a task with no
  // AC ref or an `ac_ref` that does not resolve to a parsed AC id in this story.
  // Required-presence (T0-1) is the scan-time validator's job (Story 10.3); the
  // parse here only enforces shape + intra-story ref integrity when the section exists.
  const tasksSection = sections.get("Tasks");
  const tasks = tasksSection ? parseTasks(tasksSection.bodyLines, acIds, absPath) : undefined;

  // Cited Sources (Story 10.2). Parsed when present: a bullet list of
  // repo-relative paths into `cited_sources: string[]`. Throws when the section
  // exists but is empty. On-disk resolvability of each path is T0-5 (Story 10.3).
  const citedSection = sections.get("Cited Sources");
  const cited_sources = citedSection ? parseCitedSources(citedSection.bodyLines, absPath) : undefined;

  // Dependencies (optional, bullet list of refs).
  const depSection = sections.get("Dependencies");
  const depends_on = depSection ? parseDependencies(depSection.bodyLines, absPath) : [];

  const ulid = deriveUlidFromPath(absPath);
  const ref = `native:${ulid}`;

  const source_hash = createHash("sha256").update(fileContents).digest("hex");

  return {
    ref,
    title,
    narrative,
    narrative_struct,
    acceptance_criteria,
    depends_on,
    implementation_notes,
    tasks,
    cited_sources,
    raw_path: absPath,
    raw_frontmatter: { title, ref },
    source_hash,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Section = { name: string; bodyLines: string[] };

function splitTopLevelSections(lines: string[], startIdx: number): Map<string, Section> {
  const out = new Map<string, Section>();
  let current: Section | null = null;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) out.set(current.name, current);
      current = { name: m[1]!, bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) out.set(current.name, current);
  return out;
}

/**
 * A candidate verification-directive line within an AC block.
 *
 * Story 10.1 promotes the already-conventional `vitest: <path>` / `artifact:
 * <path>` marker line to a parsed field. A *candidate* marker is a standalone
 * line of the shape `<token>: <target>` whose leading token is a bare
 * lowercase word (`[a-z][a-z0-9-]*`) — distinct from the Given/When/Then prose,
 * which is written with bold `**Given**` markers and never starts a line with a
 * bare `word:` token. Capturing the token loosely lets the parser reject an
 * unknown type (e.g. `jest:`) with a *named* error rather than silently
 * misreading it as prose and then reporting a confusing "missing directive".
 */
const VERIFICATION_LINE_RE = /^([a-z][a-z0-9-]*):\s*(.*)$/;

/**
 * Parse AC blocks from the body lines of the `## Acceptance Criteria` section.
 *
 * Expected shape per line:
 *   `**AC1:**` or `**AC2 (integration):**`
 * followed by `**Given** … **When** … **Then** …` prose, then exactly one
 * verification line — `vitest: <path>` or `artifact: <path>` (Story 10.1).
 *
 * The `(integration)` parenthetical tag → `kind: "integration"`.
 * Any other tag (including `(user-surface)`) or no tag → `kind: "unit"`.
 */
function parseAcceptanceCriteria(bodyLines: string[], absPath: string): AC[] {
  const headingRe = /^\*\*AC(\d+)(?:\s*\(([^)]+)\))?:\*\*\s*$/;
  const acs: { idx: number; tag: string | undefined; body: string[] }[] = [];
  let current: { idx: number; tag: string | undefined; body: string[] } | null = null;

  for (const raw of bodyLines) {
    const m = headingRe.exec(raw.trim());
    if (m) {
      if (current) acs.push(current);
      current = { idx: parseInt(m[1]!, 10), tag: m[2]?.trim(), body: [] };
      continue;
    }
    if (current) current.body.push(raw);
  }
  if (current) acs.push(current);

  return acs.map((ac) => {
    const cleanedLines = ac.body
      .join("\n")
      .replace(/<!--[\s\S]*?-->/g, "")
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""));

    // Extract the verification-directive line(s). A candidate marker is a
    // standalone `<token>: <target>` line (see VERIFICATION_LINE_RE); the
    // remaining lines are the Given/When/Then prose. Capturing candidates with
    // an unknown type here (rather than leaving them in the prose) lets the
    // parser fail with a *named* type error.
    const verificationLines: { type: string; target: string }[] = [];
    const proseLines: string[] = [];
    for (const line of cleanedLines) {
      const vm = VERIFICATION_LINE_RE.exec(line.trim());
      if (vm) {
        verificationLines.push({ type: vm[1]!, target: vm[2]!.trim() });
        continue;
      }
      proseLines.push(line);
    }

    const text = proseLines.join("\n").trim();

    // Require Given/When/Then prose.
    if (!/\*\*Given\*\*/.test(text) || !/\*\*When\*\*/.test(text) || !/\*\*Then\*\*/.test(text)) {
      throw new MalformedNativeStoryError({
        path: absPath,
        section: `## Acceptance Criteria / AC${ac.idx}`,
        reason: `AC${ac.idx} body must contain **Given**, **When**, and **Then** clauses`,
      });
    }

    // Require exactly one verification line per AC. Story 10.1: fail-closed on
    // absence, wrong type, empty target, or more than one line. (Resolvability
    // of the target — that the path names a real file — is deferred to T0-6,
    // Story 10.3.)
    if (verificationLines.length === 0) {
      throw new MalformedNativeStoryError({
        path: absPath,
        section: `## Acceptance Criteria / AC${ac.idx}`,
        reason:
          `AC${ac.idx} is missing its verification directive — ` +
          `expected exactly one 'vitest: <path>' or 'artifact: <path>' line`,
      });
    }
    if (verificationLines.length > 1) {
      throw new MalformedNativeStoryError({
        path: absPath,
        section: `## Acceptance Criteria / AC${ac.idx}`,
        reason:
          `AC${ac.idx} has ${verificationLines.length} verification directives — ` +
          `expected exactly one 'vitest: <path>' or 'artifact: <path>' line (one AC, one check)`,
      });
    }
    const v = verificationLines[0]!;
    if (v.type !== "vitest" && v.type !== "artifact") {
      throw new MalformedNativeStoryError({
        path: absPath,
        section: `## Acceptance Criteria / AC${ac.idx}`,
        reason:
          `AC${ac.idx} verification directive type '${v.type}' is invalid — ` +
          `expected 'vitest' or 'artifact'`,
      });
    }
    if (v.target.length === 0) {
      throw new MalformedNativeStoryError({
        path: absPath,
        section: `## Acceptance Criteria / AC${ac.idx}`,
        reason: `AC${ac.idx} verification directive '${v.type}:' has an empty target path`,
      });
    }
    const verification: AC["verification"] = {
      type: v.type,
      target: v.target,
    };

    const tag = (ac.tag ?? "").toLowerCase();
    const kind: AC["kind"] = tag === "integration" ? "integration" : "unit";
    return { text, kind, verification };
  });
}

/** Ref patterns accepted in `## Dependencies` bullet items. */
const NATIVE_REF_RE = /^native:[0-9A-HJKMNP-TV-Z]{26}$/;
const BMAD_REF_RE = /^bmad:\d+\.\d+$/;

function parseDependencies(bodyLines: string[], absPath: string): string[] {
  const out: string[] = [];
  for (const line of bodyLines) {
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const ref = m[1]!.trim();
    if (!NATIVE_REF_RE.test(ref) && !BMAD_REF_RE.test(ref)) {
      throw new MalformedNativeStoryError({
        path: absPath,
        section: "## Dependencies",
        reason: `dependency bullet '${ref}' does not parse as a valid ref (expected 'native:<ULID>' or 'bmad:<epic>.<story>')`,
      });
    }
    out.push(ref);
  }
  return out;
}

/**
 * Parse the structured narrative `{ role, want, so_that }` from the canonical
 * "As a {role}, I want {want}, so that {so_that}." sentence (Story 10.2).
 *
 * Grammar is strict and symmetric with `renderNativeStoryBody`'s emission:
 *   `As a <role>, I want <want>, so that <so_that>.`
 * The match is case-insensitive on the connective words and tolerant of an
 * "As an" article and surrounding whitespace, but each of the three captured
 * parts must be non-empty. Anything else throws `MalformedNativeStoryError`.
 */
function parseNarrativeStruct(narrative: string, absPath: string): NarrativeStruct {
  // Collapse internal newlines/whitespace so a wrapped narrative still matches.
  // The comma before "so that" is optional — both "…, I want X, so that Y." and
  // "…, I want X so that Y." are accepted (the latter is the common BMad form).
  const flat = narrative.replace(/\s+/g, " ").trim();
  const m = /^As an? (.+?), I want (.+?),? so that (.+?)\.?$/i.exec(flat);
  if (!m) {
    throw new MalformedNativeStoryError({
      path: absPath,
      section: "## Narrative",
      reason:
        "narrative must be in the form 'As a {role}, I want {want}, so that {so_that}.'",
    });
  }
  const role = m[1]!.trim();
  const want = m[2]!.trim();
  const so_that = m[3]!.trim();
  if (role.length === 0 || want.length === 0 || so_that.length === 0) {
    throw new MalformedNativeStoryError({
      path: absPath,
      section: "## Narrative",
      reason:
        "narrative role/want/so_that parts must each be non-empty in 'As a {role}, I want {want}, so that {so_that}.'",
    });
  }
  return { role, want, so_that };
}

/** Trailing `(AC: 1, 3)` ref clause on a `## Tasks` bullet. */
const TASK_AC_CLAUSE_RE = /\(AC:\s*([^)]*)\)\s*$/;

/**
 * Parse the `## Tasks` section bullets (Story 10.2). Each bullet has the shape
 * `- <text> (AC: 1, 3)`, mapping to `{ text, ac_refs: ["AC1", "AC3"] }`.
 *
 * Fail-closed (`MalformedNativeStoryError`) when:
 *   - a bullet carries no `(AC: …)` clause (a task with no AC ref);
 *   - the clause is empty (`(AC: )`) or names a non-numeric ref;
 *   - an `ac_ref` does not resolve to a parsed AC id in the same story (dangling
 *     ref — the integrity the T0-1 validator later enforces across scan).
 *
 * @param acIds  the set of AC ids the story declares (e.g. `{"AC1","AC2"}`).
 */
function parseTasks(bodyLines: string[], acIds: Set<string>, absPath: string): Task[] {
  const out: Task[] = [];
  for (const line of bodyLines) {
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const bullet = m[1]!.trim();

    const clauseMatch = TASK_AC_CLAUSE_RE.exec(bullet);
    if (!clauseMatch) {
      throw new MalformedNativeStoryError({
        path: absPath,
        section: "## Tasks",
        reason: `task '${bullet}' carries no AC ref — expected a trailing '(AC: <n>, …)' clause`,
      });
    }
    const text = bullet.replace(TASK_AC_CLAUSE_RE, "").trim();
    if (text.length === 0) {
      throw new MalformedNativeStoryError({
        path: absPath,
        section: "## Tasks",
        reason: `task bullet '${bullet}' has no task text before its '(AC: …)' clause`,
      });
    }

    const rawRefs = clauseMatch[1]!
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    if (rawRefs.length === 0) {
      throw new MalformedNativeStoryError({
        path: absPath,
        section: "## Tasks",
        reason: `task '${text}' has an empty AC ref clause '(AC: )' — expected at least one AC number`,
      });
    }

    const ac_refs: string[] = [];
    for (const raw of rawRefs) {
      if (!/^\d+$/.test(raw)) {
        throw new MalformedNativeStoryError({
          path: absPath,
          section: "## Tasks",
          reason: `task '${text}' has a non-numeric AC ref '${raw}' — expected '(AC: 1, 3)'`,
        });
      }
      const acId = `AC${parseInt(raw, 10)}`;
      if (!acIds.has(acId)) {
        throw new MalformedNativeStoryError({
          path: absPath,
          section: "## Tasks",
          reason: `task '${text}' references ${acId}, which does not resolve to any AC in this story`,
        });
      }
      ac_refs.push(acId);
    }

    out.push({ text, ac_refs });
  }
  return out;
}

/**
 * Parse the `## Cited Sources` section (Story 10.2): a bullet list of
 * repo-relative paths into `string[]`. Throws when the section exists but
 * contains no parseable bullet (an empty section). On-disk resolvability of
 * each path is T0-5 (Story 10.3) — not checked here.
 */
function parseCitedSources(bodyLines: string[], absPath: string): string[] {
  const out: string[] = [];
  for (const line of bodyLines) {
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const cited = m[1]!.trim();
    if (cited.length === 0) continue;
    out.push(cited);
  }
  if (out.length === 0) {
    throw new MalformedNativeStoryError({
      path: absPath,
      section: "## Cited Sources",
      reason: "'## Cited Sources' section is present but empty — expected ≥1 repo-relative path bullet",
    });
  }
  return out;
}

/**
 * Derive the ULID from the file's basename. The native adapter uses the
 * bare ULID as the filename (`<ULID>.md`) and the colonised form
 * (`native:<ULID>`) as the ref. The parser recovers the ref from the path
 * so there is no ambiguity.
 */
function deriveUlidFromPath(absPath: string): string {
  const base = absPath.split("/").pop() ?? absPath;
  const m = /^([0-9A-HJKMNP-TV-Z]{26})\.md$/.exec(base);
  if (!m) {
    throw new MalformedNativeStoryError({
      path: absPath,
      section: "filename",
      reason: `filename '${base}' does not match the native-story ULID pattern (<26-char ULID>.md)`,
    });
  }
  return m[1]!;
}
