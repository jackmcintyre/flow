/**
 * The four `skill-*` apply handlers — Story 6.7.
 *
 * Registers `skill-create`, `skill-revise`, `skill-supersede`, and
 * `skill-retire` into the Story 6.4 diff-then-confirm gate. Accepting a skill
 * proposal writes, replaces, supersedes, or archives a project-scope skill file
 * under `<target-repo>/.flow/skills/` — the **constructive twin** of the rule
 * work (Stories 6.5/6.5b).
 *
 * Each handler implements `ProposalApplyHandler` for its `type`:
 *  - `previewDiff` — renders a human-readable before/after; NO write, NO commit.
 *  - `apply` — performs the file effect(s) via `writeManagedFile` (skill files
 *    live under `.crew/skills/**`, made canonical in Story 6.7), returns the
 *    repo-relative `changedPaths`; NO commit (the gate commits).
 *
 * **Scope (Story 6.7).** This is purely the apply surface. It does NOT build
 * `skill.invoke` telemetry or effectiveness measurement (Story 6.8) — the skill
 * files written here are inert until 6.8 measures their use.
 *
 * **`skill-supersede` is one atomic proposal.** The shipped 6.3 schema models
 * supersede as a SINGLE proposal carrying an embedded `replacement` (not a pair
 * of independently-acceptable halves). One accept applies both halves
 * atomically: write the replacement, then archive the superseded skill. If
 * either half throws, the gate commits nothing (it only commits on a clean
 * apply return) — the effects are ordered (replacement write first, archive
 * second) so a throw never leaves a committed half-applied state.
 *
 * (Story 6.7 — FR63, Architecture §Skill calibration loop)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { SkillAlreadyExistsError, SkillNotFoundError } from "../errors.js";
import { writeManagedFile } from "./managed-fs.js";
import { splitFrontmatter } from "./markdown-frontmatter.js";
import {
  SkillFrontmatterSchema,
  type SkillFrontmatter,
} from "../schemas/skill-frontmatter.js";
import type {
  HandlerContext,
  ProposalApplyHandler,
  ProposalApplyResult,
} from "./proposal-apply-registry.js";
import type { RetroProposal } from "../schemas/retro-proposal.js";

const ACCEPT_TOOL_NAME = "acceptProposal";

// ---------------------------------------------------------------------------
// Pure helpers — version bump, name derivation, frontmatter render/read
// ---------------------------------------------------------------------------

/**
 * Bump a semver `x.y.z` per the `version_bump` rule:
 *   - `patch` → `x.y.(z+1)`
 *   - `minor` → `x.(y+1).0`
 *
 * Pure so AC2 can assert it deterministically. Throws on a non-semver input
 * (the frontmatter schema guarantees the shape, but the helper is defensive).
 */
export function bumpVersion(
  version: string,
  bump: "patch" | "minor",
): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) {
    throw new Error(`bumpVersion: '${version}' is not semver 'x.y.z'`);
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  return `${major}.${minor + 1}.0`;
}

/**
 * Derive a skill's `name` from its repo-relative path: the basename minus the
 * `.md` extension. `.crew/skills/foo.md` → `foo`.
 */
function skillNameFromPath(relPath: string): string {
  return path.basename(relPath, ".md");
}

/** Repo-relative POSIX path for a path under `targetRepoRoot`. */
function relPosix(targetRepoRoot: string, absPath: string): string {
  return path.relative(targetRepoRoot, absPath).split(path.sep).join("/");
}

/**
 * Render a skill file's bytes from validated frontmatter and a body. The
 * frontmatter is the source of truth; `yaml.stringify({ lineWidth: 0 })`
 * matches the byte-stable convention used across the codebase (skill files are
 * derived/managed — comment preservation is not required, unlike the
 * hand-annotated rule registry).
 */
function renderSkillFile(frontmatter: SkillFrontmatter, body: string): string {
  const fm = yamlStringify(frontmatter, { lineWidth: 0 });
  const trimmedBody = body.replace(/\n+$/, "");
  return `---\n${fm}---\n\n${trimmedBody}\n`;
}

/**
 * Read + parse an existing skill file at `absPath`. Returns the validated
 * frontmatter and the body. Throws `SkillNotFoundError` when the file is
 * absent; propagates the schema/frontmatter-split errors otherwise.
 */
