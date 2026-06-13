/**
 * Planning-phase friction emission tests — Story native:01KTAWWYF46WD6QS8F96EMA039.
 *
 * Verifies that the three planning tools emit `agent.friction` telemetry events at
 * their respective fallback points:
 *
 *   AC1 (integration): `renderGateWriteNativeStory` emits friction with
 *     kind='forced-fallback' / role='author' before propagating
 *     `DisciplineViolationError`. Two or more such events appear in
 *     `gatherRetroInputs().recurringFriction`.
 *
 *   AC2 (unit): `runJudgePanel` emits friction with kind='missing-cited-source' /
 *     role='orchestrator' before propagating `LensVerdictFileMalformedError`.
 *
 *   AC3 (unit): `adjudicateQualityLead` emits friction with kind='forced-fallback' /
 *     role='quality-lead' when the panel is still split at round >= k. The returned
 *     `AdjudicationVerdict` still has decision='escalate'.
 *
 *   AC4 (unit): Happy-path across all three tools produces zero `agent.friction`
 *     events.
 *
 * All tests use real file-system fixtures in a temp dir (no mocking of the things
 * under test). Friction is asserted by reading the `.flow/telemetry/*.jsonl` file
 * after each call — the same seam `gatherRetroInputs` reads.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { DisciplineViolationError, LensVerdictFileMalformedError } from "../errors.js";
import { renderGateWriteNativeStory, type WriteNativeStoryInput } from "../tools/write-native-story.js";
import {
  runJudgePanel,
  writeLensVerdict,
  DEFAULT_LENS_ROLES,
  type JudgeRunner,
  type JudgeDraft,
} from "../tools/judge-panel.js";
import {
  adjudicateQualityLead,
  DEFAULT_ADJUDICATION_K,
} from "../tools/quality-lead-adjudicate.js";
import { gatherRetroInputs } from "../tools/gather-retro-inputs.js";
import { LENS_NAMES, type LensName, type PanelVerdict } from "../schemas/lens-verdict.js";
import { TelemetryEventSchema } from "../schemas/telemetry-events.js";
import type { ExecutionManifest } from "../schemas/execution-manifest.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let targetRepoRoot: string;

/**
 * Read all telemetry lines from `.flow/telemetry/*.jsonl` and return only
 * the `agent.friction` events.
 */
async function readFrictionEvents(root: string): Promise<Array<{ kind: string; role?: string }>> {
  const telemetryDir = path.join(root, ".flow", "telemetry");
  let entries: string[];
  try {
    entries = await fs.readdir(telemetryDir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith(".jsonl")).sort();
  const events: Array<{ kind: string; role?: string }> = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(telemetryDir, file), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const result = TelemetryEventSchema.safeParse(parsed);
      if (!result.success) continue;
      if (result.data.type === "agent.friction") {
        const ev = result.data as { type: "agent.friction"; data: { kind: string }; agent?: string };
        events.push({ kind: ev.data.kind, role: ev.agent });
      }
    }
  }
  return events;
}

/**
 * Seed the minimal directory layout so `renderGateWriteNativeStory` can resolve
 * cited sources on disk. The native-stories dir must exist; config.yaml is NOT
 * required (`renderGateWriteNativeStory` skips the adapter guard).
 */
async function seedWorkspace(root: string): Promise<void> {
  await fs.mkdir(path.join(root, ".flow", "native-stories"), { recursive: true });
}

/** Seed a repo-relative file under `root`. */
async function seedFile(root: string, relPath: string): Promise<void> {
  await atomicWriteFile(path.join(root, relPath), "// seeded for resolvability\n");
}

/**
 * A `WriteNativeStoryInput` whose cited source is seeded on disk, and whose
 * single AC is a non-state-mutating unit AC (passes discipline gate).
 *
 * `targetRepoRoot` is passed so Zod's `.min(1)` check passes.
 */
function makeValidStoryInput(root: string, sessionUlid?: string): WriteNativeStoryInput {
  return {
    targetRepoRoot: root,
    title: "Render a friendly greeting",
    narrative: {
      role: "user",
      want: "a friendly greeting on login",
      so_that: "the app feels welcoming",
    },
    acceptance_criteria: [
      {
        text: "**Given** the user logs in, **When** the app renders, **Then** a greeting message appears.",
        kind: "unit",
        verification: {
          type: "vitest",
          target: "src/__tests__/planning-friction-emission-happy.test.ts",
        },
      },
    ],
    tasks: [{ text: "Render the greeting component", ac_refs: ["AC1"] }],
    cited_sources: ["src/ui/greeting.ts"],
    depends_on: [],
    risk_reasoning: "Highest risk: greeting text is blank — caught by the unit AC assertion.",
    sessionUlid,
  };
}

