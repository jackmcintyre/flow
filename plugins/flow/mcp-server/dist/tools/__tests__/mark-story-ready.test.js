/**
 * Integration tests for `markStoryReady` — Story 9.1 (Epic 9 intake cockpit).
 *
 * Covers AC3 (the toggle tool) and AC4 (the readiness telemetry event):
 *
 *   AC3:
 *     (a) Mark a to-do/ backlog item ready → flag flips false→true, item stays
 *         in to-do/ (no state-directory move), `status` untouched.
 *     (b) Re-mark ready → no-op (no write, no event, mtime stable).
 *     (c) Mark not-ready → flag flips true→false.
 *     (d) An unknown reference → NotAnEligibleBacklogItemError (no mutation).
 *         Also: a non-to-do/ item (in-progress/) and a withdrawn item raise it.
 *
 *   AC4:
 *     One real toggle lands exactly one `backlog.readiness_changed` telemetry
 *     event with the right ref and value; an idempotent no-op re-toggle emits
 *     nothing.
 *
 * Uses a real tmpdir with real `node:fs` ops — same pattern as
 * `claim-next-story.test.ts`. Manifests are written via the canonical
 * `atomicWriteFile` primitive to comply with the static fs-guard.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { NotAnEligibleBacklogItemError } from "../../errors.js";
import { markStoryReady } from "../mark-story-ready.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STORY_REF = "native:01J9P0K2N3MZX0YV4S5RTQ4AAA";
const SESSION_ULID = "01HZSESSION00000000000099";
// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
function makeTodoManifest(ref, opts = {}) {
    return {
        ref,
        status: "to-do",
        adapter: "native",
        source_path: `.flow/native-stories/${ref}.yaml`,
        source_hash: "a".repeat(64),
        depends_on: [],
        acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
        title: `Test story ${ref}`,
        narrative: "As a dev, I want to test.",
        withdrawn: opts.withdrawn ?? false,
        ready: opts.ready ?? false,
    };
}
let tmpRoot;
let todoDir;
let inProgressDir;
function todoPath(ref) {
    return path.join(todoDir, `${ref}.yaml`);
}
async function seedTodo(manifest) {
    await atomicWriteFile(todoPath(manifest.ref), yamlStringify(manifest, { lineWidth: 0 }));
}
async function readManifest(absPath) {
    const raw = await fs.readFile(absPath, "utf8");
    const { parse: yamlParse } = await import("yaml");
    return yamlParse(raw);
}
async function readReadinessEvents() {
    const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
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
            if (parsed.type === "backlog.readiness_changed")
                events.push(parsed);
        }
    }
    return events;
}
// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-mark-story-ready-"));
    todoDir = path.join(tmpRoot, ".flow", "state", "to-do");
    inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
    await fs.mkdir(todoDir, { recursive: true });
    await fs.mkdir(inProgressDir, { recursive: true });
    await fs.mkdir(path.join(tmpRoot, ".flow", "state", "done"), { recursive: true });
});
afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// AC3 — the toggle tool
// ---------------------------------------------------------------------------
describe("markStoryReady AC3 — toggle a backlog item's readiness", () => {
    it("(a) flips ready false→true, leaves the item in to-do/ and status untouched", async () => {
        await seedTodo(makeTodoManifest(STORY_REF, { ready: false }));
        const result = await markStoryReady({
            targetRepoRoot: tmpRoot,
            ref: STORY_REF,
            ready: true,
        });
        expect(result.ref).toBe(STORY_REF);
        expect(result.ready).toBe(true);
        expect(result.noop).toBe(false);
        expect(result.state).toBe("to-do");
        // Manifest flag flipped, item still in to-do/, status untouched.
        const after = await readManifest(todoPath(STORY_REF));
        expect(after["ready"]).toBe(true);
        expect(after["status"]).toBe("to-do");
        await expect(fs.stat(todoPath(STORY_REF))).resolves.toBeTruthy();
        // No move into any other state directory.
        await expect(fs.stat(path.join(inProgressDir, `${STORY_REF}.yaml`))).rejects.toBeTruthy();
    });
    it("(b) re-marking ready is a no-op — no write (mtime stable), noop:true", async () => {
        await seedTodo(makeTodoManifest(STORY_REF, { ready: false }));
        // First toggle flips it to ready.
        await markStoryReady({ targetRepoRoot: tmpRoot, ref: STORY_REF, ready: true });
        const statsAfterFirst = await fs.stat(todoPath(STORY_REF));
        // Backdate by 1s so any second-call write is detectable on coarse filesystems.
        const oneSec = statsAfterFirst.mtimeMs / 1000 - 1;
        await fs.utimes(todoPath(STORY_REF), oneSec, oneSec);
        const mtimeBackdated = (await fs.stat(todoPath(STORY_REF))).mtimeMs;
        const result = await markStoryReady({ targetRepoRoot: tmpRoot, ref: STORY_REF, ready: true });
        expect(result.noop).toBe(true);
        expect(result.ready).toBe(true);
        expect(result.absPath).toBeUndefined();
        // mtime unchanged → no write happened.
        expect((await fs.stat(todoPath(STORY_REF))).mtimeMs).toBe(mtimeBackdated);
    });
    it("(c) marks not-ready — flips ready true→false", async () => {
        await seedTodo(makeTodoManifest(STORY_REF, { ready: true }));
        const result = await markStoryReady({ targetRepoRoot: tmpRoot, ref: STORY_REF, ready: false });
        expect(result.noop).toBe(false);
        expect(result.ready).toBe(false);
        const after = await readManifest(todoPath(STORY_REF));
        expect(after["ready"]).toBe(false);
        expect(after["status"]).toBe("to-do");
    });
    it("(d) an unknown reference raises NotAnEligibleBacklogItemError without mutating anything", async () => {
        await expect(markStoryReady({ targetRepoRoot: tmpRoot, ref: "native:does-not-exist", ready: true })).rejects.toBeInstanceOf(NotAnEligibleBacklogItemError);
    });
    it("(d) a non-to-do/ item (in-progress) raises NotAnEligibleBacklogItemError", async () => {
        const claimed = {
            ...makeTodoManifest(STORY_REF),
            status: "in-progress",
            claimed_by: SESSION_ULID,
        };
        await atomicWriteFile(path.join(inProgressDir, `${STORY_REF}.yaml`), yamlStringify(claimed, { lineWidth: 0 }));
        await expect(markStoryReady({ targetRepoRoot: tmpRoot, ref: STORY_REF, ready: true })).rejects.toBeInstanceOf(NotAnEligibleBacklogItemError);
        // The in-progress manifest is untouched.
        const after = await readManifest(path.join(inProgressDir, `${STORY_REF}.yaml`));
        expect(after["ready"]).toBe(false);
        expect(after["status"]).toBe("in-progress");
    });
    it("(d) a withdrawn backlog item raises NotAnEligibleBacklogItemError (withdraw wins)", async () => {
        await seedTodo(makeTodoManifest(STORY_REF, { ready: false, withdrawn: true }));
        await expect(markStoryReady({ targetRepoRoot: tmpRoot, ref: STORY_REF, ready: true })).rejects.toBeInstanceOf(NotAnEligibleBacklogItemError);
        // Untouched.
        const after = await readManifest(todoPath(STORY_REF));
        expect(after["ready"]).toBe(false);
        expect(after["withdrawn"]).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC4 — readiness telemetry event
// ---------------------------------------------------------------------------
describe("markStoryReady AC4 — readiness telemetry event", () => {
    it("a real toggle lands exactly one backlog.readiness_changed event with the right ref and value", async () => {
        await seedTodo(makeTodoManifest(STORY_REF, { ready: false }));
        await markStoryReady({
            targetRepoRoot: tmpRoot,
            ref: STORY_REF,
            ready: true,
            sessionUlid: SESSION_ULID,
        });
        const events = await readReadinessEvents();
        expect(events).toHaveLength(1);
        expect(events[0].data?.ref).toBe(STORY_REF);
        expect(events[0].data?.ready).toBe(true);
        expect(events[0].story_id).toBe(STORY_REF);
    });
    it("no event is emitted on an idempotent no-op re-toggle", async () => {
        await seedTodo(makeTodoManifest(STORY_REF, { ready: false }));
        // One real toggle → one event.
        await markStoryReady({ targetRepoRoot: tmpRoot, ref: STORY_REF, ready: true });
        expect(await readReadinessEvents()).toHaveLength(1);
        // No-op re-toggle (already true) → still exactly one event, none added.
        const noop = await markStoryReady({ targetRepoRoot: tmpRoot, ref: STORY_REF, ready: true });
        expect(noop.noop).toBe(true);
        expect(await readReadinessEvents()).toHaveLength(1);
    });
    it("no event is emitted on the typed-error path", async () => {
        await expect(markStoryReady({ targetRepoRoot: tmpRoot, ref: "native:nope", ready: true })).rejects.toBeInstanceOf(NotAnEligibleBacklogItemError);
        expect(await readReadinessEvents()).toHaveLength(0);
    });
});
