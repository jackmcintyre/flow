# Story 8.9: Document the provisional-trust auto-merge flag

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **a short doc explaining the `plugin.provisional_trust` config flag — what it does, its default, the low-risk-only constraint, and how to turn it on and off**,
So that **I can understand and safely control cold-start auto-merge without reading the gate's source code**.

This is the Stage-2 dogfood guinea pig (Epic 8): a docs-only, purely-additive change — the safest possible first story the autonomous loop merges with zero human intervention via cold-start provisional trust. It creates exactly one new Markdown file. No code, no tests, nothing else changed.

## Dependencies

- None. Leaf story: one new documentation file. Does not touch source, build output, or any `.crew/state` file.

## Acceptance Criteria

**AC1 — a provisional-trust doc exists explaining the flag and its safety constraint:**

A new Markdown file exists at `plugins/crew/docs/provisional-trust.md`. It explains the `plugin.provisional_trust` config flag (set under the `plugin:` block in `.crew/config.yaml`): what it does (lets the auto-merge gate merge a PR with no human while agreement history is still accruing), that it defaults to `false`, and — critically — that it ONLY relaxes the merge gate for `low`-risk PRs: `medium`, `high`, and untiered PRs always pause for a human regardless of the flag.
artifact: plugins/crew/docs/provisional-trust.md

**AC2 — the doc explains how to enable and disable the flag:**

The same file (`plugins/crew/docs/provisional-trust.md`) includes a short "How to enable / disable" section showing the `.crew/config.yaml` snippet (`plugin:` → `provisional_trust: true`) and states that the flag is operator-controlled with no automatic expiry, so it should be turned off once the agreement window has filled and the normal threshold gate can take over.
artifact: plugins/crew/docs/provisional-trust.md

## Notes

**Docs-only — do NOT write any code or tests.** Create exactly one new file, `plugins/crew/docs/provisional-trust.md`, with real, accurate prose covering both ACs. Do not modify any `.ts` file, the build output (`dist/`), the execution manifest, or any `.crew/state` file — the PR's diff must contain only the new `.md` file (this keeps it classified `low`-risk). No build step is needed for a docs-only change.