/**
 * A `WriteNativeStoryInput` that VIOLATES the discipline gate: it names a
 * state-mutating path (sprint-status.yaml) but only has a unit AC (missing
 * the required integration AC).
 */
function makeViolatingStoryInput(root: string, sessionUlid?: string): WriteNativeStoryInput {
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
        kind: "unit",
        verification: {
          type: "vitest",
          target: "src/__tests__/planning-friction-emission-gate.test.ts",
        },
      },
    ],
    tasks: [{ text: "Write the ledger path", ac_refs: ["AC1"] }],
    cited_sources: ["src/state/ledger.ts"],
    depends_on: [],
    sessionUlid,
  };
}

/** Build a PanelVerdict where the named lenses fail; all others pass. */
function makePanel(failing: Partial<Record<LensName, string>> = {}): PanelVerdict {
  return {
    tier0: "pass",
    lenses: LENS_NAMES.map((lens) => {
      const miss = failing[lens];
      return {
        lens,
        role: DEFAULT_LENS_ROLES[lens],
        pass: miss === undefined,
        missed: miss ?? "nothing missed",
      };
    }),
  };
}

/** Seed a risk-tiering spec in the plugin root so `runJudgePanel` can classify risk. */
async function seedRiskSpec(pluginRoot: string): Promise<void> {
  const docsDir = path.join(pluginRoot, "docs");
  await fs.mkdir(docsDir, { recursive: true });
  const spec = `---
version: "1.0.0"
fallback_tier: medium
tiers:
  high:
    - id: high.migration
      path_patterns:
        - "migrations/**"
  low:
    - id: low.docs-only
      path_patterns:
        - "docs/**"
---

# Risk-tiering rules
`;
  await atomicWriteFile(path.join(docsDir, "risk-tiering.md"), spec);
}