async function readSkillFile(
  absPath: string,
  relPath: string,
): Promise<{ frontmatter: SkillFrontmatter; body: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      throw new SkillNotFoundError({ skillPath: relPath });
    }
    throw err;
  }
  const { frontmatterRaw, body } = splitFrontmatter(raw, absPath);
  const parsedYaml = yamlParse(frontmatterRaw) as unknown;
  const frontmatter = SkillFrontmatterSchema.parse(parsedYaml);
  return { frontmatter, body };
}

/** True when `absPath` exists on disk. */
async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

/**
 * Compute the `_archived/<name>.md` path a retired/superseded skill moves to,
 * resolved relative to the skill file's OWN directory's `.crew/skills/` root.
 * For `.crew/skills/foo.md` the archive is `.crew/skills/_archived/foo.md`.
 */
function archivePathFor(relPath: string): string {
  const dir = path.posix.dirname(relPath.split(path.sep).join("/"));
  const name = skillNameFromPath(relPath);
  return path.posix.join(dir, "_archived", `${name}.md`);
}

/**
 * Compute the `<skill>.history/<version>.md` path the prior body of a revised
 * skill is archived to before replacement.
 */
function historyPathFor(relPath: string, priorVersion: string): string {
  const posix = relPath.split(path.sep).join("/");
  return `${posix}.history/${priorVersion}.md`;
}

/** Write a file through the managed-fs guard with the accept-proposal context. */
async function writeManaged(
  ctx: HandlerContext,
  relPath: string,
  contents: string,
): Promise<void> {
  await writeManagedFile({
    absPath: path.join(ctx.targetRepoRoot, relPath),
    contents,
    targetRepoRoot: ctx.targetRepoRoot,
    mcpToolContext: { toolName: ACCEPT_TOOL_NAME, role: ctx.role },
  });
}

// ---------------------------------------------------------------------------
// Shared create logic (used by skill-create AND skill-supersede's replacement)
// ---------------------------------------------------------------------------

/**
 * Write a brand-new skill file. Throws `SkillAlreadyExistsError` BEFORE any
 * write when a file already exists at the proposed path (no overwrite).
 * Returns the repo-relative path written.
 */
async function writeNewSkill(
  ctx: HandlerContext,
  opts: {
    proposedPath: string;
    description: string;
    body: string;
    sourceLessonRefs: string[];
    introducedAt: string;
    supersedes?: string;
  },
): Promise<string> {
  const abs = path.join(ctx.targetRepoRoot, opts.proposedPath);
  const rel = relPosix(ctx.targetRepoRoot, abs);

  if (await fileExists(abs)) {
    throw new SkillAlreadyExistsError({ skillPath: rel });
  }

  const frontmatter: SkillFrontmatter = {
    name: skillNameFromPath(rel),
    description: opts.description,
    allowed_tools: [],
    version: "0.1.0",
    introduced_at: opts.introducedAt,
    source_lesson_refs: opts.sourceLessonRefs,
    ...(opts.supersedes ? { supersedes: opts.supersedes } : {}),
  };

  await writeManaged(ctx, rel, renderSkillFile(frontmatter, opts.body));
  return rel;
}

// ---------------------------------------------------------------------------
// Clock seam — injectable for deterministic tests
// ---------------------------------------------------------------------------

export interface SkillHandlerDeps {
  /** Returns the current instant; the source of `introduced_at` / `retired_at`. */
  now: () => Date;
}

const DEFAULT_DEPS: SkillHandlerDeps = { now: () => new Date() };

/**
 * The lesson-provenance refs a skill carries are pulled from the proposal's
 * rationale provenance. The 6.3 skill-create / supersede schema does NOT carry
 * a dedicated lesson-refs array, so we derive an empty array here; Story 6.8's
 * effectiveness work and any future schema-change story may thread real refs
 * through. The frontmatter field exists (audit-trail contract) and round-trips.
 */
function lessonRefsFor(_proposal: RetroProposal): string[] {
  return [];
}

// ---------------------------------------------------------------------------
// Handler: skill-create (AC1)
// ---------------------------------------------------------------------------

function makeSkillCreateHandler(deps: SkillHandlerDeps): ProposalApplyHandler {
  return {
    type: "skill-create",
    async previewDiff(proposal): Promise<string> {
      if (proposal.type !== "skill-create") throw wrongKind(proposal.type);
      return [
        `Create skill: ${proposal.proposed_path}`,
        ``,
        `+ name: ${skillNameFromPath(proposal.proposed_path)}`,
        `+ description: ${proposal.frontmatter_description}`,
        `+ version: 0.1.0`,
        ``,
        `--- body (${proposal.body.split("\n").length} lines) ---`,
        proposal.body,
      ].join("\n");
    },
    async apply(proposal, ctx): Promise<ProposalApplyResult> {
      if (proposal.type !== "skill-create") throw wrongKind(proposal.type);
      const rel = await writeNewSkill(ctx, {
        proposedPath: proposal.proposed_path,
        description: proposal.frontmatter_description,
        body: proposal.body,
        sourceLessonRefs: lessonRefsFor(proposal),
        introducedAt: deps.now().toISOString(),
      });
      return { changedPaths: [rel] };
    },
  };
}

