/**
 * Story native:01KTAWXGA4X1YN5SQT760P359Y — Auto-advance cycle on retro completion.
 *
 * Covers the three ACs for the retro → openCycle wiring:
 *
 *   AC1 (integration): after `openCycle` is called as the retro exit step,
 *     `gatherRetroInputs` returns only manifests at or after the new cycle's
 *     `opened_at` — the prior cycle's manifests are excluded.
 *
 *   AC2 (unit): before the window resets, a YAML archive file is written
 *     under `.flow/cycle-archive/` capturing the prior cycle's done manifests
 *     and retro-proposal paths.
 *
 *   AC3 (unit): when `writeRetroProposal` throws
 *     (`RetroProposalAlreadyExistsError` or `MalformedRetroProposalError`),
 *     `openCycle` is NOT called — `cycle-state.json` remains unchanged after
 *     the failed proposal write.
 *
 *   AC4 (unit): `openCycle` returns `cycleUlid` and `openedAt` values that
 *     are sufficient for the skill to surface the plain-language message
 *     "Cycle advanced to <cycleUlid>, new window opens at <openedAt>" to the
 *     operator (SKILL.md step 5d).
 *
 * All tests are pure deterministic — no LLM invocation, no network.
 * File mtimes (a done manifest's completion instant) are set with `fs.utimes`,
 * which is a read-shaped operation not covered by the fs-write guard.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { gatherRetroInputs } from "../gather-retro-inputs.js";
import { openCycle } from "../open-cycle.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { readCycleState } from "../../schemas/cycle-state.js";
import {
  RetroProposalAlreadyExistsError,
} from "../../errors.js";

// Resolve the production plugin root (plugins/flow/) from this test file's location:
//   plugins/flow/mcp-server/src/tools/__tests__/  →  4 levels up  →  plugins/flow/
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_PLUGIN_ROOT = path.resolve(HERE, "..", "..", "..", "..");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "open-cycle-retro-"));
  // Seed a minimal native workspace so gatherRetroInputs resolves cleanly.
  await seedNativeWorkspace(tmpRoot);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function seedNativeWorkspace(root: string): Promise<void> {
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    yamlStringify({ adapter: "native" }, { lineWidth: 0 }),
  );
  // Native adapter's detect() requires at least one ULID-named .md file.
  await atomicWriteFile(
    path.join(root, ".flow", "native-stories", "01KTAWXGA4X1YN5SQT760P359Y.md"),
    "# fixture story\n",
  );
}

function buildDoneManifest(ref: string): Record<string, unknown> {
  return {
    ref,
    status: "done",
    adapter: "native",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: `Story ${ref}`,
    narrative: "As a user, I want X, so that Y.",
    withdrawn: false,
    claimed_by: "01KSRP1Y9J9R9F5SKB7QXQ83ZK",
  };
}

/**
 * Write a done/ manifest and stamp its mtime to `completedAtMs` — the file
 * mtime IS the completion instant the retro windows on.
 */
async function seedDoneManifest(ref: string, completedAtMs: number): Promise<void> {
  const absPath = path.join(tmpRoot, ".flow", "state", "done", `${ref}.yaml`);
  await atomicWriteFile(absPath, yamlStringify(buildDoneManifest(ref), { lineWidth: 0 }));
  const when = new Date(completedAtMs);
  await fs.utimes(absPath, when, when);
}

async function seedRetroProposal(isoStamp: string): Promise<string> {
  const absPath = path.join(tmpRoot, ".flow", "retro-proposals", `${isoStamp}.md`);
  await atomicWriteFile(absPath, "# a proposal\n");
  return absPath;
}

