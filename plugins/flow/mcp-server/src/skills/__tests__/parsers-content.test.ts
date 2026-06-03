/**
 * Content-structure tests for AC5 anchors — Story 4.3 Task 11.2 (parsers only).
 *
 * Reads the source files for the two parser modules and asserts
 * that the verbatim anchor strings required by their specs are present.
 *
 * Note: dev-reviewer-cycle.ts was deleted in Story 4.3b. Its chat-line anchors
 * have moved to the new processor tools; those are tested in
 * `src/tools/__tests__/processors-content.test.ts`.
 *
 * AC5(i):   `handoff-parser.ts` exports `HANDOFF_PHRASE_TEMPLATE` with verbatim value.
 * AC5(ii):  `verdict-parser.ts` exports `VERDICT_SENTINELS` containing all three sentinels.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(HERE, ".."); // src/skills/

const HANDOFF_PARSER_FILE = path.join(SKILLS_DIR, "handoff-parser.ts");
const VERDICT_PARSER_FILE = path.join(SKILLS_DIR, "verdict-parser.ts");

describe("AC5(i) — handoff-parser.ts content structure", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(HANDOFF_PARSER_FILE, "utf8");
  });

  it("exports HANDOFF_PHRASE_TEMPLATE with the verbatim locked-phrase value", () => {
    // The exact substring the AC requires.
    expect(source).toContain(
      `HANDOFF_PHRASE_TEMPLATE = "Handoff to reviewer — story <story-id> ready for review."`,
    );
  });
});

describe("AC5(ii) — verdict-parser.ts content structure", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(VERDICT_PARSER_FILE, "utf8");
  });

  it("contains the string 'READY FOR MERGE' as a literal value", () => {
    expect(source).toContain('"READY FOR MERGE"');
  });

  it("contains the string 'NEEDS CHANGES' as a literal value", () => {
    expect(source).toContain('"NEEDS CHANGES"');
  });

  it("contains the string 'BLOCKED' as a literal value", () => {
    expect(source).toContain('"BLOCKED"');
  });
});
