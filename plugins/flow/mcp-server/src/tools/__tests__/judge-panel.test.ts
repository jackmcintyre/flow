/**
 * Integration tests for the judge panel — Story 9.3 (gate 1, Tier 1).
 *
 * Covers AC1–AC5. The panel is driven through `runJudgePanel` with an INJECTED
 * `judgeRunner` (the spawn seam): each test wires a runner that writes a fixture
 * `LensVerdict` to the lens's deterministic result file via the same
 * `writeLensVerdict` tool a real judge subagent calls. The panel then reads the
 * FILES (never the runner's return), validating the deterministic-seam discipline.
 *
 * Fixture convention: real temp dirs (`fs.mkdtemp`), no mocking of
 * `classifyRiskTier`, `writeLensVerdict`, the file reader, or `logTelemetryEvent`.
 * A real risk-tiering spec is seeded so the Considered-lens bar (AC4) keys off the
 * classifier's actual output.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import {
  runJudgePanel,
  aggregateJudgePanel,
  readLensVerdictFile,
  lensVerdictFilePath,
  validateLensRoleBinding,
  writeLensVerdict,
  DEFAULT_LENS_ROLES,
  type JudgeRunner,
  type JudgeDraft,
  type LensRoleBinding,
} from "../judge-panel.js";
import { PanelVerdictSchema, LENS_NAMES, type LensName } from "../../schemas/lens-verdict.js";
import {
  LensJudgeUnavailableError,
  DuplicateLensJudgeError,
  LensVerdictFileMalformedError,
} from "../../errors.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let targetRepoRoot: string;
let pluginRoot: string;
const sessionUlid = "01TESTSESSIONULID0000000000";

beforeEach(async () => {
  targetRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "judge-panel-"));
  pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "judge-panel-plugin-"));
  // Seed a risk-tiering spec so classifyRiskTier returns a deterministic tier.
  // - any path under `migrations/` → high
  // - everything else falls through to the medium fallback unless a low rule
  //   matches; we add a `docs/`-only low rule for the low-risk path.
  await seedRiskSpec(pluginRoot);
});

afterEach(async () => {
  await fs.rm(targetRepoRoot, { recursive: true, force: true });
  await fs.rm(pluginRoot, { recursive: true, force: true });
});

async function seedRiskSpec(root: string): Promise<void> {
  const docsDir = path.join(root, "docs");
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

const DRAFT: JudgeDraft = {
  ref: "native:01JUDGEDRAFT00000000000000",
  title: "A drafted story",
  specText: "## Story\nAs a ... I want ... so that ...\n## Acceptance Criteria\n...",
  changedPaths: ["docs/foo.md"], // low-risk path under the seeded spec
  diffSize: 10,
};

/**
 * Build an injected judge runner from a per-lens verdict plan. For each lens the
 * runner writes the planned `{ pass, missed }` (with the panel-supplied role) to
 * the lens's result file via `writeLensVerdict` — the same seam a real judge
 * subagent uses. `considered` may be a function of the risk tier (AC4).
 */
function makeRunner(
  plan: Partial<
    Record<
      LensName,
      | { pass: boolean; missed: string }
      | ((riskTier: "low" | "medium" | "high") => { pass: boolean; missed: string })
    >
  >,
  defaults: { pass: boolean; missed: string } = { pass: true, missed: "nothing missed" },
): JudgeRunner {
  return async ({ lens, role, draft, riskTier, resultFilePath }) => {
    const entry = plan[lens] ?? defaults;
    const resolved = typeof entry === "function" ? entry(riskTier) : entry;
    const written = await writeLensVerdict({
      targetRepoRoot,
      sessionUlid,
      ref: draft.ref,
      lens,
      role,
      pass: resolved.pass,
      missed: resolved.missed,
    });
    // Sanity: the writer agrees with the panel reader on the path.
    expect(written.resultFilePath).toBe(resultFilePath);
  };
}

// ---------------------------------------------------------------------------
// AC1 — each lens judge emits a machine-checkable verdict to a file, not prose
// ---------------------------------------------------------------------------

