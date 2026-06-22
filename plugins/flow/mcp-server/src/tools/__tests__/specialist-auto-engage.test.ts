/**
 * Unit tests for `matchStorySpecialist` and `recordSpecialistEngagement`.
 *
 * Story native:01KVPSZ14HH48J9NEH7N6S6QDR — AC2/AC3 unit coverage.
 *
 * matchStorySpecialist:
 *   - Reads cited_sources from the manifest, calls matchSpecialistByCitedSources.
 *   - Returns { role: null, domain: null } on manifest read failure (fail-soft).
 *   - Returns { role: null, domain: null } on empty cited_sources.
 *   - Returns { role, domain } when a specialist matches.
 *
 * recordSpecialistEngagement:
 *   - Throws ManifestNotFoundError when the manifest is not in in-progress/.
 *   - Throws on session mismatch.
 *   - Writes engaged_specialist field and returns { ok: true, ref, specialistRole }.
 *   - Is idempotent: re-writing the same role is valid.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { matchStorySpecialist } from "../match-story-specialist.js";
import { recordSpecialistEngagement } from "../record-specialist-engagement.js";
import { ManifestNotFoundError } from "../../errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-specialist-engage-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a minimal PERSONA.md for a specialist role under team/.
 */
async function seedSpecialist(opts: {
  root: string;
  role: string;
  domain: string;
  pathPatterns: string[];
}): Promise<void> {
  const { root, role, domain, pathPatterns } = opts;
  const roleDir = path.join(root, "team", role);
  await fs.mkdir(roleDir, { recursive: true });

  const patternsYaml =
    pathPatterns.length > 0
      ? ["  path_patterns:", ...pathPatterns.map((p) => `    - '${p}'`)].join("\n")
      : "  path_patterns: []";

  const capBlock = [
    "capabilities:",
    "  review_lenses: []",
    "  run_jobs: []",
    patternsYaml,
  ].join("\n");

  const persona = [
    "---",
    `role: ${role}`,
    `domain: ${domain}`,
    `model_tier: medium`,
    `tools_allow: []`,
    `gh_allow: []`,
    `locked_phrases:`,
    `  handoff: "Handoff to reviewer"`,
    `  verdict: "Verdict:"`,
    capBlock,
    `hired_at: "2026-06-01T00:00:00.000Z"`,
    `catalogue_version: "1.0.0"`,
    "---",
    "",
    `# ${role}`,
    "",
    "## Domain",
    "",
    domain,
    "",
    "## Mandate",
    "",
    "Specialist mandate.",
    "",
    "## Out of mandate",
    "",
    "Nothing excluded.",
    "",
    "## Prompt",
    "",
    "You are a specialist.",
    "",
    "## Knowledge",
    "",
  ].join("\n");

  await atomicWriteFile(path.join(roleDir, "PERSONA.md"), persona);
}

/**
 * Seed a minimal in-progress execution manifest.
 */
async function seedInProgressManifest(opts: {
  root: string;
  ref: string;
  sessionUlid: string;
  citedSources?: string[];
}): Promise<string> {
  const { root, ref, sessionUlid, citedSources = [] } = opts;
  const dir = path.join(root, ".flow", "state", "in-progress");
  await fs.mkdir(dir, { recursive: true });

  const manifest = {
    ref,
    status: "in-progress",
    adapter: "native",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [
      {
        text: "Given a test, When run, Then pass.",
        kind: "unit",
        verification: { type: "vitest", target: "src/tools/__tests__/specialist-auto-engage.test.ts" },
      },
    ],
    title: "Specialist test story",
    narrative: "As a tester, I want to verify specialist engagement.",
    narrative_struct: { role: "tester", want: "specialist engagement", so_that: "tests pass" },
    tasks: [{ text: "Test.", ac_refs: ["AC1"] }],
    cited_sources: citedSources,
    implementation_notes: "Test fixture.",
    withdrawn: false,
    ready: true,
    claimed_by: sessionUlid,
    risk_tier: "medium" as const,
    risk_tier_evidence: { matched_rule: "fallback", paths: [], change_types: [], diff_size: 0 },
  };

  const filePath = path.join(dir, `${ref}.yaml`);
  await atomicWriteFile(filePath, yamlStringify(manifest, { lineWidth: 0 }));
  return filePath;
}

// ---------------------------------------------------------------------------
// matchStorySpecialist
// ---------------------------------------------------------------------------

