# Story 1.10: README rewrite — match observed Claude Code UI reality

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Maya, the relatively-technical non-engineer following the install README on a clean machine**,
I want **every command and confirmation in the README to behave exactly as the README claims**,
so that **I don't hit "the docs said I'd see X, but Claude Code showed me a UI panel" mid-install and lose trust in whether the rest of the plugin works.**

### What this story fixes (and why it needs its own story)

The current `plugins/crew/docs/README-install.md` describes `/plugin marketplace add` as printing a stdout confirmation line (e.g. `Marketplace added: crew`). In Claude Code 2.1.x it actually opens an interactive **Marketplaces** TUI panel — no stdout line, the operator confirms inside the panel and lands on a named tab. `/plugin install crew@crew` has the same shape: it opens a TUI flow, can fail validation with a `temp_local_*` cache caveat, and only finishes by surfacing a panel state, not a `Plugin installed: …` stdout line.

The README's "Expected confirmation" copy is **fiction** — drafted by an agent that never ran the commands. PR #61 surfaced this when Jack actually tried the install live: every "Expected confirmation" line in steps 3a, 3b, and 4 was wrong, and the restart step under-explained why a quit-and-reopen is non-optional (MCP servers only start at Claude Code launch — `/plugin install` does NOT spawn them mid-session).

Story 1.10 rewrites `plugins/crew/docs/README-install.md` so every step describes what a real operator actually sees, and routes the rewrite through Story 1.8's pre-PR smoke gate as the **first concrete, non-self-referential production user of that gate**. The gate forces an operator to run each README command verbatim in real Claude Code, paste the observed UI/toast/output, and confirm match — any mismatch fails the gate and the README must be edited until reality and copy agree.

### What this story is, in one sentence

Rewrite `plugins/crew/docs/README-install.md` so that every command, every "Expected confirmation" block, and every prose explanation matches what a fresh-clone operator actually observes in Claude Code 2.1.x — verified end-to-end through Story 1.8's `user_surface_verified` smoke gate before the PR opens — and pin the README's verified state with a vitest harness that asserts command literals, Markdown validity, and internal-link integrity.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- (b) Change the install path itself. The wired commands (`/plugin marketplace add ./`, `/plugin install crew@crew`, `/crew:status`) and the underlying plugin behaviour are not modified. This story changes only the **documentation** of those commands and their observable confirmations.
- (c) Edit any other doc (`standards-example.md`, `user-surface-acs.md`, root `README.md` if any, MCP-server READMEs). Scope is exactly `plugins/crew/docs/README-install.md`.
- (d) Add screenshots as PNG/JPEG binaries. If a "TUI screenshot" is needed for an Expected-confirmation block, use a fenced ASCII/text description of the panel layout (panel title, visible rows, the row Maya is expected to act on) — not an image asset. Rationale: binary diffs are unreviewable and rot fastest; the regex check in AC3 only meaningfully covers fenced code blocks.
- (e) Modify Claude Code itself, file Claude Code bug reports, or work around Claude Code TUI behaviour. If the observed UI is awkward (e.g. the Marketplaces panel uses different copy than expected), the README documents reality verbatim — it does not editorialise.
- (f) Backfill `user-surface` tagging or smoke-gate verification onto prior shipped stories. Story 1.10 is the first non-self-referential production user of the gate (Story 1.8 dog-fooded it against its own AC1).
- (g) Introduce, modify, or remove any vitest config, MCP tool, ship.py subcommand, or skill file. The only code addition is one new vitest test file under `plugins/crew/mcp-server/tests/`.
- (h) Resolve the `/plugin marketplace add .` vs `/plugin marketplace add ./` literal discrepancy by guessing. The dev (or the operator running the smoke step) MUST try the literal the README ships and update the README to whatever Claude Code actually accepts. If both work, pick the form used in the epic (`./`) for consistency with Story 1.9's AC1; if only one works, the README uses that one and the smoke evidence records which.

---

## Acceptance Criteria

> **Verbatim from epic.** The four ACs below match `_bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md` § Story 1.10 exactly. All four are `user-surface`: every AC names either a slash-command literal Maya types, a file path the README/docs ask the operator to follow, or a Claude Code TUI element the operator is expected to observe — satisfying rubric items (i), (iii), and (iv) of `plugins/crew/docs/user-surface-acs.md`.

