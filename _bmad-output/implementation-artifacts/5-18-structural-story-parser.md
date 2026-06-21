# Story 5.18: Structural / AST-style story parser (stub-only, protected backlog)

story_shape: substrate
Status: optional

<!-- Status flipped backlog → optional on 2026-05-28 so the BMad adapter skips this stub during /crew:scan. The adapter aborts the whole scan on the first malformed story file; this stub has no `## Acceptance Criteria` by design (protected backlog), so it was blocking every other ready-for-dev story from being materialised. Skip-via-optional-status is the smallest fix; the underlying "skip-and-flag-instead-of-abort" parser resilience is logged onto epic-5-carry-forward.md as a signal for when 5.18 itself is eventually authored. -->


## Story

As a **plugin operator**,
I want **the BMad story parser to extract semantic fields tolerantly from a markdown AST rather than chain-matching brittle line-shape regexes**,
So that **stories from external planners (BMad, native, future adapters) and human-authored stories survive minor formatting drift without losing the orchestrator's ability to scan and validate them**.

This is a **protected-backlog stub**. The full spec MUST NOT be authored or shipped until the trigger condition below fires.

## Trigger condition (verbatim — do NOT author the spec until this fires)

This story MUST NOT be authored or shipped unless one of the following triggers:

1. **A non-BMad adapter input shape lands.** Any new planning adapter whose `parseSourceStory` differs structurally from `parseBmadStory` / `parseNativeStory` (e.g. JIRA, Linear, GitHub Issues, a custom user-built adapter) — author 5.18 BEFORE merging that adapter so the parser is structural from the start.
2. **An external-planner integration ships.** Same shape as (1) — any change that lets a planner outside crew's own authoring contract drop stories into the queue.
3. **The cumulative cost of regex-widening patches exceeds the structural-refactor cost.** Carry-forward tracker (entry 11) lists each parser-regex-widening ship; when the total widening surface gets too large to safely add another widening (~3-4 patches after 5.14 + 5.17 = somewhere around 7-8 widenings cumulatively, or when a widening would conflict with another), promote 5.18.

When any trigger fires, author the full spec via `/bmad-create-story 5.18` and ship via `/ship-story 5-18`.

## Scope sketch (NOT authoritative — spec authoring required when triggered)

Replace the current chain of whitespace-strict regexes in `parse-bmad-story.ts` and `parse-native-story.ts` with a markdown-AST extraction pipeline:

- Parse story body via a markdown parser (e.g. `remark` / `mdast` ecosystem — already in pnpm dep tree if `remark` is pulled in elsewhere; otherwise pick lightest stable option).
- Extract semantic fields from AST node types rather than line shapes:
  - H1 → `title`
  - First H2 with text matching "Story" / "Acceptance Criteria" / etc. → section anchors
  - Bold strong-text immediately followed by paragraph → AC heading + body pattern
  - Code-span inside a paragraph → marker hint (`artifact:`, `vitest:`)
- Tolerate ordering and whitespace variations within H2 sections.
- Reject only at semantic level (missing required field, schema violation), not at line-shape level.

The new parser must be drop-in: same `parseBmadStory` / `parseNativeStory` interface, same return shape, same error types. No upstream callers should need to change.

## Why not now

The current chain-of-regexes parser, plus the 5.14 + 5.17 widening patches, accommodates BMad-authored and human-authored stories acceptably. Cost of regex patching has been small-per-occurrence (one widening per quarter, roughly). Cost of structural refactor is substantial (~1-2 weeks substrate work).

If we never integrate a non-BMad planner, the structural refactor is overhead that never pays for itself. The trigger condition above ensures we author 5.18 exactly when it starts paying off.

Same shape of protection as Story 5.23 (`markStoryShipped` MCP tool) — trigger-condition gating, no premature authoring.

## Memory references

- `project_current_blocker_story_parser` — "POC with tight template first, then permissive/structural AST parser (stories are interchange format)" — the eventual fix posture.
- `feedback_default_to_deterministic_seams` — same principle: load-bearing decisions belong in deterministic code, not LLM prose / regex chains.
- `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-27-reframe.md` § Phase B item 5 — original framing of 5.18 as protected backlog.
- Carry-forward entry 11 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` — promotes parser-brittleness from informal tracking to story-shaped.
