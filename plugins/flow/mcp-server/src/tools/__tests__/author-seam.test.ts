/**
 * Integration tests for the author seam — Story 9.2 (Epic 9 intake cockpit,
 * gate 1: "propose a feature") and Story native:01KT49G9B38NZ2QP16GY843KYK
 * (auto-materialise on write).
 *
 * The seam reuses the existing native-authoring machinery end-to-end:
 *   - `writeNativeStory` (now fail-closed on discipline) authors the draft,
 *   - auto-materialises the manifest into to-do/ immediately after writing
 *     (Story native:01KT49G9B38NZ2QP16GY843KYK AC1),
 *   - the claim entry point (`claimNextStory`) refuses to return it until the
 *     operator blesses it (Story 9.1 readiness brake, AC2).
 *
 * Covered ACs (Story native:01KT49G9B38NZ2QP16GY843KYK):
 *   AC1 — (integration) after writeNativeStory returns, the to-do/ manifest
 *         exists WITHOUT a manual scanSources call.
 *   AC2 — (unit) the auto-materialised manifest carries ready: false —
 *         the readiness brake is intact.
 *   AC4 — (unit) BMad-adapter repos do NOT auto-materialise on write
 *         (writeNativeStory rejects with WrongAdapterError for non-native repos,
 *         so no scan is triggered — BMad behaviour is unchanged).
 *
 * Covered ACs (Story 9.2, preserved):
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
import { DisciplineViolationError, WrongAdapterError } from "../../errors.js";
import { writeNativeStory } from "../write-native-story.js";
import { scanSources } from "../scan-sources.js";
import { claimNextStory, QUEUE_DRAINED_LINE } from "../claim-next-story.js";
import { markStoryReady } from "../mark-story-ready.js";

const SESSION_ULID = "01HZSESSION00000000000099";

let root: string;
let storiesDir: string;

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
        kind: "integration" as const,
        verification: { type: "vitest" as const, target: "src/__tests__/ledger.integration.test.ts" },
      },
    ],
    tasks: [{ text: "Write the ledger persistence path", ac_refs: ["AC1"] }],
    cited_sources: ["src/state/ledger.ts"],
    depends_on: [] as string[],
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
        kind: "unit" as const,
        verification: { type: "vitest" as const, target: "src/__tests__/ledger.test.ts" },
      },
    ],
    tasks: [{ text: "Write the ledger persistence path", ac_refs: ["AC1"] }],
    cited_sources: ["src/state/ledger.ts"],
    depends_on: [] as string[],
    sessionUlid: SESSION_ULID,
  };
}

interface DraftEvent {
  type: string;
  story_id?: string;
  data?: { ref?: string; title?: string };
}

async function readDraftAuthoredEvents(): Promise<DraftEvent[]> {
  const telemetryDir = path.join(root, ".flow", "telemetry");
  let files: string[];
  try {
    files = await fs.readdir(telemetryDir);
  } catch {
    return [];
  }
  const events: DraftEvent[] = [];
  for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
    const content = await fs.readFile(path.join(telemetryDir, file), "utf8");
    for (const line of content.trim().split("\n").filter(Boolean)) {
      const parsed = JSON.parse(line) as DraftEvent;
      if (parsed.type === "draft.authored") events.push(parsed);
    }
  }
  return events;
}

beforeEach(async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-author-seam-"));
  root = path.join(scratch, "workspace");
  storiesDir = path.join(root, ".flow", "native-stories");
  await fs.mkdir(storiesDir, { recursive: true });
  // The claim path stats these directories — create them so it does not error.
  await fs.mkdir(path.join(root, ".flow", "state", "in-progress"), { recursive: true });
  await fs.mkdir(path.join(root, ".flow", "state", "done"), { recursive: true });
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    `adapter: native\nadapter_config: {}\n`,
  );
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
  it("authors through the seam and the draft is a not-ready manifest the claim path will not return", async () => {
    const { ref } = await writeNativeStory(passingCandidate());

    // writeNativeStory auto-materialises the manifest (Story native:01KT49G9B38NZ2QP16GY843KYK):
    // a subsequent scan sees the ref as unchanged (idempotency invariant, AC3).
    const scan = await scanSources({ targetRepoRoot: root });
    // The ref is already materialised — it shows up as unchanged, not created.
    expect(scan.unchangedRefs).toContain(ref);

    // The manifest exists in the backlog state and reads not-ready.
    const manifestPath = path.join(root, ".flow", "state", "to-do", `${ref}.yaml`);
    const parsed = yamlParse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
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
    let caught: unknown;
    try {
      await writeNativeStory(failingCandidate());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const codes = (caught as DisciplineViolationError).violations.map((v) => v.code);
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
    expect(events[0]!.data?.ref).toBe(ref);
    expect(events[0]!.data?.title).toBe("Persist the backlog ledger");
    expect(events[0]!.story_id).toBe(ref);
  });

  it("emits no draft.authored event for a refused (violating) candidate", async () => {
    await expect(writeNativeStory(failingCandidate())).rejects.toBeInstanceOf(
      DisciplineViolationError,
    );

    expect(await readDraftAuthoredEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC1 — inline approval prompt at the end of /flow:author
//
// These tests verify the tool-layer seam that the /flow:author skill invokes
// after surfacing a judge panel grade:
//   - An explicit yes answer → markStoryReady(ready: true) → story is claimable
//   - A no answer or silence → markStoryReady is not called → story stays parked
//   - An explicit no answer → markStoryReady(ready: false) confirms not-ready
// ---------------------------------------------------------------------------

describe("author seam AC1 — inline approval prompt flips readiness via markStoryReady", () => {
  it("yes answer: calling markStoryReady(ready:true) after authoring makes the story claimable", async () => {
    const { ref } = await writeNativeStory(passingCandidate());
    await scanSources({ targetRepoRoot: root });

    // Verify the story starts not-ready.
    const manifestPath = path.join(root, ".flow", "state", "to-do", `${ref}.yaml`);
    const before = yamlParse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    expect(before["ready"]).toBe(false);

    // Simulate the operator answering yes: the skill calls markStoryReady(ready: true).
    const result = await markStoryReady({
      targetRepoRoot: root,
      ref,
      ready: true,
      sessionUlid: SESSION_ULID,
    });

    expect(result.ref).toBe(ref);
    expect(result.ready).toBe(true);
    expect(result.noop).toBe(false);

    // Story is now claimable — claimNextStory returns it (not queue-drained).
    const claim = await claimNextStory({ targetRepoRoot: root, sessionUlid: SESSION_ULID });
    expect(claim.next).toBe("spawn-dev");
    if (claim.next === "spawn-dev") {
      expect(claim.ref).toBe(ref);
    }
  });

  it("no answer: not calling markStoryReady leaves the story parked not-ready, not claimable", async () => {
    const { ref } = await writeNativeStory(passingCandidate());
    await scanSources({ targetRepoRoot: root });

    // Simulate the operator answering no: the skill does NOT call markStoryReady.
    // The story remains at its default not-ready state.

    const manifestPath = path.join(root, ".flow", "state", "to-do", `${ref}.yaml`);
    const after = yamlParse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    expect(after["ready"]).toBe(false);

    // The build loop cannot claim it.
    const claim = await claimNextStory({ targetRepoRoot: root, sessionUlid: SESSION_ULID });
    expect(claim.next).toBe("queue-drained");
    expect(claim.chatLog).toContain(QUEUE_DRAINED_LINE);
  });

  it("silence / non-yes: markStoryReady(ready:false) is a no-op that keeps the story not-ready", async () => {
    const { ref } = await writeNativeStory(passingCandidate());
    await scanSources({ targetRepoRoot: root });

    // Simulate marking not-ready explicitly (e.g., the skill sees a non-yes response).
    const result = await markStoryReady({
      targetRepoRoot: root,
      ref,
      ready: false,
      sessionUlid: SESSION_ULID,
    });

    // Already false → noop (no write, no event).
    expect(result.noop).toBe(true);
    expect(result.ready).toBe(false);

    // Story is still not claimable.
    const claim = await claimNextStory({ targetRepoRoot: root, sessionUlid: SESSION_ULID });
    expect(claim.next).toBe("queue-drained");
  });
});

// ---------------------------------------------------------------------------
// Story native:01KT49G9B38NZ2QP16GY843KYK
// AC1 — auto-materialise: to-do/ manifest exists WITHOUT a manual /flow:scan
// ---------------------------------------------------------------------------

describe("auto-materialise AC1 — to-do manifest created immediately on writeNativeStory (no manual scan needed)", () => {
  it("after writeNativeStory returns, the to-do manifest exists without a manual scanSources call", async () => {
    const { ref } = await writeNativeStory(passingCandidate());

    // No explicit scanSources call — the manifest must already exist.
    const manifestPath = path.join(root, ".flow", "state", "to-do", `${ref}.yaml`);
    const stat = await fs.stat(manifestPath).catch(() => null);
    expect(stat).not.toBeNull();

    const parsed = yamlParse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    expect(parsed["ref"]).toBe(ref);
    expect(parsed["status"]).toBe("to-do");
  });

  it("the auto-materialised manifest is not claimable — the readiness brake (Story 9.1) is intact", async () => {
    const { ref } = await writeNativeStory(passingCandidate());

    // Without blessing, the claim entry point must refuse this story.
    const claim = await claimNextStory({ targetRepoRoot: root, sessionUlid: SESSION_ULID });
    expect(claim.next).toBe("queue-drained");
    expect(claim.chatLog).toContain(QUEUE_DRAINED_LINE);

    // Verify the ref is in to-do/ (not absent — was materialised).
    const manifestPath = path.join(root, ".flow", "state", "to-do", `${ref}.yaml`);
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Story native:01KT49G9B38NZ2QP16GY843KYK
// AC2 — auto-materialised manifest carries ready: false
// ---------------------------------------------------------------------------

describe("auto-materialise AC2 — auto-materialised manifest carries ready: false (readiness brake intact)", () => {
  it("the to-do manifest written by writeNativeStory has ready: false without an explicit scanSources call", async () => {
    const { ref } = await writeNativeStory(passingCandidate());

    const manifestPath = path.join(root, ".flow", "state", "to-do", `${ref}.yaml`);
    const parsed = yamlParse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;

    // The readiness brake must be intact on the auto-materialised manifest.
    expect(parsed["ready"]).toBe(false);
    expect(parsed["status"]).toBe("to-do");
  });
});

// ---------------------------------------------------------------------------
// Story native:01KT49G9B38NZ2QP16GY843KYK
// AC4 — BMad adapter guard: writeNativeStory rejects on non-native repos,
//        so no auto-materialisation occurs for BMad workspaces.
// ---------------------------------------------------------------------------

describe("auto-materialise AC4 — BMad adapter repos do NOT auto-materialise on write", () => {
  it("writeNativeStory throws WrongAdapterError on a BMad-adapter repo and writes no manifest", async () => {
    // Switch the workspace to a BMad adapter by rewriting config.yaml.
    await atomicWriteFile(
      path.join(root, ".flow", "config.yaml"),
      `adapter: bmad\nadapter_config:\n  stories_root: _bmad-output/planning-artifacts/stories\n`,
    );

    // writeNativeStory must reject with WrongAdapterError — the native adapter
    // guard fires before any write or scan step.
    let caught: unknown;
    try {
      await writeNativeStory(passingCandidate());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WrongAdapterError);

    // No to-do manifest must exist — nothing was scanned.
    const todoDir = path.join(root, ".flow", "state", "to-do");
    const entries = await fs.readdir(todoDir).catch(() => [] as string[]);
    expect(entries.filter((f) => f.endsWith(".yaml"))).toHaveLength(0);
  });
});
