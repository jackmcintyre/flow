/**
 * Unit tests for `scanOrphanedInProgress` — Story 5.11 Task 1.5.
 *
 * Covers:
 *   (a) No in-progress/ directory → empty array.
 *   (b) Empty in-progress/ directory → empty array.
 *   (c) Current-session manifest only → empty array (5e fixture).
 *   (d) One stale-ULID manifest with transcript → one orphan with hasTranscript: true.
 *   (e) One stale-ULID manifest without transcript → hasTranscript: false.
 *   (f) Two stale-ULID manifests → returned in alphabetical ref order (5d fixture).
 *   (g) Absent claimed_by → skipped silently.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { scanOrphanedInProgress } from "../scan-orphaned-in-progress.js";
import { devOutcomeFilePath } from "../../lib/read-dev-outcome-file.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENT_SESSION_ULID = "01JVWX2CURRENT0000000001AA";
const STALE_ULID_A = "01JVWX2STALE0000000000001A";
const STALE_ULID_B = "01JVWX2STALE0000000000002B";
const SOURCE_HASH = "a".repeat(64);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifestYaml(
  ref: string,
  opts: { claimed_by?: string; omitClaimedBy?: boolean; drain_resume_attempts?: number } = {},
): string {
  const manifest: Record<string, unknown> = {
    ref,
    status: "in-progress",
    adapter: "native",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [
      { text: "Given AC, when done, then works.", kind: "integration" },
    ],
    title: "Test story",
    narrative: "As a dev, I want to test orphan scan.",
    withdrawn: false,
  };
  if (!opts.omitClaimedBy) {
    manifest["claimed_by"] = opts.claimed_by ?? CURRENT_SESSION_ULID;
  }
  if (opts.drain_resume_attempts !== undefined) {
    manifest["drain_resume_attempts"] = opts.drain_resume_attempts;
  }
  return yamlStringify(manifest, { lineWidth: 0 });
}

// Story native:01KT3YDHM10FPQ77N22BTJP9AF: the dev-outcome record is now
// namespaced per story ref under the stale session's directory, so seeding takes
// the ref and writes to the same per-ref path the crash-recovery reader derives.
async function seedDevOutcome(
  targetRepoRoot: string,
  sessionUlid: string,
  ref: string,
  prNumber: number,
): Promise<void> {
  const outcomePath = devOutcomeFilePath(targetRepoRoot, sessionUlid, ref);
  await fs.mkdir(path.dirname(outcomePath), { recursive: true });
  await fs.writeFile(
    outcomePath,
    JSON.stringify({ prUrl: `https://x/pull/${prNumber}`, prNumber, branch: "b", commitSha: "abc123" }),
    "utf8",
  );
}

async function seedInProgressManifest(
  stateRoot: string,
  ref: string,
  opts?: { claimed_by?: string; omitClaimedBy?: boolean; drain_resume_attempts?: number },
): Promise<string> {
  const dir = path.join(stateRoot, "in-progress");
  await fs.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, `${ref}.yaml`);
  await fs.writeFile(absPath, makeManifestYaml(ref, opts), "utf8");
  return absPath;
}

async function seedTranscriptFile(
  stateRoot: string,
  sessionUlid: string,
  content = "dev transcript content\nHandoff to reviewer — story x ready for review.",
): Promise<string> {
  const transcriptPath = path.join(
    stateRoot,
    "sessions",
    sessionUlid,
    "dev-transcript.txt",
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.writeFile(transcriptPath, content, "utf8");
  return transcriptPath;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let stateRoot: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-5-11-scan-"));
  stateRoot = path.join(tmpDir, ".flow", "state");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) No in-progress/ directory → empty array
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — no in-progress directory", () => {
  it("returns empty orphans array when in-progress/ does not exist", async () => {
    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });
    expect(result.orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) Empty in-progress/ → empty array
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — empty in-progress directory", () => {
  it("returns empty orphans array when in-progress/ is empty", async () => {
    await fs.mkdir(path.join(stateRoot, "in-progress"), { recursive: true });
    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });
    expect(result.orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c) Current-session manifest only → empty array (5e fixture)
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — current-session manifest (5e fixture)", () => {
  it("returns empty array when in-progress/ has only the current session's manifest", async () => {
    const ref = "native:01JVWX2CURRENT0000000001";
    await seedInProgressManifest(stateRoot, ref, { claimed_by: CURRENT_SESSION_ULID });

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });
    expect(result.orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Crash-recovery fields: title, prNumber (from the stale session's
// dev-outcome.json), and resumeAttempts (from the manifest).
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — crash-recovery fields", () => {
  it("recovers prNumber from the stale session's dev-outcome.json and reports title + resumeAttempts", async () => {
    const ref = "native:01JVWX2STALE0000000000009";
    await seedInProgressManifest(stateRoot, ref, {
      claimed_by: STALE_ULID_A,
      drain_resume_attempts: 2,
    });
    await seedDevOutcome(tmpDir, STALE_ULID_A, ref, 42);

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]!.prNumber).toBe(42);
    expect(result.orphans[0]!.title).toBe("Test story");
    expect(result.orphans[0]!.resumeAttempts).toBe(2);
  });

  it("reports prNumber: null when the dev never opened a PR (no dev-outcome.json) and resumeAttempts: 0 when unset", async () => {
    const ref = "native:01JVWX2STALE0000000000010";
    await seedInProgressManifest(stateRoot, ref, { claimed_by: STALE_ULID_A });
    // No dev-outcome.json seeded for STALE_ULID_A.

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]!.prNumber).toBeNull();
    expect(result.orphans[0]!.resumeAttempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC1 (story native:01KT3YDHM10FPQ77N22BTJP9AF): a crash-recovery scan must
// never cross-attribute a sibling's PR. Two stories built concurrently in ONE
// drain run share a single session ULID; before the per-ref fix they wrote to
// the same `dev-outcome.json`, so recovery resumed whichever story it scanned
// against the last-written PR — marking an unbuilt story done against a
// sibling's already-merged PR (the 2026-06-02 regression). With the per-ref
// record each story recovers its OWN PR.
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — sibling PR is never cross-attributed (AC1)", () => {
  it("recovers each concurrently-built story's OWN prNumber when both share one session ULID", async () => {
    const refA = "native:01JVWX2STALE000000000A0001";
    const refB = "native:01JVWX2STALE000000000B0002";
    // Both stories were claimed by the SAME (now-stale) drain session — the
    // concurrency case that drove the regression.
    await seedInProgressManifest(stateRoot, refA, { claimed_by: STALE_ULID_A });
    await seedInProgressManifest(stateRoot, refB, { claimed_by: STALE_ULID_A });
    // Each opened its own PR; both records live under the shared session ULID
    // but at distinct per-ref paths.
    await seedDevOutcome(tmpDir, STALE_ULID_A, refA, 101);
    await seedDevOutcome(tmpDir, STALE_ULID_A, refB, 202);

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    // Orphans are sorted by ref; refA sorts before refB.
    expect(result.orphans).toHaveLength(2);
    const orphanA = result.orphans.find((o) => o.ref === refA);
    const orphanB = result.orphans.find((o) => o.ref === refB);
    expect(orphanA).toBeDefined();
    expect(orphanB).toBeDefined();
    // The crux: each story resumes against its OWN PR — never the sibling's.
    expect(orphanA!.prNumber).toBe(101);
    expect(orphanB!.prNumber).toBe(202);
  });

  it("recovers prNumber for the built sibling as null for the unbuilt one — never the built one's PR", async () => {
    // The exact regression shape: storyBuilt opened a PR; storyUnbuilt never did.
    // An unbuilt story must recover prNumber: null, NOT the built sibling's PR
    // (which previously let it be marked done against a PR it never produced).
    const refBuilt = "native:01JVWX2STALEBUILT00000001";
    const refUnbuilt = "native:01JVWX2STALEUNBUILT00002";
    await seedInProgressManifest(stateRoot, refBuilt, { claimed_by: STALE_ULID_A });
    await seedInProgressManifest(stateRoot, refUnbuilt, { claimed_by: STALE_ULID_A });
    // Only the built story has a dev-outcome record.
    await seedDevOutcome(tmpDir, STALE_ULID_A, refBuilt, 303);

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(result.orphans).toHaveLength(2);
    const builtOrphan = result.orphans.find((o) => o.ref === refBuilt);
    const unbuiltOrphan = result.orphans.find((o) => o.ref === refUnbuilt);
    expect(builtOrphan!.prNumber).toBe(303);
    // The unbuilt story must NOT inherit the built sibling's PR.
    expect(unbuiltOrphan!.prNumber).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (d) One stale-ULID manifest with transcript → hasTranscript: true
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — stale manifest with transcript", () => {
  it("returns one orphan with hasTranscript: true when transcript exists", async () => {
    const ref = "native:01JVWX2STALE0000000000001";
    await seedInProgressManifest(stateRoot, ref, { claimed_by: STALE_ULID_A });
    await seedTranscriptFile(stateRoot, STALE_ULID_A);

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(result.orphans).toHaveLength(1);
    const orphan = result.orphans[0]!;
    expect(orphan.ref).toBe(ref);
    expect(orphan.staleUlid).toBe(STALE_ULID_A);
    expect(orphan.hasTranscript).toBe(true);
    expect(orphan.manifestPath).toContain(`in-progress/${ref}.yaml`);
    expect(orphan.transcriptPath).toContain(
      path.join("sessions", STALE_ULID_A, "dev-transcript.txt"),
    );
  });
});

// ---------------------------------------------------------------------------
// (e) One stale-ULID manifest without transcript → hasTranscript: false
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — stale manifest without transcript", () => {
  it("returns one orphan with hasTranscript: false when no transcript exists", async () => {
    const ref = "native:01JVWX2STALE0000000000002";
    await seedInProgressManifest(stateRoot, ref, { claimed_by: STALE_ULID_A });
    // No transcript file seeded.

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(result.orphans).toHaveLength(1);
    const orphan = result.orphans[0]!;
    expect(orphan.ref).toBe(ref);
    expect(orphan.staleUlid).toBe(STALE_ULID_A);
    expect(orphan.hasTranscript).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (f) Two stale-ULID manifests → alphabetical order (5d fixture)
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — alphabetical ordering (5d fixture)", () => {
  it("returns two orphans in alphabetical ref order", async () => {
    const refA = "native:01JVWX2A-FIRST00000000001";
    const refB = "native:01JVWX2B-SECOND0000000001";
    // Seed in reverse order to test sorting.
    await seedInProgressManifest(stateRoot, refB, { claimed_by: STALE_ULID_B });
    await seedInProgressManifest(stateRoot, refA, { claimed_by: STALE_ULID_A });

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(result.orphans).toHaveLength(2);
    // Should be in alphabetical order by ref (filename).
    expect(result.orphans[0]!.ref).toBe(refA);
    expect(result.orphans[1]!.ref).toBe(refB);
  });
});

// ---------------------------------------------------------------------------
// (g) Absent claimed_by → skipped silently
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — absent claimed_by skipped silently", () => {
  it("silently skips manifests with no claimed_by field", async () => {
    const ref = "native:01JVWX2MALFORMED00000001A";
    await seedInProgressManifest(stateRoot, ref, { omitClaimedBy: true });

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(result.orphans).toEqual([]);
  });

  it("returns other orphans when mixed with a malformed manifest", async () => {
    const refMalformed = "native:01JVWX2MALFORMED00000001B";
    const refOrphan = "native:01JVWX2ORPHAN000000000001";
    await seedInProgressManifest(stateRoot, refMalformed, { omitClaimedBy: true });
    await seedInProgressManifest(stateRoot, refOrphan, { claimed_by: STALE_ULID_A });

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]!.ref).toBe(refOrphan);
  });
});

// ---------------------------------------------------------------------------
// (h) Claim-time `<ref>.snapshot.yaml` sidecar is skipped, not parsed
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — claim-time snapshot sidecar skipped", () => {
  // Test seam: avoid a real `gh pr list` call for the orphan's hasOpenPR probe.
  const noOpenPrExeca = (async () => ({ stdout: "[]" })) as unknown as typeof import("execa").execa;

  // The sidecar mirrors only the operator-editable fields (no ref/status/adapter),
  // matching what claim-story.ts writes at `<ref>.snapshot.yaml` (Story 5.29).
  function makeSnapshotYaml(): string {
    return yamlStringify(
      {
        source_hash: SOURCE_HASH,
        title: "Test story",
        narrative: "As a dev, I want to test orphan scan.",
        acceptance_criteria: [
          { text: "Given AC, when done, then works.", kind: "integration" },
        ],
      },
      { lineWidth: 0 },
    );
  }

  it("skips the sidecar and still returns the real orphan (does not throw)", async () => {
    const ref = "native:01JVWX2STALE0000000000003";
    await seedInProgressManifest(stateRoot, ref, { claimed_by: STALE_ULID_A });
    // Seed the sidecar baseline next to the live manifest.
    await fs.writeFile(
      path.join(stateRoot, "in-progress", `${ref}.snapshot.yaml`),
      makeSnapshotYaml(),
      "utf8",
    );

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
      execaImpl: noOpenPrExeca,
    });

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]!.ref).toBe(ref);
    expect(result.orphans[0]!.staleUlid).toBe(STALE_ULID_A);
  });
});
