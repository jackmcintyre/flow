/**
 * Integration tests for `processReviewerYield` — Story 4.11 Task 8.1.
 *
 * AC6 coverage:
 *   (6c) Sub-case a: success branch — spawn-specialist-reviewer + yield.handoff telemetry
 *   (6d) Sub-case b: routing-failure branch — no hired role matches domain
 *   (6e) Sub-case c: self-yield branch — specialist yielded to its own domain
 *   (6f) Sub-case d: no-yield pass-through — no yield phrase in transcript
 *   (6g) Sub-case e: drift branch — en-dash instead of em-dash (silent pass-through)
 *   (6i) Sub-case g: empty-transcript pass-through
 *   (6j) Sub-case h: PersonaFileNotFoundError propagates on race condition
 *   (6l) Sub-case j: schema-strict assertion — unknown extra key in data
 *   (6m) Sub-case k: round-trip JSONL parseability
 *
 * Uses real tmpdir fixtures. No mocking of lookupRoleByDomain, buildPersonaSpawnPrompt,
 * or logTelemetryEvent — tests exercise real implementations.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";
import { TelemetryEventSchema } from "../../schemas/telemetry-events.js";
import { TelemetryEventInvalidError, PersonaFileNotFoundError } from "../../errors.js";
import { processReviewerYield } from "../process-reviewer-yield.js";
import { buildPersonaSpawnPrompt } from "../build-persona-spawn-prompt.js";
import { logTelemetryEvent } from "../../lib/logger.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STORY_REF = "native:01HZTEST";
const SESSION_ULID = "01HZSESSION00000000000001";
const SECURITY_DOMAIN = "authentication authorization and secret handling";
const GENERALIST_REVIEWER_DOMAIN = "code review and verdict authoring";
const YIELD_PHRASE = `This sits in ${SECURITY_DOMAIN}'s domain — handing off.`;
const REVIEWER_TRANSCRIPT_WITH_YIELD = `Some reviewer prose.\n\n${YIELD_PHRASE}`;
const REVIEWER_TRANSCRIPT_NO_YIELD = "Normal reviewer output.\n\n**Verdict: READY FOR MERGE**";
// ---------------------------------------------------------------------------
// Persona MD fixtures
// ---------------------------------------------------------------------------
function makePersonaMd(opts) {
    const yieldPhrase = opts.lockedYield ?? `This sits in <domain>'s domain — handing off.`;
    const handoffPhrase = opts.lockedHandoff ?? `Handoff to generalist-dev — work complete`;
    const verdictPhrase = opts.lockedVerdict ?? `**Verdict: <SENTINEL>**`;
    return `---
role: ${opts.role}
domain: "${opts.domain}"
model_tier: sonnet
tools_allow:
  - Read
gh_allow: []
locked_phrases:
  handoff: "${handoffPhrase}"
  yield: "${yieldPhrase}"
  verdict: "${verdictPhrase}"
hired_at: "2026-01-01T00:00:00Z"
catalogue_version: "0.1.0"
---

# ${opts.role.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join(" ")} — Persona

## Domain

${opts.domain}

## Mandate

- Fulfil the mandate for this role.

## Out of mandate

- Everything else.

## Prompt

You are the ${opts.role}.

## Knowledge

No knowledge yet.
`;
}
// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
async function seedHiredTeam(targetRepoRoot, roles) {
    for (const r of roles) {
        const roleDir = path.join(targetRepoRoot, "team", r.role);
        await fs.mkdir(roleDir, { recursive: true });
        const personaMd = makePersonaMd(r);
        await atomicWriteFile(path.join(roleDir, "PERSONA.md"), personaMd);
    }
}
function makeBaseManifest(ref) {
    return {
        ref,
        status: "in-progress",
        adapter: "native",
        source_path: `.flow/native-stories/${ref}.yaml`,
        source_hash: "a".repeat(64),
        depends_on: [],
        acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
        title: "Test Story",
        narrative: "As a dev, I want to test.",
        withdrawn: false,
        ready: true,
        claimed_by: SESSION_ULID,
    };
}
async function seedManifest(manifestPath, ref) {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const manifest = makeBaseManifest(ref);
    const yaml = yamlStringify(manifest, { lineWidth: 0 });
    await atomicWriteFile(manifestPath, yaml);
}
async function readOnDiskManifest(manifestPath) {
    const raw = await fs.readFile(manifestPath, "utf8");
    return parseExecutionManifest(yamlParse(raw), { absPath: manifestPath });
}
async function readTelemetryJsonl(targetRepoRoot) {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const filePath = path.join(targetRepoRoot, ".flow", "telemetry", `${month}.jsonl`);
    try {
        const raw = await fs.readFile(filePath, "utf8");
        return raw
            .trim()
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l));
    }
    catch (err) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
            return [];
        }
        throw err;
    }
}
// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
let tmpRoot;
let manifestPath;
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yield-protocol-"));
    manifestPath = path.join(tmpRoot, ".flow", "state", "in-progress", `${STORY_REF}.yaml`);
    await seedManifest(manifestPath, STORY_REF);
});
afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// Sub-case a (6c): success branch
// ---------------------------------------------------------------------------
describe("processReviewerYield — success branch (sub-case a)", () => {
    it("routes yield to security-specialist and emits yield.handoff telemetry", async () => {
        await seedHiredTeam(tmpRoot, [
            { role: "generalist-reviewer", domain: GENERALIST_REVIEWER_DOMAIN },
            { role: "security-specialist", domain: SECURITY_DOMAIN },
        ]);
        const result = await processReviewerYield({
            targetRepoRoot: tmpRoot,
            sessionUlid: SESSION_ULID,
            ref: STORY_REF,
            fromRole: "generalist-reviewer",
            reviewerTranscript: REVIEWER_TRANSCRIPT_WITH_YIELD,
            manifestPath,
        });
        // Verify result shape
        expect(result.next).toBe("spawn-specialist-reviewer");
        if (result.next !== "spawn-specialist-reviewer")
            throw new Error("Type narrowing");
        expect(result.toRole).toBe("security-specialist");
        expect(result.specialistPrompt).toBeTruthy();
        expect(result.specialistPrompt.startsWith("# Security Specialist — Persona")).toBe(true);
        expect(result.chatLog).toEqual([
            `yield routed — from generalist-reviewer to security-specialist on domain "${SECURITY_DOMAIN}" — spawning specialist reviewer (clean context)`,
        ]);
        // Verify telemetry event was written
        const events = await readTelemetryJsonl(tmpRoot);
        expect(events.length).toBe(1);
        const evt = events[0];
        expect(evt["type"]).toBe("yield.handoff");
        const data = evt["data"];
        expect(data["from_role"]).toBe("generalist-reviewer");
        expect(data["to_role"]).toBe("security-specialist");
        expect(data["domain"]).toBe(SECURITY_DOMAIN);
        // Manifest should NOT be stamped with blocked_by
        const manifest = await readOnDiskManifest(manifestPath);
        expect(manifest.blocked_by).toBeUndefined();
    });
});
// ---------------------------------------------------------------------------
// Sub-case b (6d): routing-failure branch
// ---------------------------------------------------------------------------
describe("processReviewerYield — routing-failure branch (sub-case b)", () => {
    it("blocks when no hired role matches the domain", async () => {
        // Only generalist-reviewer hired, no security-specialist
        await seedHiredTeam(tmpRoot, [
            { role: "generalist-reviewer", domain: GENERALIST_REVIEWER_DOMAIN },
        ]);
        const result = await processReviewerYield({
            targetRepoRoot: tmpRoot,
            sessionUlid: SESSION_ULID,
            ref: STORY_REF,
            fromRole: "generalist-reviewer",
            reviewerTranscript: REVIEWER_TRANSCRIPT_WITH_YIELD,
            manifestPath,
        });
        expect(result.next).toBe("done-blocked-routing-failure");
        expect(result.chatLog).toEqual([
            `[routing-failure] no hired role matches domain "${SECURITY_DOMAIN}" — story ${STORY_REF} blocked. Clear blocked_by on the manifest and re-run /flow:start after hiring a role with this domain.`,
        ]);
        // Manifest should be stamped with blocked_by: routing-failure
        const manifest = await readOnDiskManifest(manifestPath);
        expect(manifest.blocked_by).toBe("routing-failure");
        // No telemetry event written
        const events = await readTelemetryJsonl(tmpRoot);
        expect(events.length).toBe(0);
        // Telemetry directory should not exist
        const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
        await expect(fs.stat(telemetryDir)).rejects.toThrow();
    });
});
// ---------------------------------------------------------------------------
// Sub-case c (6e): self-yield branch
// ---------------------------------------------------------------------------
describe("processReviewerYield — self-yield branch (sub-case c)", () => {
    it("rejects self-yield when specialist names its own domain", async () => {
        await seedHiredTeam(tmpRoot, [
            { role: "security-specialist", domain: SECURITY_DOMAIN },
        ]);
        const result = await processReviewerYield({
            targetRepoRoot: tmpRoot,
            sessionUlid: SESSION_ULID,
            ref: STORY_REF,
            fromRole: "security-specialist",
            reviewerTranscript: REVIEWER_TRANSCRIPT_WITH_YIELD,
            manifestPath,
        });
        expect(result.next).toBe("done-blocked-routing-self-yield");
        expect(result.chatLog).toEqual([
            `[routing-failure] self-yield rejected — security-specialist attempted to yield to its own domain "${SECURITY_DOMAIN}"; in-domain insistence applies`,
        ]);
        // Manifest should be stamped with blocked_by: routing-self-yield
        const manifest = await readOnDiskManifest(manifestPath);
        expect(manifest.blocked_by).toBe("routing-self-yield");
        // No telemetry event written
        const events = await readTelemetryJsonl(tmpRoot);
        expect(events.length).toBe(0);
    });
});
// ---------------------------------------------------------------------------
// Sub-case d (6f): no-yield pass-through
// ---------------------------------------------------------------------------
describe("processReviewerYield — no-yield pass-through (sub-case d)", () => {
    it("returns no-yield with empty chatLog for a transcript without the yield phrase", async () => {
        await seedHiredTeam(tmpRoot, [
            { role: "generalist-reviewer", domain: GENERALIST_REVIEWER_DOMAIN },
            { role: "security-specialist", domain: SECURITY_DOMAIN },
        ]);
        const result = await processReviewerYield({
            targetRepoRoot: tmpRoot,
            sessionUlid: SESSION_ULID,
            ref: STORY_REF,
            fromRole: "generalist-reviewer",
            reviewerTranscript: REVIEWER_TRANSCRIPT_NO_YIELD,
            manifestPath,
        });
        expect(result).toEqual({ next: "no-yield", chatLog: [] });
        // Manifest unchanged
        const manifest = await readOnDiskManifest(manifestPath);
        expect(manifest.blocked_by).toBeUndefined();
        // No JSONL file created
        const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
        await expect(fs.stat(telemetryDir)).rejects.toThrow();
    });
});
// ---------------------------------------------------------------------------
// Sub-case e (6g): drift branch (silent pass-through)
// ---------------------------------------------------------------------------
describe("processReviewerYield — drift branch (sub-case e)", () => {
    it("returns no-yield for en-dash drift (off-spec phrase)", async () => {
        await seedHiredTeam(tmpRoot, [
            { role: "generalist-reviewer", domain: GENERALIST_REVIEWER_DOMAIN },
            { role: "security-specialist", domain: SECURITY_DOMAIN },
        ]);
        // En-dash instead of em-dash — off-spec
        const driftTranscript = `This sits in the security specialist's domain - handing off.`;
        const result = await processReviewerYield({
            targetRepoRoot: tmpRoot,
            sessionUlid: SESSION_ULID,
            ref: STORY_REF,
            fromRole: "generalist-reviewer",
            reviewerTranscript: driftTranscript,
            manifestPath,
        });
        expect(result).toEqual({ next: "no-yield", chatLog: [] });
        // Manifest unchanged
        const manifest = await readOnDiskManifest(manifestPath);
        expect(manifest.blocked_by).toBeUndefined();
        // No JSONL file created
        const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
        await expect(fs.stat(telemetryDir)).rejects.toThrow();
    });
});
// ---------------------------------------------------------------------------
// Sub-case g (6i): empty-transcript pass-through
// ---------------------------------------------------------------------------
describe("processReviewerYield — empty-transcript pass-through (sub-case g)", () => {
    it("returns no-yield for an empty transcript", async () => {
        await seedHiredTeam(tmpRoot, [
            { role: "generalist-reviewer", domain: GENERALIST_REVIEWER_DOMAIN },
            { role: "security-specialist", domain: SECURITY_DOMAIN },
        ]);
        const result = await processReviewerYield({
            targetRepoRoot: tmpRoot,
            sessionUlid: SESSION_ULID,
            ref: STORY_REF,
            fromRole: "generalist-reviewer",
            reviewerTranscript: "",
            manifestPath,
        });
        expect(result).toEqual({ next: "no-yield", chatLog: [] });
        // No manifest write
        const manifest = await readOnDiskManifest(manifestPath);
        expect(manifest.blocked_by).toBeUndefined();
        // No JSONL file created
        const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
        await expect(fs.stat(telemetryDir)).rejects.toThrow();
    });
});
// ---------------------------------------------------------------------------
// Sub-case h (6j): PersonaFileNotFoundError propagates (separate describe for stub clarity)
// ---------------------------------------------------------------------------
// Simulates the race: lookupRoleByDomain found the role but the persona file was
// deleted before buildPersonaSpawnPrompt could read it. We exercise the propagation
// path by directly calling buildPersonaSpawnPrompt with a non-existent persona.
// Per AC1h: "If `buildPersonaSpawnPrompt` raises `PersonaFileNotFoundError` despite
// `lookupRoleByDomain` having found the role (race: persona deleted between the two
// calls), the error propagates verbatim."
describe("processReviewerYield — PersonaFileNotFoundError race condition (sub-case h)", () => {
    it("buildPersonaSpawnPrompt raises PersonaFileNotFoundError when PERSONA.md is absent", async () => {
        // This verifies the propagation contract at the buildPersonaSpawnPrompt layer,
        // which is the call that would fail in the race condition scenario.
        await expect(buildPersonaSpawnPrompt({
            targetRepoRoot: tmpRoot,
            role: "security-specialist", // persona file does not exist in tmpRoot
        })).rejects.toThrow(PersonaFileNotFoundError);
    });
});
// ---------------------------------------------------------------------------
// Sub-case j (6l): schema-strict assertion — unknown extra key in data
// ---------------------------------------------------------------------------
describe("processReviewerYield — schema-strict telemetry assertion (sub-case j)", () => {
    it("rejects yield.handoff event with extra key in data and writes telemetry.invalid", async () => {
        await expect(logTelemetryEvent({
            targetRepoRoot: tmpRoot,
            event: {
                type: "yield.handoff",
                session_id: SESSION_ULID,
                agent: "generalist-reviewer",
                story_id: STORY_REF,
                data: {
                    from_role: "generalist-reviewer",
                    to_role: "security-specialist",
                    domain: SECURITY_DOMAIN,
                    // @ts-expect-error — extra key to trigger schema-strict rejection
                    extra: "nope",
                },
            },
        })).rejects.toThrow(TelemetryEventInvalidError);
        // A telemetry.invalid event should have been written
        const events = await readTelemetryJsonl(tmpRoot);
        expect(events.length).toBe(1);
        const evt = events[0];
        expect(evt["type"]).toBe("telemetry.invalid");
    });
});
// ---------------------------------------------------------------------------
// Sub-case k (6m): round-trip JSONL parseability
// ---------------------------------------------------------------------------
describe("processReviewerYield — round-trip JSONL parseability (sub-case k)", () => {
    it("all JSONL lines in the telemetry file parse cleanly with TelemetryEventSchema", async () => {
        await seedHiredTeam(tmpRoot, [
            { role: "generalist-reviewer", domain: GENERALIST_REVIEWER_DOMAIN },
            { role: "security-specialist", domain: SECURITY_DOMAIN },
        ]);
        // Sub-case a: success branch — emits yield.handoff
        await processReviewerYield({
            targetRepoRoot: tmpRoot,
            sessionUlid: SESSION_ULID,
            ref: STORY_REF,
            fromRole: "generalist-reviewer",
            reviewerTranscript: REVIEWER_TRANSCRIPT_WITH_YIELD,
            manifestPath,
        });
        // Sub-case c (self-yield) writes NO telemetry — only success does
        const events = await readTelemetryJsonl(tmpRoot);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
            const result = TelemetryEventSchema.safeParse(event);
            expect(result.success).toBe(true);
        }
    });
});