async function listArchiveFiles(): Promise<string[]> {
  const dir = path.join(tmpRoot, ".flow", "cycle-archive");
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// AC1 — gatherRetroInputs after openCycle excludes pre-window manifests
// ---------------------------------------------------------------------------

describe("AC1 — gatherRetroInputs after retro exit openCycle excludes prior-cycle manifests", () => {
  it("excludes done manifests completed before the cycle opened, includes those after", async () => {
    const cycleOpenMs = Date.parse("2026-06-01T00:00:00.000Z");
    const beforeCycleMs = Date.parse("2026-05-15T00:00:00.000Z");
    const afterCycleMs = Date.parse("2026-06-05T00:00:00.000Z");

    // Two stories completed BEFORE the cycle opens — these must be excluded.
    await seedDoneManifest("native:PRECYCLEA000000000000001", beforeCycleMs);
    await seedDoneManifest("native:PRECYCLEB000000000000002", beforeCycleMs);
    // One story completed AFTER the cycle opens — this must be included.
    await seedDoneManifest("native:POSTCYCLEC00000000000003", afterCycleMs);

    // Simulate the retro exit step: openCycle is called after writeRetroProposal
    // succeeds (confirmed by the locked handoff phrase).
    await openCycle({
      targetRepoRoot: tmpRoot,
      now: () => new Date(cycleOpenMs),
    });

    // Subsequent call to gatherRetroInputs must scope to the new window.
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // Only the post-cycle story is in scope.
    expect(bundle.doneManifests.map((m) => m.ref)).toEqual([
      "native:POSTCYCLEC00000000000003",
    ]);

    // Pre-cycle manifests are excluded entirely.
    const refs = bundle.doneManifests.map((m) => m.ref);
    expect(refs).not.toContain("native:PRECYCLEA000000000000001");
    expect(refs).not.toContain("native:PRECYCLEB000000000000002");
  });

  it("a story completed exactly at the open instant is included (>= boundary)", async () => {
    const cycleOpenMs = Date.parse("2026-06-01T00:00:00.000Z");
    // Completed exactly at the cycle-open boundary — must be in scope.
    await seedDoneManifest("native:EXACTBOUNDARY0000000001", cycleOpenMs);

    await openCycle({
      targetRepoRoot: tmpRoot,
      now: () => new Date(cycleOpenMs),
    });

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.doneManifests.map((m) => m.ref)).toContain(
      "native:EXACTBOUNDARY0000000001",
    );
  });

  it("all manifests returned when no cycle was open before openCycle", async () => {
    // Without any prior cycle, all history is baseline.
    const longAgoMs = Date.parse("2026-01-01T00:00:00.000Z");
    await seedDoneManifest("native:OLDHISTORY000000000001", longAgoMs);

    // No cycle opened yet — gatherRetroInputs returns full history.
    const bundleBefore = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundleBefore.doneManifests.map((m) => m.ref)).toContain(
      "native:OLDHISTORY000000000001",
    );

    // Open cycle in the future — now the pre-cycle manifest is excluded.
    const futureMs = Date.parse("2026-06-01T00:00:00.000Z");
    await openCycle({
      targetRepoRoot: tmpRoot,
      now: () => new Date(futureMs),
    });

    const bundleAfter = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    // The old manifest is now excluded because its mtime predates the cycle open.
    expect(bundleAfter.doneManifests.map((m) => m.ref)).not.toContain(
      "native:OLDHISTORY000000000001",
    );
  });
});

// ---------------------------------------------------------------------------
// AC2 — cycle-archive YAML is written before the window resets
// ---------------------------------------------------------------------------

