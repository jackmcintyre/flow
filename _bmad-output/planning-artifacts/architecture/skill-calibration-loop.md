# Skill Calibration Loop

Skills are the constructive twin of rules. Rules codify "what shouldn't happen again" (failure-driven; live in `discipline-rules.yaml` → regenerated as `docs/standards.md`); skills codify "what should happen, every time" (success-driven; live as Markdown slash-command files, version-controlled). The same retro infrastructure produces both — the architecture additions below make the skill half symmetrical and observable.

## Vocabulary

- **Lesson kinds** (story-level retro entries — already in PRD FR11):
  - `pitfall` → candidate **rule**
  - `pattern` → candidate **skill**
  - `tool-quirk` → candidate **rule** (workaround flavour) or **skill** (codified workaround)
  - `discipline` → candidate **rule** (process flavour) or **skill** (procedural)
- **Pattern fire-count threshold:** symmetric to rule promotion. Once a `pattern` lesson recurs ≥ N times across a rolling window, retro analyst drafts a skill proposal.
- **Skill scopes:**

  | Scope | Location | Read by |
  |---|---|---|
  | Project-specific | `<target-repo>/.flow/skills/<name>.md` | Agents on this project; user as a slash-command |
  | Persona-specific | Referenced from `team/<role>/PERSONA.md` Knowledge section | That role's subagents only |
  | Plugin-shipped | `plugins/flow/skills/<name>.md` | Every install (Growth-phase promotion path) |

  Retro-promoted skills land at project-scope by default. Promotion to plugin-shipped is a Growth-phase action gated on cross-user evidence, not a v1 path.

## Skill proposal types (extends FR59)

The retro analyst's proposal markdown carries five discriminators after this addition (was three):

| Type | What it does | Apply effect |
|---|---|---|
| `rule` | Add a criterion to the rule registry | `discipline-rules.yaml` mutated; `docs/standards.md` regenerated |
| `rule-retirement` (FR64a) | Remove or demote a stale rule | `discipline-rules.yaml` mutated; `docs/standards.md` regenerated |
| `skill-create` | Write a new skill Markdown file | New file at the proposed path; refuses to overwrite (FR63) |
| `skill-revise` | Replace an existing skill's body | Diff-then-confirm; file replaced; skill frontmatter `version` bumps; prior version archived under `<skill>.history/<version>.md` |
| `skill-supersede` | Pair a `skill-create` with a `skill-retire` of an old skill | Both proposals link by id; user can accept one without the other |
| `skill-retire` | Archive a skill that has stopped firing usefully | File moved to `_archived/<name>.md`; preserves history |
| `team-change` (FR105) | Hire or unhire a role | Existing FR107 flow |

All flow through the unified `/<plugin>:accept-proposal <id>` gate with diff-then-confirm.

## New telemetry event: `skill.invoke`

Joined retrospectively to verdict outcomes for effectiveness stats. JSONL shape:

```jsonc
{
  "ts": "<ISO-8601>",
  "type": "skill.invoke",
  "session_id": "<ulid>",
  "story_id": "<ref>",                       // optional; present when skill fires inside a story flow
  "agent": "<role-id>" | "user",
  "data": {
    "skill_name": "<plugin>:<command>",
    "skill_path": "<absolute path>",
    "skill_version": "<semver from skill frontmatter>",
    "skill_scope": "project" | "persona" | "plugin",
    "invocation_source": "user-slash-command" | "agent-call"
  }
}
```

## New MCP tools (extends §Project Structure tool list)

| Tool | Purpose |
|---|---|
| `applySkillRevision` | Replace a skill body from a `skill-revise` proposal; bumps frontmatter `version`; archives prior body |
| `applySkillRetirement` | Move a skill to `_archived/`; preserves history |
| `computeSkillEffectiveness` | Pure helper: reads `skill.invoke` events + downstream verdict outcomes; reports per-skill invoke count, "useful fire" count (READY-FOR-MERGE-followed), and a rolling effectiveness ratio — deterministic, no LLM (matches NFR23 style) |
| `recordSkillInvoke` | Single write-path for the `skill.invoke` event; called by the skill runtime wrapper |

The existing `applySkillProposal` (FR63) covers the `skill-create` case. The above add the revise / retire / measurement paths the original PRD didn't name.

## Skill frontmatter (extends Pattern §8)

```markdown
---
name: <plugin>:<command>
description: <one sentence>
allowed_tools: [Read, Edit, Bash(execa-allowlist), Task]
version: 0.2.0                       # bumped on revise
introduced_at: <ISO-8601>            # set on accept of skill-create
source_lesson_refs:                  # which lessons drove this skill into existence
  - "bmad:1.2.3#L4"                  # story ref + lesson index
  - "bmad:1.4.0#L1"
supersedes: <skill-name>             # set on skill-supersede
retired_at: <ISO-8601>               # set on skill-retire; only present in _archived/
---
```

- `source_lesson_refs` is the audit trail — why this skill exists; what observations crystallised into it.
- `version` enables `computeSkillEffectiveness` to attribute outcomes to the specific body that fired, not the skill's whole history.

## Retirement criterion (symmetric to FR64a)

Retro analyst flags a skill as a retirement candidate when **all** hold over a configurable observation window (default M = 5 cycles):

- Invoke count ≥ 1 per cycle threshold *not* met, OR
- Invoke count met but the joined "useful fire" ratio is below a configurable floor (default 0.3 — i.e. fewer than ~30% of invocations are followed by a READY-FOR-MERGE within the same story).

The retirement proposal carries both numbers so the user sees the evidence, not just the recommendation.

## Shape-of-learning observable

A single derived metric makes the loop's health visible:

> **constructive-to-defensive ratio** = (accepted skill proposals in window) / (accepted rule proposals in window)

A ratio that trends upward over time means the team is moving from "learning what not to do" to "learning what to always do" — the actual signal of a calibration loop earning its keep. Exposed by `computeOutcomeStats` alongside the existing rule fire counts and team-fitness signals (extends FR68 / FR110).

## Implications for earlier sections

| Section | Update |
|---|---|
| §Patterns §5 (JSONL schema) | `skill.invoke` added to the `type` discriminator list (edited in place above) |
| §Patterns §8 (skill file shape) | Frontmatter extended with `version`, `introduced_at`, `source_lesson_refs`, `supersedes`, `retired_at` |
| §Project Structure — tool list | `applySkillRevision`, `applySkillRetirement`, `computeSkillEffectiveness`, `recordSkillInvoke` added |
| §Telemetry & Observability | The `computeSkillEffectiveness` helper is the skill-side analogue of `computeOutcomeStats` — deterministic, no LLM (NFR23 style) |
| §Planning Adapter Model | No change — adapters are orthogonal to the skill loop; skills are plugin-owned in all configurations |
| FR59 (PRD) | Satisfied with the addition of revise / supersede / retire as proposal types alongside the original rule + skill + team-change set |
