/**
 * Unit tests for `recallLesson` — Story native:01KT6QEWY794ZY0DH6JHQFWG6V (AC2).
 *
 * Covers:
 *   (a) Returns the full body of a lesson when called with the lesson's id.
 *   (b) Returns { found: false } when no lesson matches the id.
 *   (c) Works for structured lesson blocks (<!-- lesson:json ... -->).
 *   (d) Works for flat-bullet migrated entries (id = MIGRATED-N).
 *   (e) PersonaFileNotFoundError propagates when the persona file is absent.
 *
 * Approach: real filesystem ops against a tmpdir with a constructed persona file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersonaFileNotFoundError } from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { recallLesson } from "../recall-lesson.js";
let tmpRoot;
// ---------------------------------------------------------------------------
// Fixture persona file
// ---------------------------------------------------------------------------
const FIXTURE_PERSONA_MD = `---
role: generalist-dev
domain: "feature implementation in a story scope"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
  - Bash
  - Task
gh_allow:
  - pr-create
  - pr-view
  - pr-comment
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
---

# Generalist Dev

## Domain

Implements one story at a time.

## Mandate

Claim and build.

## Out of mandate

Not reviewing.

## Prompt

You are the generalist dev.

## Knowledge

<!-- lesson:json {"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","kind":"pattern","applies_when":"use atomic writes for file ops","detail":"Always use atomic write patterns to avoid partial file corruption under concurrent access. Applies to any file that might be written by multiple processes.","source_ref":"native:01KT1234","learned_at":"2026-01-01T00:00:00.000Z"} -->
<!-- lesson:json {"id":"01ARZ3NDEKTSV4RRFFQ69G5FAW","kind":"pitfall","applies_when":"avoid race conditions in tests","detail":"Test isolation failures cause flaky results. Always use unique temp directories per test.","failure_class":"test-quality","source_ref":"native:01KT5678","learned_at":"2026-01-02T00:00:00.000Z"} -->
`;
const FIXTURE_WITH_FLAT_BULLET = `---
role: generalist-dev
domain: "feature implementation in a story scope"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
  - Bash
  - Task
gh_allow:
  - pr-create
  - pr-view
  - pr-comment
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
---

# Generalist Dev

## Domain

Implements one story at a time.

## Mandate

Claim and build.

## Out of mandate

Not reviewing.

## Prompt

You are the generalist dev.

## Knowledge

- Always double-check the test setup before running.
- Prefer explicit over implicit in API design.
`;
async function makePersonaDir(root, role) {
    const dir = path.join(root, "team", role);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}
// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-recall-lesson-"));
});
afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("recallLesson", () => {
    it("(a) returns found:true and the full lesson detail for a known id", async () => {
        const dir = await makePersonaDir(tmpRoot, "generalist-dev");
        await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_PERSONA_MD);
        const result = await recallLesson({
            targetRepoRoot: tmpRoot,
            role: "generalist-dev",
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        });
        expect(result.found).toBe(true);
        if (!result.found)
            return; // type narrowing
        expect(result.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
        expect(result.kind).toBe("pattern");
        expect(result.applies_when).toBe("use atomic writes for file ops");
        expect(result.detail).toContain("atomic write patterns");
        expect(result.source_ref).toBe("native:01KT1234");
    });
    it("(a) returns the second lesson when called with its id", async () => {
        const dir = await makePersonaDir(tmpRoot, "generalist-dev");
        await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_PERSONA_MD);
        const result = await recallLesson({
            targetRepoRoot: tmpRoot,
            role: "generalist-dev",
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        });
        expect(result.found).toBe(true);
        if (!result.found)
            return;
        expect(result.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAW");
        expect(result.kind).toBe("pitfall");
        expect(result.applies_when).toBe("avoid race conditions in tests");
        expect(result.detail).toContain("Test isolation failures");
    });
    it("(b) returns found:false when no lesson matches the id", async () => {
        const dir = await makePersonaDir(tmpRoot, "generalist-dev");
        await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_PERSONA_MD);
        const result = await recallLesson({
            targetRepoRoot: tmpRoot,
            role: "generalist-dev",
            id: "NO-SUCH-ID",
        });
        expect(result.found).toBe(false);
    });
    it("(d) returns the full detail for a flat-bullet migrated entry using MIGRATED-N id", async () => {
        const dir = await makePersonaDir(tmpRoot, "generalist-dev");
        await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_WITH_FLAT_BULLET);
        // Flat bullets are migrated with MIGRATED-0, MIGRATED-1, etc.
        const result0 = await recallLesson({
            targetRepoRoot: tmpRoot,
            role: "generalist-dev",
            id: "MIGRATED-0",
        });
        expect(result0.found).toBe(true);
        if (!result0.found)
            return;
        expect(result0.kind).toBe("pattern");
        expect(result0.applies_when).toBe("Always double-check the test setup before running.");
        expect(result0.detail).toBe("Always double-check the test setup before running.");
        const result1 = await recallLesson({
            targetRepoRoot: tmpRoot,
            role: "generalist-dev",
            id: "MIGRATED-1",
        });
        expect(result1.found).toBe(true);
        if (!result1.found)
            return;
        expect(result1.applies_when).toBe("Prefer explicit over implicit in API design.");
    });
    it("(e) PersonaFileNotFoundError propagates when the persona file is absent", async () => {
        await expect(recallLesson({
            targetRepoRoot: tmpRoot,
            role: "generalist-dev",
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        })).rejects.toThrow(PersonaFileNotFoundError);
    });
});
