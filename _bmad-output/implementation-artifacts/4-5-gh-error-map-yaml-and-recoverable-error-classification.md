# Story 4.5: `gh-error-map.yaml` and recoverable-error classification

story_shape: substrate

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **a versioned mapping of `gh` exit codes and stderr regexes to a `defer | retry | needs-human` class, plus an execa-wrapper-side classifier that converts mapped failures into a typed `GhRecoverableError` and a tool-layer side-effect that stamps `blocked_by: gh-<class>` on the in-progress manifest**,
so that **`gh` rate limits, auth expiry, and network blips don't cascade into spurious story failures — the story stays in `in-progress/` (or, once Story 5.1 lands the `blocked/` move, moves there) with a typed blocked reason rather than being marked failed**.

### What this story is, in one sentence

Populate `plugins/crew/permissions/gh-error-map.yaml` with the v1 (exit_code, stderr_regex) → class rows, add a parser + classifier that the existing `gh` execa wrapper (`plugins/crew/mcp-server/src/lib/gh.ts`) calls on every non-zero-exit result to convert mapped failures into a typed `GhRecoverableError` carrying its class, and route that error through a tool-layer side-effect so the in-progress manifest is stamped with `blocked_by: gh-<class>` rather than reaching the "marked failed" terminal state — keeping the recoverable-error → blocked transition entirely in the tool layer (NOT in SKILL.md prose), per `feedback_prose_mut_steps_need_seam.md`.

### What this story fixes (and why it needs its own story)

Story 4.4 shipped the `gh` execa wrapper (`plugins/crew/mcp-server/src/lib/gh.ts`) with `gh_allow` subcommand enforcement and `assertNoNegativeFlags` arg refusal, plus a `GhPrCreateFailedError` raised on non-zero exit from `gh pr create` and "stdout did not contain a PR URL" diagnostics. That error is **terminal** — when it propagates up through `runDevTerminalAction`, the dev subagent's `Task` returns a hard failure to the SKILL.md prose, and the manifest is left in `in-progress/` with no `blocked_by` field. The next `/crew:start` pass sees `waiting-on-in-progress` forever.

That behaviour is wrong for *recoverable* failures. Three concrete cases NFR18 names:

- **Rate limit** (`gh` returns exit 4 or stderr `API rate limit exceeded`) — operator should wait, then re-run. Story is not failed; it's deferred.
- **Auth expiry** (`gh` returns exit 4 or stderr `requires authentication`) — operator runs `gh auth login`, then re-runs. Story is blocked on a human action.
- **Network blip** (`gh` returns exit 1 or stderr `dial tcp:`/`connection reset`/`could not resolve host`) — transient; a retry would work.

Today the wrapper does not distinguish these from genuine spec-violation failures (e.g. `gh pr create` against a branch that has no commits). Story 4.5 closes that gap by adding:

1. **The `gh-error-map.yaml` map** — currently `entries: []` (Story 2.2 shipped the file as a placeholder; AC1's "one YAML per role plus gh-error-map.yaml" count holds but the table is empty).
2. **A parser + classifier** — `lib/gh-error-map.ts`, loaded once per process; matches against the wrapper's `{ exitCode, stderr }` result and returns either `null` (unmapped → existing terminal-error path stays) or `{ class: "defer" | "retry" | "needs-human" }`.
3. **A typed `GhRecoverableError`** — raised by the wrapper when the classifier returns a class; carries `{ class, exitCode, stderr, subcommand }`.
4. **A tool-layer routing point** — `processDevTranscript` learns to detect `GhRecoverableError` surfaced via the dev subagent's transcript (the dev `Task` reports the wrapper's error verbatim in its final message) and stamps `blocked_by: gh-<class>` on the in-progress manifest before returning a new `done-blocked-gh-<class>` next-step to the SKILL.md prose. This is the mutating step — placed in the tool layer per `feedback_prose_mut_steps_need_seam.md`.

