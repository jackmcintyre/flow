---
version: "1.4.0"
fallback_tier: medium
tiers:
  low:
    - id: low.docs-only
      path_patterns:
        - "docs/**"
        - "**/*.md"
      all_paths_match: true
      path_excludes:
        - ".github/**"
        - "**/package.json"
        - "**/package-lock.json"
        - "**/pnpm-lock.yaml"
        - "**/yarn.lock"
        - "**/.npmrc"
        - "**/tsconfig*.json"
        - "**/*.config.js"
        - "**/*.config.ts"
        - "**/*.config.mjs"
        - "**/*.config.cjs"
        - "**/Dockerfile"
        - "**/Dockerfile.*"
        - "**/.env*"
        - "**/*.sh"
    - id: low.tests-only
      path_patterns:
        - "**/*.test.ts"
        - "**/*.test.js"
        - "**/*.test.d.ts"
        - "**/__tests__/**"
        - "tests/**"
      all_paths_match: true
    - id: low.additive-only
      additive_only: true
      diff_size_thresholds:
        max_lines_changed: 300
      path_excludes:
        - ".github/**"
        - "**/package.json"
        - "**/package-lock.json"
        - "**/pnpm-lock.yaml"
        - "**/yarn.lock"
        - "**/.npmrc"
        - "**/tsconfig*.json"
        - "**/*.config.js"
        - "**/*.config.ts"
        - "**/*.config.mjs"
        - "**/*.config.cjs"
        - "**/Dockerfile"
        - "**/Dockerfile.*"
        - "**/.env*"
        - "**/*.sh"
  high:
    - id: high.schema-or-migration
      change_types:
        - migration
        - schema
---

# Risk-tiering rules

This file declares the rules the reviewer uses to classify each PR's risk
tier. The classifier (Story 4.9b) walks the rule list in declaration order
and returns the first matching tier. If no rule matches, the `fallback_tier`
(`medium`) applies. The parsed spec is consumed by `lookupRiskTieringSpec`
(Story 4.9) and passed to `classifyRiskTier` (Story 4.9b).

## Tiers

### Low

A **low**-risk PR is safe to auto-merge without additional human review. Three
rules classify `low`:

- `low.docs-only` — every changed file falls under `docs/**` or matches
  `**/*.md`. Documentation and Markdown content cannot cause a runtime
  regression. Example: updating a README, adding a `.md` file.
- `low.tests-only` — every changed file is a test file (matches
  `**/*.test.ts`, `**/*.test.js`, `**/*.test.d.ts`, `**/__tests__/**`, or
  `tests/**`). This includes committed compiled test output that travels with a
  source test change (e.g. a `.test.ts` source alongside its built
  `.test.js` counterpart). Test files cannot regress production behaviour —
  the only code they can affect is other tests. There is **no size cap** for
  this rule: a large batch of test-only edits is just as safe to auto-merge as
  a small one.
- `low.additive-only` — every changed file is a **brand-new file addition**
  (nothing existing modified, deleted, or renamed), the diff is ≤ 300 lines,
  **and** no changed file matches the `path_excludes` guard. *Import-wired*
  additive code is inert until a later, non-low PR edits an existing file to
  wire it in — so it can't change existing behavior. The exception is
  *convention-wired* files that run by path/convention rather than by import
  (CI workflows, dependency manifests, build/test config, Dockerfiles, env
  files, shell scripts); those CAN change behavior on their own, so the
  `path_excludes` list keeps them out of `low` even when purely additive. The
  size cap bounds blast radius; high rules (migrations/schema) are evaluated
  first. (Both low.docs-only and low.additive-only carry the same `path_excludes`
  guard; low.tests-only does not need one because test files are already
  scope-limited.)

### Medium

A **medium**-risk PR requires a human eyeball — automated reviewer checks run
and the verdict is surfaced, but a team member confirms before merge. Medium
is also the **fallback tier**: any PR that matches no explicit rule lands here.
In v1 no explicit `medium` rules are declared; the fallback semantics cover the
gap. Future iterations may add explicit medium rules (e.g. refactor-only
changes identified by path pattern or commit message convention).

### High

A **high**-risk PR always requires human sign-off before merge, regardless of
reviewer verdict. High-risk changes include database migrations, schema
modifications, and other changes whose rollback path is non-trivial or whose
blast radius spans production data. The v1 rule (`high.schema-or-migration`)
matches any PR whose declared `change_types` include `migration` or `schema`.

## Rules

### `low.docs-only`

Matches PRs whose changed files all fall under the `docs/**` glob or match
`**/*.md`. This is a path-pattern rule — the classifier (Story 4.9b) will use
a glob library (e.g. `picomatch`) to test each changed file path against these
patterns. A PR is classified `low` only when ALL changed files match at least
one of the patterns; a PR that touches both `docs/README.md` and `src/index.ts`
does not match this rule (the `src/` file falls outside both patterns) and will
instead receive the `fallback_tier` of `medium`.

### `low.tests-only`

Matches PRs whose changed files ALL fall under the test-file globs:
`**/*.test.ts`, `**/*.test.js`, `**/*.test.d.ts`, `**/__tests__/**`, or
`tests/**`. Like `low.docs-only` this rule uses `all_paths_match: true` — a
single non-test file disqualifies it. Unlike the other `low` rules there is no
`diff_size_thresholds` cap and no `path_excludes` guard: test files exist
solely to verify behaviour and cannot alter production code paths on their own,
so no size threshold is needed to bound blast radius. The globs are chosen to
cover both TypeScript source test files and their compiled JavaScript and
declaration-file counterparts that are committed to `dist/` alongside the
source (CI fails on dist drift, so compiled test outputs travel with their
source in the same PR).

### `high.schema-or-migration`

Matches PRs whose `change_types` array includes `migration` or `schema`. The
`change_types` field is populated by the classifier's commit-message parser
(Story 4.9b), which looks for conventional-commit footers or type prefixes
(e.g. `feat(migration):`, `chore(schema):`). When either type is present, the
PR is classified `high` regardless of which files changed. This reflects the
architectural decision that schema and migration changes are always high-risk —
their blast radius (production data, rollback complexity) outweighs any
path-based signal.

## Overriding

To customise risk-tiering rules for your repository, copy this file into your
target repo at `<target-repo>/docs/risk-tiering.md` and edit it. The loader
(`lookupRiskTieringSpec`) checks for an override at that path first; if found
and valid, it is used **in its entirety** — the shipped default is not
consulted. This is a **wholesale-replace** semantic: your override must declare
a complete, self-contained rule set. If you want to extend the shipped default,
copy its content verbatim into your override and add your rules.

The override must conform to the same Zod schema as this file — the loader
validates both with the same parser. Malformed overrides raise a
`MalformedRiskTieringSpecError` citing the offending key; the error message
includes the path of this shipped default as a reference.

Future versions of the plugin may introduce an `extends: shipped` key in the
override to enable additive merging without a full copy; that is deferred work.