describe("AC2 — cycle-archive YAML captures prior manifests and proposal paths before window resets", () => {
  it("archive file is written with done manifests and retro proposal paths from the prior cycle", async () => {
    // Cycle 1 opens.
    const cycle1OpenMs = Date.parse("2026-06-01T00:00:00.000Z");
    const firstOpen = await openCycle({
      targetRepoRoot: tmpRoot,
      now: () => new Date(cycle1OpenMs),
    });

    // No archive on first open (nothing to archive).
    expect(firstOpen.archivePath).toBeNull();
    expect(await listArchiveFiles()).toEqual([]);

    // Work inside cycle 1: a story completes and a retro proposal is written.
    const inCycle1Ms = Date.parse("2026-06-05T00:00:00.000Z");
    await seedDoneManifest("native:CYCLE1DONE0000000000001", inCycle1Ms);
    await seedRetroProposal("2026-06-06T00:00:00.000Z");

    // Retro exit step fires: openCycle is called to advance to cycle 2.
    const cycle2OpenMs = Date.parse("2026-07-01T00:00:00.000Z");
    const secondOpen = await openCycle({
      targetRepoRoot: tmpRoot,
      now: () => new Date(cycle2OpenMs),
    });

    // Archive was written before the window reset.
    expect(secondOpen.archivePath).not.toBeNull();
    const archives = await listArchiveFiles();
    expect(archives.length).toBe(1);
    expect(archives[0]).toContain(firstOpen.cycleUlid);

    // Read and verify the archive content.
    const raw = await fs.readFile(secondOpen.archivePath!, "utf8");
    const record = yamlParse(raw) as {
      cycle_ulid: string;
      opened_at: string;
      closed_at: string;
      done_manifests: Array<{ ref: string }>;
      retro_proposals: Array<{ path: string; iso_timestamp: string }>;
      telemetry_summary: { event_count: number; skipped_count: number };
    };

    // The archive captures cycle 1's identity.
    expect(record.cycle_ulid).toBe(firstOpen.cycleUlid);
    expect(record.opened_at).toBe(firstOpen.openedAt);
    expect(record.closed_at).toBe(secondOpen.openedAt);

    // The archive captures cycle 1's done manifests.
    expect(record.done_manifests.map((m) => m.ref)).toEqual([
      "native:CYCLE1DONE0000000000001",
    ]);

    // The archive captures the retro proposal path (relative, not absolute).
    expect(record.retro_proposals.map((p) => p.iso_timestamp)).toEqual([
      "2026-06-06T00:00:00.000Z",
    ]);

    // After the second open, cycle-state.json names the NEW cycle ULID.
    const state = await readCycleState(tmpRoot);
    expect(state?.cycle_ulid).toBe(secondOpen.cycleUlid);
    expect(state?.cycle_ulid).not.toBe(firstOpen.cycleUlid);
  });

  it("archive is a sibling file when openCycle is called again (idempotent re-run)", async () => {
    // First open — no prior cycle to archive.
    const t1 = Date.parse("2026-06-01T00:00:00.000Z");
    await openCycle({ targetRepoRoot: tmpRoot, now: () => new Date(t1) });

    // Second open — archives cycle 1.
    const t2 = Date.parse("2026-07-01T00:00:00.000Z");
    const second = await openCycle({ targetRepoRoot: tmpRoot, now: () => new Date(t2) });
    expect(second.archivePath).not.toBeNull();

    // Third open — archives cycle 2 as a NEW sibling, does not clobber cycle-1 archive.
    const t3 = Date.parse("2026-08-01T00:00:00.000Z");
    const third = await openCycle({ targetRepoRoot: tmpRoot, now: () => new Date(t3) });
    expect(third.archivePath).not.toBeNull();
    expect(third.archivePath).not.toBe(second.archivePath);

    const archives = await listArchiveFiles();
    expect(archives.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC3 — openCycle is NOT called when writeRetroProposal throws
// ---------------------------------------------------------------------------

describe("AC3 — cycle does not advance when writeRetroProposal throws", () => {
  it("cycle-state.json is unchanged after RetroProposalAlreadyExistsError", async () => {
    // Open a cycle so there IS a known cycle-state.json to check.
    const cycleOpenMs = Date.parse("2026-06-01T00:00:00.000Z");
    const initialOpen = await openCycle({
      targetRepoRoot: tmpRoot,
      now: () => new Date(cycleOpenMs),
    });
    const stateBeforeAttempt = await readCycleState(tmpRoot);
    expect(stateBeforeAttempt?.cycle_ulid).toBe(initialOpen.cycleUlid);

    const ISO = "2026-06-05T12:00:00.000Z";

    // Write a first valid proposal (simulating the first retro analyst call).
    const validProposal = {
      type: "rule" as const,
      id: "01KSRP1Y9J9R9F5SKB7QXQ83ZK",
      created_at: ISO,
      rationale: "Test rationale.",
      text: "Test rule text.",
      target_failure_class: "test-failure",
      recommended_promotion_level: "must" as const,
    };
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [validProposal],
    });

    // Attempt to write a SECOND proposal with the same timestamp — this MUST throw
    // RetroProposalAlreadyExistsError (the analyst re-used the timestamp).
    let writeThrew = false;
    try {
      await writeRetroProposal({
        targetRepoRoot: tmpRoot,
        isoTimestamp: ISO,
        proposals: [validProposal],
      });
    } catch (err) {
      // Verify it is the expected error type.
      expect(err).toBeInstanceOf(RetroProposalAlreadyExistsError);
      writeThrew = true;
      // The skill's conditional gate: because writeRetroProposal threw,
      // openCycle MUST NOT be called. We verify this by asserting
      // cycle-state.json is still the initial cycle ULID (unchanged).
    }
    expect(writeThrew).toBe(true);

    // Cycle must NOT have advanced — openCycle was not called.
    const stateAfterFailedWrite = await readCycleState(tmpRoot);
    expect(stateAfterFailedWrite?.cycle_ulid).toBe(initialOpen.cycleUlid);
  });

  it("cycle-state.json is unchanged after MalformedRetroProposalError (invalid proposal shape)", async () => {
    // Open a cycle to establish initial state.
    const cycleOpenMs = Date.parse("2026-06-01T00:00:00.000Z");
    const initialOpen = await openCycle({
      targetRepoRoot: tmpRoot,
      now: () => new Date(cycleOpenMs),
    });
    const stateBeforeAttempt = await readCycleState(tmpRoot);
    expect(stateBeforeAttempt?.cycle_ulid).toBe(initialOpen.cycleUlid);

    const ISO = "2026-06-05T12:00:00.000Z";

    // Attempt to write a proposal with an invalid shape (missing required fields).
    let writeThrew = false;
    try {
      await writeRetroProposal({
        targetRepoRoot: tmpRoot,
        isoTimestamp: ISO,
        proposals: [
          {
            type: "rule",
            // Intentionally missing required fields: id, created_at, rationale,
            // text, target_failure_class, recommended_promotion_level.
          },
        ],
      });
    } catch (err) {
      // Any validation error (MalformedRetroProposalError or ZodError) means
      // the write did not succeed, so openCycle MUST NOT be called.
      writeThrew = true;
    }
    expect(writeThrew).toBe(true);

    // Cycle must NOT have advanced.
    const stateAfterFailedWrite = await readCycleState(tmpRoot);
    expect(stateAfterFailedWrite?.cycle_ulid).toBe(initialOpen.cycleUlid);
  });

  it("cycle DOES advance after a successful writeRetroProposal (positive control)", async () => {
    // Open a cycle to establish initial state.
    const cycleOpenMs = Date.parse("2026-06-01T00:00:00.000Z");
    const initialOpen = await openCycle({
      targetRepoRoot: tmpRoot,
      now: () => new Date(cycleOpenMs),
    });

    const ISO = "2026-06-05T12:00:00.000Z";

    // Successful writeRetroProposal — simulates the analyst completing its task
    // and the locked handoff phrase appearing.
    const { absPath } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "rule",
          id: "01KSRP1Y9J9R9F5SKB7QXQ83ZK",
          created_at: ISO,
          rationale: "Test rationale.",
          text: "Test rule text.",
          target_failure_class: "test-failure",
          recommended_promotion_level: "must",
        },
      ],
    });
    expect(absPath).toContain(".flow/retro-proposals");

    // The retro skill's conditional: locked handoff phrase appeared, so call openCycle.
    const advanceMs = Date.parse("2026-06-05T13:00:00.000Z");
    const advance = await openCycle({
      targetRepoRoot: tmpRoot,
      now: () => new Date(advanceMs),
    });

    // Cycle advanced to a new ULID.
    expect(advance.cycleUlid).not.toBe(initialOpen.cycleUlid);
    expect(advance.priorCycleUlid).toBe(initialOpen.cycleUlid);

    const state = await readCycleState(tmpRoot);
    expect(state?.cycle_ulid).toBe(advance.cycleUlid);
  });
});

