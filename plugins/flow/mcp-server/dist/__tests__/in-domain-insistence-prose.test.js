/**
 * In-domain insistence prose anchor test — Story 4.11 Task 8.2.
 *
 * AC6 sub-case (6h): Asserts that every shipped specialist catalogue file
 * contains the verbatim in-domain insistence sentence, and that generalist
 * catalogue files do NOT contain it (the contract is specialist-only).
 *
 * The specialist list is enumerated explicitly (no glob) — adding a new
 * specialist persona requires a deliberate edit to both the catalogue AND
 * this test, which is the right friction.
 *
 * Story 4.11 AC2 (FR101).
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// The verbatim in-domain insistence sentence (AC2a).
const IN_DOMAIN_INSISTENCE_SENTENCE = "MUST NOT yield when work is in your own domain. The yield phrase is for routing work OUT of your domain; in-domain work is yours to handle even when another agent has produced a contrary verdict.";
// Resolve the catalogue directory relative to this test file.
// This file is at: plugins/flow/mcp-server/src/__tests__/in-domain-insistence-prose.test.ts
// Catalogue is at: plugins/flow/catalogue/
// Traverse: __tests__(1) → src(2) → mcp-server(3) → flow (plugin root) → catalogue
const CATALOGUE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "catalogue");
// ---------------------------------------------------------------------------
// Specialist catalogue files — MUST contain the sentence
// ---------------------------------------------------------------------------
const SPECIALIST_ROLES = [
    "security-specialist",
    "test-specialist",
    "docs-specialist",
    "debugger",
];
describe("in-domain insistence prose — specialist catalogue files", () => {
    for (const role of SPECIALIST_ROLES) {
        it(`${role}.md contains the verbatim in-domain insistence sentence`, async () => {
            const filePath = path.join(CATALOGUE_DIR, `${role}.md`);
            const content = await fs.readFile(filePath, "utf8");
            expect(content).toContain(IN_DOMAIN_INSISTENCE_SENTENCE);
        });
    }
});
// ---------------------------------------------------------------------------
// Generalist catalogue files — MUST NOT contain the sentence
// ---------------------------------------------------------------------------
const GENERALIST_ROLES = [
    "generalist-dev",
    "generalist-reviewer",
    "planner",
    "hiring-manager",
    "orchestrator",
    "retro-analyst",
];
describe("in-domain insistence prose — generalist catalogue files (negative assertion)", () => {
    for (const role of GENERALIST_ROLES) {
        it(`${role}.md does NOT contain the in-domain insistence sentence`, async () => {
            const filePath = path.join(CATALOGUE_DIR, `${role}.md`);
            const content = await fs.readFile(filePath, "utf8");
            expect(content).not.toContain(IN_DOMAIN_INSISTENCE_SENTENCE);
        });
    }
});
