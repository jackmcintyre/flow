# BMad story format — adapter spike

Maintainer-facing reference for the BMad planning adapter
(`plugins/flow/mcp-server/src/adapters/bmad/`). Captures the
observed shape of BMad story files in this repo as of Story 3.3.

This spike is **not** a user doc; do not link it from any README or
install path. The adapter source links here via TSDoc `@see`.

---

## Source-file location convention

`BmadAdapter.defaultConfig()` returns
`stories_root: "_bmad-output/planning-artifacts/stories"`. In this
repo, however, the actually-committed BMad stories live under
`_bmad-output/implementation-artifacts/`. The default is best-effort
for first-run auto-detect; the real location lives in
`.flow/config.yaml`'s `adapter_config.stories_root`, which always
wins.

**Precedence:** `adapter_config.stories_root` from `.flow/config.yaml`
> `BmadAdapter.defaultConfig().stories_root`.

`detect()` cannot read `.flow/config.yaml` (the config may not exist
at first-run auto-detect time), so it uses the default. If a custom
`stories_root` is set, the registry only consults `detect()` when
there is no config — so the default is correct.

## Frontmatter fields

BMad stories do **not** carry YAML frontmatter. The "frontmatter" is
a prose header block:

- **Story id** — parsed from the filename `<epic>-<story>-<slug>.md`
  and verified against the H1. Filename pattern:
  `^\d+-\d+-[a-z0-9-]+\.md$`. The H1 has the shape
  `# Story <epic>.<story>: <title>`. On mismatch, the parser throws
  `MalformedBmadStoryError`.
- **Title** — the H1 text after the colon. Inline backticks are
  preserved; surrounding whitespace stripped.
- **Status** — the `Status: <value>` line near the top of the file
  (typically line 3).
- **Sections** — `## Story`, `## Acceptance Criteria`,
  `## Tasks / Subtasks`, `## Dev Notes`, optional `## Dependencies`,
  `## Implementation Notes`. Section presence is used to extract
  narrative, ACs, dependencies, and implementation notes.

## Lifecycle vocabulary

Confirmed values from
`_bmad-output/implementation-artifacts/sprint-status.yaml` STATUS
DEFINITIONS plus Story 3.1's backward-compat note. Mapping to the
plugin's execution-state vocabulary
(`to-do | in-progress | blocked | done`):

| BMad status      | Execution state | Notes                                                   |
|------------------|-----------------|---------------------------------------------------------|
| `draft`          | `to-do`         | spec exists but PM hasn't approved for dev pickup; not claimable yet — semantically equivalent to `backlog` |
| `approved`       | `to-do`         | PM has approved spec for dev pickup; semantically equivalent to `ready-for-dev` |
| `backlog`        | `to-do`         |                                                         |
| `ready-for-dev`  | `to-do`         | manifest moves to `in-progress` on claim                |
| `in-progress`    | `in-progress`   |                                                         |
| `review`         | `in-progress`   | dev work complete, awaiting human review — mid-flight from the orchestrator's POV |
| `done`           | `done`          |                                                         |
| `optional`       | _(skipped)_     | `listSourceStories` filters these out                   |
| `contexted`      | `to-do`         | legacy, backward-compat                                 |
| _(anything else)_ | _(throws)_     | `MalformedBmadStoryError` naming the unknown status     |

Operators who want `optional` stories executed should remove the
`optional` tag and use `backlog` / `ready-for-dev`.

## Acceptance criteria shape

ACs are bolded numbered headings followed by Given/When/Then prose:

```
**AC1:**
**Given** ...
**When** ...
**Then** ...

**AC2 (user-surface):**
...

**AC3 (integration):**
...

**AC4 — Some descriptive title:**
...

**AC5 — Some title (integration):**
...
```

- The numeric prefix is canonical (`AC<n>`).
- An optional **descriptive title** may appear after the AC number,
  separated by an em-dash (`—`, U+2014) with surrounding spaces:
  `**AC4 — Install & build pass cleanly:**`. The descriptive token is
  **documentation only** — the parser discards it. Only em-dash
  (U+2014) is accepted; hyphens and en-dashes are intentionally
  rejected to keep the grammar tight and avoid ambiguity with
  title-internal hyphens.
- The parenthetical tag is the kind hint:
  - `(integration)` → `kind: "integration"`.
  - `(user-surface)` → `kind: "integration"` (user-surface ACs are
    end-to-end by construction; see `user-surface-acs.md`).
  - any other parenthetical, or none → `kind: "unit"`.
- When both a descriptive title and a parenthetical tag are present,
  the tag must follow the title: `**AC5 — Some title (integration):**`.
- Matching is case-insensitive.
- HTML comments inside an AC body are stripped.

The planning-discipline validator (Story 3.5) is responsible for
raising the bar when a state-mutating story lacks an `integration`
AC. The adapter just reports what it sees.

## Dependency syntax

BMad stories in this repo do not carry a structured `depends_on`
field. The adapter parses an optional `## Dependencies` (or
`### Dependencies`) section as a bullet list. Refs accepted:

- `bmad:<epic>.<story>` — already-normalised form.
- `<epic>-<story>-<slug>` — filename-style; the adapter normalises
  to `bmad:<epic>.<story>`.

If the section is missing, `depends_on` is `[]`. The adapter does
**not** mine prose for dependencies.

## `raw_frontmatter` carrier

BMad has no real frontmatter; the adapter synthesises:

```
{
  status: "<status-string>",
  title: "<title>",
  id: "<epic>.<story>",
  filename_slug: "<slug>"
}
```

The `bmad:`-prefixed form lives in `ref`. Additional fields are not
populated.

## Disagreements with Story 3.3 tasks

None at spike time. If the dev finds disagreements during
implementation, record them in the Dev Agent Record so the
orchestrator can correct course before PR.
