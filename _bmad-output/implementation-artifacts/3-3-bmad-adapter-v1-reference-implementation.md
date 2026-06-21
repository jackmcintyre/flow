# Story 3.3: BMad adapter — v1 reference implementation

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator using BMad as my planning tool**,
I want **my BMad-authored stories projected into normalised execution manifests automatically**,
so that **I can keep authoring stories in BMad's vocabulary and have the crew plugin execute against my BMad backlog without me hand-shaping anything.**

### What this story is, in one sentence

Replace the `NotImplementedError` stubs in `plugins/crew/mcp-server/src/adapters/bmad/index.ts` with a real BMad adapter — `detect`, `listSourceStories`, `readSourceStory`, `resolveSourcePath` — that walks the BMad stories directory under `adapter_config.stories_root`, parses each BMad-shaped story file, normalises it to the `SourceStory` shape pinned by Story 3.1's interface (with each AC tagged `integration` or `unit`), maps BMad's lifecycle vocabulary to our execution states for reconciliation, and ships a committed fixture target repo plus a vitest integration suite that exercises every interface method end-to-end.

### What this story fixes (and why it needs its own story)

Stories 3.1 and 3.2 land the adapter contract, the registry, and `scan-sources`. Until this story lands, `BmadAdapter` returns `[]` from `listSourceStories` and throws `NotImplementedError` everywhere else. That means: a BMad-shaped target repo can be configured (`adapter: bmad`) and detected, but no source stories ever reach the execution layer; the dev loop has nothing to claim. This story makes BMad real — it is the **v1 reference implementation** that proves the adapter seam carries a complete, production-shaped planning tool, and is the bar every future adapter (Linear, GitHub Issues, plain Markdown) must clear.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- (b) Re-define the `PlanningAdapter` interface or `SourceStory` shape — those are owned by Story 3.1; this story only implements against them.
- (c) Implement `scan-sources` or the execution manifest writer — those land in Story 3.2 and consume this adapter's output.
- (d) Implement `watchForChanges()` — the contract leaves it optional and Story 3.2 polls on skill invoke. Do not add it here.
- (e) Implement `validateAgainstDiscipline()` — that's Story 3.5's job; this adapter returns the normalised `SourceStory` shape and lets the validator layer do its work.
- (f) Mutate BMad's source files. The adapter is read-only against `_bmad-output/`. No writes, no rewrites, no "normalising" on disk.
- (g) Add a `prepare`/postinstall hook or any build-on-install machinery. The dist-shipping contract from Story 1.9 stands.
- (h) Introduce a new MCP tool. The reconciliation prompt referenced in AC3 is surfaced via the existing tool-call surface; no new tool name is registered.
- (i) Add cross-namespace dependency resolution logic. `depends_on` is carried verbatim from the BMad source (which only references BMad story IDs); cross-adapter edges are a v2 concern (Architecture §Risks).
- (j) Touch the `native` adapter or its scaffolding.

---

## Acceptance Criteria

> **Verbatim from epic.** The four ACs below match `_bmad-output/planning-artifacts/epics/epic-3-backlog-layer-planning-adapters-story-manifests-and-the-planning-conversation.md` § Story 3.3 exactly. None of the ACs names a slash command, a CLI literal the operator types verbatim, a README-named install path, or a Claude Code UI element — every AC governs an internal TypeScript interface method, a documentation spike under `plugins/crew/docs/spikes/`, an internal reconciliation surface, or committed test fixtures. They are therefore **all untagged** per `plugins/crew/docs/user-surface-acs.md`. (The user-facing surface this story is reachable from — `/<plugin>:scan` — is covered by Story 3.2's AC4 and Story 3.4's `/plan` skill; the BMad adapter itself sits behind those surfaces, not at them.)

**AC1:**
**Given** the BMad story file format as it exists today,
**When** the implementer begins this story,
**Then** a brief BMad-format spike report exists at `plugins/crew/docs/spikes/bmad-format.md` enumerating the source frontmatter fields, lifecycle vocabulary, and dependency syntax the adapter must handle.
<!-- Not user-surface: the spike doc lives at a maintainer-facing internal path that no README or install doc instructs the operator to open. Rubric (iii) requires the user be told to open the file by name; this is dev-internal reference. -->

**AC2:**
**Given** a target repo with BMad-shaped sources under `_bmad-output/.../stories/`,
**When** `BmadAdapter.listSourceStories()` runs,
**Then** it returns one `SourceStory` per BMad story file, with normalised `acceptance_criteria` (each tagged `integration` or `unit`), `depends_on`, `narrative`, and `raw_frontmatter`. _(Architecture §BMad adapter)_
<!-- Not user-surface: AC2 names the internal interface method `BmadAdapter.listSourceStories()` and the returned `SourceStory` schema; neither is a user-typed CLI literal, slash command, copy-by-name path, nor a Claude Code UI element. -->

**AC3:**
**Given** a BMad story whose lifecycle status maps to `Done`,
**When** `BmadAdapter` reconciles status with our execution manifest,
**Then** discrepancies (BMad says Done; manifest says in-progress) surface as a reconciliation prompt rather than a silent override.
<!-- Not user-surface: "reconciliation prompt" here is the typed error / structured payload the calling skill returns through MCP — the locked-phrase surface for it is owned by Story 3.2's scan flow, not this story. The AC governs the internal contract that the discrepancy must not be silently overridden. -->

