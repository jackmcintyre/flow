/**
 * Skill-frontmatter Zod schema — Story 6.7.
 *
 * Every project-scope skill file written under `<target-repo>/.flow/skills/`
 * carries this YAML frontmatter block. Skills are the **constructive twin** of
 * rules (architecture: "Skills are the constructive twin of rules") — where the
 * rule registry codifies "what shouldn't happen," skill files codify "what
 * should always happen," and both apply through the same diff-then-confirm gate
 * (Story 6.4) with the same audit-trail discipline.
 *
 * The frontmatter is the source of truth the operator reads and `git revert`s.
 * It is `.strict()` — an unknown key is a malformed skill file, never silently
 * accepted (memory `feedback_default_to_deterministic_seams`).
 *
 * Fields:
 *  - `name`               — `<plugin>:<command>` identity of the skill.
 *  - `description`        — operator-readable summary (from the proposal's
 *                           `frontmatter_description`).
 *  - `allowed_tools`      — the negative-capability allowlist the skill runs
 *                           under (may be empty; the skill files this story
 *                           writes are inert until Story 6.8 measures their use).
 *  - `version`            — semver `x.y.z`; starts at `0.1.0` on create, bumped
 *                           per `version_bump` on revise.
 *  - `introduced_at`      — ISO-8601 UTC timestamp of the create.
 *  - `source_lesson_refs` — audit trail (story-ref#lesson) of the lessons this
 *                           skill codifies; may be empty.
 *  - `supersedes`         — optional; the path of the skill this one replaced
 *                           (set on supersede only).
 *  - `retired_at`         — optional; ISO-8601 UTC timestamp; set only when the
 *                           file lives under `_archived/` (retire / supersede).
 *
 * (Story 6.7 — FR63, Architecture §Skill calibration loop)
 */
import { z } from "zod";
/**
 * Semver shape — `x.y.z` with each component a non-negative integer. Matches
 * the `version_bump` helper's output and the architecture's skill-versioning
 * convention. Not a full semver (no pre-release / build metadata) — skill
 * versions are derived purely by the bump helper.
 */
const SemverSchema = z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, "must be semver 'x.y.z'");
export const SkillFrontmatterSchema = z
    .object({
    name: z.string().min(1),
    description: z.string().min(1),
    allowed_tools: z.array(z.string()),
    version: SemverSchema,
    introduced_at: z.string().min(1),
    source_lesson_refs: z.array(z.string()),
    supersedes: z.string().optional(),
    retired_at: z.string().optional(),
})
    .strict();