**AC1 (user-surface):**
**Given** the rewritten README,
**When** Maya follows it step-by-step on a clean machine with a fresh checkout,
**Then** every "Expected confirmation" block describes the actual observed UI state (TUI screenshot, literal toast text, or the named tab the user lands on) — no fictional stdout lines, no commands that don't exist as written.
<!-- user-surface: AC describes Maya following the README verbatim, observing real Claude Code UI elements (TUI panel, toast, tab). Rubric items (iii) — the README itself is the file Maya is asked to open by name — and (iv) — every confirmation is a Claude Code UI element. -->

**AC2 (user-surface):**
**Given** the rewritten README,
**When** I diff it against what Jack observed in the PR #61 debug session,
**Then** the README's step 3 covers the TUI flow (open marketplaces list, see entries, add `./`, confirm), step 3b covers `/plugin install crew@crew` and the `temp_local_*` cache caveat surfaced on validation failure, and step 4 explains MCP servers only start on Claude Code launch so the restart is non-optional.
<!-- user-surface: AC names the slash command literals `/plugin marketplace add ./` and `/plugin install crew@crew` (rubric i), and references a Claude Code internal cache path the operator may see surfaced on failure (rubric iv). -->

**AC3 (user-surface):**
**Given** the rewritten README contains command literals (e.g. `/plugin marketplace add ./`, `/plugin install crew@crew`),
**When** a vitest test runs the README through a regex check,
**Then** every literal in a fenced code block tagged `bash` or `text` is one that's been verified against real Claude Code at least once (referenced by `user_surface_verified` event ID in the story's run log).
<!-- user-surface: AC names slash-command literals (rubric i) and the run-log evidence that pins them to a real Claude Code session. The test itself is internal, but the literals it guards are user-typed. -->

**AC4 (user-surface):**
<!-- qualifier: smoke + integration -->
the story flows through Story 1.8's new smoke gate. The gate's `user_surface_verified` event records Jack (or an operator) running each README command verbatim in a real Claude Code session, pasting the observed UI/toast/output for each step, and confirming match-vs-mismatch with the rewritten copy. Any mismatch fails the gate; the README must be edited until reality and copy agree. vitest additionally asserts `docs/README-install.md` parses as valid Markdown and every internal link resolves.
<!-- user-surface: AC requires verbatim operator runs of every README slash command (rubric i) plus observation of Claude Code UI for each (rubric iv). The vitest portion is internal but the gate it enforces is the user-surface contract. -->

---

## Tasks / Subtasks

- [ ] **Task 1 — Inventory the current README's claims vs PR #61 observations (AC: 1, 2)**
  - [ ] 1.1 Read `plugins/crew/docs/README-install.md` end-to-end. For each of the six checkpoints, extract: (a) the literal command shown, (b) the "Expected confirmation" copy, (c) any prose explanation around restart / cache / validation.
  - [ ] 1.2 Cross-reference against the PR #61 observations cited in the epic context (lines 237–253) and in Story 1.7a's spec. Build a private working list (in scratch, not in the README) of: every step whose "Expected confirmation" is fictional, every command literal whose form is uncertain (`add .` vs `add ./`), every behaviour the README omits (TUI panels, `temp_local_*` cache validation failure, MCP-spawn-at-launch).
  - [ ] 1.3 The dev does NOT need to actually run Claude Code in Task 1 — the orchestrator runs the smoke step at Task 6 and the dev edits the README based on the operator's pasted output. Task 1's job is to produce a draft that matches PR #61's observations and is internally consistent; Task 6 closes the loop with reality.