describe("AC1: a lens judge writes a well-formed verdict file and a reader round-trips it", () => {
  it("writes a {lens, pass, missed} verdict file with a non-empty missed on a fail, and the reader round-trips it", async () => {
    const lens: LensName = "verifiability";
    const role = "test-specialist";

    // A single lens judge grades the draft and writes its verdict to a file.
    const { resultFilePath } = await writeLensVerdict({
      targetRepoRoot,
      sessionUlid,
      ref: DRAFT.ref,
      lens,
      role,
      pass: false,
      missed: "AC1 asserts a string appears in a file — presence, not behaviour",
    });

    // The verdict is on disk as JSON (a file, not a transcript).
    const raw = JSON.parse(await fs.readFile(resultFilePath, "utf8"));
    expect(raw.lens).toBe("verifiability");
    expect(typeof raw.pass).toBe("boolean");
    expect(raw.pass).toBe(false);
    expect(typeof raw.missed).toBe("string");
    expect(raw.missed.length).toBeGreaterThan(0);

    // The reader round-trips the parsed verdict.
    const verdict = await readLensVerdictFile({
      filePath: resultFilePath,
      expectedLens: lens,
      expectedRole: role,
    });
    expect(verdict).toEqual({
      lens: "verifiability",
      role: "test-specialist",
      pass: false,
      missed: "AC1 asserts a string appears in a file — presence, not behaviour",
    });
  });

  it("rejects a fail with an empty missed at write time (a malformed verdict never reaches disk)", async () => {
    await expect(
      writeLensVerdict({
        targetRepoRoot,
        sessionUlid,
        ref: DRAFT.ref,
        lens: "structure",
        role: "architect",
        pass: false,
        missed: "",
      }),
    ).rejects.toThrow();
    // No file was written.
    const p = lensVerdictFilePath(targetRepoRoot, sessionUlid, DRAFT.ref, "structure");
    await expect(fs.access(p)).rejects.toThrow();
  });

  it("the panel consumes the file, never the runner's return value (a lying runner cannot inject a verdict)", async () => {
    // This runner RETURNS nothing useful and writes a PASS file; the panel must
    // reflect the FILE contents, proving it reads files not transcripts.
    const runner: JudgeRunner = async ({ lens, role, draft }) => {
      await writeLensVerdict({
        targetRepoRoot,
        sessionUlid,
        ref: draft.ref,
        lens,
        role,
        pass: true,
        missed: "nothing missed",
      });
      return undefined;
    };
    const { verdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      judgeRunner: runner,
      pluginRootOverride: pluginRoot,
    });
    expect(verdict.lenses.every((l) => l.pass)).toBe(true);
  });

  it("fails loudly when a judge writes no verdict file (no silent pass)", async () => {
    // Runner that writes nothing for the `domain` lens.
    const runner: JudgeRunner = async ({ lens, role, draft }) => {
      if (lens === "domain") return; // judge produced no file
      await writeLensVerdict({
        targetRepoRoot,
        sessionUlid,
        ref: draft.ref,
        lens,
        role,
        pass: true,
        missed: "nothing missed",
      });
    };
    await expect(
      runJudgePanel({
        targetRepoRoot,
        sessionUlid,
        draft: DRAFT,
        lensRoles: DEFAULT_LENS_ROLES,
        judgeRunner: runner,
        pluginRootOverride: pluginRoot,
      }),
    ).rejects.toBeInstanceOf(LensVerdictFileMalformedError);
  });
});

// ---------------------------------------------------------------------------
// AC2 — full diverse lens set, one role per lens
// ---------------------------------------------------------------------------