// ---------------------------------------------------------------------------
// Handler: skill-revise (AC2)
// ---------------------------------------------------------------------------

function makeSkillReviseHandler(deps: SkillHandlerDeps): ProposalApplyHandler {
  return {
    type: "skill-revise",
    async previewDiff(proposal, ctx): Promise<string> {
      if (proposal.type !== "skill-revise") throw wrongKind(proposal.type);
      const abs = path.join(ctx.targetRepoRoot, proposal.target_skill_path);
      const rel = relPosix(ctx.targetRepoRoot, abs);
      const { frontmatter } = await readSkillFile(abs, rel);
      const nextVersion = bumpVersion(frontmatter.version, proposal.version_bump);
      return [
        `Revise skill: ${rel}`,
        ``,
        `- version: ${frontmatter.version}`,
        `+ version: ${nextVersion}  (${proposal.version_bump})`,
        `  prior body archived → ${historyPathFor(rel, frontmatter.version)}`,
        ``,
        `--- new body (${proposal.revised_body.split("\n").length} lines) ---`,
        proposal.revised_body,
      ].join("\n");
    },
    async apply(proposal, ctx): Promise<ProposalApplyResult> {
      if (proposal.type !== "skill-revise") throw wrongKind(proposal.type);
      const abs = path.join(ctx.targetRepoRoot, proposal.target_skill_path);
      const rel = relPosix(ctx.targetRepoRoot, abs);
      // Throws SkillNotFoundError before any write when the target is absent.
      const { frontmatter, body } = await readSkillFile(abs, rel);

      // Archive the PRIOR body at <skill>.history/<prior-version>.md first.
      // The history name derives from the prior version, so revising twice
      // never clobbers an earlier archive (the bump makes the live version
      // monotonic; the archive name is always the pre-bump version).
      const priorVersion = frontmatter.version;
      const historyRel = historyPathFor(rel, priorVersion);
      await writeManaged(ctx, historyRel, renderSkillFile(frontmatter, body));

      // Bump the version, replace the body, preserve the rest of the frontmatter.
      const nextFrontmatter: SkillFrontmatter = {
        ...frontmatter,
        version: bumpVersion(priorVersion, proposal.version_bump),
      };
      await writeManaged(
        ctx,
        rel,
        renderSkillFile(nextFrontmatter, proposal.revised_body),
      );

      return { changedPaths: [rel, historyRel] };
    },
  };
}

// ---------------------------------------------------------------------------
// Handler: skill-supersede (AC3)
// ---------------------------------------------------------------------------

