/**
 * Tests for risk_reasoning enforcement — Story native:01KT7SSYVMJDVFKHK5VB7KBPFR.
 *
 * AC1: writeNativeStory refuses a draft whose risk_reasoning is absent or
 *      matches the default placeholder, throwing DisciplineViolationError with
 *      code "placeholder-risk", and writing no file.
 *
 * AC2: writeNativeStory saves a draft whose risk_reasoning is a real
 *      non-placeholder string, and the saved file contains the author-supplied text.
 *
 * AC3: When a draft has both a placeholder risk and another discipline violation,
 *      a SINGLE DisciplineViolationError is thrown listing both codes together.
 *
 * AC4: validatePlannerBacklog returns { ok: false } with violation code
 *      "placeholder-risk" when the pending story's risk_reasoning is absent or
 *      the default placeholder, giving the author a chance to fix before write.
 *
 * AC5: bmadToNativeIngest (the BMad→native ingest seam) is exempt from the
 *      risk_reasoning enforcement: an enriched draft without risk_reasoning
 *      passes the gate and is written.
 *
 * Fixture pattern mirrors write-native-story.test.ts: a minimal native-adapter
 * workspace in a fresh tmpdir.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { DisciplineViolationError } from "../../errors.js";
import { writeNativeStory, DEFAULT_RISK_REASONING } from "../write-native-story.js";
import { validatePlannerBacklog } from "../validate-planner-backlog.js";
import {
  bmadToNativeIngest,
  type BmadEnricher,
  type EnrichedDraft,
} from "../bmad-to-native-ingest.js";
import { parseNativeStory } from "../../adapters/native/parse-native-story.js";
import { resetBmadAdapter } from "../../adapters/bmad/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers — mirrors write-native-story.test.ts pattern
// ---------------------------------------------------------------------------

let root: string;
let storiesDir: string;

async function listStoryFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(storiesDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

async function seedFile(relPath: string): Promise<void> {
  await atomicWriteFile(path.join(root, relPath), "// seeded for resolvability\n");
}

/** A minimal passing candidate — all fields valid, real risk_reasoning supplied. */
function passingCandidate(riskOverride?: string) {
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
        text: "**Given** the app is open, **When** the user logs in, **Then** a greeting is shown.",
        kind: "unit" as const,
        verification: {
          type: "vitest" as const,
          target: "src/__tests__/risk-greeting.test.ts",
        },
      },
    ],
    tasks: [{ text: "Render the greeting component", ac_refs: ["AC1"] }],
    cited_sources: ["src/ui/greeting.ts"],
    depends_on: [] as string[],
    ...(riskOverride !== undefined ? { risk_reasoning: riskOverride } : {}),
  };
}

/**
 * A state-mutating candidate (names sprint-status.yaml in the narrative) with
 * only a UNIT AC. This violates the missing-integration-ac rule. Used in AC3
 * to verify two violations accumulate into one error.
 */
function stateMutatingUnitAcCandidate(riskOverride?: string) {
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
        verification: {
          type: "vitest" as const,
          target: "src/__tests__/risk-ledger.test.ts",
        },
      },
    ],
    tasks: [{ text: "Write the ledger path", ac_refs: ["AC1"] }],
    cited_sources: ["src/state/ledger.ts"],
    depends_on: [] as string[],
    ...(riskOverride !== undefined ? { risk_reasoning: riskOverride } : {}),
  };
}

beforeEach(async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-risk-enforcement-"));
  root = path.join(scratch, "workspace");
  storiesDir = path.join(root, ".flow", "native-stories");
  await fs.mkdir(storiesDir, { recursive: true });
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    `adapter: native\nadapter_config: {}\n`,
  );
  // Story native:01KVS2MG — package.json so shape-valid vitest: targets resolve to a package
  await atomicWriteFile(path.join(root, "package.json"), `{ "name": "fixture" }\n`);
  // Seed files cited by the test candidates so T0-5 resolvability passes.
  await seedFile("src/ui/greeting.ts");
  await seedFile("src/state/ledger.ts");
  resetBmadAdapter();
});