describe("AC2: the panel runs all five lenses, one distinct role per lens", () => {
  it("collects all five lens verdicts, each keyed to its lens and tagged with a distinct judging role", async () => {
    const { verdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      judgeRunner: makeRunner({}),
      pluginRootOverride: pluginRoot,
    });

    // All five lenses present, none skipped.
    const lensesSeen = verdict.lenses.map((l) => l.lens).sort();
    expect(lensesSeen).toEqual([...LENS_NAMES].sort());

    // Each verdict is keyed to its lens and carries the bound role.
    for (const lensName of LENS_NAMES) {
      const lv = verdict.lenses.find((l) => l.lens === lensName);
      expect(lv).toBeDefined();
      expect(lv!.role).toBe(DEFAULT_LENS_ROLES[lensName]);
    }

    // No two lenses shared a judge — five distinct roles.
    const roles = verdict.lenses.map((l) => l.role);
    expect(new Set(roles).size).toBe(roles.length);
    expect(new Set(roles).size).toBe(5);
  });

  it("fails loudly when a lens has no judging role (a missing lens is the rubber-stamp failure in disguise)", () => {
    const broken = { ...DEFAULT_LENS_ROLES } as Record<string, string>;
    delete broken["considered"];
    expect(() => validateLensRoleBinding(broken as LensRoleBinding)).toThrow(
      LensJudgeUnavailableError,
    );
  });

  it("fails loudly when one role is bound to two lenses (no two lenses share a judge)", () => {
    const collided: LensRoleBinding = {
      ...DEFAULT_LENS_ROLES,
      domain: DEFAULT_LENS_ROLES.structure, // architect now judges two lenses
    };
    expect(() => validateLensRoleBinding(collided)).toThrow(DuplicateLensJudgeError);
  });
});

// ---------------------------------------------------------------------------
// AC3 — a failed lens is recorded as failing, with the specific miss
// ---------------------------------------------------------------------------