function makeSkillSupersedeHandler(
  deps: SkillHandlerDeps,
): ProposalApplyHandler {
  return {
    type: "skill-supersede",
    async previewDiff(proposal, ctx): Promise<string> {
      if (proposal.type !== "skill-supersede") throw wrongKind(proposal.type);
      const supersededAbs = path.join(
        ctx.targetRepoRoot,
        proposal.superseded_skill_path,
      );
      const supersededRel = relPosix(ctx.targetRepoRoot, supersededAbs);
      // Surface the missing-target failure on preview too (no write).
      await readSkillFile(supersededAbs, supersededRel);
      const archiveRel = archivePathFor(supersededRel);
      const replacementRel = relPosix(
        ctx.targetRepoRoot,
        path.join(ctx.targetRepoRoot, proposal.replacement.proposed_path),
      );
      return [
        `Supersede skill (one atomic apply):`,
        ``,
        `+ replacement: ${replacementRel}`,
        `    supersedes: ${supersededRel}`,
        `    description: ${proposal.replacement.frontmatter_description}`,
        `- superseded: ${supersededRel} → archived at ${archiveRel} (retired_at stamped)`,
        ``,
        `--- replacement body (${proposal.replacement.body.split("\n").length} lines) ---`,
        proposal.replacement.body,
      ].join("\n");
    },
    async apply(proposal, ctx): Promise<ProposalApplyResult> {
      if (proposal.type !== "skill-supersede") throw wrongKind(proposal.type);

      const supersededAbs = path.join(
        ctx.targetRepoRoot,
        proposal.superseded_skill_path,
      );
      const supersededRel = relPosix(ctx.targetRepoRoot, supersededAbs);

      // Read the superseded skill FIRST — throws SkillNotFoundError before any
      // write when the target is absent (atomicity: no half-applied state).
      const { frontmatter: supersededFm, body: supersededBody } =
        await readSkillFile(supersededAbs, supersededRel);

      // Effect 1: write the replacement (with `supersedes:` set). Throws
      // SkillAlreadyExistsError before any write if the replacement path is
      // occupied — ordered first so a collision leaves the superseded skill
      // intact (nothing archived yet).
      const replacementRel = await writeNewSkill(ctx, {
        proposedPath: proposal.replacement.proposed_path,
        description: proposal.replacement.frontmatter_description,
        body: proposal.replacement.body,
        sourceLessonRefs: lessonRefsFor(proposal),
        introducedAt: deps.now().toISOString(),
        supersedes: supersededRel,
      });

      // Effect 2: archive the superseded skill to _archived/<name>.md with
      // retired_at stamped, then remove the live file. Any <skill>.history/ is
      // preserved (we only move the skill file itself).
      const archiveRel = archivePathFor(supersededRel);
      const archivedFm: SkillFrontmatter = {
        ...supersededFm,
        retired_at: deps.now().toISOString(),
      };
      await writeManaged(
        ctx,
        archiveRel,
        renderSkillFile(archivedFm, supersededBody),
      );
      await fs.rm(supersededAbs);

      return { changedPaths: [replacementRel, archiveRel, supersededRel] };
    },
  };
}

// ---------------------------------------------------------------------------
// Handler: skill-retire (AC4)
// ---------------------------------------------------------------------------

function makeSkillRetireHandler(deps: SkillHandlerDeps): ProposalApplyHandler {
  return {
    type: "skill-retire",
    async previewDiff(proposal, ctx): Promise<string> {
      if (proposal.type !== "skill-retire") throw wrongKind(proposal.type);
      const abs = path.join(ctx.targetRepoRoot, proposal.target_skill_path);
      const rel = relPosix(ctx.targetRepoRoot, abs);
      // Surface the missing-target failure on preview too (no write).
      await readSkillFile(abs, rel);
      const archiveRel = archivePathFor(rel);
      return [
        `Retire skill: ${rel}`,
        ``,
        `- ${rel}  (removed from the live path)`,
        `+ ${archiveRel}  (retired_at stamped; any .history/ preserved)`,
        ``,
        `last_invoked_at: ${
          proposal.last_invoked_at === null
            ? "null (never fired)"
            : proposal.last_invoked_at
        }`,
      ].join("\n");
    },
    async apply(proposal, ctx): Promise<ProposalApplyResult> {
      if (proposal.type !== "skill-retire") throw wrongKind(proposal.type);
      const abs = path.join(ctx.targetRepoRoot, proposal.target_skill_path);
      const rel = relPosix(ctx.targetRepoRoot, abs);

      // Throws SkillNotFoundError before any write when the target is absent.
      const { frontmatter, body } = await readSkillFile(abs, rel);

      // Write the archived copy with retired_at stamped, then remove the live
      // file. Any <skill>.history/ is preserved (we only move the skill file).
      const archiveRel = archivePathFor(rel);
      const archivedFm: SkillFrontmatter = {
        ...frontmatter,
        retired_at: deps.now().toISOString(),
      };
      await writeManaged(ctx, archiveRel, renderSkillFile(archivedFm, body));
      await fs.rm(abs);

      return { changedPaths: [archiveRel, rel] };
    },
  };
}

function wrongKind(kind: string): Error {
  return new Error(
    `apply-skill-proposal: handler invoked for the wrong kind '${kind}'`,
  );
}

// ---------------------------------------------------------------------------
// Public factory — the four handlers
// ---------------------------------------------------------------------------

/**
 * Build the four `skill-*` apply handlers. The clock seam is injectable so
 * tests can assert `introduced_at` / `retired_at` deterministically; production
 * passes nothing and the real `Date` clock is used.
 */
export function createSkillProposalHandlers(
  deps: SkillHandlerDeps = DEFAULT_DEPS,
): ProposalApplyHandler[] {
  return [
    makeSkillCreateHandler(deps),
    makeSkillReviseHandler(deps),
    makeSkillSupersedeHandler(deps),
    makeSkillRetireHandler(deps),
  ];
}
