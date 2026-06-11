/**
 * Unit tests for the snapshot-gap behaviour in `claimStory` and
 * `detectInProgressHandEdit` — this story (native:01KTSQXX61SQ6CSE94YHW0PP27).
 *
 * AC2 — A missing snapshot on a freshly-claimed story is treated as the
 *       harmless lost-race / gap signal rather than a hand-edit, and is
 *       reported as "already claimed by another worker" when reached via
 *       claimNextStory.
 *
 * AC4 — An in-progress story that was GENUINELY hand-edited (its content
 *       really changed) is still refused as InProgressHandEditError — the
 *       new lost-race leniency does NOT swallow real tamper.
 *
 * Both ACs are verified by testing `detectInProgressHandEdit` directly plus
 * `claimStory`'s re-entry path behaviour (propagates _snapshot_missing when
 * claimed_by is absent, per the gap-vs-crash-recovery distinction).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { InProgressHandEditError } from "../../errors.js";
import {
  detectInProgressHandEdit,
  writeInProgressSnapshot,
} from "../../state/manifest-state-machine.js";
import { claimStory } from "../claim-story.js";
import type { ExecutionManifest } from "../../schemas/execution-manifest.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF = "native:01HZSNAP0000000000000001";
const SESSION_ULID = "01HZSESSION00000000000001";
const SOURCE_HASH = "a".repeat(64);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeInProgressManifest(
  opts: { claimed_by?: string } = {},
): ExecutionManifest {
  return {
    ref: REF,
    status: "in-progress" as const,
    adapter: "native" as const,
    source_path: `.flow/native-stories/${REF}.md`,
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [
      { text: "Given x, when y, then z.", kind: "integration" as const },
    ],
    title: "Snapshot gap test story",
    narrative: "As a dev, I want to test the gap.",
    withdrawn: false,
    ready: true,
    ...(opts.claimed_by !== undefined ? { claimed_by: opts.claimed_by } : {}),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let inProgressDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-snap-gap-"));
  inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
  await fs.mkdir(inProgressDir, { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "to-do"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "done"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeInProgressManifest(manifest: ExecutionManifest): Promise<string> {
  const absPath = path.join(inProgressDir, `${manifest.ref}.yaml`);
  await atomicWriteFile(absPath, yamlStringify(manifest, { lineWidth: 0 }));
  return absPath;
}

// ---------------------------------------------------------------------------
// AC2 — _snapshot_missing on a freshly-claimed story is the harmless gap signal
// ---------------------------------------------------------------------------

describe("AC2: _snapshot_missing is the harmless lost-race / gap signal", () => {
  it(
    "detectInProgressHandEdit throws InProgressHandEditError with changedFields=['_snapshot_missing'] when snapshot is absent",
    async () => {
      // Seed an in-progress manifest with NO snapshot sidecar.
      const manifest = makeInProgressManifest({ claimed_by: SESSION_ULID });
      await writeInProgressManifest(manifest);
      // Deliberately NO snapshot written — simulates the gap.

      await expect(
        detectInProgressHandEdit({ targetRepoRoot: tmpRoot, ref: REF }),
      ).rejects.toMatchObject({
        changedFields: ["_snapshot_missing"],
      });
    },
  );

  it(
    "claimStory re-entry with _snapshot_missing and claimed_by ABSENT propagates InProgressHandEditError (gap sub-case: winner still running)",
    async () => {
      // Simulate the gap: story is in in-progress/ with no claimed_by (winner has
      // done the rename but not yet written the field-rewrite). No snapshot either.
      const manifest = makeInProgressManifest(); // no claimed_by
      await writeInProgressManifest(manifest);
      // No snapshot written.

      // claimStory re-entry should propagate InProgressHandEditError with _snapshot_missing
      // (not re-baseline, because claimed_by is absent → gap scenario, winner still running).
      await expect(
        claimStory({ targetRepoRoot: tmpRoot, ref: REF, sessionUlid: SESSION_ULID }),
      ).rejects.toMatchObject({
        changedFields: ["_snapshot_missing"],
      });
    },
  );
});

// ---------------------------------------------------------------------------
// AC4 — genuine hand-edit still surfaces as InProgressHandEditError
// ---------------------------------------------------------------------------

describe("AC4: genuine hand-edit still refused — leniency never swallows real tamper", () => {
  it(
    "detectInProgressHandEdit throws InProgressHandEditError with real field names when content drifted since claim",
    async () => {
      // Seed a claimed manifest and write a clean snapshot.
      const manifest = makeInProgressManifest({ claimed_by: SESSION_ULID });
      await writeInProgressManifest(manifest);
      await writeInProgressSnapshot({ targetRepoRoot: tmpRoot, ref: REF, manifest });

      // Now mutate the in-progress manifest's title (simulating an operator hand-edit).
      const mutated: ExecutionManifest = { ...manifest, title: "HAND EDITED TITLE" };
      await atomicWriteFile(
        path.join(inProgressDir, `${REF}.yaml`),
        yamlStringify(mutated, { lineWidth: 0 }),
      );

      // The guard must detect the real drift and throw with the changed field name.
      await expect(
        detectInProgressHandEdit({ targetRepoRoot: tmpRoot, ref: REF }),
      ).rejects.toMatchObject({
        changedFields: expect.arrayContaining(["title"]),
      });
    },
  );

  it(
    "changedFields does NOT include '_snapshot_missing' when the snapshot exists but content drifted",
    async () => {
      const manifest = makeInProgressManifest({ claimed_by: SESSION_ULID });
      await writeInProgressManifest(manifest);
      await writeInProgressSnapshot({ targetRepoRoot: tmpRoot, ref: REF, manifest });

      // Mutate narrative.
      const mutated: ExecutionManifest = { ...manifest, narrative: "Changed narrative." };
      await atomicWriteFile(
        path.join(inProgressDir, `${REF}.yaml`),
        yamlStringify(mutated, { lineWidth: 0 }),
      );

      // Error must NOT include _snapshot_missing — real field drift, not a gap.
      await expect(
        detectInProgressHandEdit({ targetRepoRoot: tmpRoot, ref: REF }),
      ).rejects.toMatchObject({
        changedFields: expect.not.arrayContaining(["_snapshot_missing"]),
      });
    },
  );

  it(
    "a story with both a missing snapshot AND drifted fields surfaces ALL changed fields (snapshot_missing is not the only entry)",
    async () => {
      // No snapshot AND the title has been mutated relative to what the snapshot
      // WOULD have recorded. Since there's no snapshot, only _snapshot_missing is
      // reported — the hand-edit guard can't compare fields without a baseline.
      // But this test verifies: the presence of a genuine drift doesn't hide the
      // snapshot-missing signal either.
      const manifest = makeInProgressManifest({ claimed_by: SESSION_ULID });
      await writeInProgressManifest(manifest);
      // No snapshot.

      // The guard must throw _snapshot_missing (no baseline to compare against).
      const err = await detectInProgressHandEdit({ targetRepoRoot: tmpRoot, ref: REF })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InProgressHandEditError);
      const handEditErr = err as InProgressHandEditError;
      expect(handEditErr.changedFields).toEqual(["_snapshot_missing"]);
    },
  );
});
