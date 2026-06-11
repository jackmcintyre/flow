/**
 * Integration tests for liveness-gated orphan recovery — Story native:01KTSQWJ62C4XQBDK4NXTEPQC0.
 *
 * AC1: When a first build run is actively building a story (it has claimed the story and
 *      owns a live work folder), a second build run's crash-recovery sweep leaves the first
 *      run's claimed story completely untouched — because it confirms the first run is still
 *      alive before treating any of its work as abandoned.
 *
 * AC2: When a build run has genuinely crashed (left a claimed story with no live run still
 *      owning it), a new build run's crash-recovery sweep recognises that abandoned story as
 *      genuinely orphaned and recovers it as before — so the aliveness check protects
 *      in-flight work without ever stranding truly crashed work.
 *
 * Both ACs are exercised through `scanOrphanedInProgress` with a stubbed
 * `isSessionAliveImpl` so no real processes or heartbeat files are needed.
 *
 * vitest: plugins/flow/mcp-server/src/tools/__tests__/liveness-before-reclaim.test.ts
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { scanOrphanedInProgress } from "../scan-orphaned-in-progress.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENT_SESSION = "01JVWX2CURRENT0000000002AA";
const LIVE_OTHER_SESSION = "01JVWX2LIVESESSION00000001";
const DEAD_OTHER_SESSION = "01JVWX2DEADSESSION00000002";
const SOURCE_HASH = "b".repeat(64);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifestYaml(
  ref: string,
  claimed_by: string,
): string {
  const manifest: Record<string, unknown> = {
    ref,
    status: "in-progress",
    adapter: "native",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [
      { text: "Given the story, when done, then it works.", kind: "integration" },
    ],
    title: "Liveness test story",
    narrative: "As a dev, I want the liveness gate to work.",
    withdrawn: false,
    claimed_by,
  };
  return yamlStringify(manifest, { lineWidth: 0 });
}

async function seedInProgressManifest(
  stateRoot: string,
  ref: string,
  claimed_by: string,
): Promise<void> {
  const dir = path.join(stateRoot, "in-progress");
  await fs.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, `${ref}.yaml`);
  await fs.writeFile(absPath, makeManifestYaml(ref, claimed_by), "utf8");
}

/** A stub execaImpl that always reports no open PRs. */
const noOpenPrExeca = (async () => ({ stdout: "[]" })) as unknown as typeof import("execa").execa;

/** An isSessionAliveImpl that marks LIVE_OTHER_SESSION as alive and everything else as dead. */
const liveStubFor = (liveSession: string) =>
  async (_root: string, sessionUlid: string): Promise<boolean> => {
    return sessionUlid === liveSession;
  };