describe("matchStorySpecialist — Story native:01KVPSZ14HH48J9NEH7N6S6QDR AC2", () => {
  it("returns null role+domain when manifest file does not exist (fail-soft)", async () => {
    const result = await matchStorySpecialist({
      targetRepoRoot: tmpRoot,
      manifestPath: path.join(tmpRoot, "nonexistent", "manifest.yaml"),
    });
    expect(result.role).toBeNull();
    expect(result.domain).toBeNull();
  });

  it("returns null role+domain when manifest YAML is invalid (fail-soft)", async () => {
    const badPath = path.join(tmpRoot, "bad.yaml");
    await atomicWriteFile(badPath, "not: valid: yaml: [[[\n");
    const result = await matchStorySpecialist({
      targetRepoRoot: tmpRoot,
      manifestPath: badPath,
    });
    // Invalid manifest → fail-soft null.
    expect(result.role).toBeNull();
    expect(result.domain).toBeNull();
  });

  it("returns null role+domain when manifest has no cited_sources", async () => {
    const manifestPath = await seedInProgressManifest({
      root: tmpRoot,
      ref: "native:01KVPSZ1TEST00000000000001",
      sessionUlid: "01KVPSZ1SESS000000000001",
      citedSources: [],
    });

    const result = await matchStorySpecialist({
      targetRepoRoot: tmpRoot,
      manifestPath,
    });
    expect(result.role).toBeNull();
    expect(result.domain).toBeNull();
  });

  it("returns null role+domain when no specialist's patterns match the cited sources", async () => {
    await seedSpecialist({
      root: tmpRoot,
      role: "run-loop-specialist",
      domain: "Run loop",
      pathPatterns: ["plugins/flow/workflows/**"],
    });

    const manifestPath = await seedInProgressManifest({
      root: tmpRoot,
      ref: "native:01KVPSZ1TEST00000000000002",
      sessionUlid: "01KVPSZ1SESS000000000002",
      citedSources: [
        "plugins/flow/mcp-server/src/tools/classify-story-lane.ts",
        "plugins/flow/mcp-server/src/tools/lookup-role-by-domain.ts",
      ],
    });

    const result = await matchStorySpecialist({
      targetRepoRoot: tmpRoot,
      manifestPath,
    });
    expect(result.role).toBeNull();
    expect(result.domain).toBeNull();
  });

  it("returns the matching specialist's role and domain when cited sources match", async () => {
    await seedSpecialist({
      root: tmpRoot,
      role: "run-loop-specialist",
      domain: "Run loop",
      pathPatterns: ["plugins/flow/workflows/**"],
    });

    const manifestPath = await seedInProgressManifest({
      root: tmpRoot,
      ref: "native:01KVPSZ1TEST00000000000003",
      sessionUlid: "01KVPSZ1SESS000000000003",
      citedSources: [
        "plugins/flow/workflows/internal/run.workflow.js",
        "plugins/flow/mcp-server/src/tools/classify-story-lane.ts",
      ],
    });

    const result = await matchStorySpecialist({
      targetRepoRoot: tmpRoot,
      manifestPath,
    });
    expect(result.role).toBe("run-loop-specialist");
    expect(result.domain).toBe("Run loop");
  });
});

// ---------------------------------------------------------------------------
// recordSpecialistEngagement
// ---------------------------------------------------------------------------

describe("recordSpecialistEngagement — Story native:01KVPSZ14HH48J9NEH7N6S6QDR AC2", () => {
  const SESSION_ULID = "01KVPSZ1SESS000000000004";
  const REF = "native:01KVPSZ1TEST00000000000004";

  it("throws ManifestNotFoundError when the manifest is not in in-progress/", async () => {
    await expect(
      recordSpecialistEngagement({
        targetRepoRoot: tmpRoot,
        ref: REF,
        sessionUlid: SESSION_ULID,
        specialistRole: "run-loop-specialist",
      }),
    ).rejects.toBeInstanceOf(ManifestNotFoundError);
  });

  it("throws on session mismatch (claimed_by does not match sessionUlid)", async () => {
    await seedInProgressManifest({
      root: tmpRoot,
      ref: REF,
      sessionUlid: "DIFFERENT-SESSION-ULID-00000000",
      citedSources: [],
    });

    await expect(
      recordSpecialistEngagement({
        targetRepoRoot: tmpRoot,
        ref: REF,
        sessionUlid: SESSION_ULID, // wrong session
        specialistRole: "run-loop-specialist",
      }),
    ).rejects.toThrow(/session mismatch/);
  });

  it("writes engaged_specialist and returns { ok: true, ref, specialistRole } on success", async () => {
    await seedInProgressManifest({
      root: tmpRoot,
      ref: REF,
      sessionUlid: SESSION_ULID,
      citedSources: ["plugins/flow/workflows/internal/run.workflow.js"],
    });

    const result = await recordSpecialistEngagement({
      targetRepoRoot: tmpRoot,
      ref: REF,
      sessionUlid: SESSION_ULID,
      specialistRole: "run-loop-specialist",
    });

    expect(result.ok).toBe(true);
    expect(result.ref).toBe(REF);
    expect(result.specialistRole).toBe("run-loop-specialist");

    // Verify the manifest was written with the engaged_specialist field.
    const { parse: yamlParse } = await import("yaml");
    const manifestPath = path.join(
      tmpRoot,
      ".flow",
      "state",
      "in-progress",
      `${REF}.yaml`,
    );
    const rawText = await fs.readFile(manifestPath, "utf8");
    const parsed = yamlParse(rawText) as Record<string, unknown>;
    expect(parsed["engaged_specialist"]).toBe("run-loop-specialist");
  });

  it("is idempotent: re-writing the same role is valid (no error, field unchanged)", async () => {
    await seedInProgressManifest({
      root: tmpRoot,
      ref: "native:01KVPSZ1TEST00000000000005",
      sessionUlid: SESSION_ULID,
      citedSources: [],
    });

    // First write.
    await recordSpecialistEngagement({
      targetRepoRoot: tmpRoot,
      ref: "native:01KVPSZ1TEST00000000000005",
      sessionUlid: SESSION_ULID,
      specialistRole: "run-loop-specialist",
    });

    // Idempotent second write — same role.
    const result = await recordSpecialistEngagement({
      targetRepoRoot: tmpRoot,
      ref: "native:01KVPSZ1TEST00000000000005",
      sessionUlid: SESSION_ULID,
      specialistRole: "run-loop-specialist",
    });

    expect(result.ok).toBe(true);
    expect(result.specialistRole).toBe("run-loop-specialist");
  });
});
