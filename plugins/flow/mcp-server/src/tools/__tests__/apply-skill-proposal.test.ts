/**
 * `skill-*` apply-handler tests — Story 6.7 AC1–AC5.
 *
 * AC1–AC4 drive each handler directly (via `createSkillProposalHandlers`) with
 * a deterministic clock seam, against a tmp `.crew/skills/` tree, asserting the
 * file effects + the typed errors with no mutation on the failure paths.
 *
 * AC5 drives the REAL `acceptProposal` gate (no injected handlers — the
 * production registry now carries the four `skill-*` handlers) through preview +
 * confirm for `skill-create` and `skill-revise`, injecting only the git seam,
 * and asserts the preview-no-op, the single combined commit, the applied stamp,
 * one telemetry event, and the idempotent re-accept.
 *
 * Test conventions mirror `accept-proposal.test.ts`: tmpRoot, seed proposals via
 * `writeRetroProposal`, inject the git seam, read telemetry from
 * `.flow/telemetry/*.jsonl`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import {
  SkillAlreadyExistsError,
  SkillNotFoundError,
} from "../../errors.js";
import {
  bumpVersion,
  createSkillProposalHandlers,
} from "../../lib/apply-skill-proposal.js";
import { SkillFrontmatterSchema } from "../../schemas/skill-frontmatter.js";
import {
  createProductionRegistry,
  type HandlerContext,
} from "../../lib/proposal-apply-registry.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { acceptProposal } from "../accept-proposal.js";
import { parseRetroProposalFile } from "../../schemas/retro-proposal.js";
import type { gitCommit as gitCommitType } from "../../lib/git.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ULID_CREATE = "01KSYQGHBK09MZZC93J90QZEDQ";
const ULID_REVISE = "01KSYQGHBNYV724V435F5D0FEE";
const ULID_SUPER = "01KSYQGHBNE7AYBJW1BGQK39ST";
const ULID_RETIRE = "01KSYQGHBNDHXQQ564455JYE9P";

const ISO = "2026-05-31T09:00:00.000Z";
const FIXED_NOW = new Date("2026-05-31T10:00:00.000Z");
const FIXED_NOW_ISO = FIXED_NOW.toISOString();

const SKILL_REL = ".crew/skills/foo.md";
const REPLACEMENT_REL = ".crew/skills/foo-v2.md";

function ctxOf(targetRepoRoot: string): HandlerContext {
  return { targetRepoRoot, role: "operator" };
}

function handlersByType(now: () => Date) {
  const map = new Map(
    createSkillProposalHandlers({ now }).map((h) => [h.type, h] as const),
  );
  return map;
}

/**
 * Seed a `0.1.0` skill file at `<root>/.flow/skills/foo.md` (with a
 * `.history/`-shaped sibling so retire/supersede preservation is observable).
 */