**AC4:**
**Given** the BMad adapter's fixture target repo at `plugins/crew/mcp-server/src/adapters/bmad/fixtures/`,
**When** the adapter integration tests run,
**Then** every interface method (`detect`, `listSourceStories`, `readSourceStory`, `resolveSourcePath`) is exercised against committed fixture data.
<!-- Not user-surface: AC4 governs vitest coverage against a committed fixture path that no operator-facing doc instructs the user to open. Rubric (iii) requires the README/install docs to name the path; this path is test-internal. -->

**AC5 (integration):**
vitest runs the BMad fixture suite end-to-end and asserts normalised `SourceStory` shape, including AC kind tagging and `depends_on` resolution.

---

## Tasks / Subtasks

- [ ] **Task 1 — BMad-format spike report (AC: 1)**
  - [ ] 1.1 Create `plugins/crew/docs/spikes/bmad-format.md`. The directory does not exist today (`ls plugins/crew/docs/spikes` returns "No such file or directory" as of story authoring); create it.
  - [ ] 1.2 The spike must enumerate, against the **actually-committed BMad stories in this repo** (under `_bmad-output/implementation-artifacts/`, e.g. `1-9-ship-a-pre-built-dist-with-the-plugin.md`, `1-8-user-surface-ac-type-and-smoke-gate-in-ship-story.md`), the following sections:
    - **Source-file location convention** — what relative path under `adapter_config.stories_root` BMad stories actually land at. Confirm that `_bmad-output/planning-artifacts/stories/` (the path baked into `BmadAdapter.defaultConfig().stories_root`) is or is not where this repo's stories live, and if not, document the actual convention plus the precedence rule (`adapter_config.stories_root` from `.crew/config.yaml` always wins; the default is best-effort).
    - **Frontmatter fields** — BMad stories use a non-YAML-frontmatter shape (the existing `1-X-*.md` files start with a Markdown H1 like `# Story 1.9: ...` and a `Status: ready-for-dev` line, not `---`-delimited YAML). Document this exactly: the "frontmatter" is a prose header block, not YAML. Enumerate every field the adapter extracts and the heuristic that finds it: story id (parsed from the filename `<epic>-<story>-<slug>.md` and verified against the H1), title (H1 after the colon), status (the `Status: <value>` line near the top), and any other lines treated as semantic (e.g. the `## Story` block, `## Acceptance Criteria`, `## Tasks / Subtasks`).
    - **Lifecycle vocabulary** — list the exact strings the `Status:` line can take. Confirmed values from `_bmad-output/implementation-artifacts/sprint-status.yaml`'s STATUS DEFINITIONS comment block: `backlog`, `ready-for-dev`, `in-progress`, `done`, `optional`, plus the legacy `contexted` (Story 3.1 mentions backward-compat handling). Map each to the plugin's execution-state vocabulary (`to-do | in-progress | blocked | done`). Document `optional` and `contexted` as **unmappable** for execution purposes and call out that the adapter treats them as `to-do` only when explicitly required; otherwise they are skipped from `listSourceStories` (see §Lifecycle mapping rules below).
    - **Acceptance criteria shape** — BMad ACs are bolded numbered headings (`**AC1:**`, `**AC2 (user-surface):**`, `**AC3 (integration):**`) followed by `**Given** ... **When** ... **Then** ...` prose. Document the parsing strategy: numeric prefix is canonical (`AC<n>`), the parenthetical tag is the kind hint. Document the kind-tagging rules in §AC kind tagging below.
    - **Dependency syntax** — BMad stories do not carry a structured `depends_on` field in the existing repo's stories. Document the heuristic the adapter uses to extract dependencies: (a) any line under a section literally named `## Dependencies` or `### Dependencies` (if present), parsed as a bullet list of refs in the form `bmad:<epic>.<story>` or `<epic>-<story>-<slug>`; (b) if no such section exists, `depends_on: []`. This is intentionally lenient because the existing in-repo BMad stories do not declare dependencies structurally; the adapter must not invent dependencies from prose.
    - **`raw_frontmatter` carrier** — define what the adapter stuffs into `raw_frontmatter` given that BMad has no real frontmatter. Default: `{ status: "<status-string>", title: "<title>", id: "<id>" }`. Anything additional is documented here so a future adapter consumer knows what to expect.
  - [ ] 1.3 The spike is a maintainer-facing reference, not a user doc. It must NOT be linked from `README.md`, `plugins/crew/README.md`, or `plugins/crew/docs/README-install.md`. It IS linked from this story's References block and from the BMad adapter's source via a TSDoc `@see` comment on the `BmadAdapter` export.
  - [ ] 1.4 Length budget: 1–3 pages of Markdown. The spike is to unblock implementation, not to specify it. Where the spike's findings disagree with this story's tasks, **the spike wins** and the dev MUST flag the disagreement in the Dev Agent Record so the orchestrator can correct course before PR.