/** An isSessionAliveImpl that always returns dead. */
const allDead = async (_root: string, _sessionUlid: string): Promise<boolean> => false;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let stateRoot: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-liveness-reclaim-"));
  stateRoot = path.join(tmpDir, ".flow", "state");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1: live run's claimed story is NOT returned as an orphan
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — liveness gate (AC1)", () => {
  it(
    "does NOT return a story claimed by a still-alive session as an orphan — " +
      "the second run leaves the first run's in-flight story completely untouched",
    async () => {
      const ref = "native:01KTSQWJLIVE00000000001";
      await seedInProgressManifest(stateRoot, ref, LIVE_OTHER_SESSION);

      const result = await scanOrphanedInProgress({
        targetRepoRoot: tmpDir,
        sessionUlid: CURRENT_SESSION,
        execaImpl: noOpenPrExeca,
        isSessionAliveImpl: liveStubFor(LIVE_OTHER_SESSION),
      });

      // The story belongs to a live run — it must NOT appear as an orphan.
      expect(result.orphans).toHaveLength(0);
    },
  );

  it(
    "correctly handles multiple stories: skips live-session stories and returns dead-session stories",
    async () => {
      const liveRef = "native:01KTSQWJLIVE00000000002";
      const deadRef = "native:01KTSQWJDEAD00000000002";
      await seedInProgressManifest(stateRoot, liveRef, LIVE_OTHER_SESSION);
      await seedInProgressManifest(stateRoot, deadRef, DEAD_OTHER_SESSION);

      const result = await scanOrphanedInProgress({
        targetRepoRoot: tmpDir,
        sessionUlid: CURRENT_SESSION,
        execaImpl: noOpenPrExeca,
        isSessionAliveImpl: liveStubFor(LIVE_OTHER_SESSION),
      });

      // Only the dead session's story is an orphan.
      expect(result.orphans).toHaveLength(1);
      expect(result.orphans[0]!.ref).toBe(deadRef);
      expect(result.orphans[0]!.staleUlid).toBe(DEAD_OTHER_SESSION);
    },
  );

  it(
    "still skips the current session's own story regardless of liveness check",
    async () => {
      const ownRef = "native:01KTSQWJCURRENT000000001";
      await seedInProgressManifest(stateRoot, ownRef, CURRENT_SESSION);

      const result = await scanOrphanedInProgress({
        targetRepoRoot: tmpDir,
        sessionUlid: CURRENT_SESSION,
        execaImpl: noOpenPrExeca,
        // liveness impl that would return alive for CURRENT_SESSION (should be irrelevant
        // since the current session is filtered before the liveness check)
        isSessionAliveImpl: liveStubFor(CURRENT_SESSION),
      });

      expect(result.orphans).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// AC2: genuinely crashed run's story IS returned as an orphan
// ---------------------------------------------------------------------------

describe("scanOrphanedInProgress — crashed run recovery (AC2)", () => {
  it(
    "returns a story claimed by a confirmed-dead session as an orphan — " +
      "crash recovery proceeds as before, genuinely abandoned work is never stranded",
    async () => {
      const ref = "native:01KTSQWJDEAD00000000003";
      await seedInProgressManifest(stateRoot, ref, DEAD_OTHER_SESSION);

      const result = await scanOrphanedInProgress({
        targetRepoRoot: tmpDir,
        sessionUlid: CURRENT_SESSION,
        execaImpl: noOpenPrExeca,
        isSessionAliveImpl: allDead,
      });

      // The crashed session's story MUST appear as an orphan for recovery.
      expect(result.orphans).toHaveLength(1);
      expect(result.orphans[0]!.ref).toBe(ref);
      expect(result.orphans[0]!.staleUlid).toBe(DEAD_OTHER_SESSION);
    },
  );

  it(
    "recovers orphan fields correctly (title, resumeAttempts) for a dead session",
    async () => {
      const ref = "native:01KTSQWJDEAD00000000004";
      await seedInProgressManifest(stateRoot, ref, DEAD_OTHER_SESSION);

      const result = await scanOrphanedInProgress({
        targetRepoRoot: tmpDir,
        sessionUlid: CURRENT_SESSION,
        execaImpl: noOpenPrExeca,
        isSessionAliveImpl: allDead,
      });

      expect(result.orphans).toHaveLength(1);
      const orphan = result.orphans[0]!;
      expect(orphan.title).toBe("Liveness test story");
      expect(orphan.resumeAttempts).toBe(0);
      expect(orphan.hasTranscript).toBe(false);
      expect(orphan.prNumber).toBeNull();
    },
  );

  it(
    "treats a session with an indeterminate liveness verdict (aliveCheck returns false) " +
      "as dead — fail-safe ensures truly crashed work is never stranded",
    async () => {
      const ref = "native:01KTSQWJINDETERMINATE0001";
      await seedInProgressManifest(stateRoot, ref, DEAD_OTHER_SESSION);

      // Simulate indeterminate: aliveCheck throws internally (the real impl catches
      // read errors and returns false). The stub mirrors that fail-safe by returning false.
      const indeterminateStub = async (): Promise<boolean> => false;

      const result = await scanOrphanedInProgress({
        targetRepoRoot: tmpDir,
        sessionUlid: CURRENT_SESSION,
        execaImpl: noOpenPrExeca,
        isSessionAliveImpl: indeterminateStub,
      });

      // Indeterminate = dead (fail-safe) → story is recovered as orphan.
      expect(result.orphans).toHaveLength(1);
      expect(result.orphans[0]!.ref).toBe(ref);
    },
  );

  it(
    "recovers multiple dead-session stories in alphabetical order",
    async () => {
      const refA = "native:01KTSQWJDEADA000000001";
      const refB = "native:01KTSQWJDEADB000000001";
      // Seed in reverse order to verify sort.
      await seedInProgressManifest(stateRoot, refB, DEAD_OTHER_SESSION);
      await seedInProgressManifest(stateRoot, refA, DEAD_OTHER_SESSION);

      const result = await scanOrphanedInProgress({
        targetRepoRoot: tmpDir,
        sessionUlid: CURRENT_SESSION,
        execaImpl: noOpenPrExeca,
        isSessionAliveImpl: allDead,
      });

      expect(result.orphans).toHaveLength(2);
      expect(result.orphans[0]!.ref).toBe(refA);
      expect(result.orphans[1]!.ref).toBe(refB);
    },
  );
});