- [ ] **Task 2 — Rewrite the six checkpoints in `plugins/crew/docs/README-install.md` (AC: 1, 2)**
  - [ ] 2.1 Preserve the document's overall shape: numbered checkpoint list (1–6), one runnable command per step, one "Expected confirmation" block per step, optional regex-style match hint. Do NOT collapse checkpoints, renumber, or split into multiple files. Maya's mental model of "six checkpoints from clone to seeing the plugin recognise your repo" is the load-bearing UX.
  - [ ] 2.2 Step 1 (`claude --version`) and step 2 (`git clone … && pnpm --dir plugins/crew install`) are shell commands with real stdout — likely already accurate. Verify the regex hints still match current Claude Code / pnpm output; update only if PR #61 surfaced a mismatch. Default: leave as-is unless smoke (Task 6) shows otherwise.
  - [ ] 2.3 **Step 3a (`/plugin marketplace add ./`)**: replace the current `Expected confirmation: Marketplace added: crew` block with the actual observed UI. Per AC2, this is the **TUI flow**: opening the Marketplaces panel, seeing existing entries (if any), the `./` entry appearing, and the operator confirming inside the panel. Describe the panel layout in a fenced `text` block — panel title, the row Maya should see, the action she takes (e.g. "press Enter to confirm"). Reference the named tab she lands on after confirmation if applicable. Use the command literal that the smoke step verifies actually works (`./` per epic default, but record whichever real Claude Code accepts).
  - [ ] 2.4 **Step 3b (`/plugin install crew@crew`)**: replace `Expected confirmation: Plugin installed: crew@0.1.0` with the actual TUI/toast Maya observes. Include the **`temp_local_*` cache caveat** mandated by AC2: if validation fails (e.g. plugin.json shape regression), Claude Code surfaces a cache path under `~/.claude/plugins/cache/temp_local_*` in its error output — Maya should know what to look for, where the cache lives, and that the failure is local (no remote registry call). Prose for this caveat lives below the Expected-confirmation block, NOT inside it.
  - [ ] 2.5 **Step 4 (restart)**: rewrite the prose to explain that MCP servers spawn **only at Claude Code launch** — `/plugin install` does NOT start the MCP server mid-session, which is why the quit-and-reopen is **non-optional**. The current copy under-explains this; an operator who skips the restart will see `/crew:status` fail silently or hit a `Tool not found` shape and have no idea why. Replace the current Expected-confirmation block (which describes a stdout artefact the restart doesn't produce) with a description of what Maya should see when Claude Code reopens: the `/crew:` namespace appears in tab-complete; she does NOT yet need to invoke anything.
  - [ ] 2.6 **Step 5 (copy standards template)** and **step 6 (`/crew:status`)** are likely already accurate (step 5 is a shell `cp`, step 6 is the slash command this whole plugin exists to surface). Verify the step 6 Expected-confirmation block against the actual `/crew:status` output shape — Story 1.7a fixed the rendering, so the current five-line block should match. Update only if the smoke step shows mismatch.
  - [ ] 2.7 Preserve the "Build artefacts" subsection at the bottom of the file unchanged. It documents the Story 1.9 contract (committed `dist/`) and is correct as-is. If smoke surfaces a mismatch, escalate — do NOT silently edit it.
  - [ ] 2.8 Preserve the closing reference line (`> See Story 7.2 (Epic 7) for the full first-run walkthrough.`) unchanged.

- [ ] **Task 3 — Add the vitest harness for command-literal + Markdown + link integrity (AC: 3, 4)**
  - [ ] 3.1 Add `plugins/crew/mcp-server/tests/readme-install.test.ts`. This is a NEW file; it joins the existing suite (`smoke`, `workspace-resolver`, `validate-active-adapter`, `standards-doc`, `canonical-fs-guard`, `permissions-enforcement`, `telemetry-logger`, `git-commit`, `manifest-state-machine`, `get-status`, `acceptance`, `ci-drift-check`, `dist-shipping`, `pre-pr-gate`, `user-surface-convention`).
  - [ ] 3.2 The test reads `plugins/crew/docs/README-install.md` from disk (use `fs.readFileSync` with a path resolved from `import.meta.url` or the repo root — match the pattern used in existing tests like `dist-shipping.test.ts` and `ci-drift-check.test.ts`; do NOT invent a new file-locating helper).
  - [ ] 3.3 **Command-literal check (AC3).** Parse the README and extract every fenced code block tagged ` ```bash` or ` ```text`. For each block, scan for lines matching the slash-command shape `^/[a-z][\w:-]*` (e.g. `/plugin marketplace add ./`, `/plugin install crew@crew`, `/crew:status`). Assert that the set of slash-command literals found is exactly the **allowlist** pinned in the test file. The allowlist is:
    - `/plugin marketplace add ./` (or `/plugin marketplace add .` — pin whichever form the smoke step verifies; Task 6 dictates the choice)
    - `/plugin install crew@crew`
    - `/crew:status`
    A literal outside this allowlist (e.g. a typo, a stale command, a copy-paste from an old README) fails the test with a clear diagnostic naming the offending literal and the fenced block it appeared in. The allowlist is **explicit** — do NOT generate it from the README itself (that would be tautological).
  - [ ] 3.4 **Markdown-validity check (AC4).** Use `remark-parse` (or the already-present Markdown parser if one exists in `plugins/crew/mcp-server/`'s deps — check `package.json` first; add `remark-parse` at the latest stable resolved via `pnpm view remark-parse version` ONLY if no Markdown parser is already present). Assert that `README-install.md` parses without errors. A single failing parse → test fails with the parse error message.
  - [ ] 3.5 **Internal-link integrity (AC4).** Walk the parsed Markdown AST for every `link` node whose URL is relative (no scheme, no leading `#` for in-document anchors unless the anchor exists). For each relative link, resolve against the README's directory and assert the target file exists on disk. In-document anchor links (`#section`) resolve against the README's own heading slugs. A broken link → test fails naming the link text, target, and source line.
  - [ ] 3.6 The test file header MUST cite this story (`Story 1.10 AC3/AC4`) and link to `plugins/crew/docs/user-surface-acs.md`, mirroring the comment-header convention from `pre-pr-gate.test.ts`.
  - [ ] 3.7 Run with `pnpm --dir plugins/crew test` and confirm the new test passes alongside every existing suite (zero skips, zero new warnings).

- [ ] **Task 4 — Confirm the README's command literals match the smoke-step evidence (AC: 3, 4)**
  - [ ] 4.1 After Task 6's smoke step produces the `user_surface_verified` event, the allowlist in Task 3.3 must match the literals the operator actually typed. If smoke reveals that the working form is `/plugin marketplace add .` (no trailing slash) rather than `./`, update BOTH the README copy AND the test allowlist in the same change. The two must agree at PR-open time; AC3 fails closed if they don't.
  - [ ] 4.2 The dev does NOT pre-write smoke evidence or fabricate observations. Task 4.1 is a tail-end reconciliation step, executed after Task 6 closes.

- [ ] **Task 5 — Wire the story into Story 1.8's smoke gate (AC: 4)**
  - [ ] 5.1 No code change here. Story 1.8 already added `pre-pr-gate` to `ship.py` and the smoke step to `ship-story/SKILL.md`. Because every AC in this story is `(user-surface)` (see ACs above), the gate will detect AC1–AC4 from the spec's tag-extraction regex and require a `user_surface_verified` (or `automated_e2e_verified`) event covering `{1, 2, 3, 4}` before PR open.
  - [ ] 5.2 AC3 and AC4's vitest portions ARE automatable — they can be satisfied by an `automated_e2e_verified` event pointing at `plugins/crew/mcp-server/tests/readme-install.test.ts` with `ac_refs: [3, 4]`. AC1 and AC2 are NOT automatable in vitest (they require a real Claude Code session) and MUST ride the `user_surface_verified` route with operator-pasted output.
  - [ ] 5.3 Coverage strategy (the gate accepts the union of valid events per `user-surface-acs.md` § "Coverage"):
    - One `automated_e2e_verified` event with `ac_refs: [3, 4]`, `test_path: "plugins/crew/mcp-server/tests/readme-install.test.ts"`, `test_command: "pnpm --dir plugins/crew test readme-install"`.
    - One `user_surface_verified` event with `ac_refs: [1, 2]` (or `[1, 2, 3, 4]` if the operator wants to over-cover) and one `observations[]` entry per AC, each carrying `pasted_output` from a real Claude Code session.
    - The gate passes if the union covers `{1, 2, 3, 4}`. Either event alone is insufficient.
  - [ ] 5.4 The dev agent does NOT write these events. The orchestrator (ship-story Step 8/8.5, per Story 1.8 Task 5.5) calls `$SH record-verification` after dev sign-off. The dev's responsibility ends when the README and vitest test land, the AC table is green, and the spec accurately tags every user-surface AC.

- [ ] **Task 6 — Operator smoke step (orchestrator-executed, NOT dev-agent-executed) (AC: 1, 2, 4)**
  - [ ] 6.1 This task is a **marker** to the ship-story orchestrator, mirroring Story 1.8 Task 5.5 and Story 1.9's smoke pattern. Once Tasks 1–5 land and AC-table is green, the orchestrator at Step 8/8.5 of `ship-story/SKILL.md`:
    1. Opens a fresh Claude Code session on a clean checkout of the branch.
    2. Walks every step of the rewritten `plugins/crew/docs/README-install.md` verbatim — types each command exactly as printed, observes each "Expected confirmation" block.
    3. Captures the verbatim Claude Code output for each step (TUI snapshot as text, toast literal, panel title and tab name, or stdout for steps 1/2/5).
    4. Confirms match-vs-mismatch with the README copy for each step. **Any mismatch is a defect, not an evidence note** — the orchestrator pauses, hands back to a dev pass to edit the README, then re-runs the smoke.
    5. When every step matches, writes the verification events via `$SH record-verification <story-key> --type user_surface_verified --data '<json>'` per Task 5.3.
    6. Also runs `pnpm --dir plugins/crew test readme-install` and writes the `automated_e2e_verified` event per Task 5.3.
    7. Re-runs `$SH pre-pr-gate <story-key>`; the gate passes; PR opens.
  - [ ] 6.2 The orchestrator MUST NOT silently bypass a mismatch by editing the smoke evidence to lie. The fail-closed contract from Story 1.8 (AC3) applies: malformed or fabricated evidence is `MalformedVerificationEvent` and the gate exits `42`.
  - [ ] 6.3 If smoke reveals a Claude Code behaviour the README cannot accurately document (e.g. the TUI is non-deterministic across machines), the orchestrator opens a follow-up discussion with Jack — does NOT ship a "good enough" README. The whole point of this story is that "good enough" was the failure mode.

---

## Dev Notes

### What this story changes (UPDATE) vs adds (NEW)

**UPDATE files:**
- `plugins/crew/docs/README-install.md` — the six numbered checkpoints (mostly steps 3a, 3b, 4) plus surrounding prose. Preserve the "Build artefacts" subsection and the Story 7.2 footer reference unchanged.

**NEW files:**
- `plugins/crew/mcp-server/tests/readme-install.test.ts` — the vitest harness for AC3 (command-literal allowlist) and AC4 (Markdown parse + internal-link integrity).

**MUST NOT TOUCH:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — orchestrator-owned.
- Any other `_bmad-output/implementation-artifacts/*.md` story spec — including this one's siblings.
- `plugins/crew/.claude-plugin/plugin.json`, any `marketplace.json`, or any plugin manifest. The README documents these but does not modify them.
- `.claude/skills/ship-story/scripts/ship.py`, `.claude/skills/ship-story/SKILL.md`, or any other ship-story plumbing — Story 1.8 owns that surface; this story is its first production consumer.
- `.claude/skills/bmad-create-story/**` — gitignored third-party dependency per Story 1.8 Task 1.
- `plugins/crew/docs/standards-example.md`, `plugins/crew/docs/user-surface-acs.md`, and any other doc — out of scope.
- Any vitest config, tsconfig, or `package.json` (except adding `remark-parse` as a devDependency IF and ONLY IF no Markdown parser already exists in `plugins/crew/mcp-server/package.json` — verify before adding).

### Current state of files being modified

**`plugins/crew/docs/README-install.md`** (read in full before editing):
- 124 lines. Six numbered checkpoints (lines 5–112). "Build artefacts" subsection (lines 113–124).
- Step 3a (lines 33–48): `/plugin marketplace add .` — **command literal uses bare `.`**, NOT `./` as the epic and Story 1.9 AC1 use. Expected confirmation `Marketplace added: crew` — fictional per epic.
- Step 3b (lines 49–61): `/plugin install crew@crew`. Expected confirmation `Plugin installed: crew@0.1.0` — fictional per epic.
- Step 4 (lines 63–75): Restart. Expected confirmation describes tab-complete appearance, which is real but under-explains why the restart is non-optional.
- Steps 1, 2, 5, 6: shell commands and `/crew:status` — likely accurate, verify in Task 2.2 / 2.6.
- The `/plugin marketplace add .` vs `add ./` discrepancy with the epic is intentionally unresolved here. Task 6's smoke step pins the form; Task 2.3 + 4.1 align the README + test allowlist to whichever form Claude Code actually accepts. The dev does NOT pick by guessing.

### What this story preserves (must not break)

- The six-checkpoint structure and numbering of the README. Maya's onboarding flow.
- The "Build artefacts" subsection (Story 1.9's contract).
- The Story 7.2 footer reference.
- Every existing vitest suite under `plugins/crew/mcp-server/tests/` (15 suites as of this story's authoring — confirmed via `ls`). Zero skips, zero new warnings.
- The `(user-surface)` tag-extraction regex from Story 1.8 (`^\*\*AC(\d+)\s*\(user-surface\)\s*:\*\*`). Every AC in this spec was authored against that regex; smoke gate will parse all four indexes.

### Smoke-gate event payloads (reference for orchestrator)

Per Story 1.8 § "Verification event schemas":

```json
// automated_e2e_verified — covers AC3, AC4
{
  "ac_refs": [3, 4],
  "test_path": "plugins/crew/mcp-server/tests/readme-install.test.ts",
  "test_command": "pnpm --dir plugins/crew test readme-install"
}
```

```json
// user_surface_verified — covers AC1, AC2 (minimum); over-cover with [1,2,3,4] also legal
{
  "ac_refs": [1, 2],
  "operator": "jack",
  "observations": [
    {"ac_ref": 1, "pasted_output": "<verbatim Claude Code output from walking the README>"},
    {"ac_ref": 2, "pasted_output": "<verbatim Claude Code output of the TUI for step 3a, 3b, and the restart explanation in step 4>"}
  ]
}
```

The gate's coverage check is `union(ac_refs across all valid events) ⊇ {1,2,3,4}`. Missing any → exit `42`.

### Testing standards

- vitest, run via `pnpm --dir plugins/crew test`. The new `readme-install.test.ts` joins the existing 15-suite list.
- Use the same file-locating pattern as `dist-shipping.test.ts` and `ci-drift-check.test.ts` — do NOT invent a new helper for resolving repo paths.
- The Markdown parser (Task 3.4): check `plugins/crew/mcp-server/package.json` for an existing parser before adding `remark-parse`. If `remark-parse` is added, resolve the latest stable via `pnpm view remark-parse version` and pin exactly that version in `devDependencies`. Do NOT guess versions from training data (per repo memory: "default to latest stable, pnpm resolves, then pin").
- AC3's allowlist test fails closed: a literal outside the allowlist OR a literal in the allowlist that's absent from the README both fail the test with distinct diagnostics. This protects against (a) typo regressions and (b) silent removal of documented commands.
- AC4's link check considers a file existing on disk as "resolved"; it does NOT follow redirects, fetch HTTP, or validate that the linked file's content is correct. External links (with a scheme) are skipped entirely — out of scope.

### Latest tech information

- **Claude Code version observed in PR #61:** 2.1.144 (per the smoke-gate carrier prompt context for this story). The README's step 1 currently shows `claude 1.2.3` as an example regex match — that's fine; it's an illustrative pattern, not a version assertion. Do NOT bump the example version unless smoke shows the regex `^claude \d+\.\d+\.\d+` fails against current `claude --version` output.
- **Claude Code TUI surfaces** for `/plugin marketplace add` and `/plugin install` are interactive panels in 2.1.x — this is the core observed reality the README must document. There is no flag to disable the TUI; the panel is the surface.
- **`temp_local_*` cache path:** `~/.claude/plugins/cache/temp_local_*` is where Claude Code stages a plugin during validation. On failure (e.g. malformed `plugin.json`), the path appears in the error output. The README's step 3b caveat should reference this path verbatim so Maya can `ls` it if she hits a failure.

### Previous story intelligence (Story 1.9 — directly upstream)

Story 1.9 shipped the committed-`dist/` contract that the README's "Build artefacts" subsection documents. Story 1.9's AC1 is `(user-surface)` and covers the same three slash commands this story's README documents — its smoke evidence (Story 1.8 gate) and its working command form (`./`) are precedent for this story's Task 6.

Story 1.9's spec also models the "AC3 / AC4 = vitest harness covers infra; AC1 / AC2 = operator smoke" split that this story extends to all four ACs being user-surface (since the README is itself the user surface).

### Previous story intelligence (Story 1.8 — gate this story rides)

Story 1.8 added `ship.py pre-pr-gate`, the `user_surface_verified` and `automated_e2e_verified` event schemas, the `MalformedVerificationEvent` typed error (exit `42` = `USER_SURFACE_UNVERIFIED`), and the `(user-surface)` tag convention this spec authors against. Every reference to "the gate" or "the smoke step" in this spec is Story 1.8's plumbing.

Story 1.8 Task 5.5 / Manual smoke M.1 are the orchestrator-executed pattern this story's Task 6 mirrors. The dev agent does NOT generate verification evidence in either story.

### Previous story intelligence (Story 1.7a — original failure)

Story 1.7a was the hotfix that surfaced the eight install bugs which motivated Story 1.8's gate and this story's rewrite. Its retrospective is the source of truth for what the README must accurately document: every "the docs said X, Claude Code did Y" gap from that session is what Task 2's rewrite closes.

### Git intelligence

Recent commits (per `git log` at story authoring time):
- `f018050 fix: pending-cleanup/state tolerate new verification event shape (#64)` — confirms the verification-event JSONL shape is in active flux; the schema in Story 1.8 § "Verification event schemas" is the canonical source for Task 5.3's payloads.
- `83bf685 feat(1): Ship a pre-built dist/ with the plugin (#63)` — Story 1.9, directly upstream. Confirms the `dist/` is committed and the "Build artefacts" subsection of the README is correct as-shipped.
- `d7db13c feat(1): User-surface AC type and smoke gate in ship-story (#62)` — Story 1.8. The gate this story is the first non-self-referential consumer of.
- `27ac70c fix: make /crew:status install path actually work end-to-end (#61)` — PR #61. The pair-debug session that surfaced the README fictions this story rewrites.
- `27ebfa0 fix(1.7a): correct install path and register status skill (#60)` — Story 1.7a. The original failure that motivated the whole chain.

### Project Structure Notes

- `plugins/crew/docs/README-install.md` exists today and is the canonical install README (the repo-root `README.md` does not duplicate install steps; if a future story adds one, it must reference this file rather than fork it).
- `plugins/crew/mcp-server/tests/` contains the canonical vitest suite. Adding `readme-install.test.ts` follows the established pattern of one test file per concern (e.g. `dist-shipping.test.ts`, `ci-drift-check.test.ts`).
- No conflicts detected with the unified project structure. The only ambiguity is `/plugin marketplace add .` vs `add ./` — Task 6 resolves it by observation.

### References

- Epic: [Source: _bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md § Story 1.10 (lines 237–253)]
- User-surface tag rules: [Source: plugins/crew/docs/user-surface-acs.md § "What counts as a user-surface", § "Tag convention", § "Tag-extraction regex"]
- Smoke gate plumbing: [Source: _bmad-output/implementation-artifacts/1-8-user-surface-ac-type-and-smoke-gate-in-ship-story.md § "Verification event schemas", § "Coverage of the user-surface AC set"]
- Upstream story (committed dist): [Source: _bmad-output/implementation-artifacts/1-9-ship-a-pre-built-dist-with-the-plugin.md]
- README under rewrite: [Source: plugins/crew/docs/README-install.md]
- Existing vitest suite shape: [Source: plugins/crew/mcp-server/tests/dist-shipping.test.ts, plugins/crew/mcp-server/tests/pre-pr-gate.test.ts]
- Build-artefacts contract (preserved): [Source: plugins/crew/docs/README-install.md § "Build artefacts"]

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