- [ ] **Task 2 — `detect()` implementation (AC: 4, 5)**
  - [ ] 2.1 Implement `BmadAdapter.detect(targetRepo: string): Promise<boolean>` in `plugins/crew/mcp-server/src/adapters/bmad/index.ts`. Replace the `NotImplementedError` throw.
  - [ ] 2.2 Detection rule: return `true` iff the target repo contains a non-empty directory at the path `adapter_config.stories_root` (default: `_bmad-output/planning-artifacts/stories`). The function is given the `targetRepo` absolute path; resolve `stories_root` against it. If the directory does not exist OR exists but contains zero files matching the BMad story filename pattern (`<digits>-<digits>-<slug>.md` — see Task 3.2), return `false`.
  - [ ] 2.3 **Important:** `detect()` cannot read `.crew/config.yaml` to find a custom `stories_root` because at detection time the config may not yet exist (first-run auto-detect path; Story 1.2 AC2). Use the default from `BmadAdapter.defaultConfig().stories_root`. If a custom `stories_root` is configured, the registry consults `detect()` only when there is no config — so the default is correct.
  - [ ] 2.4 Failure modes:
    - Permission errors reading the directory → return `false` (do not throw; the registry treats throws as "this adapter is broken", not "this adapter doesn't match").
    - The path exists but is a file, not a directory → return `false`.
    - The directory exists but contains only non-`.md` files → return `false`.
  - [ ] 2.5 Performance: detect is called once per first-run; a single `readdir` is acceptable. Do NOT walk recursively in `detect()`.

