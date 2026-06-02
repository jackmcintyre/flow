/**
 * Unit tests for `readDevOutcomeFile` / `devOutcomeFilePath`.
 *
 * Story native:01KT3YDHM10FPQ77N22BTJP9AF (AC2): the dev-outcome (PR-pointer)
 * record is namespaced per story ref under a session, so when one story's record
 * is written while another's is being written in the same run (same session
 * ULID, different refs), reading either back returns THAT story's own PR — and
 * neither record overwrites or cross-attributes the other.
 *
 * Before the per-ref fix every story in a drain run wrote to a single shared
 * `sessions/<ulid>/dev-outcome.json`, so a later/concurrent write clobbered an
 * earlier story's PR record — the 2026-06-02 cross-attribution regression.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { devOutcomeFilePath, readDevOutcomeFile, } from "../read-dev-outcome-file.js";
import { DevOutcomeFileMalformedError } from "../../errors.js";
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SESSION_ULID = "01HZSESSION00000000000001";
let tmpRoot;
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crew-dev-outcome-"));
});
afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});
async function writeOutcome(ref, outcome) {
    const filePath = devOutcomeFilePath(tmpRoot, SESSION_ULID, ref);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(outcome, null, 2), "utf8");
    return filePath;
}
// ---------------------------------------------------------------------------
// devOutcomeFilePath — per-ref namespacing
// ---------------------------------------------------------------------------
describe("devOutcomeFilePath", () => {
    it("derives a distinct, ref-namespaced path for two refs in the same session", () => {
        const pathA = devOutcomeFilePath(tmpRoot, SESSION_ULID, "native:01AAAA");
        const pathB = devOutcomeFilePath(tmpRoot, SESSION_ULID, "native:01BBBB");
        expect(pathA).not.toBe(pathB);
        // Both live under the same session directory, namespaced by sanitised ref.
        const sessionDir = path.join(tmpRoot, ".crew", "state", "sessions", SESSION_ULID);
        expect(pathA.startsWith(sessionDir)).toBe(true);
        expect(pathB.startsWith(sessionDir)).toBe(true);
        expect(path.basename(pathA)).toBe("dev-outcome.json");
    });
    it("sanitises a colon-bearing BMad ref into a safe single path segment", () => {
        const filePath = devOutcomeFilePath(tmpRoot, SESSION_ULID, "bmad:8.15");
        // The colon must not survive as a raw path-segment character.
        const segment = path.basename(path.dirname(filePath));
        expect(segment).not.toContain(":");
        expect(segment).toBe("bmad_8.15");
    });
});
// ---------------------------------------------------------------------------
// AC2 — concurrent-write read-back: no cross-attribution
// ---------------------------------------------------------------------------
describe("readDevOutcomeFile — concurrent-write read-back (AC2)", () => {
    it("returns each story's OWN PR when two records are written in one session", async () => {
        const refA = "native:01STORYA";
        const refB = "native:01STORYB";
        await writeOutcome(refA, {
            prUrl: "https://github.com/o/r/pull/101",
            prNumber: 101,
            branch: "crew/story-a",
            commitSha: "aaa111",
        });
        await writeOutcome(refB, {
            prUrl: "https://github.com/o/r/pull/202",
            prNumber: 202,
            branch: "crew/story-b",
            commitSha: "bbb222",
        });
        const outcomeA = await readDevOutcomeFile(tmpRoot, SESSION_ULID, refA);
        const outcomeB = await readDevOutcomeFile(tmpRoot, SESSION_ULID, refB);
        // Each read returns that ref's own PR — never the sibling's.
        expect(outcomeA?.prNumber).toBe(101);
        expect(outcomeA?.prUrl).toBe("https://github.com/o/r/pull/101");
        expect(outcomeB?.prNumber).toBe(202);
        expect(outcomeB?.prUrl).toBe("https://github.com/o/r/pull/202");
    });
    it("does not let a later write to one ref overwrite or cross-attribute an earlier write to another", async () => {
        const refEarlier = "native:01EARLIER";
        const refLater = "native:01LATER";
        await writeOutcome(refEarlier, {
            prUrl: "https://github.com/o/r/pull/55",
            prNumber: 55,
            branch: "crew/earlier",
            commitSha: "ee5555",
        });
        // A second story in the SAME session writes its record afterwards.
        await writeOutcome(refLater, {
            prUrl: "https://github.com/o/r/pull/66",
            prNumber: 66,
            branch: "crew/later",
            commitSha: "ff6666",
        });
        // The earlier record is untouched by the later write.
        const earlier = await readDevOutcomeFile(tmpRoot, SESSION_ULID, refEarlier);
        expect(earlier?.prNumber).toBe(55);
    });
    it("returns null for a ref with no record even when a sibling ref in the same session has one", async () => {
        const refWithPr = "native:01HASPR";
        const refNoPr = "native:01NOPR";
        await writeOutcome(refWithPr, {
            prUrl: "https://github.com/o/r/pull/77",
            prNumber: 77,
            branch: "crew/has-pr",
            commitSha: "777aaa",
        });
        // The unbuilt sibling has no record — must read null, NOT inherit the PR.
        const noPr = await readDevOutcomeFile(tmpRoot, SESSION_ULID, refNoPr);
        expect(noPr).toBeNull();
    });
});
// ---------------------------------------------------------------------------
// Behaviour preserved from the prior (per-session) implementation
// ---------------------------------------------------------------------------
describe("readDevOutcomeFile — absent / malformed", () => {
    it("returns null on ENOENT (file absent)", async () => {
        const result = await readDevOutcomeFile(tmpRoot, SESSION_ULID, "native:01MISSING");
        expect(result).toBeNull();
    });
    it("throws DevOutcomeFileMalformedError on invalid JSON", async () => {
        const ref = "native:01BADJSON";
        const filePath = devOutcomeFilePath(tmpRoot, SESSION_ULID, ref);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, "{ not valid json", "utf8");
        await expect(readDevOutcomeFile(tmpRoot, SESSION_ULID, ref)).rejects.toBeInstanceOf(DevOutcomeFileMalformedError);
    });
    it("throws DevOutcomeFileMalformedError when prNumber is missing", async () => {
        const ref = "native:01NOPRNUM";
        const filePath = devOutcomeFilePath(tmpRoot, SESSION_ULID, ref);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify({ prUrl: "https://github.com/o/r/pull/9", branch: "b", commitSha: "c" }), "utf8");
        await expect(readDevOutcomeFile(tmpRoot, SESSION_ULID, ref)).rejects.toBeInstanceOf(DevOutcomeFileMalformedError);
    });
});
