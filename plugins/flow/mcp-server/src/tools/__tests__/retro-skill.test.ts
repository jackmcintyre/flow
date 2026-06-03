/**
 * Story 6.2 AC4 — two-halves test for the `/flow:retro` substrate.
 *
 * Half 1 — Negative-capability allowlist test:
 *   Loads the PRODUCTION `plugins/flow/permissions/retro-analyst.yaml` (no
 *   fixtures, no mocks) and asserts:
 *     (a) `tools_allow` CONTAINS the four read-only / write-bounded affordances
 *         the analyst is meant to have: Read, gatherRetroInputs,
 *         writeRetroProposal, Task.
 *     (b) `tools_allow` DOES NOT contain any tool that mutates canonical state.
 *         Explicit deny-list assertion against the known mutators, plus a regex
 *         catch-all for any future apply* / regenerate* / mutate* / delete* tool.
 *   This is the load-bearing seam — memory `project_reviewer_first_call_enforcement_needed`
 *   shows prose-only mandates get skipped under load; the YAML denial is what
 *   makes FR60 binding. (AC4 half 1)
 *
 * Half 2 — Fixture-cycle gather test:
 *   Seeds a tmp `.flow/` with three done/ manifests (one with lessons populated,
 *   one without lessons, one with `lessons: []`), one telemetry file with three
 *   valid events plus one corrupted line, and two prior proposals. Calls
 *   `gatherRetroInputs` and asserts the returned bundle shape. (AC4 half 2)
 *
 * Both halves are pure deterministic — no LLM invocation, no network.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";
import { loadRolePermissions } from "../../state/load-role-permissions.js";
import { gatherRetroInputs } from "../gather-retro-inputs.js";

// ---------------------------------------------------------------------------
// Resolve the real plugin root from this file's location.
//
// File layout:
//   plugins/flow/                                  <-- PLUGIN_ROOT
//     mcp-server/src/tools/__tests__/             <-- HERE (this file)
//
// dirname(__file__) / .. / .. / .. / ..  →  plugins/flow/
// (same pattern as load-role-permissions.test.ts / getPluginRoot()).
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_PLUGIN_ROOT = path.resolve(HERE, "..", "..", "..", "..");

// ---------------------------------------------------------------------------
// Half 1: Negative-capability allowlist test (AC4 half 1).
// ---------------------------------------------------------------------------

describe("retro-analyst permission allowlist — negative-capability seam (AC4)", () => {
  // Tools the analyst MUST be able to call: read the bundle (Read +
  // gatherRetroInputs), spawn deeper-read child Tasks (Task), and write the
  // single proposal (writeRetroProposal).
  const REQUIRED_TOOLS = ["Read", "gatherRetroInputs", "writeRetroProposal", "Task"];

  // Tools that mutate canonical state — the analyst MUST NOT be able to call
  // any of these. Edit/Write are the generic file mutators; the rest are the
  // state-mutating MCP tools.
  const FORBIDDEN_TOOLS = [
    "Edit",
    "Write",
    "writeNativeStory",
    "claimStory",
    "completeStory",
    "recordStoryRetro",
    "markWithdrawn",
    "scanSources",
  ];

  // Any future apply* / regenerate* / mutate* / delete* tool name is a mutator
  // by convention — deny it pre-emptively so a later story can't widen the
  // surface by accident.
  const MUTATOR_NAME_REGEX = /^(apply|regenerate|mutate|delete)[A-Z]/;

  it("contains the four read-only / write-bounded affordances", async () => {
    const perms = await loadRolePermissions({
      role: "retro-analyst",
      pluginRoot: REAL_PLUGIN_ROOT,
    });
    for (const tool of REQUIRED_TOOLS) {
      expect(perms.tools_allow, `tools_allow should contain ${tool}`).toContain(
        tool,
      );
    }
  });

  it("does not contain any canonical-state mutator", async () => {
    const perms = await loadRolePermissions({
      role: "retro-analyst",
      pluginRoot: REAL_PLUGIN_ROOT,
    });
    for (const tool of FORBIDDEN_TOOLS) {
      expect(
        perms.tools_allow,
        `tools_allow must NOT contain mutator ${tool}`,
      ).not.toContain(tool);
    }
  });

  it("does not contain any apply*/regenerate*/mutate*/delete* tool name", async () => {
    const perms = await loadRolePermissions({
      role: "retro-analyst",
      pluginRoot: REAL_PLUGIN_ROOT,
    });
    const offenders = perms.tools_allow.filter((t) =>
      MUTATOR_NAME_REGEX.test(t),
    );
    expect(
      offenders,
      `tools_allow must not match the mutator-name pattern; saw: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("writeRetroProposal is the only write affordance (no Edit/Write)", async () => {
    const perms = await loadRolePermissions({
      role: "retro-analyst",
      pluginRoot: REAL_PLUGIN_ROOT,
    });
    expect(perms.tools_allow).toContain("writeRetroProposal");
    expect(perms.tools_allow).not.toContain("Edit");
    expect(perms.tools_allow).not.toContain("Write");
  });
});

// ---------------------------------------------------------------------------
// Half 2: Fixture-cycle gather test (AC4 half 2).
// ---------------------------------------------------------------------------

describe("gatherRetroInputs — fixture cycle bundle (AC4)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-gather-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Build a minimal valid done/ manifest (ExecutionManifestSchema). The
   * `retro` argument lets the caller layer in `lessons` / `failure_class`.
   */
  function buildDoneManifest(
    ref: string,
    retro: { lessons?: unknown[] } = {},
  ): Record<string, unknown> {
    return {
      ref,
      status: "done",
      adapter: "bmad",
      source_path: `_bmad-output/implementation-artifacts/${ref.replace(":", "-")}.md`,
      source_hash: "a".repeat(64),
      depends_on: [],
      acceptance_criteria: [{ text: "an AC", kind: "unit" }],
      title: `Story ${ref}`,
      narrative: "As a user, I want X, so that Y.",
      withdrawn: false,
      claimed_by: "01KSRP1Y9J9R9F5SKB7QXQ83ZK",
      ...retro,
    };
  }

  async function writeYaml(absPath: string, obj: unknown): Promise<void> {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, yamlStringify(obj), "utf8");
  }

  it("assembles the typed bundle from a seeded cycle", async () => {
    const doneDir = path.join(tmpRoot, ".flow", "state", "done");
    const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
    const proposalsDir = path.join(tmpRoot, ".flow", "retro-proposals");

    // Three done/ manifests:
    //  - one with lessons[] populated (per 6.1's LessonSchema shape)
    //  - one with no lessons key at all
    //  - one with lessons: [] (empty)
    await writeYaml(
      path.join(doneDir, "bmad:1.1.yaml"),
      buildDoneManifest("bmad:1.1", {
        lessons: [
          { kind: "pitfall", text: "watch the parser", failure_class: "parse-drift" },
          { kind: "pattern", text: "use the tool seam" },
        ],
      }),
    );
    await writeYaml(
      path.join(doneDir, "bmad:1.2.yaml"),
      buildDoneManifest("bmad:1.2"),
    );
    await writeYaml(
      path.join(doneDir, "bmad:1.3.yaml"),
      buildDoneManifest("bmad:1.3", { lessons: [] }),
    );

    // One telemetry file: three valid agent.invoke events + one corrupt line.
    const validEvent = (story: string) =>
      JSON.stringify({
        ts: "2026-05-01T12:00:00.000Z",
        session_id: "01KSRP1Y9J9R9F5SKB7QXQ83ZK",
        agent: "generalist-dev",
        story_id: story,
        type: "agent.invoke",
        data: { runtime_ms: 1200 },
      });
    const telemetryContents =
      [
        validEvent("bmad:1.1"),
        validEvent("bmad:1.2"),
        "{ this is not valid json", // corrupt line — skipped + counted
        validEvent("bmad:1.3"),
      ].join("\n") + "\n";
    await fs.mkdir(telemetryDir, { recursive: true });
    await fs.writeFile(
      path.join(telemetryDir, "2026-05.jsonl"),
      telemetryContents,
      "utf8",
    );

    // Two prior proposals (contents irrelevant — only path + iso_timestamp).
    await fs.mkdir(proposalsDir, { recursive: true });
    await fs.writeFile(
      path.join(proposalsDir, "2026-04-01T00:00:00.000Z.md"),
      "# earlier proposal\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(proposalsDir, "2026-04-15T00:00:00.000Z.md"),
      "# later proposal\n",
      "utf8",
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // Assertions per AC4 half 2.
    expect(bundle.doneManifests.length).toBe(3);
    expect(bundle.telemetrySummary.events.length).toBe(3);
    expect(bundle.telemetrySummary.skipped_count).toBe(1);
    expect(bundle.priorProposals.length).toBe(2);
    expect(bundle.ruleRegistry).toBe(null);

    // Sanity: done manifests are in alphabetical ref order.
    expect(bundle.doneManifests.map((m) => m.ref)).toEqual([
      "bmad:1.1",
      "bmad:1.2",
      "bmad:1.3",
    ]);

    // Sanity: prior proposals sorted by iso_timestamp ascending.
    expect(bundle.priorProposals.map((p) => p.iso_timestamp)).toEqual([
      "2026-04-01T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
    ]);
  });

  it("returns ruleRegistry parsed when docs/discipline-rules.yaml is present", async () => {
    // Absence is the 6a-phase default (asserted above); when the registry
    // exists (6.5+) it is parsed via the validated, comment-preserving parser
    // (parseRuleRegistry). The registry must satisfy DisciplineRuleSchema —
    // a malformed one raises RuleRegistryMalformedError (asserted below).
    const validRule = {
      id: "01HZRETR0000000000000000A1",
      text: "no hand-written stories",
      target_failure_class: "handwritten-story",
      introduced_at: "2026-05-20T10:00:00.000Z",
      level: "must",
    };
    await writeYaml(path.join(tmpRoot, "docs", "discipline-rules.yaml"), {
      rules: [validRule],
    });

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.ruleRegistry).toEqual({ rules: [validRule] });
  });

  it("propagates RuleRegistryMalformedError when the registry is malformed (Story 6.5)", async () => {
    // A rule missing required fields is a hard stop — the validated parser
    // refuses it rather than handing the analyst a half-shaped registry.
    await writeYaml(path.join(tmpRoot, "docs", "discipline-rules.yaml"), {
      rules: [{ id: "r1", text: "missing required fields" }],
    });
    await expect(
      gatherRetroInputs({ targetRepoRoot: tmpRoot }),
    ).rejects.toMatchObject({ name: "RuleRegistryMalformedError" });
  });

  it("returns an empty bundle when no .flow dirs exist (absence is not an error)", async () => {
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.doneManifests).toEqual([]);
    expect(bundle.telemetrySummary.events).toEqual([]);
    expect(bundle.telemetrySummary.skipped_count).toBe(0);
    expect(bundle.priorProposals).toEqual([]);
    expect(bundle.ruleRegistry).toBe(null);
  });
});
