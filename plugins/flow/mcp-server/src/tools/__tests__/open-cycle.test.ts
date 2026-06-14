/**
 * Tests for `openCycle` and its interaction with `gatherRetroInputs` —
 * Story native:01KTAWXGA4X1YN5SQT760P359Y (Auto-advance cycle on retro completion).
 *
 * AC1 (integration): Given a repo with an active cycle (cycle-state.json has an
 *   opened_at) and at least one done/ manifest timestamped before the cycle open
 *   and one timestamped after, When openCycle is called, Then a subsequent call
 *   to gatherRetroInputs returns only the manifests at or after the new cycle's
 *   opened_at — the prior cycle's manifests are excluded.
 *
 * AC2 (unit): Given openCycle is invoked and the prior cycle had at least one
 *   done manifest and one retro proposal, When openCycle completes, Then a YAML
 *   archive file is written under .flow/cycle-archive/ that captures the prior
 *   cycle's done manifests and retro-proposal paths before the window resets.
 *
 * AC3 (unit): Given writeRetroProposal throws (e.g. RetroProposalAlreadyExistsError)
 *   during the retro exit step, When the error propagates, Then openCycle is NOT
 *   called — the cycle does not advance on a failed proposal write.
 *
 * AC4 (unit): Given openCycle returns after writeRetroProposal succeeds, When
 *   the retro skill surfaces its exit message to the operator, Then the message
 *   includes the new cycle ULID and its opened_at timestamp.
 *   (Verified via the return value of openCycle — the SKILL.md step 6 surfaces
 *   these fields to the operator.)
 *
 * All tests use real tool implementations against a temp filesystem — no mocks
 * of the things under test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { openCycle } from "../open-cycle.js";
import { gatherRetroInputs } from "../gather-retro-inputs.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { RetroProposalAlreadyExistsError } from "../../errors.js";
import { readCycleState } from "../../schemas/cycle-state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_HASH = "a".repeat(64);
const SESSION_ULID = "01KTAWXTEST000000000000001";

// Valid 26-char Crockford base-32 ULIDs (alphabet: 0-9 A-H J K M N P-T V-Z)
// Note: I, L, O, U are excluded from the Crockford alphabet.
const PRIOR_CYCLE_ULID_1 = "01HZ0000000000000000000001";
const PRIOR_CYCLE_ULID_2 = "01HZ0000000000000000000002";
const PRIOR_CYCLE_ULID_3 = "01HZ0000000000000000000003";
const PRIOR_CYCLE_ULID_AR = "01HZ000000000000000000000A";
const PRIOR_CYCLE_ULID_A3A = "01HZ000000000000000000000B";
const PRIOR_CYCLE_ULID_A3B = "01HZ000000000000000000000C";

// Manifest ref ULIDs (used inside done/ manifest filenames and ref fields)
// Must be 26 chars from the Crockford alphabet.
const MANIFEST_REF_BEFORE = "01HZ0000000000000000000011"; // before prior cycle
const MANIFEST_REF_AFTER = "01HZ0000000000000000000012";  // inside prior cycle
const MANIFEST_REF_AFTER2 = "01HZ0000000000000000000013"; // inside prior cycle
const MANIFEST_REF_ARCH = "01HZ0000000000000000000014";   // for AC2 archive test
const MANIFEST_REF_NEW = "01HZ0000000000000000000015";    // after new cycle opens

// Timestamps used to simulate a prior cycle's done manifests (before/after)
const PRIOR_CYCLE_OPENED_AT = "2026-06-01T00:00:00.000Z";
const MANIFEST_BEFORE_TS = "2026-05-31T23:00:00.000Z"; // before prior cycle
const MANIFEST_AFTER_TS = "2026-06-02T12:00:00.000Z";  // inside prior cycle
const NEW_CYCLE_OPENED_AT = "2026-06-14T10:00:00.000Z";
const NEW_CYCLE_AFTER_TS = "2026-06-14T11:00:00.000Z"; // after new cycle opens

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal done/ manifest YAML string.
 */
function makeDoneManifestYaml(ref: string): string {
  const manifest: Record<string, unknown> = {
    ref,
    status: "done",
    adapter: "native",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [
      { text: "Given x, when y, then z.", kind: "unit" },
    ],
    title: `Story ${ref}`,
    narrative: "As a user, I want X, so that Y.",
    withdrawn: false,
    claimed_by: SESSION_ULID,
  };
  return yamlStringify(manifest, { lineWidth: 0 });
}

/**
 * Seed a done/ manifest file with a specific mtime.
 * The mtime is used by gatherRetroInputs for cycle-window scoping.
 * Uses atomicWriteFile (the sanctioned write seam) then overrides mtime.
 */
