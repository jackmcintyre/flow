/**
 * Integration tests for `markWithdrawn` — Story 3.6 Task 3.4.
 *
 * Covers AC3's contract end-to-end:
 *   (a) Flip a BMad-fixture manifest in done/ from withdrawn:false → true.
 *   (b) Re-call against the same ref; assert alreadyWithdrawn:true and
 *       mtime is stable (idempotency).
 *   (c) Non-existent ref → ManifestNotFoundError.
 *   (d) Native adapter workspace → WrongAdapterError.
 *   (e) Manifest in in-progress/ → success (in-progress guard is the planner's,
 *       not the tool's).
 *
 * Each test operates against a copy of the committed fixture tree in a tmpdir
 * so the committed fixtures are never mutated.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";
import { ManifestNotFoundError, WrongAdapterError } from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { markWithdrawn } from "../mark-withdrawn.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// BMad fixture: has adapter:bmad, state/done/bmad:1.1.yaml with withdrawn:false
const BMAD_FIXTURE = path.resolve(
  HERE,
  "..",
  "..",
  "adapters",
  "bmad",
  "fixtures",
  "sample-target-repo",
);

// Native fixture: has adapter:native, state dirs with native manifests
const NATIVE_FIXTURE = path.resolve(
  HERE,
  "..",
  "..",
  "adapters",
  "native",
  "fixtures",
  "sample-target-repo",
);

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-mark-withdrawn-"));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

async function copyFixture(fixturePath: string): Promise<string> {
  const dest = path.join(scratch, path.basename(fixturePath));
  await fs.cp(fixturePath, dest, { recursive: true });
  return dest;
}

// ---------------------------------------------------------------------------
// (a) Flip a BMad manifest in done/ from withdrawn:false → true
// ---------------------------------------------------------------------------

describe("markWithdrawn (a) — flip a BMad done/ manifest withdrawn", () => {
  it("flips withdrawn:false → true and returns the expected result", async () => {
    const root = await copyFixture(BMAD_FIXTURE);
    const ref = "bmad:1.1";
    const manifestPath = path.join(root, ".flow", "state", "done", `${ref}.yaml`);

    // Pre-condition: manifest exists and withdrawn is false.
    const beforeRaw = await fs.readFile(manifestPath, "utf8");
    const beforeParsed = yamlParse(beforeRaw) as Record<string, unknown>;
    expect(beforeParsed["withdrawn"]).toBe(false);

    const result = await markWithdrawn({ targetRepoRoot: root, ref });

    expect(result.ref).toBe(ref);
    expect(result.alreadyWithdrawn).toBe(false);
    expect(result.state).toBe("done");
    expect(result.absPath).toBe(manifestPath);

    // Post-condition: manifest bytes changed, withdrawn is now true.
    const afterRaw = await fs.readFile(manifestPath, "utf8");
    const afterParsed = yamlParse(afterRaw) as Record<string, unknown>;
    expect(afterParsed["withdrawn"]).toBe(true);

    // State directory did NOT change — manifest still in done/.
    await expect(fs.stat(manifestPath)).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (b) Idempotency: second call returns alreadyWithdrawn:true, mtime stable
// ---------------------------------------------------------------------------

describe("markWithdrawn (b) — idempotency on already-withdrawn manifest", () => {
  it("second call returns alreadyWithdrawn:true without rewriting the file", async () => {
    const root = await copyFixture(BMAD_FIXTURE);
    const ref = "bmad:1.1";
    const manifestPath = path.join(root, ".flow", "state", "done", `${ref}.yaml`);

    // First call — flips the manifest.
    await markWithdrawn({ targetRepoRoot: root, ref });

    // Record mtime after first call.
    const statsAfterFirst = await fs.stat(manifestPath);
    const mtimeAfterFirst = statsAfterFirst.mtimeMs;

    // Backdate by 1 second so any second-call write is detectable even on
    // coarse (1 s) mtime filesystems.
    const oneSec = mtimeAfterFirst / 1000 - 1;
    await fs.utimes(manifestPath, oneSec, oneSec);
    const statsBackdated = await fs.stat(manifestPath);
    const mtimeBackdated = statsBackdated.mtimeMs;
    expect(mtimeBackdated).toBeLessThan(mtimeAfterFirst);

    // Second call — MUST NOT rewrite the file.
    const result = await markWithdrawn({ targetRepoRoot: root, ref });
    expect(result.alreadyWithdrawn).toBe(true);
    expect(result.ref).toBe(ref);
    expect(result.state).toBe("done");
    // absPath should be absent on the no-op path.
    expect(result.absPath).toBeUndefined();

    // mtime must be unchanged from the backdated value.
    const statsAfterSecond = await fs.stat(manifestPath);
    expect(statsAfterSecond.mtimeMs).toBe(mtimeBackdated);
  });
});

// ---------------------------------------------------------------------------
// (c) Non-existent ref → ManifestNotFoundError
// ---------------------------------------------------------------------------

describe("markWithdrawn (c) — non-existent ref throws ManifestNotFoundError", () => {
  it("throws ManifestNotFoundError for a ref that does not exist in any state dir", async () => {
    const root = await copyFixture(BMAD_FIXTURE);
    const ref = "bmad:does-not-exist";

    await expect(
      markWithdrawn({ targetRepoRoot: root, ref }),
    ).rejects.toBeInstanceOf(ManifestNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// (d) Native adapter workspace → WrongAdapterError
// ---------------------------------------------------------------------------

describe("markWithdrawn (d) — native adapter workspace throws WrongAdapterError", () => {
  it("throws WrongAdapterError when the active adapter is native", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);
    // Use a ref that exists in the native fixture (to-do state).
    const ref = "native:01HZABC0000000000000000001";

    await expect(
      markWithdrawn({ targetRepoRoot: root, ref }),
    ).rejects.toBeInstanceOf(WrongAdapterError);
  });
});

// ---------------------------------------------------------------------------
// (e) Manifest in in-progress/ → success (no state-level guard in the tool)
// ---------------------------------------------------------------------------

describe("markWithdrawn (e) — manifest in in-progress/ succeeds", () => {
  it("flips withdrawn:true on a manifest in in-progress/ state directory", async () => {
    const root = await copyFixture(BMAD_FIXTURE);

    // Seed a manifest in in-progress/ for the BMad fixture.
    const inProgressDir = path.join(root, ".flow", "state", "in-progress");
    await fs.mkdir(inProgressDir, { recursive: true });
    const ref = "bmad:1.2";
    const manifestContent = [
      `ref: "${ref}"`,
      `status: to-do`,
      `adapter: bmad`,
      `source_path: _bmad-output/planning-artifacts/stories/1-2-in-progress-story.md`,
      `source_hash: f1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6f1b2`,
      `depends_on: []`,
      `acceptance_criteria:`,
      `  - text: Given the feature is deployed, when a user accesses it, then it works.`,
      `    kind: integration`,
      `title: In-progress story`,
      `narrative: As a user, I want the in-progress feature so that I can use it.`,
      `withdrawn: false`,
      ``,
    ].join("\n");
    const manifestPath = path.join(inProgressDir, `${ref}.yaml`);
    // Use atomicWriteFile (the canonical write primitive) to comply with the
    // static fs-guard — src/**/*.ts files must not use direct write-shaped
    // node:fs APIs; only managed-fs.ts is whitelisted.
    await atomicWriteFile(manifestPath, manifestContent);

    const result = await markWithdrawn({ targetRepoRoot: root, ref });

    expect(result.ref).toBe(ref);
    expect(result.alreadyWithdrawn).toBe(false);
    expect(result.state).toBe("in-progress");
    expect(result.absPath).toBe(manifestPath);

    // Verify the manifest is still in in-progress/ (no directory move).
    await expect(fs.stat(manifestPath)).resolves.toBeTruthy();
    const afterRaw = await fs.readFile(manifestPath, "utf8");
    const afterParsed = yamlParse(afterRaw) as Record<string, unknown>;
    expect(afterParsed["withdrawn"]).toBe(true);
  });
});
