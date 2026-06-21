# Story 1.11: Dev-install loop — make plugin changes visible without a daemon restart

story_shape: user-surface

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **an engineer iterating on the crew plugin on a feature branch in a worktree**,
I want **a one-command dev-install path that makes my local changes (worktree or main) visible to a fresh Claude Code session without manual `/plugin uninstall` + reinstall dances or file-overlay hacks into `~/.claude/plugins/cache/...`**,
so that **every future `story_shape: user-surface` story can actually pass its smoke gate end-to-end instead of being shipped via the automated-route escape hatch (PR #90's failure mode).**

### What this story fixes (and why it needs its own story)

PR #90 (Story 3.2) was the first user-surface story that **could not produce real-Claude-Code evidence** for its `/crew:scan` AC. The reason is structural, and is the same wall every subsequent user-surface story (3.5, 3.6, 4.x slash commands, …) will hit:

1. **The crew marketplace is registered at `/Users/<user>/projects/crew/` (main).** `~/.claude/plugins/known_marketplaces.json` resolves `crew@crew` to a `directory` source at the main checkout. A worktree at `.worktrees/story/3-2-…/` containing the new skill is invisible to `/plugin install crew@crew`.
2. **Manual file overlay (`rsync -a` from worktree → `~/.claude/plugins/cache/crew/crew/0.1.0/`) works structurally but isn't picked up.** The MCP server runs from the overlaid `dist/index.js`, but Claude Code's **plugin daemon** caches the skill index across sessions — a fresh `claude` in a new terminal does not re-scan and the new skill never appears in the slash-command picker.
3. **`/plugin uninstall crew@crew && /plugin install crew@crew` makes it worse.** The reinstall wipes the overlay and re-copies from main (which doesn't have the new skill).
4. **Spike 8739bbf (PR #85) discovered that for a *current-branch* dev loop the live-source path already works** — `tsc --watch` + `/reload-plugins` rebuilds and rebinds in ~5–8 s. That spike is the basis for `plugins/crew/docs/worktree-smoke.md`'s "Daily dev loop" section. **But the worktree-branch case is unsolved** — the marketplace source is wrong, the daemon's skill-index cache is sticky across `/reload-plugins`, and the cache overlay gets wiped on reinstall.

Story 1.11 closes this gap with **one documented command** an engineer runs from inside a worktree before opening a fresh Claude Code session, after which the slash-command picker reflects the worktree's `skills/` and the MCP server runs the worktree's `dist/`. The mechanism is a chosen implementation detail (this spec selects one of three options); the operator-facing contract is the single command and the observable result.

### What this story is, in one sentence

Add a `pnpm dev:install` (or equivalently-named) script under `plugins/crew/scripts/` that, when run from inside a git worktree, makes the worktree's `plugins/crew/` tree (skills + `mcp-server/dist/` + catalogue) authoritative for the next Claude Code session — so a user-surface AC on any branch can be smoke-verified the same way `/crew:status` was on main — and document the script's place in the dev loop alongside the existing watch-build flow.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — orchestrator-owned.
- (b) Change the production install path (`/plugin marketplace add ./` → `/plugin install crew@crew` → restart). End-users on a clean checkout follow `plugins/crew/docs/README-install.md` unchanged. The dev-install path is a **separate, engineer-only** code path with its own command and its own doc.
- (c) Replace the existing "Daily dev loop" (watch-build + `/reload-plugins`) documented in `plugins/crew/docs/worktree-smoke.md`. That loop is still correct for editing on the **current branch**. This story covers the **switching-to-a-worktree-branch** case the spike explicitly left unsolved (`symlink-dev-install.md` § "Recipe" still applies; this story replaces *that* uninstall+install ritual with the new command).
- (d) Try to programmatically force Claude Code's plugin daemon to re-scan its skill index from inside the MCP server. We do not control the daemon's cache lifecycle and an in-process invalidation API is not documented (see Task 1 research subtask). The script's contract ends at "the cache on disk is correct"; the operator's contract is "after running the script, open a fresh Claude Code session" — analogous to the current restart-required step in the production install path.
- (e) Modify `plugins/crew/.claude-plugin/plugin.json`, `marketplace.json`, or `~/.claude/plugins/known_marketplaces.json`. The chosen mechanism (see Task 2) operates on the install cache directory; it does not rewrite Claude Code's own registries.
- (f) Add CI to verify dev-install behaviour on a fresh machine. The script's vitest harness (AC7) covers the file-copy/symlink behaviour against a temp source + temp cache fixture; live-Claude-Code interaction is verified by the story's user-surface smoke gate, not CI.
- (g) Resolve the daemon skill-index cache mystery in a code patch. If Task 1's research finds no programmatic invalidation, the script documents "after running, restart Claude Code" — this is acceptable per the operator-contract analogy with the production install path.
- (h) Replace `plugins/crew/scripts/worktree-smoke.sh`. That script remains as the print-the-recipe helper for operators who prefer the explicit three-line ritual. The new `dev:install` script is the **one-command** alternative that supersedes it for the day-to-day worktree case, but `worktree-smoke.sh` keeps working and stays in the tree for reference.
- (i) Add or modify any persona, catalogue, or role spec. Engineer-facing tooling only.

---

## Acceptance Criteria

> **Verbatim from epic (with the trailing `---` phantom-AC stripped).** ACs 1–5 are the prose ACs from the epic; AC6 is the deterministic content-structure anchor; AC7 is the integration scenario. Tagging follows `plugins/crew/docs/user-surface-acs.md`.

**AC1 (user-surface):**
**Given** a working tree on any branch (main or worktree) with local plugin changes (modified `skills/`, `mcp-server/src/`, or `mcp-server/dist/`),
**When** I run a single documented dev-install command from the repo root (e.g. `pnpm dev:install` — exact name TBD by spec),
**Then** the installed plugin cache at `~/.claude/plugins/cache/crew/crew/<version>/` reflects the current working-tree state (skills, dist, catalogue) — verifiable by `diff -r` between source and cache, or a sentinel substring assertion.
<!-- user-surface: AC names a CLI command the engineer types verbatim (rubric ii) and a file path the engineer is expected to inspect by name (rubric iii). -->

**AC2 (user-surface):**
**Given** the dev-install has run,
**When** a fresh Claude Code session is launched in this repo,
**Then** the slash-command picker lists every skill present under `plugins/crew/skills/` (including any new ones added since the last "real" `/plugin install`) — i.e. the daemon's skill-index cache no longer masks the new state. _(The mechanism — daemon kill, cache-invalidation file, symlink trick, or whatever the spec chooses — is an implementation detail.)_
<!-- user-surface: AC names the Claude Code slash-command picker (rubric iv) — a TUI element the operator observes. -->

**AC3:**
**Given** the dev-install is re-run twice in a row with no source changes,
**When** I observe the cache state and any side effects (daemon restarts, file mtimes),
**Then** the second run is a no-op (idempotent) — no destructive re-copy, no daemon thrash unless the source actually changed.
<!-- No tag: AC is about internal idempotency / cache state, not an operator-typed command outcome or observed UI. -->

**AC4:**
**Given** the dev-install fails partway (e.g. uncommitted changes in a state the script doesn't trust, or the daemon refuses to restart),
**When** the script exits,
**Then** it exits non-zero with a clear human-readable error and the cache is left in a recoverable state — never silently broken.
<!-- No tag: AC is about internal error-handling/exit-code contract; the message text is for the engineer's terminal, not a Claude Code UI surface. -->

**AC5 (user-surface):**
**Given** the repo's `docs/README-install.md` (operator-facing) and a new engineer-facing dev-loop doc,
**When** an engineer reads either doc,
**Then** the production install path (`/plugin install crew@crew`) and the new dev-install path are clearly distinguished, with one short paragraph explaining when to use which.
<!-- user-surface: AC requires the engineer to open `docs/README-install.md` and a new dev-loop doc by name (rubric iii). The dev-loop doc is the file the engineer is sent to from anywhere in the project to find the dev-install command. -->

**AC6:**
vitest assertion that the dev-install script file exists at the documented path, is executable, and contains the substring identifying its core mechanism (e.g. `~/.claude/plugins/cache/crew/crew` — proving the script targets the right cache location). Plus: the engineer-facing dev-loop doc contains the substring naming the script command (e.g. `pnpm --dir plugins/crew dev:install`) so docs and reality stay in sync.
<!-- No tag: AC is a vitest content-anchor harness (on-disk file-existence and substring checks); the operator does not type a command to satisfy this AC. The literal pinned by the substring check is operator-typed, but the AC itself only requires the test to read files and assert substrings — it inherits the tag of `automated_e2e_verified` coverage, not `user-surface`. -->

**AC7:**
vitest scenario that, given a temp source dir simulating a worktree and a temp cache dir simulating `~/.claude/plugins/cache/`, the dev-install script (a) populates the cache from the source, (b) running it again with no changes is a no-op (mtime preserved on key files), (c) running it after editing a `skills/<x>/SKILL.md` propagates only that file. The actual Claude Code daemon interaction is out of scope for vitest — that part is verified by the story's user-surface smoke gate.
<!-- No tag: AC is a hermetic vitest harness against temp dirs; no operator-typed command runs end-to-end and no Claude Code UI is observed. -->

---

## Behavioural contract (user-surface)

The `pnpm dev:install` script's invariants. Failures here are defects, not evidence notes.

**MUST:**
- MUST resolve the **source** as the current working tree (the worktree root, detected via `git rev-parse --show-toplevel`), NOT the marketplace-registered main checkout.
- MUST resolve the **target** as `~/.claude/plugins/cache/crew/crew/<version>/` where `<version>` is read from `plugins/crew/.claude-plugin/plugin.json`.
- MUST be **idempotent** on no-op re-runs: a second invocation with no source changes makes no destructive writes (mtimes on unchanged files preserved; the chosen mechanism, e.g. `rsync -a --delete` or symlink, naturally satisfies this — verify with a test).
- MUST verify a `pnpm --dir plugins/crew/mcp-server build` (or equivalent) has produced a current `dist/index.js` before populating the cache; if `dist/` is stale or missing, the script either runs the build itself OR exits non-zero with a message naming the build command — choose at implementation time, document the choice in the script's `--help` and the dev-loop doc.
- MUST exit **non-zero** with a human-readable error on any partial failure (source not a git repo, target parent missing, permission denied, build failure, sentinel mismatch after copy).
- MUST surface a one-line success message naming the target path on success (e.g. `dev:install ok → ~/.claude/plugins/cache/crew/crew/0.1.0/`) so the operator has a confirmation literal to paste into smoke evidence.
- MUST be invocable as `pnpm --dir plugins/crew dev:install` (since the repo root has no `package.json`). The dev-loop doc (Task 4) names this exact invocation as the canonical operator literal; deviating from it requires updating the doc in the same change.

**MUST NOT:**
- MUST NOT modify `~/.claude/plugins/known_marketplaces.json`, `~/.claude/settings.json`, or any other Claude Code registry file. The script operates on the cache directory only.
- MUST NOT touch any other plugin's install cache (`~/.claude/plugins/cache/<other-plugin>/`). The script's writes are scoped to `~/.claude/plugins/cache/crew/crew/<version>/` exclusively.
- MUST NOT silently fall back to the production install path if it can't find the cache. Exit non-zero with guidance instead.
- MUST NOT require root / sudo. All paths live under the operator's `$HOME`.
- MUST NOT depend on a network connection. The script is fully offline.

**NEVER:**
- NEVER delete uncommitted files in the **source** directory (the worktree). Writes flow source → cache, never the reverse. If the chosen mechanism is a symlink, the symlink points cache → source (cache is the symlink, source is the target); the symlink-creation step MUST refuse to remove source files even if it has to delete the existing cache directory to replace it with a symlink.
- NEVER spawn a `kill`/`pkill` against an arbitrary PID. If the chosen mechanism includes a daemon-restart step, it MUST target only processes whose command line includes `plugins/crew/mcp-server/dist/index.js` (verified via `pgrep -f`), and MUST document the kill in stdout before issuing it. If no programmatic daemon-restart is reliable, the script MUST instead print "now restart Claude Code" as its final line and exit 0.
- NEVER write to the cache without first verifying the source tree contains `plugins/crew/.claude-plugin/plugin.json` and `plugins/crew/mcp-server/dist/index.js` (or running the build to produce the latter). Empty / broken caches must not be createable by this script.

---

## Tasks / Subtasks

- [x] **Task 1 — Pick the mechanism (research subtask + decision record) (AC: 1, 2, 4)**
  - [x] 1.1 Three candidates from the epic context plus a fourth from the spike. Compare against the contract above and pick **one** (hybrids permitted if explicitly justified):
    - **(a) Symlink** `~/.claude/plugins/cache/crew/crew/<version>/` → the active worktree's `plugins/crew/` directory. Spike 8739bbf documented this as "not needed for daily loop" but did NOT test it for the worktree-branch case where the marketplace source is wrong. Pros: zero copy, always-fresh. Cons: replaces a directory with a symlink — risk of accidentally removing the wrong directory; behaviour under Claude Code's plugin daemon when target is a symlink is unverified.
    - **(b) Copy-based `pnpm dev:install`** that `rsync -a --delete` source → cache and (separately) signals the daemon. Pros: matches what `/plugin install` does internally; cache shape is byte-identical to a real install. Cons: must keep `dist/` in sync; redundant on no-op re-runs unless rsync's mtime check is trusted (it is).
    - **(c) Repoint `known_marketplaces.json`** source from the main checkout to the active worktree path. Pros: makes `/plugin install crew@crew` itself worktree-aware. Cons: violates "MUST NOT modify Claude Code registries" — would have to be a documented escape hatch; partial failures leave the operator unable to use the main-branch install. **Eliminated by the contract above.**
    - **(d) Hybrid** — symlink the *cache directory* to the worktree, AND run the build if `dist/` is stale, AND print a "restart Claude Code" line at the end. This is the spec's **default recommendation** unless Task 1.2 surfaces a blocker. **CHOSEN.**
  - [x] 1.2 **Research subtask (the daemon re-scan trigger).** Finding: no programmatic invalidation API is available. `/reload-plugins` restarts the MCP server but does NOT re-scan the skill index across sessions. A full Claude Code restart is the only reliable mechanism. Documented in `plugins/crew/docs/spikes/dev-install-decision.md`.
  - [x] 1.3 Record the chosen mechanism in `plugins/crew/docs/spikes/dev-install-decision.md` (new file under the existing `spikes/` dir — mirrors the spike doc convention from 8739bbf). One page: chosen mechanism, ruled-out alternatives, the Task 1.2 result.
  - [x] 1.4 `--kill-daemon` flag implemented in `dev-install.sh` (gated, off by default). Uses targeted `pgrep -f plugins/crew/mcp-server/dist/index.js` — documented in decision doc and script header.

- [x] **Task 2 — Implement `plugins/crew/scripts/dev-install.sh` (AC: 1, 3, 4)**
  - [x] 2.1 Created `plugins/crew/scripts/dev-install.sh` (POSIX shell, `set -e`, exit-code contract in header).
  - [x] 2.2 Implemented the hybrid contract: preflight → build check → cache symlink → sentinel verify → success line + daemon guidance.
  - [x] 2.3 Made executable (`chmod +x`); executable bit committed.
  - [x] 2.4 Exit codes documented in script header: `0` success, `2` preflight, `3` build, `4` cache write, `5` sentinel verify.
  - [x] 2.5 stdout success line contains `$HOME/.claude/plugins/cache/crew/crew` literal (AC6 content-anchor).

- [x] **Task 3 — Wire `pnpm dev:install` (AC: 1, 6)**
  - [x] 3.1 Added `"dev:install": "./scripts/dev-install.sh"` to `plugins/crew/package.json`.
  - [x] 3.2 Repo root has no `package.json` (confirmed). Engineer uses `pnpm --dir plugins/crew dev:install`.
  - [x] 3.3 Dev-loop doc uses `pnpm --dir plugins/crew dev:install` as the canonical literal.

- [x] **Task 4 — Write the engineer-facing dev-loop doc (AC: 5)**
  - [x] 4.1 Created `plugins/crew/docs/dev-loop.md`.
  - [x] 4.2 Contents implemented: two-path table, when-to-use paragraph, fenced bash block with `pnpm --dir plugins/crew dev:install`, three-bullet mechanism summary, after-running guidance (restart Claude Code), relationship to daily loop, troubleshooting table (all four exit codes).
  - [x] 4.3 Updated `plugins/crew/docs/README-install.md` with one paragraph at the very top distinguishing engineer vs end-user audience and pointing at `dev-loop.md`.
  - [x] 4.4 Updated `plugins/crew/docs/worktree-smoke.md` under "Recipe" with a one-command alternative callout.

- [x] **Task 5 — Add the vitest harness (AC: 6, 7)**
  - [x] 5.1 Added `plugins/crew/mcp-server/tests/dev-install.test.ts` (mirrors existing pattern, uses `import.meta.url`).
  - [x] 5.2 AC6 content-anchor: executable bit assertion; `$HOME/.claude/plugins/cache/crew/crew` substring in script; `pnpm --dir plugins/crew dev:install` in dev-loop.md.
  - [x] 5.3 AC7 integration scenario: temp git repo, three test cases (first-run symlink, no-op re-run, edit propagation), plus error-path test for missing dist/.
  - [x] 5.4 File header cites Story 1.11 AC6/AC7 and links `plugins/crew/docs/dev-loop.md`.
  - [x] 5.5 All 393 tests pass (33 test files), zero skips, zero new warnings.

- [x] **Task 6 — Wire the story into Story 1.8's smoke gate (AC: 1, 2, 5, 6)**
  - [x] 6.1 No code change (confirmed). Gate plumbing is orchestrator-owned.
  - [x] 6.2 Coverage strategy documented in spec — `automated_e2e_verified` for AC6, `user_surface_verified` for AC1/AC2/AC5.
  - [x] 6.3 Operator smoke step pattern documented in spec — not dev-agent-executed.
  - [x] 6.4 AC2 contingency documented in decision doc (full restart guidance).
  - [x] 6.5 Dev agent did NOT write verification events — orchestrator-only.

---

## Dev Notes

### What this story changes (UPDATE) vs adds (NEW)

**NEW files:**
- `plugins/crew/scripts/dev-install.sh` — the script itself (executable).
- `plugins/crew/docs/dev-loop.md` — the engineer-facing dev-loop doc.
- `plugins/crew/docs/spikes/dev-install-decision.md` — one-page decision record from Task 1.
- `plugins/crew/mcp-server/tests/dev-install.test.ts` — vitest harness.

**UPDATE files:**
- `plugins/crew/package.json` — add `"dev:install"` script entry.
- `plugins/crew/docs/README-install.md` — add one paragraph at the very top distinguishing prod vs dev install paths and pointing at `dev-loop.md`.
- `plugins/crew/docs/worktree-smoke.md` — add one sentence under "Recipe" pointing at `dev-loop.md` / `pnpm dev:install` as the supported one-command alternative.

**MUST NOT TOUCH:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — orchestrator-owned.
- Any other `_bmad-output/implementation-artifacts/*.md` story spec.
- `plugins/crew/.claude-plugin/plugin.json`, `plugins/crew/.claude-plugin/marketplace.json` (if/when present), or any other plugin manifest.
- `~/.claude/plugins/known_marketplaces.json`, `~/.claude/settings.json`, `~/.claude/plugins/cache/<other-plugin>/**`.
- `plugins/crew/scripts/worktree-smoke.sh` — preserved as the explicit three-line recipe printer.
- `.claude/skills/ship-story/**` — Story 1.8 owns that surface; this story is a consumer.
- `.claude/skills/bmad-create-story/**` — gitignored.
- Any vitest config, tsconfig, or `mcp-server/package.json` dependencies. The AC7 harness uses `node:fs`, `node:path`, `node:os`, `node:child_process` — all stdlib, no new deps.

### Current state of files being modified

**`plugins/crew/package.json`** (5 lines as of authoring):
- Top-level workspace package with only `build` and `test` scripts. Adding `dev:install` is additive — no existing script changes shape.

**`plugins/crew/docs/README-install.md`** (127 lines):
- Six-checkpoint install path for end-users, finalised by Story 1.10. The "Build artefacts" subsection (Story 1.9 contract) is at the bottom and stays untouched. The new top-of-file paragraph (Task 4.3) is the only edit. Maya's mental model of "six checkpoints from clone to seeing the plugin recognise your repo" remains the dominant flow; the engineer-only paragraph is clearly demarcated as a pre-flight for a different audience.

**`plugins/crew/docs/worktree-smoke.md`** (103 lines):
- Already documents the daily dev loop (watch + `/reload-plugins`) and the worktree-switching recipe (uninstall + install + reload). The new sentence (Task 4.4) points at `pnpm dev:install` as the one-command equivalent of the three-line recipe — does not invalidate or remove the existing content.

**`plugins/crew/scripts/worktree-smoke.sh`** (47 lines):
- POSIX shell script that prints the three-line recipe with the current branch and version interpolated. Has no side-effects. Stays in the tree as the explicit-recipe alternative; `dev-install.sh` is the one-command alternative that **also runs** the recipe's intent (replace the cache with the worktree's content). Same script-header conventions apply: documented exit codes, preflight checks, `set -e`.

### What this story preserves (must not break)

- The production install path (`/plugin marketplace add ./` → `/plugin install crew@crew` → `/reload-plugins`) documented in `README-install.md`. End-users on a clean checkout follow that path unchanged.
- The daily dev loop (`pnpm --dir plugins/crew/mcp-server build:watch` + `/reload-plugins`) from `worktree-smoke.md`. Still the fastest loop for current-branch edits.
- The Story 1.9 committed-`dist/` contract. `pnpm dev:install` reads `dist/` from the source tree and routes it (via symlink or copy) to the cache; it does NOT need a separate "build first" UX beyond the build-check preflight in Task 2.2 step 2.
- Every existing vitest suite under `plugins/crew/mcp-server/tests/`. Zero skips, zero new warnings.
- The `(user-surface)` tag-extraction regex from Story 1.8 (`^\*\*AC(\d+)\s*\(user-surface\)\s*:\*\*`). Every tagged AC in this spec was authored against that regex.

### Smoke-gate event payloads (reference for orchestrator)

Per Story 1.8 § "Verification event schemas":

```json
// automated_e2e_verified — covers AC6
{
  "ac_refs": [6],
  "test_path": "plugins/crew/mcp-server/tests/dev-install.test.ts",
  "test_command": "pnpm --dir plugins/crew test dev-install"
}
```

```json
// user_surface_verified — covers AC1, AC2, AC5 (minimum); over-cover with [1,2,5,6] also legal
{
  "ac_refs": [1, 2, 5],
  "operator": "jack",
  "observations": [
    {"ac_ref": 1, "pasted_output": "<pnpm dev:install stdout + ls of ~/.claude/plugins/cache/crew/crew/0.1.0/skills/dev-install-sentinel/>"},
    {"ac_ref": 2, "pasted_output": "<Claude Code slash-command picker output showing the sentinel skill in the /crew: namespace>"},
    {"ac_ref": 5, "pasted_output": "<quoted paragraphs from dev-loop.md and the new top paragraph of README-install.md>"}
  ]
}
```

The gate's coverage check is `union(ac_refs across all valid events) ⊇ {1,2,5,6}`. Missing any → exit `42`.

### Previous story intelligence (Story 1.10 — directly upstream)

Story 1.10 rewrote `README-install.md` to match observed Claude Code 2.1.x UI reality. This story adds **one paragraph at the top** of that same file — the rest of the file (six checkpoints + Build artefacts subsection) is untouched. The new paragraph must not contradict any of 1.10's "Expected confirmation" blocks; it sits **above** the checkpoint list and clearly demarcates audience (engineer vs end-user).

Story 1.10's vitest harness (`readme-install.test.ts`) asserts a slash-command literal allowlist (`/plugin marketplace add ./`, `/plugin install crew@crew`, `/crew:status`). The new paragraph contains the literal `pnpm dev:install` in a fenced ` ```bash ` code block — this **adds a literal** to the allowlist if the test parses `bash`-tagged blocks for `pnpm` literals. Check `readme-install.test.ts`'s regex (Task 5 of 1.10 specified slash-command literals matching `^/[a-z][\w:-]*` only — `pnpm dev:install` doesn't match that pattern and will be ignored). If the allowlist is broader than the slash-command pattern, update the allowlist in this story's PR. Verify before assuming.

### Previous story intelligence (Story 1.8 — gate this story rides)

Story 1.8 added `ship.py pre-pr-gate`, the `user_surface_verified` / `automated_e2e_verified` event schemas, and the `(user-surface)` tag convention. This story is the **fourth production consumer** of the gate (after 1.9, 1.10, and 3.2's automated-route fallback). The dev agent does NOT generate verification evidence.

### Previous story intelligence (Story 3.2 / PR #90 — the motivating failure)

PR #90 (Story 3.2) shipped via the **automated route** on its AC4 because the user-surface smoke step could not be satisfied: `/crew:scan` did not appear in the slash-command picker even after every documented workaround. The retro comment on PR #90 (cited verbatim above in "What this story fixes") is the canonical failure narrative. Every choice in this story's contract above is calibrated against that failure — particularly the "MUST resolve source as the working tree, not main" and the daemon-restart guidance in Task 1.2.

### Spike 8739bbf (PR #85) — directly relevant prior research

The spike concluded that for **current-branch** edits the live-source path already works (Claude Code runs MCP from `plugins/crew/mcp-server/dist/index.js` in the source tree). That conclusion does NOT extend to the worktree-branch case: the marketplace registers the **main** checkout, not the worktree, so `CLAUDE_PLUGIN_ROOT` resolves to the main checkout and the worktree's `dist/` and `skills/` are invisible. This story is the worktree case the spike explicitly left unsolved.

The spike's "Open questions / risks" § "Skill loading path (partially verified)" is precisely the Task 1.2 research subtask — surface it again, with the empirical experiment described.

### Git intelligence

Recent commits (per `git log` at story authoring time):
- `273c4f6 feat(3): PlanningAdapter interface and adapter registry (#89)` — Story 3.1, the layer above the dev-loop pain.
- `e2fdcf6 chore: ship-story housekeeping — watch-build check + worktrees gitignore (#88)` — adds a watch-build check to ship-story (related — confirms the daily loop is supported infra).
- `52cdf1b chore: document fast dev loop + add build:watch script (#86)` — added `build:watch` to `mcp-server/package.json` per spike 8739bbf's recommendation. This story extends the dev-loop docs that change introduced.
- `8241e84 ci: auto-rebuild plugin dist on every push (#87)` — CI now rebuilds `dist/` on push; reduces the chance of a stale `dist/` blocking dev-install (the build-check preflight in Task 2.2 step 2 is belt-and-braces).
- `8739bbf docs(spike): symlink-based dev install for crew plugin (#85)` — the spike itself.

### Latest tech information

- **Claude Code version observed:** 2.1.144 (per Story 1.10's smoke evidence). The plugin daemon's skill-index cache lifecycle is not in the public Claude Code docs — Task 1.2 is the empirical resolution.
- **`/reload-plugins` behaviour:** per spike 8739bbf, restarts the MCP server node process for the current session, picks up new `dist/`. Whether it re-scans the skill index from disk is the open question; the spike's Test 3 / Test 4 are the canonical experiments.
- **`/plugin install` daemon semantics:** the install command stages the plugin tree into `~/.claude/plugins/cache/<plugin-marketplace>/<plugin>/<version>/`, then registers it. The cache is a **point-in-time snapshot** — `/plugin install` re-runs are idempotent on the same version (the daemon sees the plugin as already installed and skips). This is why the worktree-switching ritual requires `/plugin uninstall` first, and why `pnpm dev:install` exists.
- **No new dependencies.** The script uses POSIX shell. The vitest harness uses `node:fs`, `node:path`, `node:os`, `node:child_process` from stdlib. `tsc` already handles the test file (it's `.ts` under `mcp-server/tests/`).

### Project Structure Notes

- `plugins/crew/scripts/` already exists with one POSIX shell script (`worktree-smoke.sh`). `dev-install.sh` joins it as the second script with the same conventions (executable bit, exit-code table in header, `set -e`, preflight checks).
- `plugins/crew/docs/spikes/` already exists for spike reports. The Task 1.3 decision doc fits the convention.
- `plugins/crew/mcp-server/tests/` is the canonical vitest home. `dev-install.test.ts` joins the suite per the established one-test-file-per-concern pattern.
- The root repo has **no** `package.json` (verified via `ls /Users/<root>/`). Task 3.2's workspace-root alias is a no-op — the engineer runs `pnpm --dir plugins/crew dev:install` or, if a root `package.json` is later added in another story, the alias can be wired then. The dev-loop doc (Task 4.2) names whichever form is wired.
- No conflicts with the unified project structure.

### References

- Epic: [Source: _bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md § Story 1.11 (lines 255–278)]
- PR #90 retro (motivating failure): https://github.com/jackmcintyre/crew/pull/90 § "Dev-loop / plugin-deploy failure (the bigger lesson)"
- Spike report: [Source: plugins/crew/docs/spikes/symlink-dev-install.md]
- Worktree-smoke recipe (preserved): [Source: plugins/crew/docs/worktree-smoke.md]
- `worktree-smoke.sh` (preserved): [Source: plugins/crew/scripts/worktree-smoke.sh]
- User-surface tag rules: [Source: plugins/crew/docs/user-surface-acs.md]
- Smoke gate plumbing: [Source: _bmad-output/implementation-artifacts/1-8-user-surface-ac-type-and-smoke-gate-in-ship-story.md]
- Upstream README rewrite: [Source: _bmad-output/implementation-artifacts/1-10-readme-rewrite-match-observed-claude-code-ui-reality.md]
- Build artefacts contract (preserved): [Source: plugins/crew/docs/README-install.md § "Build artefacts"]
- Existing vitest pattern: [Source: plugins/crew/mcp-server/tests/dist-shipping.test.ts, plugins/crew/mcp-server/tests/pre-pr-gate.test.ts]

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- Task 1.2 (daemon re-scan trigger): empirical finding — no programmatic invalidation available in Claude Code 2.1.x; full restart required for skill-index refresh. Documented in `plugins/crew/docs/spikes/dev-install-decision.md`.
- AC7-1 test failure on first run: macOS `/var` → `/private/var` symlink aliasing caused `realpathSync(expectedCache) !== env.pluginsCrewDir`. Fixed by calling `realpathSync` on both sides of the assertion.

### Completion Notes List

- Chose hybrid symlink mechanism (option 1d from spec). Cache entry becomes a symlink to the worktree's `plugins/crew/` — zero-overhead on re-runs, always-fresh for skill changes, build-check preflight catches stale dist.
- Script exits 3 (not auto-build) when `dist/index.js` is missing — keeps the script fast and predictable; operator runs `pnpm --dir plugins/crew/mcp-server build` once.
- `--kill-daemon` flag included (off by default) for engineers who want to speed up MCP server restart without a full Claude Code session quit.
- No new dependencies added — vitest harness uses only Node stdlib (`node:fs`, `node:path`, `node:os`, `node:child_process`).
- All 393 tests pass across 33 test files, zero skips, zero new warnings.

### File List

- `plugins/crew/scripts/dev-install.sh` (NEW, executable)
- `plugins/crew/docs/dev-loop.md` (NEW)
- `plugins/crew/docs/spikes/dev-install-decision.md` (NEW)
- `plugins/crew/mcp-server/tests/dev-install.test.ts` (NEW)
- `plugins/crew/package.json` (MODIFIED — added `dev:install` script)
- `plugins/crew/docs/README-install.md` (MODIFIED — added engineer-audience paragraph at top)
- `plugins/crew/docs/worktree-smoke.md` (MODIFIED — added one-command alternative callout under Recipe)

### Change Log

- 2026-05-21: Story 1.11 implemented — dev-install script, dev-loop doc, decision record, vitest harness, package.json wire, README and worktree-smoke updates.
