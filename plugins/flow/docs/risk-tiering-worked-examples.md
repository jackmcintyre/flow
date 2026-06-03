# Risk-tiering worked examples

This file gives concrete, labelled examples of how a pull request is classified
`low`, `medium`, or `high` risk, and why that tier decides whether the PR
auto-merges or pauses for you. It is a companion to
[`risk-tiering.md`](./risk-tiering.md), which declares the authoritative rules,
and to [`provisional-trust.md`](./provisional-trust.md), which covers the
cold-start case. Read this when you want to predict, before you queue a story,
whether it will merge hands-off or stop and wait for a human — without tracing
the classifier's rules by hand.

The classifier walks the rule list in declaration order and returns the **first**
matching tier. If no rule matches, the **fallback tier** (`medium`) applies. So
when you read the examples below, remember the order of evaluation: high-risk
rules are checked first, then the two low-risk rules, and anything left over
falls through to `medium`.

## Worked examples by tier

### Example 1 — docs-only PR → `low` (`docs-only`)

A PR that only changes documentation. Every changed path is under `docs/**` or
matches `**/*.md`.

```
docs/risk-tiering-worked-examples.md   (new)
README.md                              (edited)
plugins/flow/docs/dev-loop.md          (edited)
```

- **Tier: `low`** via the `low.docs-only` rule.
- **Why:** every changed file matches one of the documentation path patterns, so
  the rule's "all paths must match" condition holds. Documentation and Markdown
  content cannot cause a runtime regression, so the change is safe to merge
  without a human eyeball.
- **Watch out:** the rule requires *all* changed files to match. A PR that
  touches `docs/README.md` **and** `src/index.ts` does **not** qualify — the
  `src/` file falls outside both patterns, so the PR drops through to the
  `medium` fallback. There is also a `path_excludes` guard: convention-wired
  files that happen to be Markdown-adjacent (CI workflows under `.github/**`,
  `package.json`, lockfiles, `tsconfig*.json`, `*.config.*`, Dockerfiles,
  `.env*`, `*.sh`) are kept out of `low` because they can change behaviour on
  their own.

> This very PR is an instance of Example 1: it adds exactly one new `.md` file
> and changes nothing else, so it classifies `low` (`docs-only`).

### Example 2 — brand-new module plus its test → `low` (`additive-only`)

A PR that adds a brand-new, self-contained module and its test file, modifying
no existing file, with a small authored-source diff.

```
plugins/flow/mcp-server/src/lib/explain-gate-reason.ts        (new)
plugins/flow/mcp-server/src/lib/explain-gate-reason.test.ts   (new)
```

- **Tier: `low`** via the `low.additive-only` rule.
- **Why:** every changed file is a **brand-new addition** — nothing existing is
  modified, deleted, or renamed — and the authored-source diff is **≤ 300
  lines**. Import-wired additive code like this is inert: it does nothing until
  a *later, non-low* PR edits an existing file to wire it in. Because it can't
  change existing behaviour on its own, it is safe to merge hands-off. The
  300-line cap bounds the blast radius.
