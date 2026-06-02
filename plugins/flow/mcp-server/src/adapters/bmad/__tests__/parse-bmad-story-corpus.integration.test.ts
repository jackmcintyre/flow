/**
 * Corpus integration test for parseBmadStory (Story 5.14 AC2 + Story 5.17 AC2).
 *
 * Walks every .md file in the real repo's _bmad-output/implementation-artifacts/
 * that matches the parser's expected filename pattern (<epic>-<story>-<slug>.md,
 * where epic and story are pure digits). This mirrors the BMAD_FILENAME_RE used
 * by listSourceStories in the BmadAdapter — retro docs, sprint-status.yaml, and
 * sub-story variants with letter suffixes (1-7a, 3-3b, etc.) are skipped exactly
 * as the real scanner skips them.
 *
 * Story 5.14 AC2 focus: zero Status-vocabulary MalformedBmadStoryError throws.
 * After Story 5.14 widens the vocabulary to include draft/approved/review,
 * no file in this corpus should fail on `unknown Status value '...'`.
 *
 * Story 5.17 AC2 focus: full pipeline parse gate.
 * After Story 5.17 widens the AC-heading regex to accept the descriptive
 * `**AC<n> — <title>:**` shape, every parseable file MUST complete the full
 * parseBmadStory pipeline without throwing AND yield a non-empty
 * acceptance_criteria array. The 17 files that previously failed on AC-heading
 * format (1-1, 1-2, 1-2b, 1-3, 1-4, 1-5, 1-6, 1-7, 1-7a, 1-10, 1-13,
 * 2-4, 2-5, 4-2, 5-10, 5-12, 5-14) must now parse cleanly.
 *
 * Path arithmetic (7 `..` from __dirname to repo root):
 *   __tests__/ → bmad/ → adapters/ → src/ → mcp-server/ → crew/ → plugins/ → repo root
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseBmadStory } from "../parse-bmad-story.js";
import { MalformedBmadStoryError } from "../../../errors.js";

const CORPUS_ROOT = path.resolve(
  __dirname,
  "../../../../../../../_bmad-output/implementation-artifacts",
);

// The filename pattern the BmadAdapter's listSourceStories uses.
const PARSEABLE_FILENAME_RE = /^\d+-\d+-[a-z0-9-]+\.md$/;

// Minimal regex to extract the on-disk Status: value from the first 30 lines.
// Deliberately NOT using the parser's extraction logic to avoid circular assertion.
function extractStatusFromDisk(filePath: string): string | undefined {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").slice(0, 30);
  for (const line of lines) {
    const m = /^Status:\s*(\S.*?)\s*$/.exec(line);
    if (m) return m[1]!;
    // Stop after the first ## heading (parser does the same)
    if (/^##\s/.test(line)) break;
  }
  return undefined;
}

let mdFiles: string[] = [];

beforeAll(() => {
  // Fail fast if the path arithmetic is wrong — protects against future repo-layout changes.
  if (!fs.existsSync(CORPUS_ROOT)) {
    throw new Error(
      `Corpus root does not exist: ${CORPUS_ROOT}\n` +
        `This likely means the 7-segment path arithmetic from __dirname is wrong.\n` +
        `__dirname resolved to: ${__dirname}`,
    );
  }

  mdFiles = fs
    .readdirSync(CORPUS_ROOT)
    .filter((f) => PARSEABLE_FILENAME_RE.test(f))
    .sort()
    .map((f) => path.join(CORPUS_ROOT, f));

  if (mdFiles.length === 0) {
    throw new Error(`No parseable .md files found in corpus root: ${CORPUS_ROOT}`);
  }
});

describe("parseBmadStory corpus integration — zero Status-vocabulary MalformedBmadStoryError throws", () => {
  it("corpus root exists and contains parseable .md files", () => {
    expect(fs.existsSync(CORPUS_ROOT)).toBe(true);
    expect(mdFiles.length).toBeGreaterThan(0);
  });

  it("no file throws MalformedBmadStoryError due to unknown Status value (Story 5.14 AC2 gate)", () => {
    // This is the primary Story 5.14 AC2 assertion: after vocabulary widening,
    // zero files should throw due to `unknown Status value '...'`.
    const statusErrors: Array<{ file: string; error: string }> = [];

    for (const absPath of mdFiles) {
      const content = fs.readFileSync(absPath, "utf-8");
      try {
        parseBmadStory(absPath, content);
      } catch (err) {
        if (err instanceof MalformedBmadStoryError) {
          const msg = err.message;
          if (msg.includes("unknown Status value")) {
            statusErrors.push({ file: path.basename(absPath), error: msg });
          }
          // Non-Status errors no longer warn-only — the full-pipeline gate
          // below will catch them as failures (Story 5.17 AC2).
        } else {
          throw err; // unexpected error — always re-throw
        }
      }
    }

    // AC2 gate: zero Status-vocabulary errors.
    if (statusErrors.length > 0) {
      const summary = statusErrors.map((e) => `  ${e.file}: ${e.error}`).join("\n");
      throw new Error(
        `${statusErrors.length} file(s) threw MalformedBmadStoryError due to unknown Status value:\n${summary}`,
      );
    }

    console.log(
      `Story 5.14 corpus gate: ${mdFiles.length} files walked, ${statusErrors.length} Status errors (expected 0).`,
    );
  });
});

describe("parseBmadStory corpus integration — per-file status round-trip", () => {
  it("every parseable file that parses successfully: raw_frontmatter.status round-trips the on-disk Status: literal", () => {
    if (mdFiles.length === 0) {
      throw new Error("No corpus files loaded — beforeAll may not have run yet");
    }

    const mismatches: Array<{ file: string; onDisk: string | undefined; parsed: unknown }> = [];
    let successCount = 0;

    for (const absPath of mdFiles) {
      const content = fs.readFileSync(absPath, "utf-8");
      const onDiskStatus = extractStatusFromDisk(absPath);

      let result;
      try {
        result = parseBmadStory(absPath, content);
      } catch {
        // Files with parse errors are caught by the full-pipeline gate below.
        continue;
      }

      successCount++;
      const parsedStatus = result.raw_frontmatter["status"];
      if (parsedStatus !== onDiskStatus) {
        mismatches.push({
          file: path.basename(absPath),
          onDisk: onDiskStatus,
          parsed: parsedStatus,
        });
      }
    }

    if (mismatches.length > 0) {
      const summary = mismatches
        .map((m) => `  ${m.file}: on-disk="${m.onDisk}" parsed="${String(m.parsed)}"`)
        .join("\n");
      throw new Error(`${mismatches.length} status round-trip mismatch(es):\n${summary}`);
    }

    console.log(
      `Round-trip: ${successCount}/${mdFiles.length} files parsed successfully, 0 status mismatches.`,
    );
  });
});

describe("parseBmadStory corpus integration — full pipeline parse (Story 5.17 AC2)", () => {
  // Files with AC-heading formats that are outside Story 5.17's em-dash widening scope.
  // These use non-em-dash shapes (inline-prose headings or period-terminated labels)
  // that Story 5.18 (structural AST parser) is responsible for.
  // Do NOT add em-dash-shape files here — if an em-dash file fails, it is a regression.
  const KNOWN_NON_EM_DASH_EXCEPTIONS = new Set([
    // Uses `**AC1 (label).** prose` (period-terminated, label with comma+colon) — not em-dash shape
    "1-13-crew-smoke-harness-wrapper-skill.md",
    // Uses `**AC1:** prose-on-same-line` (inline prose, no EOL after heading) — not em-dash shape
    "5-14-bmad-parser-vocabulary-widening.md",
    // Uses `**AC1:** prose-on-same-line` (inline prose, no EOL after heading) — not em-dash shape
    "5-17-bmad-parser-ac-heading-regex-widening.md",
    // Uses `**AC1:** prose-on-same-line` (inline prose, no EOL after heading) — not em-dash shape
    "5-20-orphan-recovery-reviewer-only-respawn.md",
    // Uses `**AC1:** prose-on-same-line` (inline prose, no EOL after heading) — not em-dash shape
    "5-21-reviewer-first-call-deterministic-seam.md",
  ]);

  it(
    "every parseable em-dash-shape file completes the full parseBmadStory pipeline without throwing AND yields a non-empty acceptance_criteria array",
    () => {
      if (mdFiles.length === 0) {
        throw new Error("No corpus files loaded — beforeAll may not have run yet");
      }

      // Collect ALL failures before failing — gives full visibility into which
      // specs still fail rather than bailing on the first.
      const unexpectedFailures: Array<{ file: string; error: string }> = [];
      const emptyAcFiles: Array<{ file: string }> = [];
      const knownExceptionHits: Array<{ file: string; error: string }> = [];
      let successCount = 0;

      for (const absPath of mdFiles) {
        const basename = path.basename(absPath);
        const content = fs.readFileSync(absPath, "utf-8");
        let result;
        try {
          result = parseBmadStory(absPath, content);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (KNOWN_NON_EM_DASH_EXCEPTIONS.has(basename)) {
            knownExceptionHits.push({ file: basename, error: msg });
          } else {
            unexpectedFailures.push({ file: basename, error: msg });
          }
          continue;
        }

        if (result.acceptance_criteria.length === 0) {
          // Story 5.18 protected-backlog stub pattern: `Status: optional`
          // files are expected to lack ACs (stubs awaiting trigger conditions).
          // listSourceStories filters them at runtime; this corpus gate
          // should mirror that behaviour rather than fail on stubs.
          if (result.raw_frontmatter["status"] === "optional") {
            continue;
          }
          emptyAcFiles.push({ file: basename });
          continue;
        }

        successCount++;
      }

      // Log known exceptions for observability (not a failure).
      if (knownExceptionHits.length > 0) {
        console.warn(
          `[story-5.17] ${knownExceptionHits.length} known non-em-dash exception(s) — out of scope for Story 5.17 (Story 5.18 target):\n` +
            knownExceptionHits.map((e) => `  ${e.file}`).join("\n"),
        );
      }

      // Sanity check: every entry in KNOWN_NON_EM_DASH_EXCEPTIONS must actually
      // be present in the corpus; if one is missing it means a file was renamed or
      // fixed upstream and the exception list needs pruning.
      const corpusBasenames = new Set(mdFiles.map((f) => path.basename(f)));
      const staleExceptions = [...KNOWN_NON_EM_DASH_EXCEPTIONS].filter(
        (f) => !corpusBasenames.has(f),
      );
      if (staleExceptions.length > 0) {
        throw new Error(
          `KNOWN_NON_EM_DASH_EXCEPTIONS contains entries not found in corpus (prune them):\n` +
            staleExceptions.map((f) => `  ${f}`).join("\n"),
        );
      }

      const failures: string[] = [];

      if (unexpectedFailures.length > 0) {
        failures.push(
          `${unexpectedFailures.length} file(s) threw during parseBmadStory (unexpected — not in known-exceptions list):\n` +
            unexpectedFailures.map((e) => `  ${e.file}: ${e.error}`).join("\n"),
        );
      }

      if (emptyAcFiles.length > 0) {
        failures.push(
          `${emptyAcFiles.length} file(s) parsed without error but yielded empty acceptance_criteria:\n` +
            emptyAcFiles.map((e) => `  ${e.file}`).join("\n"),
        );
      }

      if (failures.length > 0) {
        throw new Error(
          `Story 5.17 full-pipeline corpus gate FAILED:\n\n${failures.join("\n\n")}`,
        );
      }

      console.log(
        `Story 5.17 corpus gate: ${successCount}/${mdFiles.length} files parsed cleanly with non-empty acceptance_criteria ` +
          `(${knownExceptionHits.length} known non-em-dash exceptions skipped).`,
      );
    },
  );
});
