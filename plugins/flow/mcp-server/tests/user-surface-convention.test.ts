/**
 * User-surface convention contract test (Story 1.8 AC1).
 *
 * AC1's mechanism is NOT a direct edit to the gitignored `bmad-create-story`
 * skill. Instead the convention is delivered via two checked-in artefacts:
 *
 *   `plugins/flow/docs/user-surface-acs.md` — the canonical, author-facing
 *   reference (the four-rubric definition, the tag syntax, the regex,
 *   tagged and untagged examples, the gate's pass/fail semantics).
 *
 * This suite pins the contract on that doc: presence of the key strings,
 * the regex, the four rubric items, and an example of each tagged/untagged AC.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const CONVENTION_DOC = resolve(REPO_ROOT, "plugins/flow/docs/user-surface-acs.md");

describe("user-surface convention doc (Story 1.8 AC1, artefact 1)", () => {
  const doc = readFileSync(CONVENTION_DOC, "utf8");

  it("exists and is non-empty at the canonical path", () => {
    expect(doc.length).toBeGreaterThan(0);
  });

  it("defines the four-rubric definition of a user-surface AC", () => {
    // (i) slash command, (ii) CLI command, (iii) file path the user copies/opens,
    // (iv) Claude Code UI element the user observes.
    expect(doc).toMatch(/\(i\)[^\n]*slash command/i);
    expect(doc).toMatch(/\(ii\)[^\n]*CLI command/i);
    expect(doc).toMatch(/\(iii\)[^\n]*file path/i);
    expect(doc).toMatch(/\(iv\)[^\n]*Claude Code UI/i);
  });

  it("pins the tag-extraction regex used by the gate", () => {
    expect(doc).toContain(
      "^\\*\\*AC(\\d+)\\s*\\(user-surface\\)\\s*:\\*\\*",
    );
  });

  it("shows the canonical tag syntax `**AC<n> (user-surface):**`", () => {
    expect(doc).toMatch(/\*\*AC1 \(user-surface\):\*\*/);
  });

  it("shows at least one tagged example AND at least one untagged example", () => {
    // Tagged example must be present.
    expect(doc).toMatch(/\*\*AC\d+ \(user-surface\):\*\*/);
    // Untagged example: an AC line without `(user-surface)`. The doc body
    // explicitly contrasts a tagged AC with an untagged one.
    expect(doc).toMatch(/Not user-surface|no tag|MUST NOT carry|absent/i);
    // And a concrete `**AC<n>:**` (no parenthetical) appears in the examples.
    expect(doc).toMatch(/\n\*\*AC\d+:\*\*/);
  });

  it("documents the gate's pass/fail semantics including USER_SURFACE_UNVERIFIED / exit 42", () => {
    expect(doc).toMatch(/USER_SURFACE_UNVERIFIED|exit[s]?\s*`?42`?/);
    expect(doc).toMatch(/skipped/);
    expect(doc).toMatch(/passed/);
  });

  it("names both verification routes (automated and operator)", () => {
    expect(doc).toContain("automated_e2e_verified");
    expect(doc).toContain("user_surface_verified");
  });
});
