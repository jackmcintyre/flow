/**
 * Integration tests for `writeNativeStory` — Story 9.2 (Epic 9 author seam).
 *
 * Focus: the FAIL-CLOSED discipline gate (AC1). The discipline validator now
 * runs INSIDE the write tool, before any filesystem write. A candidate that
 * violates an authoring-time discipline rule is refused with a typed
 * `DisciplineViolationError` carrying the violation code(s), and NO
 * native-story file appears on disk — even on a direct write that never went
 * through the planner's pre-write `validatePlannerBacklog` step.
 *
 * Fixture pattern mirrors scan-sources.test.ts / mark-story-ready.test.ts:
 * a minimal native-adapter workspace (config.yaml + native-stories dir) in a
 * fresh tmpdir, with writes routed through the canonical `atomicWriteFile`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { DisciplineViolationError } from "../../errors.js";
import { writeNativeStory } from "../write-native-story.js";
import { parseNativeStory } from "../../adapters/native/parse-native-story.js";
let root;
let storiesDir;
async function listStoryFiles() {
    try {
        return (await fs.readdir(storiesDir)).filter((f) => f.endsWith(".md"));
    }
    catch {
        return [];
    }
}
beforeEach(async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "crew-write-native-story-"));
    root = path.join(scratch, "workspace");
    storiesDir = path.join(root, ".crew", "native-stories");
    await fs.mkdir(storiesDir, { recursive: true });
    // Native-adapter config so resolveWorkspace picks the native adapter.
    await atomicWriteFile(path.join(root, ".crew", "config.yaml"), `adapter: native\nadapter_config: {}\n`);
});
afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// AC1 — the write path is fail-closed on discipline
// ---------------------------------------------------------------------------
describe("writeNativeStory AC1 — fail-closed discipline gate", () => {
    it("refuses a state-mutating candidate that lacks an integration AC, with a typed error and no file written", async () => {
        // State-mutating heuristic fires on a path-glob token like
        // `.crew/state/<ref>.yaml` / `sprint-status.yaml`. This candidate names one
        // but tags its only AC `unit`, so the missing-integration-ac rule must fire.
        const promise = writeNativeStory({
            targetRepoRoot: root,
            title: "Persist the backlog ledger",
            narrative: "As an operator, I want the plugin to write sprint-status.yaml so that the backlog ledger is durable.",
            acceptance_criteria: [
                {
                    text: "**Given** a backlog, **When** the operator runs it, **Then** sprint-status.yaml is updated.",
                    kind: "unit",
                    verification: { type: "vitest", target: "src/__tests__/ledger.test.ts" },
                },
            ],
            depends_on: [],
        });
        await expect(promise).rejects.toBeInstanceOf(DisciplineViolationError);
        // The typed error carries the violation code(s).
        let caught;
        try {
            await writeNativeStory({
                targetRepoRoot: root,
                title: "Persist the backlog ledger",
                narrative: "As an operator, I want the plugin to write sprint-status.yaml so that the backlog ledger is durable.",
                acceptance_criteria: [
                    {
                        text: "Given a backlog, When the operator runs it, Then sprint-status.yaml is updated.",
                        kind: "unit",
                        verification: { type: "vitest", target: "src/__tests__/ledger.test.ts" },
                    },
                ],
                depends_on: [],
            });
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(DisciplineViolationError);
        const codes = caught.violations.map((v) => v.code);
        expect(codes).toContain("missing-integration-ac");
        // No native-story file appears on disk.
        expect(await listStoryFiles()).toHaveLength(0);
    });
    it("writes a passing candidate (state-mutating WITH an integration AC) and returns its ref + path", async () => {
        const result = await writeNativeStory({
            targetRepoRoot: root,
            title: "Persist the backlog ledger",
            narrative: "As an operator, I want the plugin to write sprint-status.yaml so that the backlog ledger is durable.",
            acceptance_criteria: [
                {
                    text: "**Given** a backlog, **When** the operator runs it, **Then** sprint-status.yaml is updated and read back unchanged.",
                    kind: "integration",
                    verification: { type: "vitest", target: "src/__tests__/ledger.integration.test.ts" },
                },
            ],
            depends_on: [],
        });
        expect(result.ref).toMatch(/^native:[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(result.path.startsWith(storiesDir)).toBe(true);
        // Exactly one native-story file landed on disk.
        expect(await listStoryFiles()).toHaveLength(1);
    });
    it("writes a non-state-mutating candidate even with only a unit AC (heuristic does not fire)", async () => {
        const result = await writeNativeStory({
            targetRepoRoot: root,
            title: "Render a friendly greeting",
            narrative: "As a user, I want a friendly greeting so that the app feels welcoming.",
            acceptance_criteria: [
                {
                    text: "**Given** the app is open, **When** the user lands, **Then** a greeting is shown.",
                    kind: "unit",
                    verification: { type: "vitest", target: "src/__tests__/greeting.test.ts" },
                },
            ],
            depends_on: [],
        });
        expect(result.ref).toMatch(/^native:/);
        expect(await listStoryFiles()).toHaveLength(1);
    });
});
// ---------------------------------------------------------------------------
// AC1 — the verification field survives write→parse and the write fails closed
//        when it is absent (the observable spine of Story 10.1)
// ---------------------------------------------------------------------------
describe("writeNativeStory AC1 — verification round-trip + fail-closed on absence", () => {
    it("(a) writes a story whose every AC has a verification block and round-trips it through parseNativeStory intact", async () => {
        const result = await writeNativeStory({
            targetRepoRoot: root,
            title: "Multi-AC story with per-AC verification",
            narrative: "As a user, I want a feature so that I get value.",
            acceptance_criteria: [
                {
                    text: "**Given** a state, **When** an action, **Then** an outcome.",
                    kind: "unit",
                    verification: { type: "vitest", target: "src/feature/__tests__/a.test.ts" },
                },
                {
                    text: "**Given** a system, **When** integrated, **Then** an artifact appears.",
                    kind: "integration",
                    verification: { type: "artifact", target: "build/out/report.json" },
                },
            ],
            depends_on: [],
        });
        // Exactly one file landed; re-read and re-parse it.
        expect(await listStoryFiles()).toHaveLength(1);
        const written = await fs.readFile(result.path, "utf8");
        const reparsed = parseNativeStory(result.path, written);
        expect(reparsed.acceptance_criteria).toHaveLength(2);
        expect(reparsed.acceptance_criteria[0].verification).toEqual({
            type: "vitest",
            target: "src/feature/__tests__/a.test.ts",
        });
        expect(reparsed.acceptance_criteria[1].verification).toEqual({
            type: "artifact",
            target: "build/out/report.json",
        });
    });
    it("(b) refuses a write where any AC omits the verification block — before any file is written, naming the offending AC", async () => {
        let caught;
        try {
            await writeNativeStory({
                targetRepoRoot: root,
                title: "Story whose second AC omits verification",
                narrative: "As a user, I want a feature so that I get value.",
                acceptance_criteria: [
                    {
                        text: "**Given** a state, **When** an action, **Then** an outcome.",
                        kind: "unit",
                        verification: { type: "vitest", target: "src/feature/__tests__/a.test.ts" },
                    },
                    // Second AC deliberately omits `verification`.
                    {
                        text: "**Given** a system, **When** integrated, **Then** an artifact appears.",
                        kind: "integration",
                    },
                ],
                depends_on: [],
            });
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeDefined();
        // The validation error names the offending AC by its index in the array.
        const message = String(caught);
        expect(message).toMatch(/acceptance_criteria/);
        expect(message).toMatch(/verification/);
        expect(message).toMatch(/\b1\b/); // the second AC (index 1)
        // Fail-closed: no native-story file appears on disk.
        expect(await listStoryFiles()).toHaveLength(0);
    });
});