async function seedSkill(
  root: string,
  opts: { relPath?: string; version?: string; body?: string } = {},
): Promise<void> {
  const relPath = opts.relPath ?? SKILL_REL;
  const version = opts.version ?? "0.1.0";
  const body = opts.body ?? "# Foo skill\n\nDo the foo thing.";
  const frontmatter = [
    "---",
    "name: foo",
    "description: The foo skill",
    "allowed_tools: []",
    `version: ${version}`,
    "introduced_at: 2026-01-01T00:00:00.000Z",
    "source_lesson_refs: []",
    "---",
    "",
  ].join("\n");
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${frontmatter}${body}\n`, "utf8");
}

async function readSkill(root: string, relPath: string) {
  const abs = path.join(root, relPath);
  const raw = await fs.readFile(abs, "utf8");
  const rest = raw.slice("---\n".length);
  const closeIdx = rest.indexOf("\n---");
  const fmRaw = rest.slice(0, closeIdx + 1);
  const body = rest
    .slice(closeIdx + "\n---".length)
    .replace(/^\s*\n/, "")
    .replace(/\n+$/, "");
  const frontmatter = SkillFrontmatterSchema.parse(yamlParse(fmRaw));
  return { raw, frontmatter, body };
}

async function exists(absOrRoot: string, rel?: string): Promise<boolean> {
  const p = rel === undefined ? absOrRoot : path.join(absOrRoot, rel);
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tmpdir lifecycle
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-skill-"));
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

// ---------------------------------------------------------------------------
// bumpVersion — pure helper (supports AC2's deterministic version assertion)
// ---------------------------------------------------------------------------

describe("bumpVersion", () => {
  it("patch bumps the z component", () => {
    expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(bumpVersion("1.2.9", "patch")).toBe("1.2.10");
  });
  it("minor bumps y and resets z", () => {
    expect(bumpVersion("0.1.5", "minor")).toBe("0.2.0");
    expect(bumpVersion("3.4.7", "minor")).toBe("3.5.0");
  });
});

// ---------------------------------------------------------------------------
// AC1 — skill-create
// ---------------------------------------------------------------------------

describe("skill-create handler (AC1)", () => {
  function createProposal() {
    return {
      type: "skill-create" as const,
      id: ULID_CREATE,
      created_at: ISO,
      rationale: "Codify the repeatable foo success.",
      proposed_path: SKILL_REL,
      frontmatter_description: "The foo skill",
      body: "# Foo\n\nAlways foo before bar.",
    };
  }

  it("writes a new skill file with all frontmatter fields, schema-valid", async () => {
    const handler = handlersByType(() => FIXED_NOW).get("skill-create")!;
    const result = await handler.apply(createProposal(), ctxOf(tmpRoot));

    expect(result.changedPaths).toEqual([SKILL_REL]);
    expect(await exists(tmpRoot, SKILL_REL)).toBe(true);

    const { frontmatter, body } = await readSkill(tmpRoot, SKILL_REL);
    // Schema validation (also implicit in readSkill via .parse).
    expect(() => SkillFrontmatterSchema.parse(frontmatter)).not.toThrow();
    expect(frontmatter.name).toBe("foo");
    expect(frontmatter.description).toBe("The foo skill");
    expect(frontmatter.allowed_tools).toEqual([]);
    expect(frontmatter.version).toBe("0.1.0");
    expect(frontmatter.introduced_at).toBe(FIXED_NOW_ISO);
    expect(frontmatter.source_lesson_refs).toEqual([]);
    expect(frontmatter.supersedes).toBeUndefined();
    expect(frontmatter.retired_at).toBeUndefined();
    expect(body).toBe("# Foo\n\nAlways foo before bar.");
  });

  it("preview renders a diff without writing", async () => {
    const handler = handlersByType(() => FIXED_NOW).get("skill-create")!;
    const diff = await handler.previewDiff(createProposal(), ctxOf(tmpRoot));
    expect(diff).toContain("Create skill");
    expect(diff).toContain("version: 0.1.0");
    expect(await exists(tmpRoot, SKILL_REL)).toBe(false);
  });

  it("a second create at the same path raises SkillAlreadyExistsError with no mutation", async () => {
    const handler = handlersByType(() => FIXED_NOW).get("skill-create")!;
    await handler.apply(createProposal(), ctxOf(tmpRoot));
    const before = await readSkill(tmpRoot, SKILL_REL);

    await expect(
      handler.apply(
        { ...createProposal(), body: "DIFFERENT BODY" },
        ctxOf(tmpRoot),
      ),
    ).rejects.toBeInstanceOf(SkillAlreadyExistsError);

    // No overwrite — bytes unchanged.
    const after = await readSkill(tmpRoot, SKILL_REL);
    expect(after.raw).toBe(before.raw);
  });
});

// ---------------------------------------------------------------------------
// AC2 — skill-revise
// ---------------------------------------------------------------------------

describe("skill-revise handler (AC2)", () => {
  function reviseProposal(bump: "patch" | "minor" = "minor") {
    return {
      type: "skill-revise" as const,
      id: ULID_REVISE,
      created_at: ISO,
      rationale: "Tighten the foo guidance.",
      target_skill_path: SKILL_REL,
      revised_body: "# Foo (revised)\n\nFoo, then verify.",
      version_bump: bump,
    };
  }

  it("archives the prior body, bumps the version, replaces the body", async () => {
    await seedSkill(tmpRoot, { version: "0.1.0", body: "# Foo\n\nOriginal." });
    const handler = handlersByType(() => FIXED_NOW).get("skill-revise")!;

    const result = await handler.apply(reviseProposal("minor"), ctxOf(tmpRoot));

    const historyRel = `${SKILL_REL}.history/0.1.0.md`;
    expect(result.changedPaths).toEqual([SKILL_REL, historyRel]);

    // Prior body archived at <skill>.history/0.1.0.md.
    const archived = await readSkill(tmpRoot, historyRel);
    expect(archived.body).toBe("# Foo\n\nOriginal.");
    expect(archived.frontmatter.version).toBe("0.1.0");

    // New version per the bump rule; body replaced; frontmatter preserved.
    const live = await readSkill(tmpRoot, SKILL_REL);
    expect(live.frontmatter.version).toBe("0.2.0");
    expect(live.frontmatter.name).toBe("foo");
    expect(live.frontmatter.introduced_at).toBe("2026-01-01T00:00:00.000Z");
    expect(live.body).toBe("# Foo (revised)\n\nFoo, then verify.");
  });

  it("patch bump produces x.y.(z+1)", async () => {
    await seedSkill(tmpRoot, { version: "0.1.0" });
    const handler = handlersByType(() => FIXED_NOW).get("skill-revise")!;
    await handler.apply(reviseProposal("patch"), ctxOf(tmpRoot));
    const live = await readSkill(tmpRoot, SKILL_REL);
    expect(live.frontmatter.version).toBe("0.1.1");
  });

  it("a revise targeting a non-existent skill raises SkillNotFoundError with no mutation", async () => {
    const handler = handlersByType(() => FIXED_NOW).get("skill-revise")!;
    await expect(
      handler.apply(reviseProposal(), ctxOf(tmpRoot)),
    ).rejects.toBeInstanceOf(SkillNotFoundError);
    // Nothing written.
    expect(await exists(tmpRoot, SKILL_REL)).toBe(false);
    expect(await exists(tmpRoot, `${SKILL_REL}.history`)).toBe(false);
  });

  it("history archive name derives from the PRIOR version across two revises", async () => {
    await seedSkill(tmpRoot, { version: "0.1.0", body: "v0.1.0 body" });
    const handler = handlersByType(() => FIXED_NOW).get("skill-revise")!;
    await handler.apply(
      { ...reviseProposal("minor"), revised_body: "v0.2.0 body" },
      ctxOf(tmpRoot),
    );
    await handler.apply(
      { ...reviseProposal("minor"), revised_body: "v0.3.0 body" },
      ctxOf(tmpRoot),
    );
    // Both prior versions archived under distinct names (no clobber).
    expect(
      (await readSkill(tmpRoot, `${SKILL_REL}.history/0.1.0.md`)).body,
    ).toBe("v0.1.0 body");
    expect(
      (await readSkill(tmpRoot, `${SKILL_REL}.history/0.2.0.md`)).body,
    ).toBe("v0.2.0 body");
    expect((await readSkill(tmpRoot, SKILL_REL)).frontmatter.version).toBe(
      "0.3.0",
    );
  });
});

// ---------------------------------------------------------------------------
// AC3 — skill-supersede
// ---------------------------------------------------------------------------

describe("skill-supersede handler (AC3)", () => {
  function supersedeProposal() {
    return {
      type: "skill-supersede" as const,
      id: ULID_SUPER,
      created_at: ISO,
      rationale: "The foo skill is replaced by foo-v2.",
      superseded_skill_path: SKILL_REL,
      replacement: {
        proposed_path: REPLACEMENT_REL,
        frontmatter_description: "The foo-v2 skill",
        body: "# Foo v2\n\nThe better foo.",
      },
    };
  }

  it("writes the replacement (with supersedes:) and archives the superseded skill (retired_at)", async () => {
    await seedSkill(tmpRoot, { version: "0.1.0", body: "# Foo\n\nOld." });
    const handler = handlersByType(() => FIXED_NOW).get("skill-supersede")!;

    const result = await handler.apply(supersedeProposal(), ctxOf(tmpRoot));

    const archiveRel = ".crew/skills/_archived/foo.md";
    expect(result.changedPaths).toEqual([
      REPLACEMENT_REL,
      archiveRel,
      SKILL_REL,
    ]);

    // Replacement exists with supersedes: set.
    const replacement = await readSkill(tmpRoot, REPLACEMENT_REL);
    expect(replacement.frontmatter.name).toBe("foo-v2");
    expect(replacement.frontmatter.supersedes).toBe(SKILL_REL);
    expect(replacement.frontmatter.version).toBe("0.1.0");
    expect(replacement.body).toBe("# Foo v2\n\nThe better foo.");

    // Superseded skill archived with retired_at; gone from the live path.
    expect(await exists(tmpRoot, SKILL_REL)).toBe(false);
    const archived = await readSkill(tmpRoot, archiveRel);
    expect(archived.frontmatter.retired_at).toBe(FIXED_NOW_ISO);
    expect(archived.body).toBe("# Foo\n\nOld.");
  });

  it("a supersede of a missing skill raises SkillNotFoundError, writing no replacement", async () => {
    const handler = handlersByType(() => FIXED_NOW).get("skill-supersede")!;
    await expect(
      handler.apply(supersedeProposal(), ctxOf(tmpRoot)),
    ).rejects.toBeInstanceOf(SkillNotFoundError);
    // No replacement written (the missing-target check runs first).
    expect(await exists(tmpRoot, REPLACEMENT_REL)).toBe(false);
  });

  it("a replacement-path collision raises SkillAlreadyExistsError, leaving the superseded skill intact", async () => {
    await seedSkill(tmpRoot, { version: "0.1.0" });
    await seedSkill(tmpRoot, { relPath: REPLACEMENT_REL, version: "0.5.0" });
    const handler = handlersByType(() => FIXED_NOW).get("skill-supersede")!;
    await expect(
      handler.apply(supersedeProposal(), ctxOf(tmpRoot)),
    ).rejects.toBeInstanceOf(SkillAlreadyExistsError);
    // Superseded skill still live (archive half never ran).
    expect(await exists(tmpRoot, SKILL_REL)).toBe(true);
    expect(await exists(tmpRoot, ".crew/skills/_archived/foo.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — skill-retire
// ---------------------------------------------------------------------------

describe("skill-retire handler (AC4)", () => {
  function retireProposal() {
    return {
      type: "skill-retire" as const,
      id: ULID_RETIRE,
      created_at: ISO,
      rationale: "The foo skill never fires.",
      target_skill_path: SKILL_REL,
      last_invoked_at: null,
    };
  }

  it("moves the skill to _archived/ with retired_at, preserving history, gone from live", async () => {
    await seedSkill(tmpRoot, { version: "0.2.0", body: "# Foo\n\nRetire me." });
    // Seed a history file so we can assert it is preserved.
    const historyRel = `${SKILL_REL}.history/0.1.0.md`;
    const historyAbs = path.join(tmpRoot, historyRel);
    await fs.mkdir(path.dirname(historyAbs), { recursive: true });
    await fs.writeFile(historyAbs, "prior body\n", "utf8");

    const handler = handlersByType(() => FIXED_NOW).get("skill-retire")!;
    const result = await handler.apply(retireProposal(), ctxOf(tmpRoot));

    const archiveRel = ".crew/skills/_archived/foo.md";
    expect(result.changedPaths).toEqual([archiveRel, SKILL_REL]);

    // Gone from the live path.
    expect(await exists(tmpRoot, SKILL_REL)).toBe(false);

    // Present under _archived/ with retired_at.
    const archived = await readSkill(tmpRoot, archiveRel);
    expect(archived.frontmatter.retired_at).toBe(FIXED_NOW_ISO);
    expect(archived.frontmatter.version).toBe("0.2.0");
    expect(archived.body).toBe("# Foo\n\nRetire me.");

    // History preserved (not deleted).
    expect(await exists(tmpRoot, historyRel)).toBe(true);
  });

  it("a retire of a missing skill raises SkillNotFoundError with no mutation", async () => {
    const handler = handlersByType(() => FIXED_NOW).get("skill-retire")!;
    await expect(
      handler.apply(retireProposal(), ctxOf(tmpRoot)),
    ).rejects.toBeInstanceOf(SkillNotFoundError);
    expect(await exists(tmpRoot, ".crew/skills/_archived/foo.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC5 — the production gate (real registry, only the git seam injected)
// ---------------------------------------------------------------------------

function makeFakeGitCommit(sha = "5c111face0000000000000000000000000000000") {
  const calls: Array<{ paths: readonly string[]; message: string }> = [];
  const impl = (async (args: {
    paths: readonly string[];
    message: string;
  }) => {
    calls.push({ paths: args.paths, message: args.message });
    return { commitSha: sha, stdout: "", stderr: "" };
  }) as unknown as typeof gitCommitType;
  return { impl, calls };
}

async function readTelemetryEvents(
  root: string,
): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(root, ".flow", "telemetry");
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const events: Array<Record<string, unknown>> = [];
  for (const f of files.filter((x) => x.endsWith(".jsonl")).sort()) {
    const raw = await fs.readFile(path.join(dir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      events.push(JSON.parse(line));
    }
  }
  return events;
}

async function readProposalFile(root: string, iso: string) {
  const abs = path.join(root, ".flow", "retro-proposals", `${iso}.md`);
  const raw = await fs.readFile(abs, "utf8");
  const rest = raw.slice("---\n".length);
  const closeIdx = rest.indexOf("\n---\n");
  const frontmatter = rest.slice(0, closeIdx + 1);
  const file = parseRetroProposalFile(yamlParse(frontmatter));
  return { raw, file };
}

describe("acceptProposal production gate — skill-create end-to-end (AC5)", () => {
  it("preview is a no-op; confirm applies + commits both paths + stamps + one event; re-accept no-ops", async () => {
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "skill-create",
          id: ULID_CREATE,
          created_at: ISO,
          rationale: "Codify foo.",
          proposed_path: SKILL_REL,
          frontmatter_description: "The foo skill",
          body: "# Foo\n\nAlways foo.",
        },
      ],
    });
    const git = makeFakeGitCommit("aa00bb11cc22dd33ee44ff5566778899aabbccdd");

    // Preview — production registry (no handlers injection).
    const preview = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_CREATE,
      gitCommitImpl: git.impl,
      now: () => FIXED_NOW,
    });
    expect(preview.status).toBe("preview");
    expect(git.calls).toHaveLength(0);
    expect(await exists(tmpRoot, SKILL_REL)).toBe(false);
    expect(await readTelemetryEvents(tmpRoot)).toHaveLength(0);

    // Confirm.
    const applied = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_CREATE,
      confirm: true,
      gitCommitImpl: git.impl,
      now: () => FIXED_NOW,
    });
    expect(applied.status).toBe("applied");

    // Skill file written.
    expect(await exists(tmpRoot, SKILL_REL)).toBe(true);

    // Exactly one commit carrying BOTH the skill file and the proposal file.
    expect(git.calls).toHaveLength(1);
    const committed = git.calls[0]!;
    expect(committed.paths).toContain(SKILL_REL);
    expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(true);

    // Proposal stamped applied.
    const after = await readProposalFile(tmpRoot, ISO);
    expect(after.file.proposals[0]!.applied).toBeDefined();
    expect(after.file.proposals[0]!.applied!.applied_sha).toBe(
      "aa00bb11cc22dd33ee44ff5566778899aabbccdd",
    );

    // Exactly one telemetry event.
    const events = await readTelemetryEvents(tmpRoot);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("retro.proposal.applied");
    expect(events[0]!.data).toMatchObject({
      id: ULID_CREATE,
      proposal_type: "skill-create",
    });

    // Idempotent re-accept — no second write, commit, or telemetry.
    const reAccept = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_CREATE,
      confirm: true,
      gitCommitImpl: git.impl,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(reAccept.status).toBe("already-applied");
    expect(git.calls).toHaveLength(1);
    expect(await readTelemetryEvents(tmpRoot)).toHaveLength(1);
  });
});

describe("acceptProposal production gate — skill-revise end-to-end (AC5)", () => {
  it("applies a revise through the real registry, committing skill + history + proposal", async () => {
    await seedSkill(tmpRoot, { version: "0.1.0", body: "# Foo\n\nv1." });
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "skill-revise",
          id: ULID_REVISE,
          created_at: ISO,
          rationale: "Improve foo.",
          target_skill_path: SKILL_REL,
          revised_body: "# Foo\n\nv2 — better.",
          version_bump: "minor",
        },
      ],
    });
    const git = makeFakeGitCommit("bb11cc22dd33ee44ff5566778899aabbccdd0011");

    const applied = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_REVISE,
      confirm: true,
      gitCommitImpl: git.impl,
      now: () => FIXED_NOW,
    });
    expect(applied.status).toBe("applied");

    // One commit carrying skill file + history file + proposal file.
    expect(git.calls).toHaveLength(1);
    const committed = git.calls[0]!;
    expect(committed.paths).toContain(SKILL_REL);
    expect(committed.paths).toContain(`${SKILL_REL}.history/0.1.0.md`);
    expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(true);

    // Skill bumped + body replaced; prior archived.
    const live = await readSkill(tmpRoot, SKILL_REL);
    expect(live.frontmatter.version).toBe("0.2.0");
    expect(live.body).toBe("# Foo\n\nv2 — better.");
    expect(
      (await readSkill(tmpRoot, `${SKILL_REL}.history/0.1.0.md`)).body,
    ).toBe("# Foo\n\nv1.");
  });
});

// ---------------------------------------------------------------------------
// AC6 — registration: all four kinds resolve to a real handler
// ---------------------------------------------------------------------------

describe("createProductionRegistry registers the four skill-* handlers (AC6)", () => {
  it("each skill-* kind resolves to a handler (none fails closed)", () => {
    const registry = createProductionRegistry();
    for (const kind of [
      "skill-create",
      "skill-revise",
      "skill-supersede",
      "skill-retire",
    ] as const) {
      const handler = registry.get(kind);
      expect(handler, `${kind} must resolve to a handler`).toBeDefined();
      expect(handler!.type).toBe(kind);
    }
  });
});
