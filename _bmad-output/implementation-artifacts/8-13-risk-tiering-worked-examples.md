# Story 8.13: Worked examples for the risk-tiering rules

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **concrete worked examples of how a PR is classified low / medium / high risk**,
So that **I can predict whether a story will auto-merge or pause for me before I queue it, without tracing the classifier's rules by hand**.

This is an Epic 8 dogfood story for the multi-story unattended drain: a docs-only, purely-additive change. It creates exactly one new Markdown file. No code, no tests, nothing else changed.

## Dependencies

- None. Leaf story: one new documentation file. Does not touch source, build output, or any `.crew/state` file.

## Acceptance Criteria

**AC1 — a worked-examples doc exists covering all three risk tiers:**

A new Markdown file exists at `plugins/crew/docs/risk-tiering-worked-examples.md`. It gives concrete, labelled examples for each tier, grounded in the rules in `plugins/crew/docs/risk-tiering.md`: a docs-only PR (every changed path under `docs/**` or `**/*.md`) → `low` (`docs-only`); a brand-new pure module plus its test, with no existing file modified and source diff ≤ 300 lines → `low` (`additive-only`); a PR that edits an existing source file → `medium` (the fallback tier); a PR whose change types include a migration or schema change → `high`.
artifact: plugins/crew/docs/risk-tiering-worked-examples.md

**AC2 — the doc explains why the tier governs auto-merge:**

The same file explains that the tier is what the auto-merge gate keys off: only `low`-risk PRs are eligible for hands-off merge (via cold-start `provisional_trust` while agreement history accrues, or once the agreement metric meets the threshold), whereas `medium`, `high`, and untiered PRs always pause for a human regardless of trust state.
artifact: plugins/crew/docs/risk-tiering-worked-examples.md

## Notes

**Docs-only — do NOT write any code or tests.** Create exactly one new file, `plugins/crew/docs/risk-tiering-worked-examples.md`, with real, accurate prose covering both ACs. The authoritative rules live in `plugins/crew/docs/risk-tiering.md` and the gate decision table in `plugins/crew/mcp-server/src/lib/auto-merge-gate.ts` — read them for ground truth. Do not modify any `.ts` file, the build output (`dist/`), the execution manifest, or any `.crew/state` file — the PR's diff must contain only the new `.md` file (this keeps it classified `low`-risk). No build step is needed for a docs-only change.
