/**
 * Unit + integration tests for `recordStoryRetro` — Story 6.1 AC3.
 *
 * Covers:
 *   (a) Happy path — a valid retro payload lands on a done/ manifest and
 *       the file re-parses cleanly through `parseExecutionManifest`.
 *   (b) One assertion per `kind` value (four tests) showing the closed
 *       enum accepts all four members.
 *   (c) `kind: "pitfall"` without `failure_class` is rejected at the
 *       Zod boundary.
 *   (d) The tool refuses (with `StoryNotInDoneStateError`) when invoked
 *       against a ref in `to-do/`, `blocked/`, or `in-progress/`.
 *       `ManifestNotFoundError` when the ref is absent everywhere.
 *   (e) Idempotency — re-running with an identical payload produces a
 *       byte-identical file.
 *
 * Approach:
 * - Use a minimal native-adapter workspace in a tmpdir (real filesystem
 *   ops via `atomicWriteFile`).
 * - Seed `done/<ref>.yaml` manifests directly (no need to drive
 *   completeStory — the state guard is what we're testing).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import {
  ManifestNotFoundError,
  MalformedStoryRetroPayloadError,
  StoryNotInDoneStateError,
} from "../../errors.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";
import { LESSON_KINDS } from "../../schemas/story-retro.js";
import { recordStoryRetro } from "../record-story-retro.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF = "native:01HZRETRO0000000000000001";
const SESSION = "01HZSESSRETRO00000000000001";
const SOURCE_HASH = "c".repeat(64);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifestYaml(opts: {
  ref: string;
  status: "to-do" | "blocked" | "in-progress" | "done";
  withClaimedBy?: boolean;
}): string {
  const manifest: Record<string, unknown> = {
    ref: opts.ref,
    status: opts.status,
    adapter: "native",
    source_path: `.flow/native-stories/${opts.ref.replace("native:", "")}.md`,
    source_hash: SOURCE_HASH,
    depends_on: [] as string[],
    acceptance_criteria: [
      {
        text: "Given the retro tool, when called with a valid payload, then it writes.",
        kind: "integration",
      },
    ],
    title: "Retro test story",
    narrative: "As a dev, I want to test recordStoryRetro.",
    withdrawn: false,
  };
  const shouldStampClaimedBy =
    opts.withClaimedBy ??
    (opts.status === "in-progress" || opts.status === "done");
  if (shouldStampClaimedBy) {
    manifest["claimed_by"] = SESSION;
  }
  return yamlStringify(manifest, { lineWidth: 0 });
}

async function seedManifest(
  stateRoot: string,
  state: "to-do" | "blocked" | "in-progress" | "done",
  ref: string,
): Promise<string> {
  const dir = path.join(stateRoot, state);
  await fs.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, `${ref}.yaml`);
  await atomicWriteFile(
    absPath,
    makeManifestYaml({ ref, status: state }),
  );
  return absPath;
}

async function buildWorkspaceRoot(scratch: string): Promise<string> {
  const root = path.join(scratch, "repo");
  await fs.mkdir(root, { recursive: true });
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );
  return root;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let scratch: string;
let root: string;
let stateRoot: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-record-story-retro-"));
  root = await buildWorkspaceRoot(scratch);
  stateRoot = path.join(root, ".flow", "state");
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) Happy path
// ---------------------------------------------------------------------------

describe("recordStoryRetro (a) — happy path: valid payload lands on done/ manifest", () => {
  it("writes lessons[], failure_class, duration_seconds and re-parses cleanly", async () => {
    const absPath = await seedManifest(stateRoot, "done", REF);

    const payload = {
      lessons: [
        {
          kind: "pattern" as const,
          text: "Closed enums catch unknown kinds at the Zod boundary.",
        },
      ],
      failure_class: "ac-marker-gap",
      duration_seconds: 1800,
    };

    const result = await recordStoryRetro({
      targetRepoRoot: root,
      ref: REF,
      payload,
    });

    expect(result.ref).toBe(REF);
    expect(result.absPath).toBe(absPath);

    // Read from disk, assert all three retro fields are present.
    const raw = await fs.readFile(absPath, "utf8");
    const parsedYaml = yamlParse(raw) as Record<string, unknown>;
    expect(parsedYaml["lessons"]).toEqual(payload.lessons);
    expect(parsedYaml["failure_class"]).toBe("ac-marker-gap");
    expect(parsedYaml["duration_seconds"]).toBe(1800);

    // Re-parse through parseExecutionManifest cleanly — the deterministic seam.
    const manifest = parseExecutionManifest(parsedYaml, { absPath });
    expect(manifest.lessons).toEqual(payload.lessons);
    expect(manifest.failure_class).toBe("ac-marker-gap");
    expect(manifest.duration_seconds).toBe(1800);
    expect(manifest.status).toBe("done");
  });

  it("preserves the existing claimed_by and other fields on the manifest", async () => {
    const absPath = await seedManifest(stateRoot, "done", REF);

    await recordStoryRetro({
      targetRepoRoot: root,
      ref: REF,
      payload: { lessons: [], duration_seconds: 0 },
    });

    const raw = await fs.readFile(absPath, "utf8");
    const parsedYaml = yamlParse(raw) as Record<string, unknown>;
    expect(parsedYaml["claimed_by"]).toBe(SESSION);
    expect(parsedYaml["status"]).toBe("done");
    expect(parsedYaml["title"]).toBe("Retro test story");
  });
});

// ---------------------------------------------------------------------------
// (b) One assertion per kind value
// ---------------------------------------------------------------------------

describe("recordStoryRetro (b) — closed kind enum accepts all four members", () => {
  for (const kind of LESSON_KINDS) {
    it(`accepts a lesson with kind: '${kind}'`, async () => {
      const absPath = await seedManifest(stateRoot, "done", REF);

      const lesson: Record<string, unknown> = {
        kind,
        text: `A lesson of kind ${kind}.`,
      };
      // failure_class is required when kind === 'pitfall'.
      if (kind === "pitfall") {
        lesson["failure_class"] = "test-failure-class";
      }

      await recordStoryRetro({
        targetRepoRoot: root,
        ref: REF,
        payload: { lessons: [lesson] },
      });

      const raw = await fs.readFile(absPath, "utf8");
      const parsedYaml = yamlParse(raw) as Record<string, unknown>;
      const lessons = parsedYaml["lessons"] as Record<string, unknown>[];
      expect(lessons).toHaveLength(1);
      expect(lessons[0]!["kind"]).toBe(kind);
    });
  }
});

// ---------------------------------------------------------------------------
// (c) Pitfall without failure_class is rejected
// ---------------------------------------------------------------------------

describe("recordStoryRetro (c) — kind: 'pitfall' without failure_class is rejected at the Zod boundary", () => {
  it("throws MalformedStoryRetroPayloadError when a pitfall lesson omits failure_class", async () => {
    await seedManifest(stateRoot, "done", REF);

    const err = await recordStoryRetro({
      targetRepoRoot: root,
      ref: REF,
      payload: {
        lessons: [
          {
            kind: "pitfall",
            text: "A pitfall without failure_class.",
          },
        ],
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedStoryRetroPayloadError);
  });

  it("throws MalformedStoryRetroPayloadError for an out-of-enum kind value", async () => {
    await seedManifest(stateRoot, "done", REF);

    const err = await recordStoryRetro({
      targetRepoRoot: root,
      ref: REF,
      payload: {
        lessons: [
          {
            kind: "some-future-kind",
            text: "A lesson with an unknown kind.",
          },
        ],
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedStoryRetroPayloadError);
  });

  it("throws MalformedStoryRetroPayloadError for an unknown top-level key (strict)", async () => {
    await seedManifest(stateRoot, "done", REF);

    const err = await recordStoryRetro({
      targetRepoRoot: root,
      ref: REF,
      payload: {
        lessons: [],
        unknown_field: "rejected",
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedStoryRetroPayloadError);
  });
});

// ---------------------------------------------------------------------------
// (d) State-guard refusal
// ---------------------------------------------------------------------------

describe("recordStoryRetro (d) — state-guard refusal", () => {
  for (const state of ["to-do", "blocked", "in-progress"] as const) {
    it(`throws StoryNotInDoneStateError when the manifest lives in ${state}/`, async () => {
      await seedManifest(stateRoot, state, REF);

      const err = await recordStoryRetro({
        targetRepoRoot: root,
        ref: REF,
        payload: { lessons: [] },
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StoryNotInDoneStateError);
      const typed = err as StoryNotInDoneStateError;
      expect(typed.ref).toBe(REF);
      expect(typed.foundIn).toBe(state);
    });
  }

  it("throws ManifestNotFoundError when the ref does not exist in any state", async () => {
    // No seed — the ref is absent everywhere.
    const err = await recordStoryRetro({
      targetRepoRoot: root,
      ref: REF,
      payload: { lessons: [] },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ManifestNotFoundError);
    const typed = err as ManifestNotFoundError;
    expect(typed.ref).toBe(REF);
    expect(typed.fromState).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// (e) Idempotency
// ---------------------------------------------------------------------------

describe("recordStoryRetro (e) — idempotency: identical payload → byte-identical file", () => {
  it("re-running with the same payload produces a byte-identical file", async () => {
    const absPath = await seedManifest(stateRoot, "done", REF);

    const payload = {
      lessons: [
        {
          kind: "discipline" as const,
          text: "Always run parseExecutionManifest before writing.",
        },
      ],
      failure_class: "idempotency-check",
      duration_seconds: 600,
    };

    await recordStoryRetro({
      targetRepoRoot: root,
      ref: REF,
      payload,
    });
    const firstBytes = await fs.readFile(absPath);

    await recordStoryRetro({
      targetRepoRoot: root,
      ref: REF,
      payload,
    });
    const secondBytes = await fs.readFile(absPath);

    expect(secondBytes.equals(firstBytes)).toBe(true);
  });
});