/** Seed a real `to-do/` manifest so `adjudicateQualityLead` can bless on `ready`. */
async function seedTodoManifest(root: string, ref: string): Promise<void> {
  const todoDir = path.join(root, ".flow", "state", "to-do");
  await fs.mkdir(todoDir, { recursive: true });
  const manifest: ExecutionManifest = {
    ref,
    status: "to-do",
    adapter: "native",
    source_path: `.flow/native-stories/${ref}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: `Test story ${ref}`,
    narrative: "As a dev, I want to test.",
    withdrawn: false,
    ready: false,
  };
  await atomicWriteFile(
    path.join(todoDir, `${ref}.yaml`),
    yamlStringify(manifest, { lineWidth: 0 }),
  );
}

// ---------------------------------------------------------------------------
// AC1 (integration): writeNativeStory / renderGateWriteNativeStory emits friction
//   on DisciplineViolationError AND gatherRetroInputs surfaces recurring entry.
// ---------------------------------------------------------------------------

describe("AC1 — renderGateWriteNativeStory emits friction on DisciplineViolationError", () => {
  let pluginRoot: string;

  beforeEach(async () => {
    targetRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "planning-friction-ac1-"));
    pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "planning-friction-ac1-plugin-"));
    await seedWorkspace(targetRepoRoot);
    await seedFile(targetRepoRoot, "src/state/ledger.ts");
  });

  afterEach(async () => {
    await fs.rm(targetRepoRoot, { recursive: true, force: true });
    await fs.rm(pluginRoot, { recursive: true, force: true });
  });

  it("emits a friction event with kind='forced-fallback' and role='author' before propagating DisciplineViolationError", async () => {
    const SESSION = "01PLANFRICTION0000000000001";

    // The violating story triggers the discipline gate → DisciplineViolationError.
    await expect(
      renderGateWriteNativeStory(makeViolatingStoryInput(targetRepoRoot, SESSION), targetRepoRoot),
    ).rejects.toBeInstanceOf(DisciplineViolationError);

    // A friction event must have been appended to the telemetry JSONL.
    const events = await readFrictionEvents(targetRepoRoot);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("forced-fallback");
    expect(events[0]!.role).toBe("author");
  });

  it("DisciplineViolationError propagates unchanged (original violations array intact)", async () => {
    const SESSION = "01PLANFRICTION0000000000002";
    let caught: unknown;
    try {
      await renderGateWriteNativeStory(makeViolatingStoryInput(targetRepoRoot, SESSION), targetRepoRoot);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const codes = (caught as DisciplineViolationError).violations.map((v) => v.code);
    // The 'missing-integration-ac' rule fires on a state-mutating story with only a unit AC.
    expect(codes).toContain("missing-integration-ac");
  });

  it("two or more DisciplineViolationError events appear in gatherRetroInputs().recurringFriction", async () => {
    const SESSION = "01PLANFRICTION0000000000003";

    // Trigger the gate twice with the same session.
    for (let i = 0; i < 2; i++) {
      await expect(
        renderGateWriteNativeStory(makeViolatingStoryInput(targetRepoRoot, SESSION), targetRepoRoot),
      ).rejects.toBeInstanceOf(DisciplineViolationError);
    }

    // gatherRetroInputs must surface a recurringFriction entry for 'forced-fallback'.
    const bundle = await gatherRetroInputs({ targetRepoRoot });
    const entry = bundle.recurringFriction.find((e) => e.kind === "forced-fallback");
    expect(entry).toBeDefined();
    expect(entry!.count).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// AC2 (unit): runJudgePanel emits friction on LensVerdictFileMalformedError.
// ---------------------------------------------------------------------------

describe("AC2 — runJudgePanel emits friction on LensVerdictFileMalformedError", () => {
  let pluginRoot: string;
  const SESSION = "01PLANFRICTION0000000000004";
  const DRAFT: JudgeDraft = {
    ref: "native:PLANFRICTION_AC2_00000000000",
    title: "AC2 friction test draft",
    specText: "## Story\nAs a dev I want friction emitted on missing lens file.\n",
    riskTier: "low",
  };

  beforeEach(async () => {
    targetRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "planning-friction-ac2-"));
    pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "planning-friction-ac2-plugin-"));
    await seedRiskSpec(pluginRoot);
  });

  afterEach(async () => {
    await fs.rm(targetRepoRoot, { recursive: true, force: true });
    await fs.rm(pluginRoot, { recursive: true, force: true });
  });

  it("emits friction with kind='missing-cited-source' and role='orchestrator' before propagating LensVerdictFileMalformedError", async () => {
    // Inject a judgeRunner that writes NO verdict file, causing the reader to throw
    // LensVerdictFileMalformedError (ENOENT).
    const noOpRunner: JudgeRunner = async () => {
      /* intentionally writes nothing — triggers ENOENT in readLensVerdictFile */
    };

    await expect(
      runJudgePanel({
        targetRepoRoot,
        sessionUlid: SESSION,
        draft: DRAFT,
        lensRoles: DEFAULT_LENS_ROLES,
        judgeRunner: noOpRunner,
        pluginRootOverride: pluginRoot,
      }),
    ).rejects.toBeInstanceOf(LensVerdictFileMalformedError);

    // Friction event must be present.
    const events = await readFrictionEvents(targetRepoRoot);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.kind).toBe("missing-cited-source");
    expect(events[0]!.role).toBe("orchestrator");
  });

  it("LensVerdictFileMalformedError propagates unchanged (original type and message preserved)", async () => {
    const malformedRunner: JudgeRunner = async () => {
      /* writes nothing */
    };

    let caught: unknown;
    try {
      await runJudgePanel({
        targetRepoRoot,
        sessionUlid: SESSION,
        draft: DRAFT,
        lensRoles: DEFAULT_LENS_ROLES,
        judgeRunner: malformedRunner,
        pluginRootOverride: pluginRoot,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LensVerdictFileMalformedError);
    // Message must contain ENOENT-derived language from readLensVerdictFile.
    expect((caught as Error).message).toMatch(/ENOENT|wrote no verdict file/i);
  });
});

// ---------------------------------------------------------------------------
// AC3 (unit): adjudicateQualityLead emits friction on the escalate branch.
// ---------------------------------------------------------------------------

describe("AC3 — adjudicateQualityLead emits friction when panel splits at round >= k", () => {
  const REF = "native:PLANFRICTION_AC3_00000000000";
  const SESSION = "01PLANFRICTION0000000000005";

  beforeEach(async () => {
    targetRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "planning-friction-ac3-"));
  });

  afterEach(async () => {
    await fs.rm(targetRepoRoot, { recursive: true, force: true });
  });

  it("emits friction with kind='forced-fallback' and role='quality-lead' before returning the escalate verdict", async () => {
    const splitPanel = makePanel({ structure: "story is actually two stories — split it" });
    const round = DEFAULT_ADJUDICATION_K; // round == k → escalate branch

    // Use an injected markReady spy to avoid requiring a to-do/ manifest
    // (escalate never calls markReady anyway, but keeps the test self-contained).
    const markReadySpy = async () => ({
      ref: REF,
      ready: true,
      noop: false,
      state: "to-do" as const,
    });

    const { verdict } = await adjudicateQualityLead({
      targetRepoRoot,
      sessionUlid: SESSION,
      ref: REF,
      panel: splitPanel,
      round,
      k: DEFAULT_ADJUDICATION_K,
      markReady: markReadySpy,
    });

    // The verdict decision must be 'escalate'.
    expect(verdict.decision).toBe("escalate");

    // A friction event must have been appended.
    const events = await readFrictionEvents(targetRepoRoot);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("forced-fallback");
    expect(events[0]!.role).toBe("quality-lead");
  });

  it("returned AdjudicationVerdict has decision='escalate' unchanged after friction emission", async () => {
    const splitPanel = makePanel({ verifiability: "AC cannot be pinned even in principle" });

    const { verdict } = await adjudicateQualityLead({
      targetRepoRoot,
      sessionUlid: SESSION,
      ref: REF,
      panel: splitPanel,
      round: DEFAULT_ADJUDICATION_K,
      k: DEFAULT_ADJUDICATION_K,
    });

    expect(verdict.decision).toBe("escalate");
    expect(verdict.escalation_reason).toBeDefined();
    // The returned verdict is a schema-valid AdjudicationVerdict.
    expect(verdict.ref).toBe(REF);
    expect(verdict.round).toBe(DEFAULT_ADJUDICATION_K);
  });

  it("does NOT emit friction on the rework branch (round < k)", async () => {
    const splitPanel = makePanel({ discipline: "story mixes two concerns" });

    await adjudicateQualityLead({
      targetRepoRoot,
      sessionUlid: SESSION,
      ref: REF,
      panel: splitPanel,
      round: 1,
      k: DEFAULT_ADJUDICATION_K,
    });

    // No friction events on the rework path.
    const events = await readFrictionEvents(targetRepoRoot);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 (unit): happy-path — no friction events emitted across all three tools.
// ---------------------------------------------------------------------------

describe("AC4 — happy-path: zero agent.friction events on clean runs", () => {
  let pluginRoot: string;
  const REF = "native:PLANFRICTION_AC4_00000000000";
  const SESSION = "01PLANFRICTION0000000000006";

  beforeEach(async () => {
    targetRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "planning-friction-ac4-"));
    pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "planning-friction-ac4-plugin-"));
    await seedWorkspace(targetRepoRoot);
    // Seed the cited source used by the valid story.
    await seedFile(targetRepoRoot, "src/ui/greeting.ts");
    await seedRiskSpec(pluginRoot);
  });

  afterEach(async () => {
    await fs.rm(targetRepoRoot, { recursive: true, force: true });
    await fs.rm(pluginRoot, { recursive: true, force: true });
  });

  it("all three planning tools complete their happy paths with zero agent.friction events", async () => {
    // --- Happy path 1: renderGateWriteNativeStory with a valid story ---
    const storyResult = await renderGateWriteNativeStory(
      makeValidStoryInput(targetRepoRoot, SESSION),
      targetRepoRoot,
    );
    expect(storyResult.ref).toMatch(/^native:/);

    // --- Happy path 2: runJudgePanel with all lenses passing ---
    const DRAFT: JudgeDraft = {
      ref: REF,
      title: "AC4 happy path draft",
      specText: "## Story\nAs a dev I want all lenses to pass.\n",
      riskTier: "low",
    };

    const allPassRunner: JudgeRunner = async ({ lens, role, draft }) => {
      await writeLensVerdict({
        targetRepoRoot,
        sessionUlid: SESSION,
        ref: draft.ref,
        lens,
        role,
        pass: true,
        missed: "nothing missed",
      });
    };

    const { verdict: panelVerdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid: SESSION,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      judgeRunner: allPassRunner,
      pluginRootOverride: pluginRoot,
    });
    expect(panelVerdict.lenses.every((l) => l.pass)).toBe(true);

    // --- Happy path 3: adjudicateQualityLead with an all-pass panel → ready ---
    await seedTodoManifest(targetRepoRoot, REF);
    const { verdict: adjVerdict } = await adjudicateQualityLead({
      targetRepoRoot,
      sessionUlid: SESSION,
      ref: REF,
      panel: makePanel(),  // all lenses pass
    });
    expect(adjVerdict.decision).toBe("ready");

    // --- Assert zero agent.friction events were appended across all three ---
    const frictionEvents = await readFrictionEvents(targetRepoRoot);
    expect(frictionEvents).toHaveLength(0);
  });
});
