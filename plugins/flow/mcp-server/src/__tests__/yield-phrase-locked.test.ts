/**
 * Catalogue locked-phrase anchor test — Story 4.11 Task 6.4 / Task 8.3.
 *
 * Asserts that every shipped catalogue file's `locked_phrases.yield` value
 * equals `YIELD_PHRASE_TEMPLATE` (imported from yield-parser.ts). This pins
 * the lock against accidental drift.
 *
 * The catalogue list is enumerated explicitly (no glob). Adding a new
 * catalogue persona requires a deliberate edit to this test, which is the
 * right friction.
 *
 * Story 4.11 AC1 (token rename <role> → <domain> + trailing period).
 */

import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";
import { splitFrontmatter } from "../lib/markdown-frontmatter.js";
import { YIELD_PHRASE_TEMPLATE } from "../skills/yield-parser.js";

// Resolve the catalogue directory relative to this test file.
// This file is at: plugins/flow/mcp-server/src/__tests__/yield-phrase-locked.test.ts
// Catalogue is at: plugins/flow/catalogue/
// Traverse: __tests__(1) → src(2) → mcp-server(3) → crew (plugin root) → catalogue
const CATALOGUE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "catalogue",
);

// All shipped catalogue files that carry locked_phrases.yield
const ALL_CATALOGUE_ROLES = [
  "generalist-dev",
  "generalist-reviewer",
  "planner",
  "hiring-manager",
  "orchestrator",
  "retro-analyst",
  "security-specialist",
  "test-specialist",
  "docs-specialist",
  "debugger",
  "author",
] as const;

async function readLockedYield(role: string): Promise<string | undefined> {
  const filePath = path.join(CATALOGUE_DIR, `${role}.md`);
  const raw = await fs.readFile(filePath, "utf8");
  const { frontmatterRaw } = splitFrontmatter(raw, filePath);
  const parsed = yamlParse(frontmatterRaw) as {
    locked_phrases?: { yield?: string };
  };
  return parsed.locked_phrases?.yield;
}

describe("catalogue locked-phrase anchor — yield value equals YIELD_PHRASE_TEMPLATE", () => {
  for (const role of ALL_CATALOGUE_ROLES) {
    it(`${role}.md locked_phrases.yield === YIELD_PHRASE_TEMPLATE`, async () => {
      const yieldPhrase = await readLockedYield(role);
      expect(yieldPhrase).toBe(YIELD_PHRASE_TEMPLATE);
    });
  }
});