describe("AC3: a draft that fails a lens is recorded failing with the specific miss", () => {
  it("records Verifiability as fail with a populated missed for a string-presence-only AC", async () => {
    const runner = makeRunner({
      verifiability: {
        pass: false,
        missed:
          "AC asserts the string \"failed\" appears in source — presence, not behaviour; would pass even if the write used the wrong status",
      },
    });
    const { verdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      judgeRunner: runner,
      pluginRootOverride: pluginRoot,
    });
    const verifiability = verdict.lenses.find((l) => l.lens === "verifiability")!;
    expect(verifiability.pass).toBe(false);
    expect(verifiability.missed.length).toBeGreaterThan(0);
    expect(verifiability.missed).toMatch(/presence/i);
  });

  it("records Verifiability as pass for a behaviour-asserting AC", async () => {
    const runner = makeRunner({
      verifiability: {
        pass: true,
        missed: "AC drives the real claim path and asserts the returned manifest — behaviour is pinned",
      },
    });
    const { verdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      judgeRunner: runner,
      pluginRootOverride: pluginRoot,
    });
    const verifiability = verdict.lenses.find((l) => l.lens === "verifiability")!;
    expect(verifiability.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4 — the Considered-lens bar scales with the draft's risk tier
// ---------------------------------------------------------------------------

describe("AC4: the Considered-lens bar scales with the draft's risk tier", () => {
  // The injected considered judge applies the rubric's tiered bar by keying off
  // the riskTier the panel passes it (the same tier classifyRiskTier returns):
  //   - low: passes on "names what could break + pins top failure"
  //   - medium/high: fails when an open question lacks a defaulted answer.
  const consideredByTier = (riskTier: "low" | "medium" | "high") => {
    if (riskTier === "low") {
      return { pass: true, missed: "low bar met: names what could break, top failure pinned by AC2" };
    }
    // Higher tier: this draft has an unresolved open decision → cold-dev insufficiency.
    return {
      pass: false,
      missed: "high bar: an open question ('which lock strategy?') has no defaulted answer — a cold dev would stop to ask",
    };
  };

  it("fails Considered on a high-tier draft with an unresolved open decision", async () => {
    const highDraft: JudgeDraft = {
      ...DRAFT,
      ref: "native:01HIGHDRAFT0000000000000000",
      changedPaths: ["migrations/0001_add_table.sql"], // matches the seeded high rule
      diffSize: 50,
    };
    const { riskTier, verdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: highDraft,
      lensRoles: DEFAULT_LENS_ROLES,
      judgeRunner: makeRunner({ considered: consideredByTier }),
      pluginRootOverride: pluginRoot,
    });
    expect(riskTier).toBe("high");
    const considered = verdict.lenses.find((l) => l.lens === "considered")!;
    expect(considered.pass).toBe(false);
    expect(considered.missed).toMatch(/defaulted answer|cold dev/i);
  });

  it("passes Considered on a low-tier draft meeting the lighter bar", async () => {
    const lowDraft: JudgeDraft = {
      ...DRAFT,
      ref: "native:01LOWDRAFT00000000000000000",
      changedPaths: ["docs/readme.md"], // matches the seeded low rule
      diffSize: 5,
    };
    const { riskTier, verdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: lowDraft,
      lensRoles: DEFAULT_LENS_ROLES,
      judgeRunner: makeRunner({ considered: consideredByTier }),
      pluginRootOverride: pluginRoot,
    });
    expect(riskTier).toBe("low");
    const considered = verdict.lenses.find((l) => l.lens === "considered")!;
    expect(considered.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Story 10.4 AC3 — the panel prefers the persisted risk_tier (single source of
// truth) and only computes from changedPaths when it is absent.
// ---------------------------------------------------------------------------

describe("Story 10.4 AC3: runJudgePanel prefers the persisted risk_tier", () => {
  // A considered judge that simply echoes back the tier the panel handed it, so
  // the test can assert WHICH tier reached the Considered lens.
  const echoConsidered = (riskTier: "low" | "medium" | "high") => ({
    pass: true,
    missed: `considered graded at tier=${riskTier}`,
  });

  it("uses the persisted risk_tier verbatim — even when changedPaths would classify to a different tier (no double-classify)", async () => {
    // changedPaths matches the seeded HIGH rule (migrations/**), but the draft
    // carries a PERSISTED low tier (as scan would stamp from declared paths).
    // The panel must honour the persisted value, NOT recompute to high.
    const draft: JudgeDraft = {
      ...DRAFT,
      ref: "native:01PERSISTLOW0000000000000000",
      changedPaths: ["migrations/0001_add_table.sql"], // would compute → high
      diffSize: 0, // author time — no diff
      riskTier: "low", // persisted (single source of truth)
    };

    const { riskTier, verdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft,
      lensRoles: DEFAULT_LENS_ROLES,
      judgeRunner: makeRunner({ considered: echoConsidered }),
      pluginRootOverride: pluginRoot,
    });

    // The panel reported the persisted tier, not the computed one.
    expect(riskTier).toBe("low");
    // The Considered lens received the persisted tier.
    const considered = verdict.lenses.find((l) => l.lens === "considered")!;
    expect(considered.missed).toBe("considered graded at tier=low");
  });

  it("falls back to computing from changedPaths when no persisted risk_tier is present (legacy / BMad)", async () => {
    // No `riskTier` on the draft → the panel classifies from changedPaths.
    const draft: JudgeDraft = {
      ...DRAFT,
      ref: "native:01NOPERSIST00000000000000000",
      changedPaths: ["migrations/0001_add_table.sql"], // computes → high
      diffSize: 50,
      // riskTier intentionally omitted
    };

    const { riskTier, verdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft,
      lensRoles: DEFAULT_LENS_ROLES,
      judgeRunner: makeRunner({ considered: echoConsidered }),
      pluginRootOverride: pluginRoot,
    });

    expect(riskTier).toBe("high");
    const considered = verdict.lenses.find((l) => l.lens === "considered")!;
    expect(considered.missed).toBe("considered graded at tier=high");
  });
});

// ---------------------------------------------------------------------------
// AC5 — schema-shaped verdict, panel does not decide ready
// ---------------------------------------------------------------------------

describe("AC5: the panel emits a schema-shaped verdict and does not decide ready", () => {
  it("returns a verdict that validates against the schema with exactly the five lens entries", async () => {
    const { verdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      judgeRunner: makeRunner({}),
      pluginRootOverride: pluginRoot,
    });
    // Validates against the schema.
    expect(() => PanelVerdictSchema.parse(verdict)).not.toThrow();
    // Tier-0 status plus exactly five lens entries.
    expect(verdict.tier0).toBe("pass");
    expect(verdict.lenses).toHaveLength(5);
    expect(new Set(verdict.lenses.map((l) => l.lens)).size).toBe(5);
  });

  it("touches no manifest readiness field — writes only verdict files + a telemetry event", async () => {
    // Seed an un-claimed backlog manifest with ready:false in the state dir.
    const stateDir = path.join(targetRepoRoot, ".flow", "state", "to-do");
    await fs.mkdir(stateDir, { recursive: true });
    const manifestPath = path.join(stateDir, "native_01JUDGEDRAFT.yaml");
    const manifestBefore = "ref: native:01JUDGEDRAFT00000000000000\nstatus: to-do\nready: false\nwithdrawn: false\n";
    await atomicWriteFile(manifestPath, manifestBefore);

    await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      judgeRunner: makeRunner({}),
      pluginRootOverride: pluginRoot,
    });

    // The manifest is byte-for-byte unchanged — the panel never blesses.
    const manifestAfter = await fs.readFile(manifestPath, "utf8");
    expect(manifestAfter).toBe(manifestBefore);
    expect(manifestAfter).toContain("ready: false");

    // The only state the panel wrote is the per-lens verdict files.
    for (const lens of LENS_NAMES) {
      const p = lensVerdictFilePath(targetRepoRoot, sessionUlid, DRAFT.ref, lens);
      await expect(fs.access(p)).resolves.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Gate-1 workflow ACs — Story native:01KT1MP7TR651TAGVJ6EZSR589
//
// These tests drive the gate-1 contract through `aggregateJudgePanel` (the
// MCP-registered half that the gate-1.workflow.js calls via the CLI seam after
// the parallel judge spawns). The tests pre-write the per-lens verdict files
// (exactly as the real judges do via writeLensVerdict), then call
// aggregateJudgePanel so the panel reads them — proving the deterministic-file
// discipline holds end-to-end through the CLI-seam half.
//
// AC1: all-pass panel → aggregateJudgePanel returns a PanelVerdict with all
//      lenses passing, ready for adjudication → decision=ready with blessing.
// AC2: one-lens-fail panel → aggregateJudgePanel returns a PanelVerdict with the
//      failing lens identified → with round=1 k=1 adjudication yields
//      decision=escalate immediately (no rework loop in gate-1).
// AC3: missing verdict file → aggregateJudgePanel throws LensVerdictFileMalformedError
//      rather than silently dropping the lens and reporting a false clean sweep.
// ---------------------------------------------------------------------------

/**
 * Pre-write all five (or four) per-lens verdict files so aggregateJudgePanel
 * can read them — exactly as the real judges do via writeLensVerdict.
 */
async function preSeedVerdicts(
  opts: {
    targetRepoRoot: string;
    sessionUlid: string;
    ref: string;
    plan?: Partial<Record<LensName, { pass: boolean; missed: string }>>;
    skip?: LensName; // omit this lens to test missing-file error
  },
): Promise<void> {
  const defaults = { pass: true, missed: "nothing missed" };
  for (const lens of LENS_NAMES) {
    if (opts.skip === lens) continue; // intentionally omit this file
    const { plan, ref, sessionUlid: su, targetRepoRoot: repo } = opts;
    const entry = plan?.[lens] ?? defaults;
    await writeLensVerdict({
      targetRepoRoot: repo,
      sessionUlid: su,
      ref,
      lens,
      role: DEFAULT_LENS_ROLES[lens],
      pass: entry.pass,
      missed: entry.missed,
    });
  }
}

describe("Gate-1 AC1: all-pass panel → aggregateJudgePanel returns a valid PanelVerdict with all lenses passing", () => {
  it("returns a PanelVerdict where all five lenses pass (gate-1 clean sweep path)", async () => {
    // Pre-write all five verdict files as a real judge subagent would.
    await preSeedVerdicts({ targetRepoRoot, sessionUlid, ref: DRAFT.ref });

    // Call the CLI-seam half directly — mirrors how gate-1.workflow.js calls it.
    const { verdict, riskTier } = await aggregateJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      pluginRootOverride: pluginRoot,
    });

    expect(verdict.lenses).toHaveLength(5);
    expect(verdict.lenses.every((l) => l.pass)).toBe(true);
    // Validates against the schema.
    expect(() => PanelVerdictSchema.parse(verdict)).not.toThrow();
    // Risk tier is resolved (the seeded spec classifies docs/** as low).
    expect(riskTier).toBe("low");
  });

  it("all-pass panel + adjudication with round=1 k=1 → decision=ready and story is blessed", async () => {
    // Seed a to-do manifest so markStoryReady can flip the flag.
    // markStoryReady looks for <stateName>/<ref>.yaml — use the ref verbatim as the filename.
    const stateDir = path.join(targetRepoRoot, ".flow", "state", "to-do");
    await fs.mkdir(stateDir, { recursive: true });
    const manifestPath = path.join(stateDir, `${DRAFT.ref}.yaml`);
    await atomicWriteFile(
      manifestPath,
      `ref: ${DRAFT.ref}\nstatus: to-do\nready: false\nwithdrawn: false\n` +
        `adapter: native\nsource_path: .flow/native-stories/${DRAFT.ref}.md\n` +
        `source_hash: ${"a".repeat(64)}\ndepends_on: []\nacceptance_criteria:\n  - text: Given x when y then z.\n    kind: integration\n` +
        `title: A drafted story\nnarrative: As a dev I want to test.\n`,
    );

    await preSeedVerdicts({ targetRepoRoot, sessionUlid, ref: DRAFT.ref });

    const { verdict: panelVerdict } = await aggregateJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      pluginRootOverride: pluginRoot,
    });

    // Import adjudicateQualityLead so the full gate-1 path is exercised.
    const { adjudicateQualityLead } = await import("../quality-lead-adjudicate.js");
    const { verdict: adjVerdict } = await adjudicateQualityLead({
      targetRepoRoot,
      sessionUlid,
      ref: DRAFT.ref,
      panel: panelVerdict,
      round: 1,
      k: 1,
    });

    // Clean panel + round=1 k=1 → ready (blessed).
    expect(adjVerdict.decision).toBe("ready");
    expect(adjVerdict.round).toBe(1);
    // The story was blessed on disk.
    const raw = await fs.readFile(manifestPath, "utf8");
    expect(raw).toContain("ready: true");
  });
});

describe("Gate-1 AC2: one-lens-fail panel → decision=escalate (round=1 k=1, no rework loop)", () => {
  it("returns a PanelVerdict with the failing lens identified", async () => {
    const failMsg = "AC asserts a string appears in source — presence, not behaviour; would pass even if the write used the wrong status";
    await preSeedVerdicts({
      targetRepoRoot,
      sessionUlid,
      ref: DRAFT.ref,
      plan: { verifiability: { pass: false, missed: failMsg } },
    });

    const { verdict: panelVerdict } = await aggregateJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      pluginRootOverride: pluginRoot,
    });

    const failing = panelVerdict.lenses.filter((l) => !l.pass);
    expect(failing).toHaveLength(1);
    expect(failing[0]!.lens).toBe("verifiability");
    expect(failing[0]!.missed).toBe(failMsg);
  });

  it("one-lens-fail + adjudication with round=1 k=1 → decision=escalate immediately (no rework)", async () => {
    const failMsg = "AC does not pin observable behaviour; it only checks string presence";
    await preSeedVerdicts({
      targetRepoRoot,
      sessionUlid,
      ref: DRAFT.ref,
      plan: { discipline: { pass: false, missed: failMsg } },
    });

    const { verdict: panelVerdict } = await aggregateJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      pluginRootOverride: pluginRoot,
    });

    const { adjudicateQualityLead } = await import("../quality-lead-adjudicate.js");
    const { verdict: adjVerdict } = await adjudicateQualityLead({
      targetRepoRoot,
      sessionUlid,
      ref: DRAFT.ref,
      panel: panelVerdict,
      round: 1,
      k: 1,
    });

    // Any fail + round=1 k=1 → round >= k → escalate, NOT rework.
    expect(adjVerdict.decision).toBe("escalate");
    expect(adjVerdict.round).toBe(1);
    expect(adjVerdict.escalation_reason).toBeDefined();
    // The escalation reason names the failing lens so the operator can act.
    expect(adjVerdict.escalation_reason).toMatch(/discipline/);
  });

  it("story remains not-ready after escalate — the story was never blessed", async () => {
    // markStoryReady looks for <stateName>/<ref>.yaml — use the ref verbatim.
    const stateDir = path.join(targetRepoRoot, ".flow", "state", "to-do");
    await fs.mkdir(stateDir, { recursive: true });
    const manifestPath = path.join(stateDir, `${DRAFT.ref}.yaml`);
    await atomicWriteFile(
      manifestPath,
      `ref: ${DRAFT.ref}\nstatus: to-do\nready: false\nwithdrawn: false\n` +
        `adapter: native\nsource_path: .flow/native-stories/${DRAFT.ref}.md\n` +
        `source_hash: ${"a".repeat(64)}\ndepends_on: []\nacceptance_criteria:\n  - text: Given x when y then z.\n    kind: integration\n` +
        `title: A drafted story\nnarrative: As a dev I want to test.\n`,
    );

    await preSeedVerdicts({
      targetRepoRoot,
      sessionUlid,
      ref: DRAFT.ref,
      plan: { structure: { pass: false, missed: "secretly two stories — split it" } },
    });

    const { verdict: panelVerdict } = await aggregateJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles: DEFAULT_LENS_ROLES,
      pluginRootOverride: pluginRoot,
    });

    const { adjudicateQualityLead } = await import("../quality-lead-adjudicate.js");
    const { verdict: adjVerdict, blessed } = await adjudicateQualityLead({
      targetRepoRoot,
      sessionUlid,
      ref: DRAFT.ref,
      panel: panelVerdict,
      round: 1,
      k: 1,
    });

    expect(adjVerdict.decision).toBe("escalate");
    // The brake was never called — ready flag is still false on disk.
    expect(blessed).toBeUndefined();
    const raw = await fs.readFile(manifestPath, "utf8");
    expect(raw).toContain("ready: false");
  });
});