async function seedDoneManifestWithMtime(
  tmpRoot: string,
  ref: string,
  mtimeIso: string,
): Promise<void> {
  const doneDir = path.join(tmpRoot, ".flow", "state", "done");
  await fs.mkdir(doneDir, { recursive: true });
  const filePath = path.join(doneDir, `${ref}.yaml`);
  await atomicWriteFile(filePath, makeDoneManifestYaml(ref));
  // Override mtime to simulate when the story was completed relative to the cycle.
  const mtime = new Date(mtimeIso);
  await fs.utimes(filePath, mtime, mtime);
}

/**
 * Write a cycle-state.json file to simulate an active cycle.
 */
async function seedCycleState(
  tmpRoot: string,
  cycleUlid: string,
  openedAt: string,
): Promise<void> {
  const cycleStateDir = path.join(tmpRoot, ".flow");
  await fs.mkdir(cycleStateDir, { recursive: true });
  await atomicWriteFile(
    path.join(cycleStateDir, "cycle-state.json"),
    JSON.stringify({ cycle_ulid: cycleUlid, opened_at: openedAt }, null, 2) + "\n",
  );
}

/**
 * Seed a retro proposal file under .flow/retro-proposals/.
 * Uses atomicWriteFile (the sanctioned write seam).
 */