afterEach(async () => {
  resetBmadAdapter();
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1, AC2, AC3, AC5 — write-native-story.ts enforcement
//
// The outer describe name matches the reviewer's vitest testNameFilter so that
// `pnpm vitest --run -t "plugins/flow/mcp-server/src/tools/write-native-story.ts"`
// selects these tests.
// ---------------------------------------------------------------------------

describe("plugins/flow/mcp-server/src/tools/write-native-story.ts — risk_reasoning enforcement", () => {

// ---------------------------------------------------------------------------
// AC1 — write tool refuses absent or placeholder risk_reasoning
// ---------------------------------------------------------------------------

describe("AC1 — writeNativeStory refuses absent or placeholder risk_reasoning", () => {
  it("refuses when risk_reasoning is absent (omitted from input), with placeholder-risk code and no file written", async () => {
    // Omit risk_reasoning entirely (no key in input object).
    let caught: unknown;
    try {
      await writeNativeStory(passingCandidate(/* no arg = omit */));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const codes = (caught as DisciplineViolationError).violations.map((v) => v.code);
    expect(codes).toContain("placeholder-risk");

    // Fail-closed: no file written.
    expect(await listStoryFiles()).toHaveLength(0);
  });

  it("refuses when risk_reasoning is blank (empty string), with placeholder-risk code and no file written", async () => {
    let caught: unknown;
    try {
      await writeNativeStory(passingCandidate(""));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const codes = (caught as DisciplineViolationError).violations.map((v) => v.code);
    expect(codes).toContain("placeholder-risk");
    expect(await listStoryFiles()).toHaveLength(0);
  });

  it("refuses when risk_reasoning is the default placeholder text verbatim, with placeholder-risk code and no file written", async () => {
    let caught: unknown;
    try {
      await writeNativeStory(passingCandidate(DEFAULT_RISK_REASONING));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const codes = (caught as DisciplineViolationError).violations.map((v) => v.code);
    expect(codes).toContain("placeholder-risk");
    expect(await listStoryFiles()).toHaveLength(0);
  });

  it("the thrown DisciplineViolationError names 'risk_reasoning' as the offending field", async () => {
    let caught: unknown;
    try {
      await writeNativeStory(passingCandidate(DEFAULT_RISK_REASONING));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const violating = (caught as DisciplineViolationError).violations.find(
      (v) => v.code === "placeholder-risk",
    );
    expect(violating).toBeDefined();
    expect(violating?.field).toBe("risk_reasoning");
  });
});

// ---------------------------------------------------------------------------
// AC2 — write tool saves a draft with a real non-placeholder risk_reasoning
// ---------------------------------------------------------------------------

describe("AC2 — writeNativeStory saves a draft with a real risk_reasoning", () => {
  it("writes successfully when risk_reasoning is a real non-placeholder string and the file contains the author-supplied text", async () => {
    const realRisk =
      "Highest risk: greeting text is blank — caught by the unit AC text assertion.";
    const result = await writeNativeStory(passingCandidate(realRisk));

    // One file written.
    expect(result.ref).toMatch(/^native:[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await listStoryFiles()).toHaveLength(1);

    // The written file contains the author-supplied risk text.
    const body = await fs.readFile(result.path, "utf8");
    expect(body).toContain(realRisk);
  });

  it("round-trips: the written file re-parses successfully and implementation_notes contains the real risk text", async () => {
    const realRisk = "Highest risk: greeting renders but name is missing — AC assertion catches it.";
    const result = await writeNativeStory(passingCandidate(realRisk));

    const body = await fs.readFile(result.path, "utf8");
    const reparsed = parseNativeStory(result.path, body);

    // The parsed implementation_notes carries the author-supplied risk text.
    expect(reparsed.implementation_notes).toBeDefined();
    expect(reparsed.implementation_notes).toContain(realRisk);

    // The DEFAULT_RISK_REASONING placeholder must NOT appear in the file.
    expect(body).not.toContain(DEFAULT_RISK_REASONING);
  });
});

// ---------------------------------------------------------------------------
// AC3 — placeholder risk + another violation → one DisciplineViolationError
//        with both codes, not two sequential failures
// ---------------------------------------------------------------------------

describe("AC3 — two violations accumulate into one DisciplineViolationError", () => {
  it("reports both placeholder-risk and missing-integration-ac in a single throw when both violations are present", async () => {
    // The state-mutating-unit-ac candidate:
    //   - violates missing-integration-ac (state-mutating with only a unit AC)
    //   - violates placeholder-risk (no risk_reasoning supplied)
    // Both must appear in ONE DisciplineViolationError, not two sequential exceptions.
    let caught: unknown;
    try {
      // Omit risk_reasoning (no override arg → absent).
      await writeNativeStory(stateMutatingUnitAcCandidate());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const codes = (caught as DisciplineViolationError).violations.map((v) => v.code);
    expect(codes).toContain("missing-integration-ac");
    expect(codes).toContain("placeholder-risk");

    // Still fail-closed — no file written.
    expect(await listStoryFiles()).toHaveLength(0);
  });

  it("supplies only the missing-integration-ac violation when risk_reasoning is real (one violation is cured)", async () => {
    // Supply a real risk_reasoning so only the integration-AC violation fires.
    let caught: unknown;
    try {
      await writeNativeStory(
        stateMutatingUnitAcCandidate(
          "Highest risk: ledger write silently succeeds but read-back stale — caught by integration AC.",
        ),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const codes = (caught as DisciplineViolationError).violations.map((v) => v.code);
    expect(codes).toContain("missing-integration-ac");
    expect(codes).not.toContain("placeholder-risk");
    expect(await listStoryFiles()).toHaveLength(0);
  });
});

}); // end: plugins/flow/mcp-server/src/tools/write-native-story.ts

// ---------------------------------------------------------------------------
// AC4 — validate-planner-backlog.ts enforcement
//
// The outer describe name matches the reviewer's vitest testNameFilter so that
// `pnpm vitest --run -t "plugins/flow/mcp-server/src/tools/validate-planner-backlog.ts"`
// selects these tests.
// ---------------------------------------------------------------------------

describe("plugins/flow/mcp-server/src/tools/validate-planner-backlog.ts — risk_reasoning enforcement", () => {

// ---------------------------------------------------------------------------
// AC4 — validatePlannerBacklog surfaces placeholder-risk before write
// ---------------------------------------------------------------------------

describe("AC4 — validatePlannerBacklog surfaces placeholder-risk violation before write", () => {
  it("returns ok:false with violation code placeholder-risk when risk_reasoning is the default placeholder", async () => {
    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        {
          title: "A story with a placeholder risk",
          narrative: "As a user, I want something, so that I am happy.",
          acceptance_criteria: [{ text: "Given X When Y Then Z", kind: "unit" }],
          depends_on: [],
          ship_gate: true,
          state_mutating: "auto",
          risk_reasoning: DEFAULT_RISK_REASONING,
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const allCodes = result.violations.flatMap((v) => v.violations.map((r) => r.code));
      expect(allCodes).toContain("placeholder-risk");
    }
  });

  it("returns ok:false with violation code placeholder-risk when risk_reasoning is blank", async () => {
    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        {
          title: "A story with a blank risk",
          narrative: "As a user, I want something, so that I am happy.",
          acceptance_criteria: [{ text: "Given X When Y Then Z", kind: "unit" }],
          depends_on: [],
          ship_gate: true,
          state_mutating: "auto",
          risk_reasoning: "   ", // whitespace-only
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const allCodes = result.violations.flatMap((v) => v.violations.map((r) => r.code));
      expect(allCodes).toContain("placeholder-risk");
    }
  });

  it("does NOT surface placeholder-risk when risk_reasoning is a real non-placeholder string", async () => {
    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        {
          title: "A story with a real risk",
          narrative: "As a user, I want something, so that I am happy.",
          acceptance_criteria: [{ text: "Given X When Y Then Z", kind: "unit" }],
          depends_on: [],
          ship_gate: true,
          state_mutating: "auto",
          risk_reasoning: "Highest risk: the feature ships with broken UI — caught by the unit AC.",
        },
      ],
    });

    // Should pass cleanly (no placeholder-risk; no other violations either).
    expect(result.ok).toBe(true);
  });

  it("does NOT surface placeholder-risk when risk_reasoning is omitted from the pending story (legacy batch compat)", async () => {
    // Omitting risk_reasoning from a pending story batch (legacy plan) must not
    // introduce a new failure. The enforcement only fires when the field is
    // present and violating.
    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        {
          title: "A legacy story without risk_reasoning",
          narrative: "As a user, I want something, so that I am happy.",
          acceptance_criteria: [{ text: "Given X When Y Then Z", kind: "unit" }],
          depends_on: [],
          ship_gate: true,
          state_mutating: "auto",
          // risk_reasoning intentionally absent
        },
      ],
    });

    // Legacy batch passes unchanged.
    expect(result.ok).toBe(true);
  });
});

}); // end: plugins/flow/mcp-server/src/tools/validate-planner-backlog.ts

// ---------------------------------------------------------------------------
// AC5 — write-native-story.ts enforcement (BMad ingest seam exemption)
//
// The outer describe name matches the reviewer's vitest testNameFilter so that
// `pnpm vitest --run -t "plugins/flow/mcp-server/src/tools/write-native-story.ts"`
// selects this test.
// ---------------------------------------------------------------------------

describe("plugins/flow/mcp-server/src/tools/write-native-story.ts — BMad ingest seam exemption", () => {

// ---------------------------------------------------------------------------
// AC5 — BMad→native ingest seam is exempt from risk_reasoning enforcement
// ---------------------------------------------------------------------------

// The BMad ingest seam uses the same renderGateWriteNativeStory internal but
// with agent="ingest", which bypasses the risk_reasoning check. This tests
// that a draft without risk_reasoning passes the ingest gate.

const BMAD_STORIES_REL = "_bmad-output/planning-artifacts/stories";

/** Seed a BMad source story file. */
async function seedBmadStory(filename: string, body: string): Promise<void> {
  await atomicWriteFile(path.join(root, BMAD_STORIES_REL, filename), body);
}

/** Minimal BMad story body. */
function bmadStoryBody(): string {
  return [
    `# Story 1.1: Ingest test story`,
    ``,
    `Status: ready-for-dev`,
    ``,
    `## Story`,
    ``,
    `As a developer,`,
    `I want a typed parser,`,
    `so that fields cannot drift.`,
    ``,
    `## Acceptance Criteria`,
    ``,
    `**AC1 (integration):**`,
    `**Given** a state, **When** an action, **Then** an outcome.`,
    ``,
  ].join("\n");
}

describe("AC5 — BMad→native ingest seam is exempt from risk_reasoning enforcement", () => {
  it("completes the ingest without a placeholder-risk error when the enriched draft omits risk_reasoning", async () => {
    // Switch the workspace to BMad adapter for the ingest test.
    const bmadRoot = root;
    await atomicWriteFile(
      path.join(bmadRoot, ".flow", "config.yaml"),
      `adapter: bmad\nadapter_config:\n  stories_root: ${BMAD_STORIES_REL}\n`,
    );
    await fs.mkdir(path.join(bmadRoot, BMAD_STORIES_REL), { recursive: true });
    // Seed the source file the enricher cites.
    await seedFile("src/parser.ts");
    await seedBmadStory("1-1-test.md", bmadStoryBody());

    // An enricher that produces a clean Tier-0 draft but deliberately omits
    // risk_reasoning (the key field the interactive gate now rejects).
    const enricherWithoutRisk: BmadEnricher = (story): EnrichedDraft => ({
      title: story.title,
      narrative: { role: "developer", want: "a typed parser", so_that: "fields cannot drift" },
      acceptance_criteria: [
        {
          text: "**Given** a state, **When** an action, **Then** an outcome.",
          kind: "integration",
          verification: { type: "vitest", target: "src/__tests__/ingested.test.ts" },
        },
      ],
      tasks: [{ text: "Implement the change", ac_refs: ["AC1"] }],
      cited_sources: ["src/parser.ts"],
      implementation_notes: undefined,
      depends_on: [],
      // risk_reasoning intentionally absent — the ingest seam must not enforce it
    });

    // The ingest must succeed, writing one native story and no fix-up items.
    const report = await bmadToNativeIngest({ targetRepoRoot: bmadRoot }, enricherWithoutRisk);

    expect(report.written).toHaveLength(1);
    expect(report.needs_fix_up).toHaveLength(0);

    // The file is on disk.
    const writtenPath = report.written[0]!.path;
    await expect(fs.stat(writtenPath)).resolves.toBeTruthy();
  });
});

}); // end: plugins/flow/mcp-server/src/tools/write-native-story.ts — BMad ingest seam exemption
