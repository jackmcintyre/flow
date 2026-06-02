/**
 * Deterministic structure test for the `### Plain-language guideline` subsection
 * in `plugins/flow/catalogue/planner.md` — Story 3.7 AC5.
 *
 * Loads the planner catalogue prompt from disk and asserts that the `## Prompt`
 * section contains the verbatim strings required by AC5. These are pure
 * on-disk substring assertions — no LLM invocation, no network.
 *
 * Required strings per AC5 / Task 5.1:
 *   - `### Plain-language guideline` (subsection heading)
 *   - `non-engineer who reads code at skim level` (verbatim phrase)
 *   - `FR77` (functional requirement citation)
 *
 * Ordering check per Task 5.2:
 *   - `### Plain-language guideline` appears AFTER `### Discipline validation — pre-write check`
 *   - `### Plain-language guideline` appears BEFORE `### Re-open mode — backlog review and discard flow`
 *
 * MUST NEVER be removed without a coordinated bump. The subsection heading is the
 * anchor that prevents future prompt edits from silently dropping the FR77 constraint.
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// This file lives at:
//   plugins/flow/mcp-server/src/catalogue/__tests__/planner-prompt-shape.plain-language.test.ts
// Planner file lives at:
//   plugins/flow/catalogue/planner.md
// Walk up: __tests__ → catalogue → src → mcp-server → crew → plugins → catalogue/planner.md
const PLANNER_PATH = path.resolve(HERE, "..", // src/catalogue/
"..", // src/
"..", // mcp-server/
"..", // crew/
"catalogue", "planner.md");
describe("plugins/flow/catalogue/planner.md — Plain-language guideline structural assertions (Story 3.7 AC5)", () => {
    it("planner.md exists and is readable", async () => {
        const c = await fs.readFile(PLANNER_PATH, "utf8");
        expect(c.length).toBeGreaterThan(100);
    });
    it("contains the literal subsection heading '### Plain-language guideline'", async () => {
        const c = await fs.readFile(PLANNER_PATH, "utf8");
        expect(c).toContain("### Plain-language guideline");
    });
    it("contains the literal phrase 'non-engineer who reads code at skim level'", async () => {
        const c = await fs.readFile(PLANNER_PATH, "utf8");
        expect(c).toContain("non-engineer who reads code at skim level");
    });
    it("contains the functional requirement citation 'FR77'", async () => {
        const c = await fs.readFile(PLANNER_PATH, "utf8");
        expect(c).toContain("FR77");
    });
    it("'### Plain-language guideline' appears AFTER '### Discipline validation — pre-write check'", async () => {
        const c = await fs.readFile(PLANNER_PATH, "utf8");
        const disciplineIdx = c.indexOf("### Discipline validation — pre-write check");
        const plainLangIdx = c.indexOf("### Plain-language guideline");
        expect(disciplineIdx).toBeGreaterThanOrEqual(0);
        expect(plainLangIdx).toBeGreaterThanOrEqual(0);
        expect(plainLangIdx).toBeGreaterThan(disciplineIdx);
    });
    it("'### Plain-language guideline' appears BEFORE '### Re-open mode — backlog review and discard flow'", async () => {
        const c = await fs.readFile(PLANNER_PATH, "utf8");
        const plainLangIdx = c.indexOf("### Plain-language guideline");
        const reopenIdx = c.indexOf("### Re-open mode — backlog review and discard flow");
        expect(plainLangIdx).toBeGreaterThanOrEqual(0);
        expect(reopenIdx).toBeGreaterThanOrEqual(0);
        expect(plainLangIdx).toBeLessThan(reopenIdx);
    });
    it("the subsection is inside the '## Prompt' section", async () => {
        const c = await fs.readFile(PLANNER_PATH, "utf8");
        const promptIdx = c.indexOf("## Prompt");
        const plainLangIdx = c.indexOf("### Plain-language guideline");
        expect(promptIdx).toBeGreaterThanOrEqual(0);
        expect(plainLangIdx).toBeGreaterThan(promptIdx);
    });
    // Backward-compatibility assertions: prior story anchors must still be present.
    it("Story 3.5 discipline-gate anchor is still present (regression guard)", async () => {
        const c = await fs.readFile(PLANNER_PATH, "utf8");
        expect(c).toContain("Story 3.5 AC6 anchor");
        expect(c).toContain("### Discipline validation — pre-write check");
    });
    it("Story 3.6 re-open anchor is still present (regression guard)", async () => {
        const c = await fs.readFile(PLANNER_PATH, "utf8");
        expect(c).toContain("Story 3.6 AC5 anchor");
        expect(c).toContain("### Re-open mode — backlog review and discard flow");
    });
});