- [ ] **Task 3 — `listSourceStories()` + the parser (AC: 2, 5)**
  - [ ] 3.1 Implement `BmadAdapter.listSourceStories(): Promise<SourceStory[]>`. Replace the current `return []` stub.
  - [ ] 3.2 Discovery: walk `adapter_config.stories_root` (this method DOES have config access — Story 3.1's `getActiveAdapter()` plumbs adapter config through to runtime). Filename pattern is `^\d+-\d+-[a-z0-9-]+\.md$`. Files not matching are skipped silently. Subdirectories are walked one level deep only (defensive — current BMad layout is flat; this leaves room for future epic-grouped subdirs without code change).
  - [ ] 3.3 Per-file parsing — extract a new helper at `plugins/crew/mcp-server/src/adapters/bmad/parse-bmad-story.ts` (this filename is pre-allocated by the architecture project-structure tree; see References). The helper exports a single function `parseBmadStory(absPath: string, fileContents: string): SourceStory`. It is pure (no I/O beyond what the caller passes in) so it is trivially unit-testable.
  - [ ] 3.4 Parser contract:
    - **`ref`**: `bmad:<epic>.<story>` derived from the filename `<epic>-<story>-<slug>.md`. The slug is **not** part of the ref — the ref is stable across renames; the slug is descriptive only. Validate that the H1 inside the file agrees with the parsed epic/story numbers; on disagreement, throw `MalformedBmadStoryError` (a new typed error — see Task 6).
    - **`title`**: the H1 text after the colon (e.g. `# Story 1.9: Ship a pre-built dist/ with the plugin` → `Ship a pre-built dist/ with the plugin`). Strip leading/trailing whitespace; preserve inline backticks.
    - **`narrative`**: the body of the first `## Story` section, **excluding** any nested `### What this story is, in one sentence` / `### What this story is NOT` blocks. The narrative is the "As a / I want / So that" paragraph. Preserve Markdown inline formatting; strip trailing whitespace per line.
    - **`acceptance_criteria`**: parse the `## Acceptance Criteria` section. For each `**AC<n>` heading, capture the prose until the next `**AC<n+1>` heading or section break. Tag each AC per §AC kind tagging below. The output shape is `{ text: string, kind: "integration" | "unit" }` — strip the `**AC<n> (...):**` prefix from `text`; the AC index is implicit in array order (and can be reconstructed if needed for a future v2). HTML comments inside an AC block (e.g. `<!-- Not user-surface: ... -->`) are stripped from `text`.
    - **`depends_on`**: parse the optional `## Dependencies` section per Task 1.2's syntax. Default `[]`. Refs are returned in the form `bmad:<epic>.<story>` regardless of whether the source wrote them as `bmad:1.2` or `1-2-foo` — the parser normalises.
    - **`implementation_notes`**: optional. If a `## Dev Notes` or `## Implementation Notes` section exists, capture its full Markdown body; otherwise `undefined`.
    - **`raw_path`**: the absolute path passed in by `listSourceStories` (which is `path.join(targetRepo, stories_root, <filename>)`).
    - **`raw_frontmatter`**: `{ status: "<status-string>", title: "<title>", id: "<epic>.<story>", filename_slug: "<slug>" }`. The `id` here is the BMad-native id (sans `bmad:` prefix); the prefixed form lives in `ref`.
    - **`source_hash`**: sha256 of `fileContents` (the exact bytes read from disk). Use `node:crypto`'s `createHash('sha256').update(fileContents).digest('hex')`. No newline normalisation; the hash is over the bytes the caller passed in.
  - [ ] 3.5 §AC kind tagging — the kind heuristic, in order:
    - (a) If the AC heading itself carries `(integration)` — e.g. `**AC5 (integration):**` — kind is `integration`.
    - (b) If the AC heading carries `(user-surface)` — e.g. `**AC1 (user-surface):**` — kind is `integration`. Rationale: user-surface ACs are by construction end-to-end and exercised via Story 1.8's smoke gate; they belong on the integration side of the planning-discipline split (Story 3.5 will treat them as state-mutating).
    - (c) If the AC heading carries any other parenthetical (or none), default kind is `unit`. The planning-discipline validator (Story 3.5) is responsible for raising the bar when a state-mutating story lacks an `integration` AC — this adapter just reports what it sees.
    - The parenthetical is matched case-insensitively. Unknown parentheticals (e.g. `(spike)`) are treated as the default-`unit` case; the spike is a maintainer concern, not an enforcement signal here.
  - [ ] 3.6 §Lifecycle mapping rules — produced for use by Task 4 (reconciliation):
    - `backlog` → execution state `to-do`.
    - `ready-for-dev` → execution state `to-do` (the manifest moves it to `in-progress` on claim; the adapter does not pre-assert).
    - `in-progress` → execution state `in-progress`.
    - `done` → execution state `done`.
    - `optional` → **skipped** by `listSourceStories` (returned as if absent; the manifest layer never sees them). Document in the spike that operators should remove `optional` if they want execution.
    - `contexted` (legacy) → execution state `to-do` for backward compatibility. Story 3.1 has the same backward-compat rule for epic-level entries; mirror it here.
    - Any other string → throw `MalformedBmadStoryError` naming the unknown status. Do not silently default.
  - [ ] 3.7 Ordering: `listSourceStories` returns stories in `(epic_num, story_num)` ascending order — sorted numerically, not lexicographically (so `1.10` follows `1.9`, not `1.1`). Stable order is load-bearing because Story 3.2's `scan-sources` idempotency check compares ref sets, and downstream tools that paginate (Story 4.x) will assume order.

- [ ] **Task 4 — `readSourceStory()` + status reconciliation (AC: 2, 3, 5)**
  - [ ] 4.1 Implement `BmadAdapter.readSourceStory(ref: string): Promise<SourceStory>`. Strip the `bmad:` prefix, find the file under `stories_root` whose filename starts with `<epic>-<story>-`, read it, parse with `parseBmadStory`, return the result.
  - [ ] 4.2 Errors:
    - Unknown ref (no file matches) → throw `UnknownBmadRefError` (typed; extends the existing `DomainError` hierarchy — see `mcp-server/src/errors.ts`).
    - Multiple files match the same `<epic>-<story>-` prefix → throw `AmbiguousBmadRefError`. This shouldn't happen but the failure mode is real; surface it.
    - Parse failure → propagate `MalformedBmadStoryError` from the parser.
  - [ ] 4.3 §Status reconciliation (AC3) — this is the load-bearing behaviour:
    - The adapter exposes a helper `reconcileStatus(sourceStatus: string, manifestStatus: string): ReconciliationOutcome` exported from `plugins/crew/mcp-server/src/adapters/bmad/map-bmad-status.ts` (filename pre-allocated by the architecture tree).
    - `ReconciliationOutcome` is a discriminated union: `{ kind: "agree" } | { kind: "discrepancy", source: string, manifest: string, severity: "info" | "warn" | "block" }`.
    - The discrepancy matrix:
      - Source `done`, manifest `to-do` → `{ kind: "discrepancy", severity: "warn" }`. (Operator probably edited BMad to mark a story done without it ever entering the loop.)
      - Source `done`, manifest `in-progress` → `{ kind: "discrepancy", severity: "block" }`. (This is the AC3 case: BMad says Done, we say in-progress. Block the silent override.)
      - Source `done`, manifest `done` → `{ kind: "agree" }`.
      - Source `done`, manifest `blocked` → `{ kind: "discrepancy", severity: "block" }`.
      - Source `in-progress`, manifest `to-do` → `{ kind: "discrepancy", severity: "info" }` (likely benign re-classification).
      - Source `in-progress`, manifest `done` → `{ kind: "discrepancy", severity: "warn" }` (manifest says done but BMad reverted; ask the operator).
      - All other combinations → `{ kind: "agree" }` unless the source status maps to an execution state different from the manifest's, in which case `{ kind: "discrepancy", severity: "info" }`.
    - The reconciliation prompt itself (the user-facing surface) is **NOT** implemented in this story. The adapter returns the structured outcome; Story 3.2's `scan-sources` is responsible for surfacing it. This story's job is to make the outcome computable and to unit-test the matrix.
  - [ ] 4.4 `readSourceStory` itself does NOT call `reconcileStatus`. Reconciliation is a separate call site that Story 3.2's `scan-sources` invokes after reading both the source and the existing manifest. Keep the concerns separated.

- [ ] **Task 5 — `resolveSourcePath()` (AC: 4, 5)**
  - [ ] 5.1 Implement `BmadAdapter.resolveSourcePath(ref: string): string`. Strip `bmad:`, locate the file under `stories_root`, return the absolute path. This method is synchronous in the interface — and it's used by dev/reviewer subagents who need the file path to read directly.
  - [ ] 5.2 To support synchronous lookup without I/O on every call, build a one-shot in-memory ref→path index lazily, populated the first time `listSourceStories` runs in this process. Subsequent `resolveSourcePath` calls hit the cache.
  - [ ] 5.3 If `resolveSourcePath` is called before any `listSourceStories` (cold-cache path), it falls back to a synchronous directory listing via `fs.readdirSync` against `stories_root`. This is acceptable because the cold path runs at most once per process lifetime.
  - [ ] 5.4 Unknown ref → throw `UnknownBmadRefError` (same as `readSourceStory`).

- [ ] **Task 6 — Typed errors (AC: 2, 3, 5)**
  - [ ] 6.1 Extend `plugins/crew/mcp-server/src/errors.ts` with three new error classes, each subclassing the existing `DomainError` (or whatever the canonical base is in that file — confirm by reading it before editing):
    - `MalformedBmadStoryError` — thrown by the parser when an H1 mismatches the filename, a status string is unknown, or an AC block cannot be parsed.
    - `UnknownBmadRefError` — thrown when a ref does not resolve to a file.
    - `AmbiguousBmadRefError` — thrown when two files share an epic/story prefix.
  - [ ] 6.2 Each error carries the offending path, ref, and (where applicable) the offending status/AC text in its `details` payload. The MCP-tool layer turns these into user-readable strings; the adapter is responsible only for raising them with full structured context.
  - [ ] 6.3 If `DomainError` does not yet exist (verify by reading `errors.ts`), use the existing pattern (likely `NotImplementedError extends Error` plus a `name` field) and match it. Do NOT introduce a new error-hierarchy class in this story.

- [ ] **Task 7 — Fixture target repo (AC: 4, 5)**
  - [ ] 7.1 Create the fixture tree under `plugins/crew/mcp-server/src/adapters/bmad/fixtures/`. The directory does not exist today; create it. The architecture tree spells it as `mcp-server/src/adapters/bmad/fixtures/`; the epic uses the same path (`mcp-server/src/adapters/bmad/fixtures/`) — match that exactly. Note the path in the epic AC says `mcp-server/src/adapters/bmad/fixtures/` (relative to the plugin root); resolve against `plugins/crew/`.
  - [ ] 7.2 The fixtures are split into **two sibling target repos** under `fixtures/`. The happy-path repo (`sample-target-repo/`) is what `listSourceStories()` tests walk; the error-path repo (`sample-malformed-repo/`) holds only the intentionally-broken fixtures, which the `readSourceStory()` malformed-error tests target directly via explicit refs. This split is required because `listSourceStories()` walks the entire `stories_root` and the parser throws on H1-mismatch / unknown-status mid-walk (Tasks 3.2, 3.4, 3.6) — so the two broken files cannot co-exist with the happy-path inventory in a single tree. Layout:
    ```
    fixtures/sample-target-repo/                        # happy-path only
    ├── .crew/
    │   └── config.yaml                    # adapter: bmad, adapter_config.stories_root: _bmad-output/planning-artifacts/stories
    └── _bmad-output/
        └── planning-artifacts/
            └── stories/
                ├── 1-1-scaffold-the-thing.md
                ├── 1-2-add-a-feature.md
                ├── 1-10-handle-tenth-story.md          # exercises numeric ordering vs 1-2
                ├── 2-1-cross-epic-story.md
                ├── 2-2-state-mutating-with-integration.md
                ├── 2-3-done-status-story.md            # for reconciliation tests
                └── 2-4-optional-status-story.md        # for skip-optional test

    fixtures/sample-malformed-repo/                     # error-path only
    ├── .crew/
    │   └── config.yaml                    # same shape as sample-target-repo
    └── _bmad-output/
        └── planning-artifacts/
            └── stories/
                ├── 2-1-valid-sibling.md                # minimal valid story so stories_root discovery succeeds
                ├── 2-5-malformed-h1-mismatch.md        # for parser-error test (readSourceStory("bmad:2.5"))
                └── 2-6-unknown-status.md               # for parser-error test (readSourceStory("bmad:2.6"))
    ```
  - [ ] 7.3 Each fixture story must include: an H1 matching the filename, a `Status:` line, a `## Story` block with a "As a / I want / So that" paragraph, and a `## Acceptance Criteria` block with at least one AC. AC variety across the fixtures must collectively cover: a plain `**AC1:**`, a `**AC2 (user-surface):**`, and an `**AC3 (integration):**` — so the kind-tagger sees all three branches.
  - [ ] 7.4 At least one fixture story (`2-2-state-mutating-with-integration.md`) must include a `## Dependencies` section listing one dependency in `bmad:1.1` form, to exercise dependency parsing and the ref-normalisation step.
  - [ ] 7.5 The two intentionally-broken fixtures (`2-5-malformed-h1-mismatch.md`, `2-6-unknown-status.md`) live under `sample-malformed-repo/` (NOT `sample-target-repo/`) and are used by the parser-error tests to assert error paths via `readSourceStory(ref)` with explicit refs. They must be **clearly commented** with an HTML comment at the top: `<!-- INTENTIONALLY MALFORMED for parser error tests. Do not "fix". -->`.
  - [ ] 7.6 The fixture is committed to git. It is NOT gitignored. (Confirm by checking `plugins/crew/.gitignore` after creating — the broad `dist/` rule is gone post-Story-1.9; nothing else should swallow `src/adapters/bmad/fixtures/`.)
  - [ ] 7.7 Do NOT use the live `_bmad-output/implementation-artifacts/` files as fixtures. Reason: those files are this repo's actual story specs, owned by the orchestrator; using them as test inputs couples the adapter test to ongoing planning churn. The fixture must be a self-contained scenario.

- [ ] **Task 8 — Vitest integration suite (AC: 4, 5)**
  - [ ] 8.1 Add `plugins/crew/mcp-server/tests/bmad-adapter.test.ts`. Existing test files use vitest's `describe`/`test`/`expect`; match that style (see `workspace-resolver.test.ts`, `validate-active-adapter.test.ts` for the closest precedents). Imports use the `.js` extension convention (NodeNext ESM resolution).
  - [ ] 8.2 The suite must include the following test groups, each named with `describe`:
    - `detect()` — three sub-tests: matches the fixture repo (true); rejects a target repo with no `_bmad-output/` (false); rejects a target repo where `stories_root` is empty (false).
    - `listSourceStories()` — sub-tests:
      - Returns the expected number of `SourceStory` objects (one per non-`optional` fixture story).
      - Returns them in numeric `(epic, story)` order (verify `1.10` comes after `1.2`).
      - `optional`-status fixture is skipped.
      - Every returned story has the full `SourceStory` shape (no `undefined` for required fields).
      - AC kind tagging: at least one story has an `integration` AC, one has a `unit` AC, one has a `user-surface` AC normalised to `integration`. Assert per-AC `kind` exactly.
      - `depends_on` on `2-2-state-mutating-with-integration.md` returns `["bmad:1.1"]` (verify ref normalisation).
      - `source_hash` is a 64-char hex string and changes when the file contents change (use `fs.writeFile` against a tmp-copy of the fixture for this assertion; do NOT mutate the committed fixture).
      - `raw_frontmatter` carries the documented `{ status, title, id, filename_slug }` shape.
    - `readSourceStory()` — sub-tests:
      - Against `sample-target-repo/`: returns the same shape as `listSourceStories` for a known ref; throws `UnknownBmadRefError` for `bmad:99.99`.
      - Against `sample-malformed-repo/` (separate adapter instance pointed at this repo): `readSourceStory("bmad:2.5")` throws `MalformedBmadStoryError` (H1 mismatch); `readSourceStory("bmad:2.6")` throws `MalformedBmadStoryError` (unknown status). Call `readSourceStory` directly with the explicit ref — do NOT route through `listSourceStories()` (which would throw mid-walk; that's the contradiction this split fixes).
    - `resolveSourcePath()` — sub-tests: returns the absolute path (against `sample-target-repo/`); throws `UnknownBmadRefError` for an unknown ref; cold-cache path works (call `resolveSourcePath` before `listSourceStories` in a fresh adapter instance).
    - `reconcileStatus()` — at minimum: cover every cell in the §Status reconciliation matrix (Task 4.3). Six rows × the agreement defaults; a parameterised `test.each` is acceptable.
  - [ ] 8.3 The suite resolves fixture paths via `path.join(__dirname, "..", "src", "adapters", "bmad", "fixtures", "sample-target-repo")` for the happy-path tests and `path.join(__dirname, "..", "src", "adapters", "bmad", "fixtures", "sample-malformed-repo")` for the `readSourceStory()` malformed-error tests. Compute `__dirname` from `import.meta.url` per the existing ESM pattern in this repo (see `workspace-resolver.test.ts` for the canonical helper).
  - [ ] 8.4 Run `pnpm --dir plugins/crew test` and confirm the new suite passes alongside every existing suite. Zero new skips, zero new flakes.

- [ ] **Task 9 — Wire-through and exports (AC: 2, 4)**
  - [ ] 9.1 The `BmadAdapter` export already exists in `plugins/crew/mcp-server/src/adapters/bmad/index.ts` and is already referenced by `mcp-server/src/adapters/registry.ts`. Do NOT rename or relocate it.
  - [ ] 9.2 If `parse-bmad-story.ts` and `map-bmad-status.ts` introduce exports that the rest of the codebase or tests need (the test suite needs `reconcileStatus`), export them from `mcp-server/src/adapters/bmad/index.ts` via re-export so consumers have a single entry point per adapter.
  - [ ] 9.3 Update the TSDoc comment block on `BmadAdapter` to remove the "lands in Story 3.3" placeholder and add a `@see plugins/crew/docs/spikes/bmad-format.md` reference.
  - [ ] 9.4 **Verify dist commit (Story 1.9 contract):** after all code changes, run `pnpm --dir plugins/crew build` from the plugin root and `git add plugins/crew/mcp-server/dist/`. The committed `dist/` must reflect the new source. CI's `git diff --exit-code mcp-server/dist` step will fail the PR otherwise. This is non-negotiable per Story 1.9.

- [ ] **Task 10 — Self-check before handoff**
  - [ ] 10.1 Run the full plugin test suite: `pnpm --dir plugins/crew test`. All suites green.
  - [ ] 10.2 Run `pnpm --dir plugins/crew typecheck` (or whichever script wraps `tsc --noEmit`). Zero errors.
  - [ ] 10.3 Confirm `git status` shows: new files under `plugins/crew/mcp-server/src/adapters/bmad/{parse-bmad-story.ts,map-bmad-status.ts,fixtures/...}`, new `plugins/crew/mcp-server/tests/bmad-adapter.test.ts`, updates to `index.ts` and `errors.ts`, new `plugins/crew/docs/spikes/bmad-format.md`, and the rebuilt `plugins/crew/mcp-server/dist/`. Nothing under `_bmad-output/implementation-artifacts/` should be staged.

---

## Dev Notes

### Why this story is sequenced where it is

Story 3.1 lands the `PlanningAdapter` interface and the registry — the *shape* of an adapter. Story 3.2 lands the execution manifest, the `scan-sources` tool, and source-hash capture — the *consumer* of an adapter's output. This story is the *first real producer*: the BMad adapter is the v1 reference implementation, and its existence proves the interface from 3.1 is usable and that 3.2's consumer can actually drain a planning tool. Story 3.4 (native adapter) then mirrors this implementation but writes its own source files; if BMad's adapter has a misshapen normalised output, 3.4 will inherit the same shape, so this story sets the contract for every future adapter.

### What's NEW vs UPDATE

**NEW files:**
- `plugins/crew/mcp-server/src/adapters/bmad/parse-bmad-story.ts` — pure parser, no I/O.
- `plugins/crew/mcp-server/src/adapters/bmad/map-bmad-status.ts` — `reconcileStatus` helper + the lifecycle-mapping table.
- `plugins/crew/mcp-server/src/adapters/bmad/fixtures/sample-target-repo/...` and `plugins/crew/mcp-server/src/adapters/bmad/fixtures/sample-malformed-repo/...` — committed fixture target repos (happy-path and error-path, respectively; see Task 7.2).
- `plugins/crew/mcp-server/tests/bmad-adapter.test.ts` — integration suite.
- `plugins/crew/docs/spikes/bmad-format.md` — the AC1 spike. The `spikes/` directory is also new.

**UPDATE files:**
- `plugins/crew/mcp-server/src/adapters/bmad/index.ts` — replace `NotImplementedError` stubs with real implementations; re-export helpers; update TSDoc.
- `plugins/crew/mcp-server/src/errors.ts` — add the three typed errors (Task 6.1).
- `plugins/crew/mcp-server/dist/**` — rebuilt by `pnpm build`, committed per Story 1.9's contract. Do not hand-edit.

**MUST NOT TOUCH:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- Any other story spec file under `_bmad-output/implementation-artifacts/` (including the actual BMad-shaped specs in this repo; the fixture is separate by design — Task 7.7).
- `_bmad-output/planning-artifacts/**` — read-only.
- `plugins/crew/mcp-server/src/adapters/adapter.ts` — interface owned by Story 3.1.
- `plugins/crew/mcp-server/src/adapters/registry.ts` — registry behaviour owned by Story 3.1; this story only relies on `BmadAdapter` already being in the `adapters` array.
- `plugins/crew/mcp-server/src/adapters/native/**` — owned by Story 3.4.
- `plugins/crew/mcp-server/src/tools/scan-sources.ts` (when it exists) — owned by Story 3.2.
- `plugins/crew/mcp-server/src/state/source-hash.ts` (when it exists) — owned by Story 3.2.
- `plugins/crew/mcp-server/package.json` — no new deps unless absolutely necessary. Sha256 is `node:crypto`; YAML reading (for `.crew/config.yaml`) is already handled upstream by the workspace resolver. Path/fs are `node:*`.
- `plugins/crew/.claude-plugin/plugin.json`, `marketplace.json`, or any plugin manifest.
- `.claude/skills/**` (BMad-installed skills are gitignored and treated as third-party).
- The repo-root `CLAUDE.md` (no PM-facing process change in this story).
- `README.md`, `plugins/crew/README.md`, `plugins/crew/docs/README-install.md` — the adapter is a non-user-surface internal seam; install docs do not change.

### Why no `watchForChanges` here

The contract leaves `watchForChanges` optional. Story 3.2 chose polling on skill invoke as the v1 mechanism. Implementing a `chokidar`-style watcher in this story would (a) add a dep, (b) duplicate work that 3.2's polling does correctly, (c) introduce a long-lived background concern that the MCP server's request/response model does not need. Defer.

### Why AC3's reconciliation is split between this story and 3.2

AC3 says "discrepancies surface as a reconciliation prompt rather than a silent override." The **detection** of a discrepancy is an adapter concern (the adapter knows BMad's lifecycle vocabulary; nothing else does). The **surfacing** is a skill/tool concern (the prompt copy, the MCP-tool error shape, the orchestration-loop integration). Split the responsibility cleanly: this story produces `reconcileStatus` returning a typed `ReconciliationOutcome`; Story 3.2's `scan-sources` consumes it and surfaces the prompt. Each story owns one layer; each is testable in isolation.

### Why fixtures live under `src/adapters/bmad/fixtures/` and not `tests/fixtures/`

The architecture project-structure tree pins the fixture path at `mcp-server/src/adapters/bmad/fixtures/`, and the epic AC4 names that path verbatim. Co-locating fixtures with the adapter that owns them makes adapter-extraction (a hypothetical future "split each adapter into its own package") trivial; it also means a maintainer reading the adapter code finds the fixture beside it. This breaks the convention "fixtures live under `tests/fixtures/`" used elsewhere in the codebase, but the architecture decision overrides; do not move the fixture to `tests/fixtures/`.

### Why the parser is pure

`parseBmadStory(absPath, fileContents)` takes the file contents as input rather than reading the file itself. Reason: unit tests can exercise the parser without touching the filesystem (parameterised tests with string-literal Markdown blocks). The I/O lives in `listSourceStories` and `readSourceStory` — the methods that have a directory/ref to resolve. This is the same pattern the workspace-resolver uses.

### Why we don't depend on a YAML library for "frontmatter"

BMad stories in this repo do not carry YAML frontmatter (verified against `1-9-...md`, `1-8-...md`, etc.). The "frontmatter" is prose: an H1, a `Status:` line, and section headers. Parsing it requires nothing more than line-based string splits and a couple of regexes. Do NOT pull in `gray-matter`, `js-yaml`, or `yaml` for this — the workspace resolver may already use `yaml` for `.crew/config.yaml`, which is fine; that's a different file with real YAML.

### Testing standards

- vitest, run via `pnpm --dir plugins/crew test`. The new `bmad-adapter.test.ts` joins the existing suites.
- Parser-only unit tests can be a separate `describe` block or a separate file (`parse-bmad-story.test.ts`); use whichever the dev finds cleaner. The architecture tree implies a single `bmad.test.ts`; the epic AC names "integration tests" plural. Pragmatic choice: one integration test file driving the fixture (`bmad-adapter.test.ts`) plus inline parser tests in the same file is fine. Do not over-fragment.
- The status reconciliation matrix in Task 4.3 is the most error-prone surface. Cover every cell with `test.each`. A missed cell here propagates silently through 3.2 and 3.5.
- Snapshot testing is discouraged for `SourceStory` outputs — the shape is stable enough that explicit `expect(story.title).toBe(...)` assertions are clearer and survive cosmetic changes better.

### Project Structure Notes

- The adapter directory is already scaffolded; only `parse-bmad-story.ts`, `map-bmad-status.ts`, and `fixtures/` are new under it.
- The committed `dist/` will gain the new compiled files (`adapters/bmad/parse-bmad-story.js`, `adapters/bmad/map-bmad-status.js`, plus `.d.ts`). The `dist-shipping.test.ts` sentinel from Story 1.9 will catch a partial build.
- `errors.ts` is at `plugins/crew/mcp-server/src/errors.ts` (14.9K today). Read the full file before editing to match the existing error-class pattern.
- The fixture path under `src/` does NOT confuse `tsc` because TypeScript only compiles `.ts` files by default and fixtures are `.md` + `.yaml`. Confirm by inspecting `plugins/crew/mcp-server/tsconfig.json`'s `include` — if it broadly globs `src/**/*` for non-`.ts` assets, narrow the include to `src/**/*.ts` so fixtures are not copied into `dist/`.

### References

- Epic: [Source: _bmad-output/planning-artifacts/epics/epic-3-backlog-layer-planning-adapters-story-manifests-and-the-planning-conversation.md § Story 3.3]
- Adapter contract: [Source: _bmad-output/planning-artifacts/architecture/planning-adapter-model.md § Adapter contract, § BMad adapter — v1 reference implementation]
- Adapter scaffolding (Stories 1.1, 1.2): [Source: plugins/crew/mcp-server/src/adapters/adapter.ts, plugins/crew/mcp-server/src/adapters/bmad/index.ts, plugins/crew/mcp-server/src/adapters/registry.ts]
- Project structure tree: [Source: _bmad-output/planning-artifacts/architecture/project-structure-boundaries.md § Plugin tree]
- User-surface AC rubric: [Source: plugins/crew/docs/user-surface-acs.md] — no AC in this story qualifies.
- Existing error patterns: [Source: plugins/crew/mcp-server/src/errors.ts]
- BMad lifecycle vocabulary: [Source: _bmad-output/implementation-artifacts/sprint-status.yaml § STATUS DEFINITIONS comment block]
- Dist-shipping contract: [Source: _bmad-output/implementation-artifacts/1-9-ship-a-pre-built-dist-with-the-plugin.md § Task 2, § Build artefacts]
- Story 3.1 (interface owner): _bmad-output/planning-artifacts/epics/epic-3-...md § Story 3.1 (not yet specced as of this story's authoring)
- Story 3.2 (consumer): _bmad-output/planning-artifacts/epics/epic-3-...md § Story 3.2 (not yet specced as of this story's authoring)
- Spike doc target: plugins/crew/docs/spikes/bmad-format.md (created by Task 1)

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