This story explicitly does NOT introduce the `blocked/` directory move; Story 5.1 owns the `blocked/` dir + `blockStory` MCP tool. The "moves to `blocked/`" phrasing in AC2 is satisfied for v1 by stamping `blocked_by: gh-<class>` on the manifest (the manifest stays in `in-progress/` carrying the field), and once Story 5.1 lands the dir move it will key off that field. AC3's "stays in `in-progress/` or moves to `blocked/`, never to a failed state" — for v1 the integration test asserts **stays in `in-progress/` with `blocked_by: gh-<class>`** (the "or moves to `blocked/`" clause is forward-compat language for Story 5.1).

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status/state file when implementing this story.
- (b) Add the `blocked/` directory or the `blockStory` MCP tool — Story 5.1 owns that. v1 keeps the manifest in `in-progress/` and stamps `blocked_by: gh-<class>`. The `blocked/` move is a forward-compat clause in AC2/AC3.
- (c) Add a `retry` runtime — the `retry` *class* is a label only in v1; no code attempts automatic retries. The classifier surfaces the label so a future story can build retry logic on top. (Rationale: retrying network blips without a back-off + cap is more dangerous than blocking on them. v1 blocks; v2 adds retry.)
- (d) Change the existing `gh_allow` subcommand allowlist enforcement (`GhSubcommandDeniedError`) or `assertNoNegativeFlags` refusal (`NegativeCapabilityDeniedError`). Those are checks BEFORE spawn; this story adds a check AFTER spawn on the result. The two paths are orthogonal and both remain in the wrapper.
- (e) Change `runDevTerminalAction`'s contract. The composite tool continues to raise `GhPrCreateFailedError` on unmapped failures; on mapped failures the underlying `gh` wrapper now raises `GhRecoverableError` instead, which propagates up through `runDevTerminalAction` unchanged. No new return shape on the success path.
- (f) Add retroactive classification for past failures (no telemetry replay). The classifier runs only on live wrapper invocations from this story's merge forward.
- (g) Add a target-repo override path for `gh-error-map.yaml`. v1 uses the shipped plugin-side map only. (A future story may add a `<target-repo>/.crew/gh-error-map.yaml` override using the same merge pattern as Story 4.9's risk-tiering override; not in scope here.)
- (h) Touch `plugins/crew/skills/start/SKILL.md` prose. The recoverable-error → blocked transition is fully tool-layer (wrapper raises, `processDevTranscript` stamps). The prose only learns about the new `next: "done-blocked-gh-<class>"` value as one more case in its existing switch — that prose update is informational (a chat line announcing the block), not mutating. See § Implementation strategy for the prose-vs-tool placement weighing.
- (i) Touch `processReviewerTranscript`. The reviewer subagent doesn't (yet) call `gh` from within its inner loop in a way that triggers recoverable failures during the dev cycle — reviewer `gh` calls happen in Stories 4.6/4.6b/4.7/4.8 and those stories will route reviewer-side recoverable errors through their own paths. v1's routing point is `processDevTranscript` only.
- (j) Add `blocked_by` to any new schema. The execution-manifest schema already declares `blocked_by?: string` (Story 3.5 / 3.7); this story uses the existing field with new string values: `gh-defer | gh-retry | gh-needs-human`.
- (k) Mutate the manifest from inside `lib/gh.ts`. The wrapper RAISES; the routing tool (`processDevTranscript`) WRITES. Separation of concerns: the wrapper is a pure execa adapter with classification; the manifest mutation lives in the same tool that already handles `blocked_by: handoff-grammar` and `blocked_by: reviewer-grammar` (`processDevTranscript` / `processReviewerTranscript`).
- (l) Modify `gh-error-map.yaml`'s top-level shape (still `entries: <list>`). Only the contents change: from `[]` to the v1 rows.
- (m) Emit telemetry. Story 4.12 owns telemetry; this story is silent on JSONL events. (When Story 4.12 lands, a `gh.recoverable` event keyed on `{ class, subcommand, exitCode }` is the obvious follow-up — out of scope here.)
- (n) Sign or version the map. v1 map is committed to the plugin and ships with the plugin version. No `version:` field in the YAML; bumping the map = bumping the plugin.

---

## Acceptance Criteria

> AC1, AC2, and AC3 are verbatim from the epic. None reference a slash command, operator-typed CLI, install-doc path, or Claude Code UI element — they describe internal YAML parsing, execa-wrapper post-result classification, and vitest integration. Per `plugins/crew/docs/user-surface-acs.md`, this story is **substrate**; no `(user-surface)` tags apply.

**AC1:**
**Given** `plugins/<plugin>/permissions/gh-error-map.yaml`,
**When** parsed,
**Then** each entry declares `exit_code`, optional `stderr_regex`, and `class` (`defer | retry | needs-human`). _(NFR18)_

<!-- Not user-surface: AC1 describes YAML schema + parser behaviour for a plugin-internal config file. -->

**AC2:**
**Given** a `gh` call that fails with a mapped error,
**When** the execa wrapper inspects the result,
**Then** it raises a typed `GhRecoverableError` carrying the class; the dev session moves the story to `blocked/` with `blocked_by: gh-<class>` rather than marking it failed. _(NFR18)_

<!-- Not user-surface: AC2 describes execa-wrapper-internal error classification and `processDevTranscript`-internal manifest mutation. The "blocked/" move is forward-compat language for Story 5.1; v1 satisfies via `blocked_by` stamp on the in-progress manifest. -->

**AC3 (integration):**
vitest stubs `gh` to return each mapped error class and asserts story stays in `in-progress/` or moves to `blocked/`, never to a failed state.

<!-- Not user-surface: AC3 is the vitest integration suite — internal harness only. -->

### Expanded acceptance specifics (folded into AC1–AC3 above; each clause maps to an AC for the AC-table gate)

**AC1 unpacked.** The map schema, parser shape, and shipped v1 row set:

- (1a) **Top-level shape:** `gh-error-map.yaml` has a single top-level key `entries: <list>` (existing). Empty list is valid (Story 2.2 baseline). The parser is `parseGhErrorMap(filePath: string)` → `{ entries: GhErrorMapEntry[] }`.
- (1b) **Per-entry shape:** each entry is an object with required keys `exit_code: number` and `class: "defer" | "retry" | "needs-human"`, plus optional `stderr_regex: string`. `class` MUST be one of the three literals; any other value raises `MalformedGhErrorMapError` citing the offending row (1-indexed by position in the list) and the offending key.
- (1c) **`stderr_regex` semantics:** when present, the string is compiled as a JavaScript regex (default flags) at parse time. A regex that fails to compile raises `MalformedGhErrorMapError` with `reason: "stderr_regex did not compile"` and the offending pattern. When absent, the entry matches solely on `exit_code`.
- (1d) **Match precedence:** the classifier walks `entries` in file order and returns the first matching row's `class`. Match logic: `result.exitCode === entry.exit_code` AND (if `stderr_regex` present, `entry.stderr_regex.test(result.stderr)`). No match → classifier returns `null`. This means entries with stricter (regex-bearing) conditions for the same exit code MUST appear before catch-all entries with the same exit code; the parser does NOT reorder.
- (1e) **No unknown top-level keys:** the parser rejects unknown top-level keys (`MalformedGhErrorMapError`). Unknown per-entry keys are also rejected — strict-mode Zod schema. (Rationale: typos in `stderr_regex` would be silently ignored otherwise.)
- (1f) **Shipped v1 row set** (the contents the dev agent writes into `plugins/crew/permissions/gh-error-map.yaml`):

    ```yaml
    # gh-error-map.yaml — NFR18 error-class table.
    # See _bmad-output/implementation-artifacts/4-5-gh-error-map-yaml-and-recoverable-error-classification.md
    # § Behavioural contract for entry semantics and match precedence.
    entries:
      # Auth expiry — `gh` returns exit 4 with this stderr when the
      # cached token is invalid. Operator must run `gh auth login`.
      - exit_code: 4
        stderr_regex: "requires authentication|gh auth login"
        class: needs-human

      # Rate limit — `gh` returns exit 4 with API rate limit stderr.
      # Operator waits for window reset, then re-runs.
      - exit_code: 4
        stderr_regex: "API rate limit exceeded|secondary rate limit"
        class: defer

      # Network blip — `gh` returns exit 1 with a connection error.
      # Transient; v1 blocks (v2 will retry).
      - exit_code: 1
        stderr_regex: "dial tcp|connection reset|could not resolve host|i/o timeout|network is unreachable"
        class: retry
    ```

  These are the v1 rows. Additional rows may be appended in later stories; the regexes are intentionally permissive (multiple `|` alternates) because `gh` stderr varies across versions.

- (1g) **Parser return shape:** on success, `parseGhErrorMap` returns `{ entries: Array<{ exit_code: number; stderr_regex?: RegExp; class: "defer" | "retry" | "needs-human" }> }`. The `stderr_regex` is the compiled `RegExp` instance, not the source string — callers do not recompile.
- (1h) **Load-once cache:** the wrapper loads the map once per process (lazy on first call, memoised) via `loadGhErrorMap(pluginRoot)` in `lib/gh-error-map.ts`. The cache key is the resolved absolute path; a test-only `__resetGhErrorMapCacheForTests()` export resets it between tests.

**AC2 unpacked.** The wrapper-side classification, the typed error, and the manifest-stamping side-effect:

- (2a) **Wrapper post-result classification:** in `lib/gh.ts` `gh()`, immediately after `execaImpl` returns and BEFORE the existing happy-path `return { stdout, stderr, exitCode }`, if `result.exitCode !== 0` the wrapper calls `classifyGhError({ exitCode: result.exitCode, stderr: result.stderr ?? "" }, pluginRoot)` and, on a non-null class, raises `GhRecoverableError`. On a null class, the existing non-zero-exit handling stays (the current wrapper returns `{ stdout, stderr, exitCode }` even on non-zero exit; callers like `runDevTerminalAction` already inspect `exitCode` and raise `GhPrCreateFailedError`). The classifier ADDS a path; it does not change unmapped paths.
- (2b) **`GhRecoverableError` shape:** new typed `DomainError` subclass in `errors.ts` with fields `{ class: "defer" | "retry" | "needs-human", exitCode: number, stderr: string, subcommand: string }`. Message: `"gh ${subcommand} failed and was classified as recoverable:${class}. exit=${exitCode}. stderr: ${stderr || '(empty)'}"`. The class is exposed as a typed literal so callers can pattern-match without parsing the message.
- (2c) **Subcommand on the error:** the wrapper passes `subcommand` into the error (from `opts.subcommand`) so downstream stampers can record which `gh` call failed. This is informational only — v1 doesn't branch on subcommand.
- (2d) **Manifest-stamping side-effect lives in `processDevTranscript`:** the dev subagent's `Task` returns a transcript; when the wrapper-raised `GhRecoverableError` propagates up through `runDevTerminalAction` it surfaces in the dev's final message (the dev subagent's persona prompt instructs it to include tool-error diagnostics verbatim in its final message). `processDevTranscript` parses the transcript for a recoverable-error marker (see (2e)) BEFORE calling `parseHandoff`; on detection it reads the in-progress manifest, writes back with `blocked_by: gh-${class}` (where `${class}` is one of `defer | retry | needs-human`), and returns a new `next` literal `"done-blocked-gh-${class}"` carrying a chat line. The existing handoff-grammar / `parseHandoff` path is unchanged when no recoverable-error marker is present.
- (2e) **Recoverable-error marker grammar:** the dev subagent emits a single locked line in its final transcript whenever the wrapper raises `GhRecoverableError`. Locked phrase (verbatim, no paraphrase):
  `gh-recoverable: class=<defer|retry|needs-human> subcommand=<subcommand> exit=<exitCode>`
  The persona body for `generalist-dev` is updated by this story to instruct the subagent: "if any `gh`-invoking tool raises `GhRecoverableError`, emit the verbatim line `gh-recoverable: class=<...> subcommand=<...> exit=<...>` as the last line of your final message before exiting; do NOT emit the handoff phrase." The parser in `processDevTranscript` greps for `/^gh-recoverable: class=(defer|retry|needs-human) subcommand=([a-z0-9-]+) exit=(\d+)/m` in the transcript. The locked-phrase pattern follows Story 4.3's handoff-grammar precedent (Pattern §12 "MUST use locked phrases verbatim; paraphrasing breaks routing"). Drift in the phrase falls through to the existing `parseHandoff` path, which then raises grammar-drift and stamps `blocked_by: handoff-grammar` — operator inspects the transcript and sees both the recoverable error and the grammar drift, recovers manually.
- (2f) **Result for the prose layer:** `processDevTranscript` returns one of three new literal-typed shapes (added to the existing `ProcessDevTranscriptResult` union):
  - `{ next: "done-blocked-gh-defer"; chatLog: string[] }`
  - `{ next: "done-blocked-gh-retry"; chatLog: string[] }`
  - `{ next: "done-blocked-gh-needs-human"; chatLog: string[] }`
  Each carries a verbatim chat line: `gh recoverable error (class=<class>) — story <ref> blocked. blocked_by stamped to gh-<class>. Operator action: <action-hint>.` Action hints: defer → "wait and re-run /crew:start", retry → "transient network error; re-run /crew:start (v2 will auto-retry)", needs-human → "run `gh auth login` then re-run /crew:start".
- (2g) **Manifest read-write atomicity:** the write follows the existing `manifest-io.ts` pattern (`readManifest` → spread → `writeManifest`). No new atomic-rename primitive needed; `writeManifest` already uses Story 1.6's atomic rename. The manifest stays in `in-progress/` for v1 (Story 5.1 will move it to `blocked/`).
- (2h) **No-double-stamp guard:** if the manifest already carries `blocked_by`, `processDevTranscript` OVERWRITES it with the new `gh-${class}` value (the most-recent failure wins). This matches the existing `blocked_by: handoff-grammar` write behaviour. (Rationale: a story that drifted into handoff-grammar then re-ran and hit a recoverable error should reflect the more actionable failure.)
- (2i) **Wrapper-direct callers:** any caller of `gh()` that runs OUTSIDE `runDevTerminalAction` (e.g. future reviewer-side `gh pr diff` in Story 4.6) will see `GhRecoverableError` propagate uncaught. Those callers' stories will route the error in their own ways. v1's only production caller is `runDevTerminalAction`, and the error propagates through it unchanged (the composite tool does not catch the recoverable error — it lets it bubble to the dev subagent, which then emits the locked marker line per (2e)).

**AC3 unpacked.** The integration suite covers each mapped class plus the unmapped fall-through:

- (3a) **Fixture base:** tmpdir with `git init`, an `.crew/state/in-progress/<ref>.yaml` manifest, a fixture story spec with three ACs (mirrors Story 4.4's integration fixture). A stubbed `execaImpl` is injected into `runDevTerminalAction`; the stub returns scripted `{ stdout, stderr, exitCode }` for `gh` invocations.
- (3b) **`defer` class:** stub `gh pr create` to return `{ exitCode: 4, stderr: "API rate limit exceeded", stdout: "" }`. Drive `runDevTerminalAction` end-to-end. Assert: (i) `runDevTerminalAction` raises `GhRecoverableError` with `class: "defer"`, (ii) the dev subagent's transcript (simulated by passing a transcript string into `processDevTranscript` that contains the verbatim locked line `gh-recoverable: class=defer subcommand=pr-create exit=4`) routes through `processDevTranscript` which returns `{ next: "done-blocked-gh-defer", chatLog: [...] }`, (iii) the manifest at `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` is read back and carries `blocked_by: "gh-defer"`, (iv) the manifest stays in `in-progress/` (no file moved to a hypothetical `blocked/` dir; existence-check both dirs), (v) the chat line matches the verbatim shape from (2f).
- (3c) **`needs-human` class:** stub `gh pr create` to return `{ exitCode: 4, stderr: "gh auth login required", stdout: "" }`. Assert mirror of (3b) with `class: "needs-human"`, `blocked_by: "gh-needs-human"`, and the auth-action chat line.
- (3d) **`retry` class:** stub `gh pr create` to return `{ exitCode: 1, stderr: "dial tcp: lookup api.github.com: i/o timeout", stdout: "" }`. Assert mirror of (3b) with `class: "retry"`, `blocked_by: "gh-retry"`, and the retry-action chat line.
- (3e) **Unmapped failure stays terminal:** stub `gh pr create` to return `{ exitCode: 1, stderr: "pull request already exists for branch", stdout: "" }` (a real `gh` error string that does NOT match any v1 row). Assert: (i) the wrapper does NOT raise `GhRecoverableError`, (ii) the existing `GhPrCreateFailedError` path is taken instead, (iii) the manifest does NOT carry `blocked_by: gh-*` (it may carry nothing or another `blocked_by` from earlier in the cycle — assert no `gh-*` prefix).
- (3f) **Match precedence (ordering):** with a fixture map that lists the `needs-human` auth row before the `defer` rate-limit row (both `exit_code: 4`), a result with `{ exitCode: 4, stderr: "requires authentication" }` matches `needs-human` (first match wins, regex required). A result with `{ exitCode: 4, stderr: "API rate limit exceeded" }` skips the auth row (regex doesn't match) and matches the `defer` row.
- (3g) **Optional `stderr_regex`:** with a fixture entry `{ exit_code: 99, class: "defer" }` (no regex), any result with `exitCode: 99` matches regardless of stderr content.
- (3h) **Malformed map:** the parser unit tests cover (i) unknown top-level key, (ii) unknown per-entry key, (iii) `class` not in the literal set, (iv) `stderr_regex` that fails to compile (e.g. `"["`), (v) `exit_code` missing or non-number. Each raises `MalformedGhErrorMapError` with a row index and offending key.
- (3i) **Cache reset between tests:** the integration suite calls `__resetGhErrorMapCacheForTests()` in a `beforeEach` so the per-process cache doesn't bleed across fixtures.
- (3j) **Locked-phrase drift falls through to handoff-grammar:** a transcript containing a paraphrased marker (`gh recoverable error: defer`, missing the verbatim `gh-recoverable: class=...` prefix) does NOT match the recoverable-error parser. The existing `parseHandoff` path runs and (assuming no handoff phrase is present) raises grammar-drift and stamps `blocked_by: handoff-grammar`. Assert: manifest carries `handoff-grammar`, not any `gh-*` value. (This is the safety net: a hallucinated paraphrase from the dev subagent does NOT silently classify as the wrong class.)
- (3k) **Recoverable + handoff coexistence:** if a transcript contains BOTH the locked recoverable line AND the handoff phrase (a hypothetical inconsistent subagent output), the recoverable-error parser wins (it's checked first per (2d)). The manifest is stamped `blocked_by: gh-<class>` and the handoff is ignored. Rationale: the locked recoverable line is emitted only when a tool error fired; the handoff phrase in that case is the subagent overreaching, and we trust the error signal over the handoff signal.
- (3l) **Tool count unchanged:** no new MCP tools are registered by this story (the new logic is internal to `lib/gh.ts`, `lib/gh-error-map.ts`, and `processDevTranscript`). Tool-count assertions in `ask-mode-enforcement.test.ts`, `ask-skill.test.ts`, `get-team-snapshot.test.ts` MUST NOT be bumped.

---

## Tasks / Subtasks

- [ ] **Task 1 — Add `gh-error-map.yaml` schema + parser (AC: 1, 3)**
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/schemas/gh-error-map.ts` with a Zod schema for `{ entries: GhErrorMapEntry[] }`. `GhErrorMapEntry` = `{ exit_code: z.number().int(), stderr_regex: z.string().optional(), class: z.enum(["defer", "retry", "needs-human"]) }`. Strict mode (no unknown keys, top-level or per-entry).
  - [ ] 1.2 Create `plugins/crew/mcp-server/src/lib/gh-error-map.ts`. Export:
    - `parseGhErrorMap(filePath: string): Promise<{ entries: ParsedGhErrorMapEntry[] }>` — reads YAML, validates via Zod, compiles each `stderr_regex` into a `RegExp` (catches compile errors and re-raises as `MalformedGhErrorMapError`).
    - `loadGhErrorMap(pluginRoot: string): Promise<{ entries: ParsedGhErrorMapEntry[] }>` — load-once cache keyed by absolute path; resolves `<pluginRoot>/permissions/gh-error-map.yaml`.
    - `classifyGhError(result: { exitCode: number; stderr: string }, map: { entries: ParsedGhErrorMapEntry[] }): "defer" | "retry" | "needs-human" | null` — walks `entries` in order, returns first matching class or `null`.
    - `__resetGhErrorMapCacheForTests()` — test-only cache reset.
  - [ ] 1.3 Add `MalformedGhErrorMapError` typed error to `errors.ts` with fields `{ filePath, reason, rowIndex?: number, offendingKey?: string }`.
  - [ ] 1.4 Unit tests in `plugins/crew/mcp-server/src/lib/__tests__/gh-error-map.test.ts`:
    - parser happy path (the shipped v1 rows)
    - each malformed case from AC3h
    - `classifyGhError` returns first match in order (AC3f)
    - `classifyGhError` matches on exit_code alone when no regex (AC3g)
    - `classifyGhError` returns `null` on unmapped result (AC3e)
    - cache memoisation (two calls → one parse) and `__resetGhErrorMapCacheForTests` resets

- [ ] **Task 2 — Populate `gh-error-map.yaml` with v1 rows (AC: 1)**
  - [ ] 2.1 Edit `plugins/crew/permissions/gh-error-map.yaml`. Replace `entries: []` with the v1 row set from AC1f (auth → needs-human, rate-limit → defer, network → retry). Preserve the existing header comments and add a pointer to this spec's § Behavioural contract.
  - [ ] 2.2 Spot-check the file parses cleanly via `parseGhErrorMap` in a unit test (separate from Task 1.4's fixture-driven tests — this test loads the shipped file directly).

- [ ] **Task 3 — Add `GhRecoverableError` and wrap `gh()` post-result classification (AC: 2, 3)**
  - [ ] 3.1 Add `GhRecoverableError` to `errors.ts` with fields `{ class: "defer" | "retry" | "needs-human", exitCode: number, stderr: string, subcommand: string }`. Message per AC2b.
  - [ ] 3.2 In `lib/gh.ts` `gh()`, after `execaImpl` returns and BEFORE the existing `return`, if `result.exitCode !== 0` call `loadGhErrorMap(getPluginRoot())` and `classifyGhError(result, map)`. On non-null: throw `GhRecoverableError`. On null: continue to the existing return (preserving today's behaviour for unmapped non-zero exits).
  - [ ] 3.3 Use the existing `getPluginRoot()` from `lib/plugin-root.ts` — do NOT duplicate path resolution.
  - [ ] 3.4 Unit tests in `lib/__tests__/gh.test.ts` (or a sibling file if `gh.test.ts` doesn't exist yet — check first): each mapped class raises `GhRecoverableError` with the right fields; unmapped non-zero exit still returns the existing result shape; spy on `execaImpl` confirms classification runs after spawn, not before.
  - [ ] 3.5 Confirm the existing `assertNoNegativeFlags` and `gh_allow` pre-spawn checks are unchanged (their tests stay green).

- [ ] **Task 4 — Extend `processDevTranscript` with recoverable-error parser + manifest stamp (AC: 2, 3)**
  - [ ] 4.1 In `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts`, ADD a new recoverable-error parse step BEFORE the existing `parseHandoff` call. Grep the transcript for `/^gh-recoverable: class=(defer|retry|needs-human) subcommand=([a-z0-9-]+) exit=(\d+)/m`.
  - [ ] 4.2 On match: `readManifest` → write back with `blocked_by: "gh-${class}"` → return new union variant `{ next: "done-blocked-gh-${class}", chatLog: [<verbatim line from AC2f>] }`.
  - [ ] 4.3 Extend the `ProcessDevTranscriptResult` type union with three new literal variants from AC2f.
  - [ ] 4.4 Unit tests in `__tests__/process-dev-transcript.test.ts`: each class branch (defer / retry / needs-human) stamps the right `blocked_by` and returns the right `next`; the manifest is read-modify-written exactly once per branch; locked-phrase drift falls through to handoff-grammar (AC3j); recoverable + handoff coexistence (AC3k).
  - [ ] 4.5 Cover the chat-line verbatim shape per AC2f in the test assertions (exact-string match including action hint).

- [ ] **Task 5 — Update generalist-dev persona body to instruct the locked marker line (AC: 2)**
  - [ ] 5.1 In `plugins/crew/catalogue/generalist-dev.md`, add a paragraph to the persona body's instruction set: "If any `gh`-invoking tool raises `GhRecoverableError`, emit the verbatim line `gh-recoverable: class=<defer|retry|needs-human> subcommand=<subcommand> exit=<exitCode>` as the last line of your final message before exiting. Do NOT emit the handoff phrase in that case." Use the same prose-fidelity bar Story 4.3 set for the handoff phrase.
  - [ ] 5.2 No test changes — persona body is a knowledge-edit, not a contract-shape change. A future story may add a structural-anchor test asserting the locked-phrase text is present in the persona body.

- [ ] **Task 6 — Integration suite for the recoverable-error path (AC: 2, 3)**
  - [ ] 6.1 Create `plugins/crew/mcp-server/src/tools/__tests__/gh-recoverable.integration.test.ts`.
  - [ ] 6.2 Fixture: reuse the Story 4.4 `runDevTerminalAction` fixture pattern (tmpdir + git init + in-progress manifest + fixture spec). Inject `execaImpl` stub.
  - [ ] 6.3 Cover AC3b (defer), AC3c (needs-human), AC3d (retry), AC3e (unmapped fall-through), AC3f (precedence), AC3g (optional regex), AC3j (drift falls through), AC3k (recoverable + handoff coexistence) — eight scenarios.
  - [ ] 6.4 Each scenario asserts: (i) the wrapper raises the right error type, (ii) `processDevTranscript` returns the right `next` literal, (iii) the in-progress manifest carries the right `blocked_by` value, (iv) the manifest file is still in `<.crew/state/in-progress/>`, never in a hypothetical `<.crew/state/blocked/>` dir, never deleted.
  - [ ] 6.5 Add `beforeEach` calling `__resetGhErrorMapCacheForTests()` (AC3i).

- [ ] **Task 7 — Build, full vitest suite, fs-guard regression (AC: all)**
  - [ ] 7.1 `pnpm build` passes. `dist/` committed per CLAUDE.md.
  - [ ] 7.2 All vitest tests pass; the new test files contribute branches covering AC1 / AC2 / AC3 exhaustively.
  - [ ] 7.3 `canonical-fs-guard.test.ts` still passes — `lib/gh-error-map.ts` only reads from `<pluginRoot>/permissions/gh-error-map.yaml` (a read, not a write); `processDevTranscript` writes only to the in-progress manifest path it already writes (Story 4.3's `blocked_by: handoff-grammar` path).
  - [ ] 7.4 Tool-count assertions in `ask-mode-enforcement.test.ts`, `ask-skill.test.ts`, `get-team-snapshot.test.ts` are NOT bumped (AC3l).
  - [ ] 7.5 No telemetry emit added (Story 4.12 owns telemetry).

---

## Implementation strategy

### Why the wrapper RAISES and the tool WRITES (prose-vs-tool seam placement)

Per `feedback_prose_mut_steps_need_seam.md`: SKILL.md prose is not load-bearing for mutating side-effects. The `blocked_by` stamp is the mutating step in this story. Two viable placements were weighed:

- **Option A (rejected): prose layer reads the new `next: "done-blocked-gh-<class>"` value, then calls a new `blockStory` MCP tool to stamp `blocked_by`.** This puts the mutation behind the prose's switch statement — the same shape that flaked in Story 4.3c's `completeStory` call. Even with a structural-anchor AC asserting the prose contains the call, the LLM can read the MUST, generate the chat line that announces the block, and still skip the actual stamp. Rejected.
- **Option B (chosen): the existing `processDevTranscript` tool detects the locked recoverable-error line in the transcript and stamps `blocked_by` BEFORE returning to the prose layer.** Same shape as Story 4.3's `blocked_by: handoff-grammar` and Story 4.3b's `blocked_by: reviewer-grammar` — proven mutating-step-in-tool-layer pattern. The prose layer only emits the informational chat line; the mutation is guaranteed by the tool. Chosen.

The wrapper itself does NOT call `writeManifest` — that would entangle the execa adapter with state-machine concerns and break the "single-purpose lib" pattern Story 4.4 set. The wrapper RAISES a typed error; the routing tool that already owns `blocked_by` writes (`processDevTranscript`) WRITES. Separation of concerns: classifier in the lib, stamping in the tool.

The new `next: "done-blocked-gh-<class>"` literal value is the prose's only awareness — its switch adds three cases (defer / retry / needs-human) that each emit a chat line. No prose-driven mutation.

### Why the locked-phrase marker (and not a stack trace parse)

The dev subagent's `Task` returns the raw error message in its final transcript verbatim (Claude Code default behaviour: tool errors appear in the subagent's response). One option was to parse the `GhRecoverableError` message format directly out of the transcript with a regex like `/GhRecoverableError.*class.*"(defer|retry|needs-human)"/`. Rejected because:

- The error message format is plumbing; if a future story tweaks the message, the parser silently breaks.
- Pattern §12 already mandates locked phrases for cross-subagent handoffs. A locked marker line is the convention; the message-format parse would be an exception.
- The persona-body instruction (Task 5.1) makes the contract explicit: the subagent emits the locked line, the parser reads the locked line. Symmetric with the handoff phrase (Story 4.3).

The drawback: the subagent has to remember to emit the marker. The handoff-grammar fallback (AC3j) is the safety net — drift in the marker falls through to the existing grammar-drift path, which already blocks the story (with `blocked_by: handoff-grammar`). The operator sees the marker drift in the transcript and recovers manually. No silent failure.

### Why no automated retry in v1

The `retry` class is a label that flags "this was a network blip; a retry would probably work." v1 does NOT auto-retry because:

- A retry without back-off + cap is a thundering-herd hazard against `gh`'s rate limiter.
- The simplest correct retry implementation requires a clock, a cap, and a telemetry hook — none in scope here.
- Blocking on a retry-class error costs the operator one `/crew:start` re-run, which is acceptable v1 friction.

The label still earns its keep: future Story (likely 4.12-era or 5.x) builds the retry runtime and keys off the `gh-retry` `blocked_by` value to auto-unblock + retry. v1 surfaces the label; v2 acts on it.

### Why `blocked/` dir move is deferred to Story 5.1

Epic 5 Story 5.1 ("`block-story` MCP tool and `blocked_by` taxonomy") owns the `blocked/` directory and the `blockStory` MCP tool. AC2's "moves the story to `blocked/`" is forward-compat language — for v1 the manifest stays in `in-progress/` carrying `blocked_by: gh-<class>`, and Story 5.1's `blockStory` tool will later sweep `in-progress/` for any manifest with a `blocked_by` field and atomically move it to `blocked/`. AC3's "stays in `in-progress/` or moves to `blocked/`, never to a failed state" anticipates this: the v1 integration test asserts **stays in `in-progress/` with `blocked_by` stamped**, and Story 5.1's integration test will assert the move.

If Story 5.1 lands BEFORE this story merges (unlikely but possible), the dev agent should re-read Story 5.1's contract and route through `blockStory` instead of writing `blocked_by` directly. Default for this story's spec: stamp via `writeManifest`, same shape as Stories 4.3 / 4.3b.

### Why `processDevTranscript` is the routing point (and not a new tool)

The dev subagent's transcript is where the recoverable-error signal lives. `processDevTranscript` is already the tool that parses the dev transcript for state-changing signals (`parseHandoff` for the happy path; grammar-drift stamping for the unhappy path). Adding a recoverable-error parser to the same tool is the lowest-friction placement:

- No new MCP tool registered (tool-count assertions stay untouched — AC3l).
- No new SKILL.md prose `allowed_tools` entry.
- Single tool owns all "dev-transcript → in-progress manifest mutation" logic.

Alternative placements considered and rejected:

- **A new `processRecoverableGhError` tool called by the prose layer.** Adds a tool, requires `allowed_tools` widening, puts a mutating tool behind the prose's switch (the exact failure mode `feedback_prose_mut_steps_need_seam.md` warns against). Rejected.
- **Wrapper-internal manifest write.** Couples execa adapter to state-machine. Rejected.
- **`runDevTerminalAction` catches `GhRecoverableError` and writes manifest.** The composite tool would acquire state-machine responsibility it doesn't otherwise have, and would need to know `targetRepoRoot`'s manifest layout (it already takes `manifestPath` for spec resolution, so this is technically feasible, but it splits the "blocked_by stamp" surface across two tools — `processDevTranscript` for handoff-grammar, `runDevTerminalAction` for gh-recoverable). Rejected for surface-area unity.

### Risks and mitigations

- **Risk: `gh` stderr varies across versions and the v1 regexes miss new wording.** Mitigation: regexes are intentionally permissive (multiple `|` alternates per row). When operators report a missed classification, append a row in a follow-up PR; no schema change needed. The `entries` list is order-sensitive but additive — new rows at the end don't disturb existing matches.
- **Risk: a real failure that should be terminal (e.g. a malformed PR title) accidentally matches a recoverable regex.** Mitigation: regex alternates are anchored to known-recoverable substrings (`API rate limit exceeded`, `dial tcp`, `requires authentication`). These don't appear in terminal `gh` errors. Defence in depth: the integration suite includes an explicit unmapped-failure test (AC3e) covering a real terminal `gh` stderr (`pull request already exists for branch`); if a future row is too permissive, that test breaks.
- **Risk: load-once cache stales between plugin upgrades.** Mitigation: the cache lives in the MCP server process, which restarts on plugin reload (`claude code` daemon restart). The cache key is the absolute path; if a future story adds target-repo override, the key will need to include both paths. v1 is single-source so the simple cache suffices.
- **Risk: locked-phrase drift means the marker is silently mis-parsed.** Mitigation: the parser regex is strict (`^gh-recoverable: class=(defer|retry|needs-human) subcommand=([a-z0-9-]+) exit=(\d+)`); any drift falls through to `parseHandoff`, which then raises handoff-grammar and stamps `blocked_by: handoff-grammar`. The operator sees both signals in the transcript.
- **Risk: a subagent emits BOTH the handoff phrase AND a recoverable-error marker (inconsistent state).** Mitigation: AC3k pins precedence — recoverable wins. Rationale: the locked recoverable line is emitted only when a tool error fired; the handoff phrase in that case is the subagent overreaching.
- **Risk: the persona-body instruction (Task 5.1) is ignored by the dev subagent at runtime.** Mitigation: this is the same risk Story 4.3 carries for the handoff phrase. The handoff-grammar fallback covers it — drift in the marker yields a blocked story, not a green one. Operators recover manually.

---

## Dev Notes

### Behavioural contract

The new utility file `lib/gh-error-map.ts`, the extended `lib/gh.ts`, and the extended `processDevTranscript` MUST cite this section by full path (`_bmad-output/implementation-artifacts/4-5-gh-error-map-yaml-and-recoverable-error-classification.md § Behavioural contract`) in TSDoc at the top of the file or above the new functions.

#### `parseGhErrorMap` / `loadGhErrorMap` / `classifyGhError` invariants

- **MUST** validate YAML via Zod strict-mode (no unknown top-level or per-entry keys). Unknown keys raise `MalformedGhErrorMapError` citing the offending key.
- **MUST** compile each `stderr_regex` at parse time and re-raise compile errors as `MalformedGhErrorMapError` with `reason: "stderr_regex did not compile"`.
- **MUST** preserve entry order from the YAML; `classifyGhError` returns the first matching row's class. The parser does NOT reorder.
- **MUST** return `null` from `classifyGhError` when no row matches (unmapped → existing terminal path).
- **MUST** memoise `loadGhErrorMap` by absolute path. The test-only `__resetGhErrorMapCacheForTests()` resets the cache.
- **MUST NOT** mutate any file. The map is read-only at runtime.

#### `gh()` wrapper invariants (extended by this story)

- **MUST** preserve all pre-spawn checks unchanged (`gh_allow` enforcement, `assertNoNegativeFlags`, `gh_allow_args`).
- **MUST** call `classifyGhError` on every non-zero-exit result, AFTER `execaImpl` returns and BEFORE the existing `return` statement.
- **MUST** raise `GhRecoverableError` when the classifier returns a non-null class. The error carries `{ class, exitCode, stderr, subcommand }`.
- **MUST NOT** raise `GhRecoverableError` on `exitCode === 0` (the happy path is unchanged).
- **MUST NOT** mutate the manifest, write telemetry, or retry. The wrapper is a pure execa adapter with classification.
- **MUST** continue to return the existing `{ stdout, stderr, exitCode }` shape on unmapped non-zero exits (today's callers like `runDevTerminalAction` inspect `exitCode` and raise their own typed errors).

#### `processDevTranscript` invariants (extended by this story)

- **MUST** check for the locked recoverable-error line `^gh-recoverable: class=(defer|retry|needs-human) subcommand=([a-z0-9-]+) exit=(\d+)` BEFORE calling `parseHandoff`.
- **MUST** stamp `blocked_by: gh-<class>` on the in-progress manifest atomically (read → spread → write via `manifest-io.ts`'s existing primitives) when the locked line matches.
- **MUST** return one of the three new `next: "done-blocked-gh-<class>"` literal variants with a verbatim chat line per AC2f.
- **MUST NOT** call `parseHandoff` when the recoverable-error line matched. The recoverable signal takes precedence.
- **MUST NOT** call any new MCP tool. The manifest write goes through `manifest-io.ts`'s `writeManifest` (same primitive already used for `blocked_by: handoff-grammar`).
- **MUST** preserve the existing grammar-drift fallback: if the locked line does NOT match AND `parseHandoff` returns `{ ok: false }`, the existing `blocked_by: handoff-grammar` path runs unchanged.

### File map (likely — refine during implementation)

**New files:**
- `plugins/crew/mcp-server/src/lib/gh-error-map.ts` (parser + classifier + load-once cache)
- `plugins/crew/mcp-server/src/schemas/gh-error-map.ts` (Zod schema)
- `plugins/crew/mcp-server/src/lib/__tests__/gh-error-map.test.ts` (unit tests)
- `plugins/crew/mcp-server/src/tools/__tests__/gh-recoverable.integration.test.ts` (integration suite)

**Modified files (NOT locked):**
- `plugins/crew/permissions/gh-error-map.yaml` (replace `entries: []` with v1 rows from AC1f; preserve header comments and add spec pointer)
- `plugins/crew/mcp-server/src/lib/gh.ts` (add post-result classification call; raise `GhRecoverableError` on non-null class)
- `plugins/crew/mcp-server/src/lib/__tests__/gh.test.ts` (or sibling — check first; add wrapper-side classification tests)
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` (add recoverable-error parser before `parseHandoff`; new union variants; new manifest-stamp branch)
- `plugins/crew/mcp-server/src/tools/__tests__/process-dev-transcript.test.ts` (cover the three new class branches, drift fallback, coexistence)
- `plugins/crew/mcp-server/src/errors.ts` (add `GhRecoverableError`, `MalformedGhErrorMapError`)
- `plugins/crew/catalogue/generalist-dev.md` (persona body: instruction to emit the locked recoverable-error marker line)
- `plugins/crew/mcp-server/dist/` (rebuild; commit per CLAUDE.md)

**Locked files (NOT modified by this story):**
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts` — outer-loop claim primitive owned by Story 4.3b. No changes needed; recoverable errors surface AFTER claim, in the dev transcript.
- `plugins/crew/mcp-server/src/tools/claim-story.ts` — atomic claim primitive owned by Story 4.1. No changes; this story doesn't touch claim semantics.
- `plugins/crew/mcp-server/src/tools/complete-story.ts` — atomic complete primitive owned by Story 4.1 (and called internally by `processReviewerTranscript` per Story 4.3c). No changes; recoverable errors never reach `completeStory` (the dev cycle blocks before the reviewer runs).
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` — reviewer-transcript routing owned by Story 4.3b / 4.3c. No changes; reviewer-side `gh` recoverable errors will be routed in Stories 4.6 / 4.6b / 4.7 / 4.8, not here. (v1's only recoverable-error routing point is `processDevTranscript` because v1's only production `gh` caller is `runDevTerminalAction`, which the dev subagent invokes.)
- `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts` — composite tool from Story 4.4. The new `GhRecoverableError` propagates THROUGH it unchanged; no `try/catch`, no shape change. (The composite raises the recoverable error; the dev subagent emits the locked marker line per Task 5.1; `processDevTranscript` then handles it.)
- `plugins/crew/mcp-server/src/lib/manifest-io.ts` — already provides atomic `readManifest` / `writeManifest`. Used as-is.
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` — `blocked_by?: string` field already declared (Story 3.5 / 3.7). v1's new values (`gh-defer`, `gh-retry`, `gh-needs-human`) are plain strings; no schema change needed.
- `plugins/crew/skills/start/SKILL.md` — prose layer only learns three new switch cases by reading new `next` literals. The new switch cases emit informational chat lines (already-pushed `chatLog` strings from `processDevTranscript`) — no mutating step in the prose. (SKILL.md may need a minimal additive edit listing the three new `next` cases, but this is informational prose, not a contract-shape change. The integration suite asserts the manifest stamp via the tool layer, not via SKILL.md text.)

### Dependencies

This story depends on:
- Story 1.6 (atomic fs-rename) — `writeManifest` uses this for the `blocked_by` stamp.
- Story 2.2 (per-role permission spec files) — shipped `gh-error-map.yaml` placeholder.
- Story 3.5 / 3.7 (execution-manifest `blocked_by` field) — re-used by this story.
- Story 4.1 (`claimStory` / `completeStory`) — the dev subagent is already inside `in-progress/<ref>.yaml` when the recoverable error fires.
- Story 4.3 (handoff phrase + grammar-drift `blocked_by` stamping) — the precedent pattern this story extends.
- Story 4.3b (`processDevTranscript` tool + transcript-in/verdict-out shape) — extended by this story.
- Story 4.4 (`gh` execa wrapper, `runDevTerminalAction`, `GhPrCreateFailedError`) — extended by this story; `GhPrCreateFailedError` stays as the unmapped-failure path.

Downstream stories that will consume this story's surface:
- Story 4.6 / 4.6b / 4.7 / 4.8 — reviewer-side `gh` callers; their stories will route `GhRecoverableError` on the reviewer side (likely via `processReviewerTranscript` extension or a new tool).
- Story 4.12 — telemetry; will emit `gh.recoverable` events keyed on `{ class, subcommand, exitCode }`.
- Story 5.1 — `blocked/` dir + `blockStory` MCP tool. Will sweep `in-progress/` for manifests with `blocked_by` and atomically move them. Includes `gh-defer | gh-retry | gh-needs-human` in the `blocked_by` taxonomy.

---

## Completion notes

Ultimate context engine analysis completed — comprehensive developer guide created. `gh-error-map.yaml` populated with three v1 rows (auth → needs-human, rate-limit → defer, network → retry). `lib/gh-error-map.ts` adds a strict-mode Zod parser, load-once cache, and `classifyGhError` walker. `lib/gh.ts` wrapper extended with a post-result classification call that raises `GhRecoverableError` on non-null class. `processDevTranscript` extended with a recoverable-error parser (locked phrase `gh-recoverable: class=<class> subcommand=<sub> exit=<n>`) that stamps `blocked_by: gh-<class>` on the in-progress manifest BEFORE returning a new `done-blocked-gh-<class>` next literal. Manifest stays in `in-progress/` for v1 (Story 5.1 owns the `blocked/` move). Story is substrate — no user-surface ACs, no smoke-evidence requirement, no new MCP tools registered.
