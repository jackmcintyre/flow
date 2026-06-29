import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { MalformedBmadStoryError } from "../../errors.js";
import type { AC, SourceStory } from "../adapter.js";
import type { BmadStatus } from "./map-bmad-status.js";
import { deriveBmadAcVerification } from "./derive-bmad-ac-verification.js";

/**
 * Optional inputs to {@link parseBmadStory}.
 *
 * `repoRoot` (Story native:01KW5W081X3TJPQBCYF3WAK9RZ) arms per-AC verification
 * derivation: when present, each AC for which a real test or artifact target can
 * be derived from the story's own signals carries that marker, resolved against
 * `repoRoot` on disk. When absent the parser stays the original pure, no-I/O
 * function and every AC's `verification` is left `undefined`. The adapter passes
 * its bound `targetRepo`; tests that exercise pure parsing omit it.
 */
export interface ParseBmadStoryOptions {
  repoRoot?: string;
}

/**
 * BMad story parser. Pure (no I/O) UNLESS `opts.repoRoot` is supplied, in which
 * case per-AC verification markers are derived and resolved against that tree
 * (Story native:01KW5W081X3TJPQBCYF3WAK9RZ). The caller (the adapter's
 * `listSourceStories`/`readSourceStory`) reads the file and passes the bytes in.
 *
 * See {@link plugins/flow/docs/spikes/bmad-format.md} for the source
 * shape this parser handles.
 */
