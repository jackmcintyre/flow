/**
 * Integration tests for the author seam — Story 9.2 (Epic 9 intake cockpit,
 * gate 1: "propose a feature").
 *
 * The seam reuses the existing native-authoring machinery end-to-end:
 *   - `writeNativeStory` (now fail-closed on discipline) authors the draft,
 *   - `scanSources` materialises it into a backlog manifest defaulted
 *     not-ready (the Story 9.1 brake),
 *   - the claim entry point (`claimNextStory`) refuses to return it until the
 *     operator blesses it.
 *
 * Covered ACs:
 *   AC2 — a candidate that passes the discipline gate is written, scanned into
 *         a backlog manifest that reads not-ready, and is NOT returned by the
 *         claim entry point.
 *   AC3 — refuse-and-revise: a failing candidate surfaces violation codes and
 *         writes nothing; a corrected candidate then writes.
 *   AC6 — one `draft.authored` telemetry event lands per written draft (right
 *         ref); none is emitted for a refused candidate.
 *
 * Fixture pattern mirrors scan-sources.test.ts: a minimal native-adapter
 * workspace (config.yaml + native-stories dir) in a fresh tmpdir.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { DisciplineViolationError } from "../../errors.js";
import { writeNativeStory } from "../write-native-story.js";
import { scanSources } from "../scan-sources.js";
import { claimNextStory, QUEUE_DRAINED_LINE } from "../claim-next-story.js";
const SESSION_ULID = "01HZSESSION00000000000099";
let root;
let storiesDir;
// A passing candidate: state-mutating (names sprint-status.yaml) WITH an
// integration AC, so the discipline gate admits it.
function passingCandidate() {
    return {
        targetRepoRoot: root,
        title: "Persist the backlog ledger",
        narrative: {
            role: "operator",
            want: "the plugin to write sprint-status.yaml",
            so_that: "the backlog ledger is durable",
        },
        acceptance_criteria: [
            {
                text: "**Given** a backlog, **When** the operator runs it, **Then** sprint-status.yaml is updated and read back unchanged.",
                kind: "integration",
                verification: { type: "vitest", target: "src/__tests__/ledger.integration.test.ts" },
            },
        ],
        tasks: [{ text: "Write the ledger persistence path", ac_refs: ["AC1"] }],
        cited_sources: ["src/state/ledger.ts"],
        depends_on: [],
        sessionUlid: SESSION_ULID,
    };
}
// A failing candidate: state-mutating but with only a unit AC → violates the
// missing-integration-ac rule.
function failingCandidate() {
    return {
        targetRepoRoot: root,
        title: "Persist the backlog ledger",
        narrative: {
            role: "operator",
            want: "the plugin to write sprint-status.yaml",
            so_that: "the backlog ledger is durable",
        },
        acceptance_criteria: [
            {
                text: "**Given** a backlog, **When** the operator runs it, **Then** sprint-status.yaml is updated.",
                kind: "unit",
                verification: { type: "vitest", target: "src/__tests__/ledger.test.ts" },
            },
        ],
        tasks: [{ text: "Write the ledger persistence path", ac_refs: ["AC1"] }],
        cited_sources: ["src/state/ledger.ts"],
        depends_on: [],
        sessionUlid: SESSION_ULID,
    };
}
async function readDraftAuthoredEvents() {
    const telemetryDir = path.join(root, ".crew", "telemetry");
    let files;
    try {
        files = await fs.readdir(telemetryDir);
    }
    catch {
        return [];
    }
    const events = [];
    for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
        const content = await fs.readFile(path.join(telemetryDir, file), "utf8");
        for (const line of content.trim().split("\n").filter(Boolean)) {
            const parsed = JSON.parse(line);
            if (parsed.type === "draft.authored")
                events.push(parsed);
        }
    }
    return events;
}
beforeEach(async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "crew-author-seam-"));
    root = path.join(scratch, "workspace");
    storiesDir = path.join(root, ".crew", "native-stories");
    await fs.mkdir(storiesDir, { recursive: true });
    // The claim path stats these directories — create them so it does not error.
    await fs.mkdir(path.join(root, ".crew", "state", "in-progress"), { recursive: true });
    await fs.mkdir(path.join(root, ".crew", "state", "done"), { recursive: true });
    await atomicWriteFile(path.join(root, ".crew", "config.yaml"), `adapter: native\nadapter_config: {}\n`);
    // Story 10.3 — writeNativeStory + scanSources now resolve cited_sources on
    // disk. Seed the cited path both candidates reference so the Tier-0 T0-5 check
    // passes. (Their verification targets are vitest:, which is not existence-checked.)
    await atomicWriteFile(path.join(root, "src", "state", "ledger.ts"), "// seeded\n");
});
afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// AC2 — passing draft → scanned → not-ready → not claimable
// ---------------------------------------------------------------------------
describe("author seam AC2 — passing draft is parked not-ready in the backlog", () => {
    it("authors through the seam, scans, and the draft is a not-ready manifest the claim path will not return", async () => {
        const { ref } = await writeNativeStory(passingCandidate());
        const scan = await scanSources({ targetRepoRoot: root });
        expect(scan.createdRefs).toContain(ref);
        // The manifest exists in the backlog state and reads not-ready.
        const manifestPath = path.join(root, ".crew", "state", "to-do", `${ref}.yaml`);
        const parsed = yamlParse(await fs.readFile(manifestPath, "utf8"));
        expect(parsed["ready"]).toBe(false);
        expect(parsed["status"]).toBe("to-do");
        // The claim entry point does not return it (fail-closed readiness brake).
        const claim = await claimNextStory({ targetRepoRoot: root, sessionUlid: SESSION_ULID });
        expect(claim.next).toBe("queue-drained");
        expect(claim.chatLog).toContain(QUEUE_DRAINED_LINE);
    });
});
// ---------------------------------------------------------------------------
// AC3 — refuse-and-revise: failing draft writes nothing, corrected draft writes
// ---------------------------------------------------------------------------
describe("author seam AC3 — refuse-and-revise path", () => {
    it("refuses a failing candidate with violation codes and writes nothing, then writes a corrected candidate", async () => {
        // Failing candidate → typed error carrying the codes, nothing on disk.
        let caught;
        try {
            await writeNativeStory(failingCandidate());
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(DisciplineViolationError);
        const codes = caught.violations.map((v) => v.code);
        expect(codes).toContain("missing-integration-ac");
        expect((await fs.readdir(storiesDir)).filter((f) => f.endsWith(".md"))).toHaveLength(0);
        // The operator revises the framing (adds the integration AC) and retries.
        const { ref } = await writeNativeStory(passingCandidate());
        expect(ref).toMatch(/^native:/);
        expect((await fs.readdir(storiesDir)).filter((f) => f.endsWith(".md"))).toHaveLength(1);
    });
});
// ---------------------------------------------------------------------------
// AC6 — draft.authored telemetry event
// ---------------------------------------------------------------------------
describe("author seam AC6 — draft.authored telemetry event", () => {
    it("emits exactly one draft.authored event with the right ref for a written draft", async () => {
        const { ref } = await writeNativeStory(passingCandidate());
        const events = await readDraftAuthoredEvents();
        expect(events).toHaveLength(1);
        expect(events[0].data?.ref).toBe(ref);
        expect(events[0].data?.title).toBe("Persist the backlog ledger");
        expect(events[0].story_id).toBe(ref);
    });
    it("emits no draft.authored event for a refused (violating) candidate", async () => {
        await expect(writeNativeStory(failingCandidate())).rejects.toBeInstanceOf(DisciplineViolationError);
        expect(await readDraftAuthoredEvents()).toHaveLength(0);
    });
});
