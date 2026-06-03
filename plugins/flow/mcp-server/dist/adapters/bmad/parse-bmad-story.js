import { createHash } from "node:crypto";
import * as path from "node:path";
import { MalformedBmadStoryError } from "../../errors.js";
import { mapBmadStatusToExecution } from "./map-bmad-status.js";
/**
 * Pure BMad story parser — no I/O. The caller (the adapter's
 * `listSourceStories`/`readSourceStory`) is responsible for reading the
 * file and passing the bytes in.
 *
 * See {@link plugins/flow/docs/spikes/bmad-format.md} for the source
 * shape this parser handles.
 */
export function parseBmadStory(absPath, fileContents) {
    const filename = path.basename(absPath);
    const filenameMatch = /^(\d+)-(\d+)-([a-z0-9-]+)\.md$/.exec(filename);
    if (!filenameMatch) {
        throw new MalformedBmadStoryError({
            path: absPath,
            reason: `filename '${filename}' does not match <epic>-<story>-<slug>.md`,
            details: { filename },
        });
    }
    const epicFromName = filenameMatch[1];
    const storyFromName = filenameMatch[2];
    const slug = filenameMatch[3];
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
    const h1Line = lines[h1Idx];
    const h1Match = /^#\s+Story\s+(\d+)\.(\d+)\s*:\s*(.+?)\s*$/.exec(h1Line);
    if (!h1Match) {
        throw new MalformedBmadStoryError({
            path: absPath,
            reason: `H1 '${h1Line}' does not match '# Story <epic>.<story>: <title>'`,
            details: { h1: h1Line },
        });
    }
    const epicFromH1 = h1Match[1];
    const storyFromH1 = h1Match[2];
    const title = h1Match[3].trim();
    if (epicFromH1 !== epicFromName || storyFromH1 !== storyFromName) {
        throw new MalformedBmadStoryError({
            path: absPath,
            reason: `H1 numbering ${epicFromH1}.${storyFromH1} disagrees with ` +
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
    let statusValue;
    for (let i = h1Idx + 1; i < lines.length; i++) {
        const m = /^Status:\s*(\S.*?)\s*$/.exec(lines[i]);
        if (m) {
            statusValue = m[1];
            break;
        }
        // Stop scanning after the first section heading — Status must come early.
        if (/^##\s/.test(lines[i]))
            break;
    }
    if (statusValue === undefined) {
        throw new MalformedBmadStoryError({
            path: absPath,
            reason: "no 'Status: <value>' line found between H1 and the first section heading",
        });
    }
    // Validate against the known vocabulary. mapBmadStatusToExecution
    // returns null only when we want the caller to skip; an unknown
    // string returns undefined to signal "throw".
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
    // Acceptance criteria.
    const acSection = sections.get("Acceptance Criteria");
    const acceptance_criteria = acSection ? parseAcceptanceCriteria(acSection, absPath) : [];
    // Dependencies.
    const depSection = sections.get("Dependencies");
    const depends_on = depSection ? parseDependencies(depSection) : [];
    // Implementation notes.
    const implSection = sections.get("Dev Notes") ?? sections.get("Implementation Notes");
    const implementation_notes = implSection
        ? implSection.bodyLines.join("\n").trim() || undefined
        : undefined;
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
    let shipGate;
    for (let i = h1Idx + 1; i < lines.length; i++) {
        const line = lines[i];
        const m = /^[Tt]ags?:\s*(.+?)\s*$/.exec(line);
        if (m) {
            const tagsRaw = m[1].toLowerCase();
            if (tagsRaw.includes("ship-gate")) {
                shipGate = true;
            }
            break;
        }
        if (/^##\s/.test(line))
            break;
    }
    const raw_frontmatter = {
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
function isKnownBmadStatus(s) {
    return (s === "backlog" ||
        s === "ready-for-dev" ||
        s === "in-progress" ||
        s === "done" ||
        s === "optional" ||
        s === "contexted" ||
        s === "draft" ||
        s === "approved" ||
        s === "review");
}
// Re-export the execution mapping so the adapter has a single import surface.
export { mapBmadStatusToExecution };
function splitTopLevelSections(lines, startIdx) {
    const out = new Map();
    let current = null;
    for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        const m = /^##\s+(.+?)\s*$/.exec(line);
        if (m) {
            // Push prior.
            if (current)
                out.set(current.name, current);
            current = { name: m[1], bodyLines: [] };
            continue;
        }
        if (current)
            current.bodyLines.push(line);
    }
    if (current)
        out.set(current.name, current);
    return out;
}
function extractNarrativeFromStorySection(section) {
    // Walk lines; stop emitting once we hit a `### ` heading.
    const out = [];
    for (const line of section.bodyLines) {
        if (/^###\s/.test(line))
            break;
        out.push(line.replace(/\s+$/, ""));
    }
    return out.join("\n").trim();
}
function parseAcceptanceCriteria(section, absPath) {
    // AC headings look like `**AC1:**`, `**AC2 (user-surface):**`, or
    // `**AC3 — descriptive title:**` (the descriptive token between em-dashes is
    // documentation only and is discarded by this parser).
    // We split on lines that match the heading shape.
    const headingRe = /^\*\*AC(\d+)(?:\s+—\s+[^()]*?)?(?:\s*\(([^)]+)\))?:\*\*\s*$/;
    const acs = [];
    let current = null;
    for (const raw of section.bodyLines) {
        const m = headingRe.exec(raw);
        if (m) {
            if (current)
                acs.push(current);
            current = { idx: parseInt(m[1], 10), tag: m[2]?.trim(), body: [] };
            continue;
        }
        if (current)
            current.body.push(raw);
    }
    if (current)
        acs.push(current);
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
        const kind = tag === "integration" || tag === "user-surface" ? "integration" : "unit";
        return { text, kind };
    });
}
function parseDependencies(section) {
    const out = [];
    for (const line of section.bodyLines) {
        const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
        if (!m)
            continue;
        const ref = normaliseDepRef(m[1]);
        if (ref)
            out.push(ref);
    }
    return out;
}
function normaliseDepRef(raw) {
    // Accept `bmad:<epic>.<story>` directly.
    const direct = /^bmad:(\d+)\.(\d+)\b/.exec(raw);
    if (direct)
        return `bmad:${direct[1]}.${direct[2]}`;
    // Accept `<epic>-<story>-<slug>` (slug optional).
    const fileStyle = /^(\d+)-(\d+)(?:-[a-z0-9-]+)?\b/.exec(raw);
    if (fileStyle)
        return `bmad:${fileStyle[1]}.${fileStyle[2]}`;
    return null;
}