export function parseBmadStory(
  absPath: string,
  fileContents: string,
  opts: ParseBmadStoryOptions = {},
): SourceStory {
  const filename = path.basename(absPath);
  const filenameMatch = /^(\d+)-(\d+)-([a-z0-9-]+)\.md$/.exec(filename);
  if (!filenameMatch) {
    throw new MalformedBmadStoryError({
      path: absPath,
      reason: `filename '${filename}' does not match <epic>-<story>-<slug>.md`,
      details: { filename },
    });
  }
  const epicFromName = filenameMatch[1]!;
  const storyFromName = filenameMatch[2]!;
  const slug = filenameMatch[3]!;

  // Strip a leading BOM if present, normalise CRLF -> LF.
  const text = fileContents.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  // H1 — first line that starts with "# ".
  const h1Idx = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1Idx === -1) {
    throw new MalformedBmadStoryError({
      path: absPath,
      reason: "no H1 heading found",
    });
  }
  const h1Line = lines[h1Idx]!;
  const h1Match = /^#\s+Story\s+(\d+)\.(\d+)\s*:\s*(.+?)\s*$/.exec(h1Line);
  if (!h1Match) {
    throw new MalformedBmadStoryError({
      path: absPath,
      reason: `H1 '${h1Line}' does not match '# Story <epic>.<story>: <title>'`,
      details: { h1: h1Line },
    });
  }
  const epicFromH1 = h1Match[1]!;
  const storyFromH1 = h1Match[2]!;
  const title = h1Match[3]!.trim();
  if (epicFromH1 !== epicFromName || storyFromH1 !== storyFromName) {
    throw new MalformedBmadStoryError({
      path: absPath,
      reason:
        `H1 numbering ${epicFromH1}.${storyFromH1} disagrees with ` +
        `filename ${epicFromName}.${storyFromName}`,
      details: {
        h1Epic: epicFromH1,
        h1Story: storyFromH1,
        filenameEpic: epicFromName,
        filenameStory: storyFromName,
      },
    });
  }

  // Status line — first line matching `Status: <value>` after the H1.
  let statusValue: string | undefined;
  for (let i = h1Idx + 1; i < lines.length; i++) {
    const m = /^Status:\s*(\S.*?)\s*$/.exec(lines[i]!);
    if (m) {
      statusValue = m[1]!;
      break;
    }
    // Stop scanning after the first section heading — Status must come early.
    if (/^##\s/.test(lines[i]!)) break;
  }
  if (statusValue === undefined) {
    throw new MalformedBmadStoryError({
      path: absPath,
      reason: "no 'Status: <value>' line found between H1 and the first section heading",
    });
  }
  // Validate against the known vocabulary. An unknown status value signals "throw".
  if (!isKnownBmadStatus(statusValue)) {
    throw new MalformedBmadStoryError({
      path: absPath,
      reason: `unknown Status value '${statusValue}'`,
      details: { status: statusValue },
    });
  }

  // Split into top-level sections keyed by `## <name>` headings.
  const sections = splitTopLevelSections(lines, h1Idx + 1);

  // Narrative: body of `## Story`, excluding any `### *` subsections.
  const storySection = sections.get("Story");
  const narrative = storySection ? extractNarrativeFromStorySection(storySection) : "";

  // Implementation notes — extracted BEFORE the acceptance criteria so they can
  // be mined for per-AC verification derivation (Story native:01KW5W081X3TJPQBCYF3WAK9RZ).
  const implSection = sections.get("Dev Notes") ?? sections.get("Implementation Notes");
  const implementation_notes = implSection
    ? implSection.bodyLines.join("\n").trim() || undefined
    : undefined;

  // Acceptance criteria. When `opts.repoRoot` is supplied, derive a per-AC
  // verification marker (resolved against that tree); otherwise leave it undefined.
  const acSection = sections.get("Acceptance Criteria");
  const acceptance_criteria = acSection
    ? parseAcceptanceCriteria(acSection, absPath, {
        implementationNotes: implementation_notes,
        epic: epicFromName,
        story: storyFromName,
        slug,
        repoRoot: opts.repoRoot,
      })
    : [];

  // Dependencies.
  const depSection = sections.get("Dependencies");
  const depends_on = depSection ? parseDependencies(depSection) : [];

  // Ship-gate detection (Story 3.5 Task 4.1).
  // BMad stories can be tagged as ship-gate via a `tags:` frontmatter line
  // (if present) or a YAML block before the H1. In practice, BMad story files
  // in v1 do not include YAML front-matter blocks; the "tags" field is typically
  // embedded as a Status-style line. We look for any `Tags:` or `tags:` line
  // containing the literal substring "ship-gate" (case-insensitive) in the
  // preamble before the first section heading.
  //
  // If no such tag is found, `ship_gate` is set to `undefined` — ship-gate
  // detection for BMad stories is operator-driven in v1. A future story may
  // light up full BMad-side ship-gate enforcement without re-touching this parser.
  let shipGate: true | undefined;
  for (let i = h1Idx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^[Tt]ags?:\s*(.+?)\s*$/.exec(line);
    if (m) {
      const tagsRaw = m[1]!.toLowerCase();
      if (tagsRaw.includes("ship-gate")) {
        shipGate = true;
      }
      break;
    }
    if (/^##\s/.test(line)) break;
  }

  const raw_frontmatter: Record<string, unknown> = {
    status: statusValue,
    title,
    id: `${epicFromName}.${storyFromName}`,
    filename_slug: slug,
    ...(shipGate !== undefined ? { ship_gate: shipGate } : {}),
  };

  const source_hash = createHash("sha256").update(fileContents).digest("hex");

  return {
    ref: `bmad:${epicFromName}.${storyFromName}`,
    title,
    narrative,
    acceptance_criteria,
    depends_on,
    implementation_notes,
    raw_path: absPath,
    raw_frontmatter,
    source_hash,
  };
}

function isKnownBmadStatus(s: string): s is BmadStatus {
  return (
    s === "backlog" ||
    s === "ready-for-dev" ||
    s === "in-progress" ||
    s === "done" ||
    s === "optional" ||
    s === "contexted" ||
    s === "draft" ||
    s === "approved" ||
    s === "review"
  );
}


type Section = { name: string; bodyLines: string[] };

function splitTopLevelSections(lines: string[], startIdx: number): Map<string, Section> {
  const out = new Map<string, Section>();
  let current: Section | null = null;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      // Push prior.
      if (current) out.set(current.name, current);
      current = { name: m[1]!, bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) out.set(current.name, current);
  return out;
}

function extractNarrativeFromStorySection(section: Section): string {
  // Walk lines; stop emitting once we hit a `### ` heading.
  const out: string[] = [];
  for (const line of section.bodyLines) {
    if (/^###\s/.test(line)) break;
    out.push(line.replace(/\s+$/, ""));
  }
  return out.join("\n").trim();
}

/**
 * Per-AC verification derivation context (Story native:01KW5W081X3TJPQBCYF3WAK9RZ).
 * `repoRoot` undefined → no derivation (pure mode); every AC's verification stays
 * `undefined`.
 */
interface AcDerivationContext {
  implementationNotes: string | undefined;
  epic: string;
  story: string;
  slug: string;
  repoRoot: string | undefined;
}

function parseAcceptanceCriteria(
  section: Section,
  absPath: string,
  derivation: AcDerivationContext,
): AC[] {
  // AC headings look like `**AC1:**`, `**AC2 (user-surface):**`, or
  // `**AC3 — descriptive title:**` (the descriptive token between em-dashes is
  // documentation only and is discarded by this parser).
  // We split on lines that match the heading shape.
  const headingRe = /^\*\*AC(\d+)(?:\s+—\s+[^()]*?)?(?:\s*\(([^)]+)\))?:\*\*\s*$/;
  const acs: { idx: number; tag: string | undefined; body: string[] }[] = [];
  let current: { idx: number; tag: string | undefined; body: string[] } | null = null;
  for (const raw of section.bodyLines) {
    const m = headingRe.exec(raw);
    if (m) {
      if (current) acs.push(current);
      current = { idx: parseInt(m[1]!, 10), tag: m[2]?.trim(), body: [] };
      continue;
    }
    if (current) current.body.push(raw);
  }
  if (current) acs.push(current);

  if (acs.length === 0) {
    throw new MalformedBmadStoryError({
      path: absPath,
      reason: "## Acceptance Criteria section contains no recognisable **AC<n>:** headings",
    });
  }

  return acs.map((ac) => {
    // Strip HTML comments. Strip trailing whitespace per line.
    const text = ac.body
      .join("\n")
      .replace(/<!--[\s\S]*?-->/g, "")
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .join("\n")
      .trim();
    const tag = (ac.tag ?? "").toLowerCase();
    const kind: AC["kind"] = tag === "integration" || tag === "user-surface" ? "integration" : "unit";

    // Story native:01KW5W081X3TJPQBCYF3WAK9RZ — derive a verification marker from
    // the story's own signals, but ONLY when a repoRoot is supplied (the adapter
    // path) AND the derived target resolves on disk. A non-resolving (or absent)
    // derivation leaves `verification` undefined → the reviewer falls back to
    // manual verification rather than chasing a fabricated path.
    const repoRoot = derivation.repoRoot;
    if (repoRoot === undefined) {
      return { text, kind };
    }
    const verification = deriveBmadAcVerification({
      kind,
      acBodyText: text,
      implementationNotes: derivation.implementationNotes,
      epic: derivation.epic,
      story: derivation.story,
      slug: derivation.slug,
      exists: (relPath) => existsSync(path.join(repoRoot, relPath)),
    });
    return verification ? { text, kind, verification } : { text, kind };
  });
}

function parseDependencies(section: Section): string[] {
  const out: string[] = [];
  for (const line of section.bodyLines) {
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const ref = normaliseDepRef(m[1]!);
    if (ref) out.push(ref);
  }
  return out;
}

function normaliseDepRef(raw: string): string | null {
  // Accept `bmad:<epic>.<story>` directly.
  const direct = /^bmad:(\d+)\.(\d+)\b/.exec(raw);
  if (direct) return `bmad:${direct[1]}.${direct[2]}`;
  // Accept `<epic>-<story>-<slug>` (slug optional).
  const fileStyle = /^(\d+)-(\d+)(?:-[a-z0-9-]+)?\b/.exec(raw);
  if (fileStyle) return `bmad:${fileStyle[1]}.${fileStyle[2]}`;
  return null;
}
