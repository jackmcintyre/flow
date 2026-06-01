/**
 * Planning-discipline pure validator (Story 3.5).
 *
 * Implements the four enforcement rules from the planning-discipline doctrine:
 *   1. State-mutating stories must have at least one integration AC.
 *   2. Implicit `depends_on` references in narrative/AC text must be declared.
 *   3. Every backlog must contain at least one ship-gate story (backlog-level only).
 *   4. BMad scan-time: same as rule 1 applied via BmadAdapter.
 *
 * All functions are pure — no I/O, no side effects, deterministic.
 *
 * @see _bmad-output/implementation-artifacts/3-5-planning-discipline-validation-at-authoring-and-scan-time.md
 */
import type { DisciplineViolation, SourceStory } from "../adapters/adapter.js";
/**
 * Path-glob tokens that indicate a story is state-mutating.
 * Conservative list: false positives are acceptable, false negatives are not.
 */
export declare const STATE_MUTATING_GLOBS: readonly string[];
/**
 * Verb+object pattern indicating state mutation.
 * Conservative: matches common mutation verbs paired with state/manifest/status/backlog.
 */
export declare const STATE_MUTATING_TOKEN_RE: RegExp;
/**
 * Whether a story is a native / enriched story — the only stories the Tier-0
 * §3 checks (T0-1, T0-2, T0-5, T0-6, Story 10.3) apply to.
 *
 * The gate is the `native:` ref prefix. A BMad-scanned `SourceStory` always
 * carries a `bmad:` ref and never populates the enriched fields
 * (`tasks`/`cited_sources`/per-AC `verification`) — BMad enrichment is the 10.5
 * ingest's job. Gating here is the load-bearing protection against a
 * live-backlog outage: until ingest (10.5) + cutover (10.6), a BMad story must
 * NEVER be failed by the new checks (Story 10.3 AC1c + AC2; see the pre-mortem
 * in the story's Implementation Notes). There is no path in this codebase where
 * a BMad story is presented to the validator with a `native:` ref — the ref is
 * minted by the parser/`writeNativeStory` from the adapter, not the operator.
 */
export declare function isEnrichedStory(story: SourceStory): boolean;
/**
 * Validate a single `SourceStory` against per-story discipline rules.
 *
 * Rules checked:
 *   - Missing integration AC (when story is state-mutating).
 *   - Implicit `depends_on` refs in narrative / AC text.
 *
 * Native/enriched stories (`isEnrichedStory`) additionally get the pure Tier-0
 * §3 checks (Story 10.3):
 *   - **T0-2** (`missing-verification`): every AC carries a `verification`
 *     block.
 *   - **T0-1** (`task-ac-ref-unresolved`): every task has ≥1 `ac_ref`, and each
 *     resolves to a real AC id (`AC<n>`) declared in the story.
 *
 * Both are PURE (no I/O). The disk-side Tier-0 checks (T0-5 cited-source
 * resolvability, T0-6 verification-target resolvability) live in
 * `resolveDisciplinePaths` (run at the scan/write I/O boundary), not here.
 *
 * Ship-gate is a backlog-level concept — NOT checked here.
 *
 * @param story - The story to validate.
 * @param opts.stateMutating - Override the heuristic. `true`/`false` overrides;
 *   `undefined` runs the heuristic. Used when the planner operator dismisses a
 *   false positive.
 * @returns The original `story` on pass, or a `DisciplineViolation` on fail.
 */
export declare function validateStoryAgainstDiscipline(story: SourceStory, opts?: {
    stateMutating?: boolean;
}): SourceStory | DisciplineViolation;
/**
 * Validate a backlog of stories for the ship-gate rule.
 *
 * Only the backlog-level check is performed here — per-story rules are
 * validated by `validateStoryAgainstDiscipline`.
 *
 * Ship-gate detection: a story is a ship-gate if
 * `raw_frontmatter.ship_gate === true` (native stories) OR
 * `raw_frontmatter.ship_gate === true` (BMad stories, set by the parser
 * from the `ship-gate` tag — see parse-bmad-story.ts Task 4).
 *
 * @param stories - Pending stories being authored/scanned.
 * @param opts.existingStories - Already-on-disk stories to include in the
 *   ship-gate search. Pass `[]` if not available.
 * @param opts.backlogPseudoRef - Ref to use for the violation (defaults to
 *   `"backlog:default"`).
 * @returns Empty array on pass; one-element array with `missing-ship-gate`
 *   violation on fail.
 */
export declare function validateBacklogAgainstDiscipline(stories: SourceStory[], opts: {
    existingStories: SourceStory[];
    backlogPseudoRef?: string;
}): DisciplineViolation[];