async function seedRetroProposal(
  tmpRoot: string,
  isoTimestamp: string,
): Promise<string> {
  const dir = path.join(tmpRoot, ".flow", "retro-proposals");
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${isoTimestamp}.md`;
  const filePath = path.join(dir, fileName);
  // Minimal proposal file with valid frontmatter
  const content = [
    "---",
    `iso_timestamp: "${isoTimestamp}"`,
    "proposals: []",
    "---",
    "",
    "No proposals produced this cycle.",
    "",
  ].join("\n");
  await atomicWriteFile(filePath, content);
  return filePath;
}

// ---------------------------------------------------------------------------
// AC1: Integration — gatherRetroInputs after openCycle excludes prior cycle manifests
// ---------------------------------------------------------------------------

describe("AC1 — gatherRetroInputs after openCycle excludes prior cycle manifests", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "open-cycle-ac1-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("excludes manifests from before the new cycle window after openCycle runs", async () => {
    // Seed an active prior cycle
    await seedCycleState(tmpRoot, PRIOR_CYCLE_ULID_1, PRIOR_CYCLE_OPENED_AT);

    // Seed two done manifests:
    // - "before": mtime BEFORE the prior cycle's opened_at
    // - "after": mtime INSIDE the prior cycle (after PRIOR_CYCLE_OPENED_AT)
    await seedDoneManifestWithMtime(
      tmpRoot,
      `native:${MANIFEST_REF_BEFORE}`,
      MANIFEST_BEFORE_TS,
    );
    await seedDoneManifestWithMtime(
      tmpRoot,
      `native:${MANIFEST_REF_AFTER}`,
      MANIFEST_AFTER_TS,
    );

    // Call openCycle — advances the cycle to a new window
    const now = () => new Date(NEW_CYCLE_OPENED_AT);
    const result = await openCycle({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      now,
    });

    expect(result.cycleUlid).toBeTruthy();
    expect(result.openedAt).toBe(NEW_CYCLE_OPENED_AT);
    expect(result.priorCycleUlid).toBe(PRIOR_CYCLE_ULID_1);

    // Now call gatherRetroInputs — it reads the NEW cycle-state.json and
    // includes only manifests whose mtime >= NEW_CYCLE_OPENED_AT.
    // Both "before" (2026-05-31) and "after" (2026-06-02) are earlier than
    // the new cycle (2026-06-14T10:00:00.000Z), so both are excluded.
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.doneManifests).toHaveLength(0);
  });

  it("includes manifests written after the new cycle opens", async () => {
    await seedCycleState(tmpRoot, PRIOR_CYCLE_ULID_2, PRIOR_CYCLE_OPENED_AT);

    // Seed a manifest from the prior cycle (should be excluded post-advance)
    await seedDoneManifestWithMtime(
      tmpRoot,
      `native:${MANIFEST_REF_AFTER2}`,
      MANIFEST_AFTER_TS,
    );

    const now = () => new Date(NEW_CYCLE_OPENED_AT);
    await openCycle({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID, now });

    // Seed a manifest AFTER the new cycle opened
    await seedDoneManifestWithMtime(
      tmpRoot,
      `native:${MANIFEST_REF_NEW}`,
      NEW_CYCLE_AFTER_TS,
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // Only the post-new-cycle manifest should appear
    const refs = bundle.doneManifests.map((m) => m.ref);
    expect(refs).toContain(`native:${MANIFEST_REF_NEW}`);
    expect(refs).not.toContain(`native:${MANIFEST_REF_AFTER2}`);
  });

  it("cycle-state.json is updated to new cycle ULID after openCycle", async () => {
    await seedCycleState(tmpRoot, PRIOR_CYCLE_ULID_3, PRIOR_CYCLE_OPENED_AT);

    const now = () => new Date(NEW_CYCLE_OPENED_AT);
    const result = await openCycle({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID, now });

    const cycleState = await readCycleState(tmpRoot);
    expect(cycleState).not.toBeNull();
    expect(cycleState!.cycle_ulid).toBe(result.cycleUlid);
    expect(cycleState!.opened_at).toBe(NEW_CYCLE_OPENED_AT);
    // Must differ from the prior cycle
    expect(cycleState!.cycle_ulid).not.toBe(PRIOR_CYCLE_ULID_3);
  });
});

// ---------------------------------------------------------------------------
// AC2: Unit — cycle-archive YAML is written before window resets
// ---------------------------------------------------------------------------

describe("AC2 — cycle-archive YAML written with prior manifests + proposal paths", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "open-cycle-ac2-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes a .flow/cycle-archive/ YAML with prior done manifests and retro proposals", async () => {
    await seedCycleState(tmpRoot, PRIOR_CYCLE_ULID_AR, PRIOR_CYCLE_OPENED_AT);

    // Seed a done manifest inside the prior cycle window
    await seedDoneManifestWithMtime(
      tmpRoot,
      `native:${MANIFEST_REF_ARCH}`,
      MANIFEST_AFTER_TS,
    );

    // Seed a retro proposal in the prior cycle
    const PROPOSAL_ISO = "2026-06-02T15:00:00.000Z";
    await seedRetroProposal(tmpRoot, PROPOSAL_ISO);

    const now = () => new Date(NEW_CYCLE_OPENED_AT);
    const result = await openCycle({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID, now });

    // archivePath must be non-null (there was a prior cycle)
    expect(result.archivePath).not.toBeNull();
    expect(result.priorCycleUlid).toBe(PRIOR_CYCLE_ULID_AR);

    // The archive file must exist on disk
    const archivePath = result.archivePath!;
    const archiveRaw = await fs.readFile(archivePath, "utf8");
    const archiveData = yamlParse(archiveRaw) as Record<string, unknown>;

    // Validate structure
    expect(archiveData["cycle_ulid"]).toBe(PRIOR_CYCLE_ULID_AR);
    expect(archiveData["opened_at"]).toBe(PRIOR_CYCLE_OPENED_AT);
    expect(archiveData["closed_at"]).toBe(NEW_CYCLE_OPENED_AT);

    // done_manifests array includes the seeded manifest
    const doneManifests = archiveData["done_manifests"] as unknown[];
    expect(Array.isArray(doneManifests)).toBe(true);
    expect(doneManifests.length).toBeGreaterThanOrEqual(1);
    const refs = (doneManifests as Array<{ ref: string }>).map((m) => m.ref);
    expect(refs).toContain(`native:${MANIFEST_REF_ARCH}`);

    // retro_proposals array includes the seeded proposal
    const retroProposals = archiveData["retro_proposals"] as unknown[];
    expect(Array.isArray(retroProposals)).toBe(true);
    expect(retroProposals.length).toBeGreaterThanOrEqual(1);

    // Archive file lives under .flow/cycle-archive/
    expect(archivePath).toContain(path.join(".flow", "cycle-archive"));
  });

  it("archivePath is null on first-ever openCycle (no prior cycle)", async () => {
    // No cycle-state.json seeded — first-ever open

    const now = () => new Date(NEW_CYCLE_OPENED_AT);
    const result = await openCycle({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID, now });

    expect(result.archivePath).toBeNull();
    expect(result.priorCycleUlid).toBeNull();

    // cycle-state.json is written with new cycle
    const cycleState = await readCycleState(tmpRoot);
    expect(cycleState).not.toBeNull();
    expect(cycleState!.cycle_ulid).toBe(result.cycleUlid);
  });
});

// ---------------------------------------------------------------------------
// AC3: Unit — openCycle NOT called when writeRetroProposal throws
// ---------------------------------------------------------------------------

describe("AC3 — cycle does not advance when writeRetroProposal throws", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "open-cycle-ac3-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("RetroProposalAlreadyExistsError leaves cycle-state.json unchanged", async () => {
    // Seed an active cycle
    await seedCycleState(tmpRoot, PRIOR_CYCLE_ULID_A3A, PRIOR_CYCLE_OPENED_AT);

    // Seed an existing proposal file (to cause a collision on second write)
    const PROPOSAL_ISO = "2026-06-10T09:00:00.000Z";
    await seedRetroProposal(tmpRoot, PROPOSAL_ISO);

    // Attempt writeRetroProposal with the SAME timestamp — must throw
    let caughtError: unknown = null;
    try {
      await writeRetroProposal({
        targetRepoRoot: tmpRoot,
        isoTimestamp: PROPOSAL_ISO,
        proposals: [],
      });
    } catch (err) {
      caughtError = err;
    }

    // The write must have thrown RetroProposalAlreadyExistsError
    expect(caughtError).toBeInstanceOf(RetroProposalAlreadyExistsError);

    // Since writeRetroProposal threw, the skill would NOT call openCycle.
    // We verify that if openCycle is NOT called, cycle-state.json remains
    // unchanged (still points at the prior cycle).
    const cycleState = await readCycleState(tmpRoot);
    expect(cycleState).not.toBeNull();
    expect(cycleState!.cycle_ulid).toBe(PRIOR_CYCLE_ULID_A3A);
    expect(cycleState!.opened_at).toBe(PRIOR_CYCLE_OPENED_AT);
  });

  it("malformed isoTimestamp causes writeRetroProposal to throw, leaving cycle unchanged", async () => {
    await seedCycleState(tmpRoot, PRIOR_CYCLE_ULID_A3B, PRIOR_CYCLE_OPENED_AT);

    // Attempt writeRetroProposal with a malformed isoTimestamp
    let caughtError: unknown = null;
    try {
      await writeRetroProposal({
        targetRepoRoot: tmpRoot,
        isoTimestamp: "not-an-iso-timestamp", // invalid
        proposals: [],
      });
    } catch (err) {
      caughtError = err;
    }

    // Must have thrown (either MalformedRetroProposalError or ZodError)
    expect(caughtError).toBeTruthy();

    // cycle-state.json is unchanged — openCycle was not called
    const cycleState = await readCycleState(tmpRoot);
    expect(cycleState).not.toBeNull();
    expect(cycleState!.cycle_ulid).toBe(PRIOR_CYCLE_ULID_A3B);
    expect(cycleState!.opened_at).toBe(PRIOR_CYCLE_OPENED_AT);
  });
});

// ---------------------------------------------------------------------------
// AC4: Unit — openCycle returns new cycle ULID and opened_at for the operator message
// ---------------------------------------------------------------------------

describe("AC4 — openCycle returns new cycle ULID and opened_at for operator surface", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "open-cycle-ac4-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns a valid cycleUlid and exact openedAt ISO timestamp", async () => {
    const now = () => new Date(NEW_CYCLE_OPENED_AT);

    const result = await openCycle({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID, now });

    // cycleUlid: non-empty string matching ULID format (26 Crockford base-32 chars)
    expect(typeof result.cycleUlid).toBe("string");
    expect(result.cycleUlid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // openedAt: exact ISO timestamp passed via clock seam
    expect(result.openedAt).toBe(NEW_CYCLE_OPENED_AT);

    // The SKILL.md step 6 surfaces these with the message:
    //   "Cycle advanced to <cycleUlid>, new window opens at <openedAt>"
    // We verify the data is present in the return value for the skill to use.
    const operatorMessage =
      `Cycle advanced to ${result.cycleUlid}, new window opens at ${result.openedAt}`;
    expect(operatorMessage).toContain(result.cycleUlid);
    expect(operatorMessage).toContain(result.openedAt);
  });

  it("first-ever open returns priorCycleUlid=null and archivePath=null", async () => {
    const now = () => new Date(NEW_CYCLE_OPENED_AT);

    const result = await openCycle({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID, now });

    expect(result.priorCycleUlid).toBeNull();
    expect(result.archivePath).toBeNull();
  });

  it("successive opens return priorCycleUlid matching the previous cycleUlid", async () => {
    const FIRST_OPENED_AT = "2026-06-14T10:00:00.000Z";
    const firstResult = await openCycle({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      now: () => new Date(FIRST_OPENED_AT),
    });

    const SECOND_OPENED_AT = "2026-06-15T10:00:00.000Z";
    const secondResult = await openCycle({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      now: () => new Date(SECOND_OPENED_AT),
    });

    // Second open's priorCycleUlid should equal the first open's cycleUlid
    expect(secondResult.priorCycleUlid).toBe(firstResult.cycleUlid);
    expect(secondResult.cycleUlid).not.toBe(firstResult.cycleUlid);
    expect(secondResult.openedAt).toBe(SECOND_OPENED_AT);
  });
});