- **What counts toward the 300 lines:** only **authored source**. The size check
  deliberately ignores generated output — anything under a `dist/` directory and
  the lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`) are skipped.
  This matters because committing the rebuilt `dist/` alongside a small source
  change would otherwise roughly double the measured line count and push a
  genuinely small change up into `medium`.
- **Watch out:** the same `path_excludes` guard from Example 1 applies. A purely
  additive *new* CI workflow, dependency manifest, build/test config file,
  Dockerfile, env file, or shell script is **not** `low` even though it adds no
  existing-file edits — those run by convention and can change behaviour by
  themselves. And the moment the PR edits even one existing source file, it is no
  longer additive-only (see Example 3).

### Example 3 — edits an existing source file → `medium` (the fallback tier)

A PR that modifies an existing source file — the most common kind of code change.

```
plugins/flow/mcp-server/src/tools/run-reviewer-session.ts   (edited)
```

- **Tier: `medium`** via the **fallback**.
- **Why:** no high-risk rule matches (no migration/schema change types), and
  neither low-risk rule matches — it is not docs-only, and it is not
  additive-only because an existing file was modified. With no explicit rule
  matching, the PR lands on the fallback tier, `medium`. In v1 there are no
  explicit `medium` rules; the fallback semantics cover this gap.
- **What `medium` means:** the automated reviewer checks still run and the
  verdict is surfaced, but the PR **pauses for a human** to confirm before
  merge. Editing existing behaviour carries real regression risk, so a person
  stays in the loop.

### Example 4 — migration or schema change → `high`

A PR whose declared change types include a `migration` or `schema` change — for
example a commit like `feat(migration): add users table` or
`chore(schema): widen email column`.

```
db/migrations/0007_add_users_table.sql   (new)
src/models/user.ts                        (edited)
```

- **Tier: `high`** via the `high.schema-or-migration` rule.
- **Why:** the classifier's commit-message parser detects a `migration` or
  `schema` change type (from conventional-commit prefixes/footers such as
  `feat(migration):` or `chore(schema):`). When either type is present, the PR
  is classified `high` **regardless of which files changed** — the
  path-based signals are not even consulted, because high rules are evaluated
  first.
- **What `high` means:** the PR **always requires human sign-off** before merge,
  regardless of the reviewer's verdict. Schema and migration changes have a
  blast radius that spans production data and a non-trivial rollback path, so
  they are never merged hands-off.

## Why the tier governs auto-merge

The risk tier is exactly what the **auto-merge gate** keys off when it decides
whether to merge a PR for you or stop and wait. The rule is simple:

**Only `low`-risk PRs are ever eligible for hands-off merge.** `medium`, `high`,
and untiered PRs **always pause for a human**, regardless of the team's trust
state. No amount of accrued agreement history — and no config flag — can make a
`medium`, `high`, or untiered PR merge itself.

A `low`-risk PR becomes eligible for hands-off merge in one of two ways:

1. **The agreement metric meets the threshold.** Once the team has accrued
   enough resolved reviewer/dev verdict pairs, the gate computes an agreement
   ratio. If that ratio is at or above the configured threshold (the comparison
   is `>=`), a `low`-risk PR auto-merges. If the ratio is below the threshold,
   the `low`-risk PR pauses for a human instead.

2. **Cold-start provisional trust.** On a brand-new repo the agreement window is
   empty, so the metric is `null` (insufficient data) and there is no ratio to
   compare. With the `provisional_trust` config flag **on**, a `low`-risk PR
   auto-merges anyway while that window is still filling, so agreement history
   can accrue. With the flag **off** (the default), a `low`-risk PR with
   insufficient history pauses for a human. Provisional trust relaxes **only**
   this `low` + insufficient-data case — it never touches `medium`, `high`, or
   untiered PRs. See [`provisional-trust.md`](./provisional-trust.md) for the
   full treatment.

The complete decision table the gate uses:

| Risk tier  | Agreement metric          | Provisional trust | Decision          |
|------------|---------------------------|-------------------|-------------------|
| `low`      | meets threshold (`>=`)    | any               | auto-merge        |
| `low`      | below threshold           | any               | pause for human   |
| `low`      | insufficient (null)       | off               | pause for human   |
| `low`      | insufficient (null)       | on                | auto-merge        |
| `medium`   | any                       | any               | pause for human   |
| `high`     | any                       | any               | pause for human   |
| untiered   | any                       | any               | pause for human   |

So to predict a story's fate before you queue it: figure out which example above
it most resembles. If it looks like Example 1 or 2 (docs-only, or a small
brand-new module), it is `low` and can merge hands-off once the threshold is met
or while provisional trust is on. If it looks like Example 3 or 4 (edits an
existing source file, or carries a migration/schema change), it will pause and
wait for you no matter what.