describe("Gate-1 AC3: missing verdict file → LensVerdictFileMalformedError (no silent false clean sweep)", () => {
  it("throws LensVerdictFileMalformedError when a judge wrote no verdict file", async () => {
    // Seed only four files (omit 'domain') — exactly what happens when a judge
    // narrates a verdict but does not call writeLensVerdict.
    await preSeedVerdicts({
      targetRepoRoot,
      sessionUlid,
      ref: DRAFT.ref,
      skip: "domain",
    });

    await expect(
      aggregateJudgePanel({
        targetRepoRoot,
        sessionUlid,
        draft: DRAFT,
        lensRoles: DEFAULT_LENS_ROLES,
        pluginRootOverride: pluginRoot,
      }),
    ).rejects.toBeInstanceOf(LensVerdictFileMalformedError);
  });

  it("throws LensVerdictFileMalformedError when a verdict file contains malformed JSON", async () => {
    // Seed all five files normally, then overwrite one with garbage JSON via atomicWriteFile
    // (the project's managed write path — the fs-write guard requires it).
    await preSeedVerdicts({ targetRepoRoot, sessionUlid, ref: DRAFT.ref });
    const badFilePath = lensVerdictFilePath(targetRepoRoot, sessionUlid, DRAFT.ref, "considered");
    await atomicWriteFile(badFilePath, "not-valid-json{{{");

    await expect(
      aggregateJudgePanel({
        targetRepoRoot,
        sessionUlid,
        draft: DRAFT,
        lensRoles: DEFAULT_LENS_ROLES,
        pluginRootOverride: pluginRoot,
      }),
    ).rejects.toBeInstanceOf(LensVerdictFileMalformedError);
  });
});