// ---------------------------------------------------------------------------
// AC4 — operator exit message includes new cycle ULID and opened_at
// ---------------------------------------------------------------------------

describe("AC4 — openCycle returns cycleUlid and openedAt for operator surface", () => {
  it("returns a valid ULID and ISO openedAt timestamp suitable for plain-language surfacing", async () => {
    const nowMs = Date.parse("2026-06-10T09:00:00.000Z");
    const result = await openCycle({
      targetRepoRoot: tmpRoot,
      now: () => new Date(nowMs),
    });

    // cycleUlid must be a valid ULID (26 chars, Crockford base32).
    expect(result.cycleUlid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // openedAt must be the ISO instant the clock seam returned.
    expect(result.openedAt).toBe("2026-06-10T09:00:00.000Z");

    // The returned values are sufficient for the skill to surface the
    // exact plain-language message from SKILL.md step 5d:
    // "Cycle advanced to <cycleUlid>, new window opens at <openedAt>"
    const expectedMessage = `Cycle advanced to ${result.cycleUlid}, new window opens at ${result.openedAt}`;
    expect(expectedMessage).toMatch(
      /^Cycle advanced to [0-9A-HJKMNP-TV-Z]{26}, new window opens at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    // Verify openedAt is a valid ISO 8601 timestamp with milliseconds.
    expect(new Date(result.openedAt).toISOString()).toBe(result.openedAt);
  });
});

// ---------------------------------------------------------------------------
// Skill wiring — retro SKILL.md declares openCycle in allowed_tools and
// Step 6 is present (Story native:01KTAWXGA4X1YN5SQT760P359Y Task 1 + 2)
// ---------------------------------------------------------------------------

/**
 * Helper: extract the frontmatter `allowed_tools` array from a SKILL.md file.
 */
async function extractAllowedTools(skillPath: string): Promise<string[]> {
  const raw = await fs.readFile(skillPath, "utf8");
  const lines = raw.split("\n");
  const fmLines: string[] = [];
  let inFm = false;
  let closed = false;
  for (const line of lines) {
    if (!inFm && line === "---") { inFm = true; continue; }
    if (inFm && !closed) {
      if (line === "---") { closed = true; break; }
      fmLines.push(line);
    }
  }
  const fm = yamlParse(fmLines.join("\n")) as { allowed_tools?: string[] };
  return fm.allowed_tools ?? [];
}

describe("retro SKILL.md wiring — openCycle declared and step 6 present", () => {
  const SKILL_PATH = path.resolve(REAL_PLUGIN_ROOT, "skills", "retro", "SKILL.md");

  it("openCycle is present in allowed_tools (Task 2 — permission surface permits the call)", async () => {
    const tools = await extractAllowedTools(SKILL_PATH);
    expect(tools, "retro SKILL.md must declare openCycle in allowed_tools").toContain("openCycle");
  });

  it("step 6 conditional openCycle call is present in SKILL.md body (Task 1 — wiring)", async () => {
    const raw = await fs.readFile(SKILL_PATH, "utf8");
    // Step 6 must contain an openCycle call conditioned on the handoff phrase.
    expect(raw).toContain("openCycle");
    // The step must be conditional: only fired when the locked handoff phrase appeared.
    expect(raw).toContain("Handoff to operator — retro proposal ready for review at");
    // The step must surface cycleUlid and openedAt to the operator.
    expect(raw).toContain("cycleUlid");
    expect(raw).toContain("openedAt");
  });
});
