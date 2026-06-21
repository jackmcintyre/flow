# Story 1.7a: Hotfix — make the install path actually work end-to-end

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the **plugin operator running Story 1.7's install README**,
I want **every command in the install path to actually work and the `/crew:status` skill to actually appear in tab-complete after a real install**,
so that **1.7's "happy path" isn't a literature exercise — it's a runnable sequence with at least one acceptance gate that verifies the install contract on every commit (FR71, FR73)**.

### What this story fixes (and why it needs its own story)

Story 1.7 shipped under green ACs but the install path was broken in two ways no AC caught:

1. **Wrong install command syntax.** Step 3 of `plugins/crew/docs/README-install.md` instructs the user to run `/plugin install plugins/crew`. Claude Code's `/plugin install` command does NOT take a path; it takes a `plugin-name@marketplace-name` reference that resolves against a marketplace previously registered via `/plugin marketplace add <path>`. (Verified against Claude Code docs — `/discover-plugins` and `/plugins-reference` pages.) A marketplace is a directory containing `.claude-plugin/marketplace.json` listing one or more plugins.
2. **`plugin.json` has `"skills": []`.** Even after a correct install, the new `plugins/crew/skills/status.md` is invisible to Claude Code because the plugin manifest's `skills` array doesn't register it. The `/crew:status` slash command never appears in tab-complete.

There IS a `.claude-plugin/marketplace.json` at the repo root today (`/Users/jackmcintyre/projects/crew/.claude-plugin/marketplace.json`) but it is **stale** — it still references the removed `sprint-orchestrator` plugin from before the rename. It must be rewritten in this story; it cannot be reused as-is.

Story 1.7's AC4f verified the README *contains* the expected checkpoint strings via regex — it did not verify the commands actually run. This story adds the missing static-contract acceptance gate (AC4 below) and acknowledges honestly that the runtime "Claude Code reports the plugin as installed" check cannot be automated in vitest (vitest can't drive Claude Code itself) — that piece becomes a one-shot manual smoke step Jack performs once after merge.

### What this story is, in one sentence

Replace the stale root `marketplace.json`, register `skills/status.md` in `plugin.json`, rewrite the README install step that uses the wrong command, and add a vitest suite that pins all three contracts (plus an orphan-skill guard for future stories) so the same class of bug can't ship green again.

### This story does NOT

- (a) Change `renderStatus`, `getStatus`, `StatusReportSchema`, or the `/crew:status` skill body — Story 1.7's runtime contract is preserved exactly. The 1.7 unit/integration suite (`get-status.test.ts`, etc.) MUST stay green with zero modifications.
- (b) Add a new MCP tool or new schema.
- (c) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions for this story (per the constraints handed to story creation).
- (d) Promise a vitest gate that drives Claude Code itself. AC1's "Claude Code reports the plugin as installed" line is a manual smoke step, called out explicitly. AC4 is the testable static-contract surface.
- (e) Introduce the full first-run walkthrough (example sprint, `/scan`, `/start`, PR merge) — that is still Epic 7 Story 7.2.
- (f) Add a troubleshooting section — that is still Epic 7 Story 7.5.
- (g) Touch any other plugin file under `plugins/crew/mcp-server/`, `plugins/crew/permissions/`, `plugins/crew/catalogue/`, or `plugins/crew/example/`.

---

## Acceptance Criteria

> **Note on AC scope.** The epic lists four ACs (AC1, AC2, AC3, AC4). The trailing `---` in the epic source is a section separator, not a fifth AC. The four ACs below match the epic verbatim and are the complete acceptance gate for this story.

**AC1 — A freshly cloned repo can run the corrected install sequence end-to-end (FR71, FR73):**
**Given** a freshly cloned `crew` repo,
**When** an operator runs the install sequence as documented in the corrected `plugins/crew/docs/README-install.md` — namely:
1. `claude --version` (checkpoint 1) succeeds,
2. `git clone … && cd crew && pnpm --dir plugins/crew install` (checkpoint 2) succeeds,
3. `/plugin marketplace add .` (checkpoint 3a, run from the repo root inside Claude Code) succeeds,
4. `/plugin install crew@crew` (checkpoint 3b) succeeds,
5. Claude Code is restarted (checkpoint 4),

**Then** every command exits successfully and Claude Code reports the plugin as installed at the version declared in `plugins/crew/.claude-plugin/plugin.json` (currently `0.1.0`).

> **Verification surface for AC1.** The static parts of this AC — that the README literally contains the corrected `/plugin marketplace add .` and `/plugin install crew@crew` strings, that the root `marketplace.json` exists and lists the `crew` plugin at the expected source path, and that `plugin.json` advertises a valid semver — are **all verified by AC4 below** (the testable static-contract gate). The runtime confirmation ("Claude Code reports the plugin as installed") cannot be driven from vitest (vitest can't reach into Claude Code's plugin runtime). It is a **manual smoke step Jack performs once after merge** — see "Manual smoke step (post-merge)" in the Tasks section. This is called out honestly: no unrunnable automation gate is promised.

**AC2 — After install, `/crew:status` appears in tab-complete and returns the unchanged five-line status block:**
**Given** the installed plugin (post-AC1 sequence) and Claude Code reopened,
**When** the operator opens the slash-command tab-complete,
**Then** `/crew:status` appears in the `/crew:` namespace,
**And** invoking it returns exactly the five-line status block defined by Story 1.7's `renderStatus(report)` — no behavioural change to the rendered output. This is verified statically by:
- AC4b — `plugin.json`'s `skills` array contains `skills/status.md` (so Claude Code discovers it),
- Story 1.7's existing `get-status.test.ts` continuing to pass with zero modifications (no behavioural drift in `renderStatus`).

The runtime tab-complete confirmation is part of the same manual smoke step as AC1.

**AC3 — Orphan-skill guard prevents the same class of bug from any future skill addition:**
**Given** the repo,
**When** any future story adds a new file under `plugins/crew/skills/`,
**Then** the vitest suite (specifically the test added in AC4b — see below) fails with a clear, actionable message naming the orphaned file(s), unless either:
1. The file IS registered in `plugins/crew/.claude-plugin/plugin.json`'s `skills` array (the normal path), OR
2. The file is named `.gitkeep` (existing convention — placeholder for a tracked-empty directory), OR
3. The file is listed in a documented opt-out file at `plugins/crew/.claude-plugin/skills-opt-out.txt` (one path per line, relative to the plugin root, e.g. `skills/draft.md`) — this opt-out mechanism is the documented escape hatch for in-progress / experimental skills that should not yet be surfaced to Claude Code.

The opt-out file MAY be absent (the common case); when absent, the test treats it as "no exclusions". When present, the test reads it, ignores blank lines and lines starting with `#` (comments), and treats every other line as an exclusion.

**Failure message format (mandatory wording, asserted by the test itself for self-consistency):**
```
Orphaned skill file(s) detected under plugins/crew/skills/:
  - skills/<orphan-1>.md
  - skills/<orphan-2>.md
Register each file in plugins/crew/.claude-plugin/plugin.json's "skills" array,
or add it to plugins/crew/.claude-plugin/skills-opt-out.txt (one path per line).
```

**AC4 — vitest asserts the four static install contracts (epic AC4):**

`pnpm test` from `plugins/crew/` adds one new test file: `plugins/crew/mcp-server/tests/install-contract.test.ts`. The suite asserts:

- **AC4a — Root `marketplace.json` exists, parses, and lists the `crew` plugin at the expected path.**
  Read `<repo-root>/.claude-plugin/marketplace.json` via `readFileSync` (resolve `<repo-root>` as `path.resolve(__dirname, "../../../..")` — three levels up from `plugins/crew/mcp-server/tests/`). Assert:
  1. The file exists (no `ENOENT`).
  2. `JSON.parse` succeeds (valid JSON).
  3. The parsed object satisfies `MarketplaceManifestSchema` (Zod, defined in Task 4) — shape pinned in "Marketplace manifest schema" below.
  4. `manifest.name === "crew"`.
  5. Exactly one entry in `manifest.plugins` has `{ name: "crew", source: "./plugins/crew" }`. Other entries are tolerated (forward-compat) but the `crew` entry MUST be present with that exact name and source.
  6. The `crew` plugin entry's `source` resolves on disk to a directory containing a `.claude-plugin/plugin.json` (i.e. `existsSync(path.resolve(repoRoot, source, ".claude-plugin/plugin.json"))` is true).

- **AC4b — `plugin.json`'s `skills` array lists every non-`.gitkeep` `*.md` file under `plugins/crew/skills/`, modulo the opt-out file.**
  Read `plugins/crew/.claude-plugin/plugin.json`. Glob `plugins/crew/skills/**/*.md` (use Node's `fs.readdirSync` recursively or the existing glob pattern from other tests — do NOT introduce a new dependency). Normalise each found path to a forward-slash relative path from the plugin root (e.g. `skills/status.md`). Read the opt-out file `plugins/crew/.claude-plugin/skills-opt-out.txt` if present (otherwise treat as empty). Compute `expected = globbed_paths − opt_out_paths`. Assert `manifest.skills` is a superset of `expected` (every expected path is in the array). When it isn't, **the test failure message MUST match the wording in AC3 verbatim**, listing each orphan as `skills/<filename>`. Path comparisons are case-sensitive, forward-slash normalised, and use POSIX `path.posix.join` for assembly (so the test passes on Linux CI and macOS dev alike).

- **AC4c — The corrected README contains the two-command install sequence.**
  Read `plugins/crew/docs/README-install.md`. Assert:
  1. The file contains the literal substring `/plugin marketplace add .` (checkpoint 3a).
  2. The file contains the literal substring `/plugin install crew@crew` (checkpoint 3b).
  3. The file does NOT contain the obsolete literal `/plugin install plugins/crew` (the bug we're fixing — explicit negative assertion to prevent silent regression).
  4. The file still satisfies Story 1.7's `CHECKPOINT_BLOCK_REGEX` (`/^\d+\.\s+\*\*[^*]+\.\*\*/gm`) — see "Checkpoint count" below for the exact count.
  5. The file still ends with the literal forward-reference line `> See Story 7.2 (Epic 7) for the full first-run walkthrough.` (Story 1.7's AC4f invariant — preserved verbatim).

- **AC4d — Story 1.7's `get-status.test.ts` still passes unchanged.**
  This is a meta-assertion: the test file from 1.7 is not modified by this story, and `pnpm test` from `plugins/crew/` runs both `get-status.test.ts` and `install-contract.test.ts` green. Verification: the dev confirms the `get-status.test.ts` file's git diff is empty against `main` at the end of this story, and `pnpm test` exits 0 with both files included.

All sub-tests pass alongside existing suites (smoke 1.1, resolver 1.2, validate-active-adapter 1.2b, standards-doc 1.3, permissions/canonical-fs 1.4, telemetry + git-commit 1.5, manifest-state-machine 1.6, get-status 1.7); total expected = existing baseline + new `install-contract.test.ts`; all green, zero skips.

---

### Checkpoint count

Story 1.7's README had six checkpoints. This story splits checkpoint 3 into two sub-steps (3a `/plugin marketplace add .` and 3b `/plugin install crew@crew`) and renumbers nothing else. The implementation MAY choose one of two equivalent encodings:

- **Option A (recommended):** Keep six top-level numbered headings; under checkpoint 3, use sub-bullets `3a.` and `3b.` (which do NOT match `CHECKPOINT_BLOCK_REGEX` because they start with `3a.` not `3.`). The regex still matches exactly six headings; AC4c clause 4 passes with `expect(matches.length).toBe(6)`.
- **Option B:** Renumber to seven top-level checkpoints (1, 2, 3, 4, 5, 6, 7). Then AC4c clause 4 must assert `expect(matches.length).toBe(7)`.

The dev MUST pick one and make the README and the AC4c assertion match. **Option A is recommended** because it keeps the checkpoint count stable (six is the number Story 1.7's spec language uses repeatedly) and the change is minimally invasive. The sample README copy in "Sample artifacts" below uses Option A.

---

## Tasks / Subtasks

- [ ] **Task 1 — Rewrite `<repo-root>/.claude-plugin/marketplace.json`** (AC: 1, 4a)
  - [ ] Open `/Users/jackmcintyre/projects/crew/.claude-plugin/marketplace.json` (which currently lists the removed `sprint-orchestrator` plugin — stale carry-over from the rename).
  - [ ] Replace the entire file contents with the JSON in "Sample artifacts → marketplace.json" below. The file's `name` is `crew`, `owner.name` is `Jack McIntyre` (matches the existing stale file's owner — no change needed there), and `plugins` has exactly one entry pointing at `./plugins/crew`.
  - [ ] Do NOT add a `version` field on the plugin entry — `plugin.json`'s `version` is the single source of truth, and Claude Code resolves it from there. (The stale file had `"version": "0.0.1"` on the sprint-orchestrator entry; we drop it on the new entry to avoid drift.)
  - [ ] Verify by hand: open the file in your editor, paste the JSON, save, and run `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json', 'utf8'))"` from the repo root — exit code 0 means valid JSON.

- [ ] **Task 2 — Update `plugins/crew/.claude-plugin/plugin.json` to register `skills/status.md`** (AC: 2, 4b)
  - [ ] Open `/Users/jackmcintyre/projects/crew/plugins/crew/.claude-plugin/plugin.json`. Today's contents:
    ```json
    {
      "name": "crew",
      "version": "0.1.0",
      "description": "AI Engineering Team v1 — a project-shaped team of long-lived AI agents driving a continuous-flow backlog.",
      "mcpServers": {
        "crew": {
          "command": "node",
          "args": ["./mcp-server/dist/index.js"]
        }
      },
      "skills": [],
      "agents": []
    }
    ```
  - [ ] Change the `skills` array from `[]` to `["skills/status.md"]`. Leave every other field unchanged (name, version, description, mcpServers, agents).
  - [ ] Path encoding: forward-slash, relative to the plugin root (`plugins/crew/`). No leading `./`. No trailing slash. (Claude Code accepts this shape per the plugin manifest docs.)
  - [ ] When future stories add new skill files, they extend this array. Story 1.7a does NOT add other skills.

- [ ] **Task 3 — Fix `plugins/crew/docs/README-install.md` checkpoint 3** (AC: 1, 4c)
  - [ ] Open `/Users/jackmcintyre/projects/crew/plugins/crew/docs/README-install.md`. Today's checkpoint 3 (lines 33–47) instructs `/plugin install plugins/crew` — this is the broken command.
  - [ ] Replace the body of checkpoint 3 (everything between the `3. **Load the plugin into Claude Code.**` heading and the `4. **Restart Claude Code.**` heading) with the copy in "Sample artifacts → README checkpoint 3" below. The replacement keeps a single `3.` heading (Option A in "Checkpoint count" above) and uses two sub-bullets `3a.` and `3b.` for the two commands.
  - [ ] Do NOT renumber checkpoints 1, 2, 4, 5, 6. Do NOT touch the forward-reference line at the end of the file.
  - [ ] Preserve the "Expected confirmation" fenced code block convention: each expected line goes in a code block tagged `text`. The semver-on-install confirmation line stays in 3b's expected block.

- [ ] **Task 4 — Define `MarketplaceManifestSchema` and add `install-contract.test.ts`** (AC: 3, 4a, 4b, 4c)
  - [ ] Create `plugins/crew/mcp-server/src/schemas/marketplace-manifest.ts`. Export:
    ```ts
    import { z } from "zod";

    export const MarketplaceManifestSchema = z.object({
      name: z.string().min(1),
      owner: z.object({ name: z.string().min(1) }),
      plugins: z.array(z.object({
        name: z.string().min(1),
        source: z.string().min(1),
        description: z.string().optional(),
      })).min(1),
    });
    export type MarketplaceManifest = z.infer<typeof MarketplaceManifestSchema>;
    ```
    > **Schema assumption (called out per instructions).** Claude Code's published docs (https://code.claude.com/docs/en/plugin-marketplaces, accessed via Context7) confirm `name`, `owner.name`, and a `plugins[]` array with `name` + `source` as the required fields, plus optional `description`, `version`, `category`, `tags`, `homepage`, `repository`, `license`, `keywords`, `author` per plugin entry, and an optional top-level `allowCrossMarketplaceDependenciesOn`. The schema above pins only the minimum required fields the install command depends on. We tolerate (and do not validate) the optional fields by leaving them out of the Zod object (Zod's default is to **strip** unknown keys via `.parse` — that is the intended behavior here; we're not enforcing a closed shape on the marketplace file, just the install-relevant subset).
  - [ ] Create `plugins/crew/mcp-server/tests/install-contract.test.ts`. Test layout mirrors the existing `get-status.test.ts` for fixture / import conventions. Imports:
    ```ts
    import { describe, it, expect } from "vitest";
    import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
    import * as path from "node:path";
    import { MarketplaceManifestSchema } from "../src/schemas/marketplace-manifest.js";
    ```
  - [ ] Resolve repo root: `const repoRoot = path.resolve(__dirname, "../../../..");`. Resolve plugin root: `const pluginRoot = path.resolve(repoRoot, "plugins/crew");`. **Sanity-check** at the top of the file: `expect(existsSync(path.join(pluginRoot, ".claude-plugin/plugin.json"))).toBe(true)` — if this fails, the test file is in the wrong place; fix that before any other assertion.
  - [ ] **Test cases (one `it` per AC4 sub-clause, plus the orphan-guard test for AC3):**
    1. `it("AC4a — root marketplace.json exists, is valid JSON, satisfies the schema, lists crew@./plugins/crew")` — read, parse, validate against `MarketplaceManifestSchema`, assert the `crew` plugin entry is present with `source: "./plugins/crew"`, assert that source resolves to a directory containing `.claude-plugin/plugin.json`.
    2. `it("AC4b — plugin.json's skills array lists every non-opt-out *.md file under skills/")` — implement the glob + opt-out logic from AC4b. **This test also covers AC3** — it's the orphan-skill guard. When the assertion fails, throw with the exact failure-message wording from AC3 (the test file MUST `expect(...).toEqual(expected)` AND on mismatch produce the message verbatim; the simplest implementation is to build the diff list, format the message, and call `throw new Error(message)` rather than relying on vitest's default diff output).
    3. `it("AC4c — README-install.md contains '/plugin marketplace add .' and '/plugin install crew@crew' and does NOT contain '/plugin install plugins/crew'")` — read the file, run three substring assertions (two positive, one negative).
    4. `it("AC4c — README-install.md still matches Story 1.7's CHECKPOINT_BLOCK_REGEX with the expected count")` — assert exactly six matches (Option A — recommended) OR seven (Option B). Pick one in lockstep with the README implementation. Sample artifacts below assume six.
    5. `it("AC4c — README-install.md ends with the Story 7.2 forward-reference line")` — assert the trimmed file ends with `> See Story 7.2 (Epic 7) for the full first-run walkthrough.`. **Preserves Story 1.7's AC4f invariant verbatim** — do not change the line text or weaken the assertion.
  - [ ] **Determinism:** No `Date.now()`, no `Math.random()`, no network, no spawned subprocesses. All inputs are on-disk files in the repo. The test is deterministic across macOS dev and Linux CI (path normalisation via `path.posix`).

- [ ] **Task 5 — (Optional) Create `plugins/crew/.claude-plugin/skills-opt-out.txt` as a placeholder?** (AC: 3)
  - [ ] **Do NOT create the file.** AC3 explicitly states the file MAY be absent and the test treats absence as "no exclusions". Creating an empty file would be noise. The opt-out mechanism is documented in this spec (and re-stated in the failure message) — that is sufficient. Future stories that need an opt-out create the file lazily.

- [ ] **Task 6 — Manual smoke step (post-merge — NOT a vitest gate)** (AC: 1, 2)
  - [ ] After the PR for this story merges, Jack performs the following manual sequence ONCE on a clean checkout (or in a fresh worktree) to confirm AC1's runtime claim and AC2's tab-complete claim:
    1. From the repo root, in Claude Code: `/plugin marketplace add .` → expect a confirmation that the `crew` marketplace was added.
    2. `/plugin install crew@crew` → expect a confirmation that the `crew@0.1.0` plugin is installed.
    3. Quit and reopen Claude Code.
    4. Open the slash-command tab-complete → expect `/crew:status` to be listed under the `/crew:` namespace.
    5. Run `/crew:status` from a directory that resolves to a valid target repo (or against this repo itself — same-repo case) → expect the five-line status block from Story 1.7 (`crew v0.1.0`, `target repo:`, `adapter:`, `standards:`, `cycle:`).
  - [ ] **This is not committable as a vitest test** — vitest cannot drive Claude Code's plugin runtime, slash-command registration, or tab-complete. The spec acknowledges this honestly and treats AC4 (static contract) as the testable surface.
  - [ ] If the manual smoke fails for any reason, **open a follow-up story** — do not amend this one post-merge. The follow-up's job is to add whichever static check would have caught the runtime failure, so the next regression can be a vitest test.

---

## Dev Notes

### Files to create

- `plugins/crew/mcp-server/src/schemas/marketplace-manifest.ts` (NEW — Zod schema for `marketplace.json`)
- `plugins/crew/mcp-server/tests/install-contract.test.ts` (NEW — install-contract acceptance gate)

### Files to modify

- `/Users/jackmcintyre/projects/crew/.claude-plugin/marketplace.json` (REWRITE — currently stale, references removed sprint-orchestrator plugin)
- `/Users/jackmcintyre/projects/crew/plugins/crew/.claude-plugin/plugin.json` (UPDATE — `skills: []` → `skills: ["skills/status.md"]`; no other field changes)
- `/Users/jackmcintyre/projects/crew/plugins/crew/docs/README-install.md` (UPDATE — checkpoint 3 only; checkpoints 1, 2, 4, 5, 6 unchanged; forward-reference line unchanged)

### Files NOT to modify (read-only context — touching them is a regression)

- `plugins/crew/mcp-server/src/tools/get-status.ts` — Story 1.7. `renderStatus` and `getStatus` are frozen.
- `plugins/crew/mcp-server/src/schemas/status-report.ts` — Story 1.7. `StatusReportSchema` is frozen.
- `plugins/crew/skills/status.md` — Story 1.7. Skill body is frozen.
- `plugins/crew/mcp-server/tests/get-status.test.ts` — Story 1.7. **Must remain bit-identical to `main` at end of this story** (AC4d).
- `plugins/crew/mcp-server/src/server.ts`, `src/index.ts`, `src/tools/register.ts` — Stories 1.1, 1.4, 1.7. No changes.
- `plugins/crew/mcp-server/src/lib/plugin-version.ts` — Story 1.1.
- `plugins/crew/mcp-server/src/state/*.ts` — Stories 1.2, 1.2b, 1.3.
- `plugins/crew/permissions/`, `plugins/crew/catalogue/`, `plugins/crew/example/` — out of scope.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — orchestrator-owned. **Do not touch.**

### Sample artifacts

These are the literal contents the implementation must produce. Examples are **self-consistent with every regex, schema, and assertion** in this spec — verify by inspection.

#### `<repo-root>/.claude-plugin/marketplace.json`

```json
{
  "name": "crew",
  "owner": {
    "name": "Jack McIntyre"
  },
  "plugins": [
    {
      "name": "crew",
      "source": "./plugins/crew",
      "description": "AI Engineering Team v1 — a project-shaped team of long-lived AI agents driving a continuous-flow backlog."
    }
  ]
}
```

**Self-consistency check:**
- Satisfies `MarketplaceManifestSchema` (name, owner.name, plugins[≥1] each with name+source, optional description) — ✓.
- `plugins[0].name === "crew"` — matches AC4a clause 4 and the `/plugin install crew@crew` reference in the README.
- `plugins[0].source === "./plugins/crew"` — matches AC4a clause 5 and resolves on disk to `<repo-root>/plugins/crew/.claude-plugin/plugin.json` (exists today) — AC4a clause 6 passes.

#### `plugins/crew/.claude-plugin/plugin.json` (after Task 2)

```json
{
  "name": "crew",
  "version": "0.1.0",
  "description": "AI Engineering Team v1 — a project-shaped team of long-lived AI agents driving a continuous-flow backlog.",
  "mcpServers": {
    "crew": {
      "command": "node",
      "args": ["./mcp-server/dist/index.js"]
    }
  },
  "skills": ["skills/status.md"],
  "agents": []
}
```

**Self-consistency check:**
- `skills` contains `skills/status.md` — AC4b passes (the only `*.md` file under `plugins/crew/skills/` today is `status.md`; `.gitkeep` is excluded per AC3 clause 2).
- `version` matches `SEMVER_REGEX` — `0.0.0`-style strings would fail; `0.1.0` matches `^\d+\.\d+\.\d+(?:-[\w.]+)?$`.
- No other fields change vs. today's file.

#### README checkpoint 3 (replacement copy — Option A, six total checkpoints)

```markdown
3. **Load the plugin into Claude Code.**

   Run two commands from the repo root, inside Claude Code:

   3a. Register the repo as a plugin marketplace:

   ```text
   /plugin marketplace add .
   ```

   Expected confirmation:

   ```text
   Marketplace added: crew
   ```

   3b. Install the `crew` plugin from that marketplace:

   ```text
   /plugin install crew@crew
   ```

   Expected confirmation:

   ```text
   Plugin installed: crew@0.1.0
   ```

   (The exact version comes from `plugins/crew/.claude-plugin/plugin.json`; `<semver>` matches `^\d+\.\d+\.\d+(?:-[\w.]+)?$`.)
```

**Self-consistency check:**
- Contains literal `/plugin marketplace add .` — AC4c clause 1 passes.
- Contains literal `/plugin install crew@crew` — AC4c clause 2 passes.
- Does NOT contain `/plugin install plugins/crew` — AC4c clause 3 passes (negative assertion).
- The `3.` heading line `3. **Load the plugin into Claude Code.**` matches `CHECKPOINT_BLOCK_REGEX` (`^\d+\.\s+\*\*[^*]+\.\*\*`) — verify by reading: `3` → `^\d+`, `. ` → `\.\s+`, `**Load the plugin into Claude Code.**` → `\*\*[^*]+\.\*\*` (the `[^*]+` covers `Load the plugin into Claude Code`, then `.`, then `\*\*`). ✓ One match for checkpoint 3.
- `3a.` and `3b.` do NOT match `CHECKPOINT_BLOCK_REGEX` because `3a` is not `\d+` (it has the letter `a` after the digit before the dot). ✓ The total match count over the file stays at 6.
- `Plugin installed: crew@0.1.0` — the semver `0.1.0` matches `SEMVER_REGEX`. ✓
- "Marketplace added: crew" — this is the expected confirmation string; the dev should verify the exact wording against a real Claude Code run during the manual smoke step (Task 6). If Claude Code's actual output differs (e.g. "Added marketplace: crew" or "Plugin marketplace added"), update the README in lockstep and **adjust the spec's sample-artifact text accordingly**. AC4c does NOT assert the confirmation-line text — only the command text — so this drift does not break tests; it's a fidelity issue for the human reader.

#### Failure message (mandatory wording for AC4b's orphan-guard test)

```
Orphaned skill file(s) detected under plugins/crew/skills/:
  - skills/<orphan-1>.md
  - skills/<orphan-2>.md
Register each file in plugins/crew/.claude-plugin/plugin.json's "skills" array,
or add it to plugins/crew/.claude-plugin/skills-opt-out.txt (one path per line).
```

The test computes the diff (globbed files minus opt-out minus already-registered), formats one bullet per orphan in the order returned by `readdirSync` (lexicographic on most filesystems), and throws an Error with this message verbatim.

### Marketplace manifest schema — call-out and source

The schema in Task 4 (`MarketplaceManifestSchema`) pins the minimum required shape of `.claude-plugin/marketplace.json` for the install command to resolve `crew@crew` correctly. Source: Claude Code public docs (`https://code.claude.com/docs/en/plugin-marketplaces`, accessed via Context7 during story creation, 2026-05-19). The required fields are `name`, `owner.name`, and `plugins[]` with `name` + `source` per entry. The full doc-supported schema also accepts optional `version`, `category`, `tags`, `homepage`, `repository`, `license`, `keywords`, `author` per plugin entry, and a top-level `allowCrossMarketplaceDependenciesOn` array. We do not validate these because they are not load-bearing for the install path. **If a future story needs to assert any of those fields, extend the schema in lockstep with the assertion** — do not add fields speculatively.

### Architectural compliance

- **TS code conventions** (`architecture/implementation-patterns-consistency-rules.md` §6): `kebab-case.ts` filenames, named exports only, no `any`, no default exports, no path aliases. `marketplace-manifest.ts` and `install-contract.test.ts` comply.
- **Schema location**: Zod schemas live under `mcp-server/src/schemas/`. `marketplace-manifest.ts` complies.
- **Test location**: vitest files live under `mcp-server/tests/`. `install-contract.test.ts` complies.
- **No new dependencies**: `zod`, `vitest`, `node:fs`, `node:path` are already in the workspace. No new npm packages.
- **MCP tool registration**: not relevant — this story adds no MCP tool.
- **Skill-file shape** (`architecture/implementation-patterns-consistency-rules.md` §8): not relevant — no skill body changes.
- **Locked phrases** (§7): not relevant — no verdict / handoff / yield grammar in scope.

### Self-consistency invariants (the cross-check between spec and implementation)

These constants appear in this spec and MUST be the exact strings the implementation emits / matches:

1. **`/plugin marketplace add .`** — exact literal in README checkpoint 3a; asserted by AC4c clause 1.
2. **`/plugin install crew@crew`** — exact literal in README checkpoint 3b; asserted by AC4c clause 2. The `crew@crew` notation is `<plugin-name>@<marketplace-name>` where both happen to be `crew` (plugin name from `plugin.json`, marketplace name from `marketplace.json.name`).
3. **`/plugin install plugins/crew`** — the obsolete bug-bait literal that MUST NOT appear in the file (AC4c clause 3 — negative assertion).
4. **`crew` (plugin name)** — `plugin.json.name === "crew"`, `marketplace.json.plugins[0].name === "crew"`. Both files agree.
5. **`./plugins/crew`** — `marketplace.json.plugins[0].source`. Resolves on disk to `<repo-root>/plugins/crew/.claude-plugin/plugin.json`. AC4a clause 6.
6. **`skills/status.md`** — `plugin.json.skills[0]`. The single file currently under `plugins/crew/skills/` (the `.gitkeep` is filtered by AC3 clause 2).
7. **`> See Story 7.2 (Epic 7) for the full first-run walkthrough.`** — Story 1.7's AC4f forward-reference line; preserved verbatim; AC4c clause 5.
8. **Checkpoint count = 6** — Option A in "Checkpoint count" above; AC4c clause 4 asserts `matches.length === 6`.
9. **`CHECKPOINT_BLOCK_REGEX` = `/^\d+\.\s+\*\*[^*]+\.\*\*/gm`** — Story 1.7's regex; reused verbatim, not re-defined.
10. **Failure message text** — see "Sample artifacts → Failure message" above; matched verbatim by the orphan-guard test.

If the implementation drifts from any of the ten above, both the spec sample artifact AND the test will fail together — that's the point.

### Manual smoke step — what to do if it fails

If Jack runs the post-merge smoke step (Task 6) and any of the five sub-steps fail, the failure is either:

1. **A wording drift** (e.g. Claude Code prints "Marketplace registered" instead of "Marketplace added"). This is a docs-fidelity bug — update `README-install.md` checkpoint 3a's "Expected confirmation" text in a follow-up commit. No spec change needed; AC4c does not assert confirmation text.
2. **A real install failure** (e.g. `/plugin install crew@crew` errors). Open a follow-up story whose job is to (a) reproduce the failure deterministically and (b) add a static check that would have caught it. Do NOT amend Story 1.7a — its job is done once the four static ACs pass and the static contract is locked.
3. **`/crew:status` doesn't appear in tab-complete** after install + restart. Triage: verify `plugin.json` actually has `skills/status.md` registered (AC4b would have failed if not), and verify the skill file's frontmatter is parseable (Story 1.7 frozen the body — should be fine). If Claude Code's skill-discovery has additional requirements beyond `plugin.json.skills` (e.g. a specific frontmatter key), capture them in a follow-up story.

### Deferred (out of scope, captured for traceability)

- **Full first-run walkthrough** (example sprint, `/scan`, `/start`, PR merge) — still Epic 7 Story 7.2.
- **Troubleshooting guide** — still Epic 7 Story 7.5.
- **CI integration of the manual smoke step** — would require either a Claude Code headless mode or a separate harness. Out of v1 scope. Captured as a deferred item; revisit when Epic 7 builds out the install canary.
- **Cross-marketplace dependencies** (`allowCrossMarketplaceDependenciesOn`) — not needed; the `crew` plugin has no dependencies on plugins from other marketplaces.
- **Plugin signing / publication** — out of v1 scope.

### Previous story intelligence (Story 1.7)

- Story 1.7 shipped `getStatus`, `renderStatus`, `StatusReportSchema`, `/crew:status` skill, `README-install.md`, root README + plugin README rewrites, and `get-status.test.ts`. All of those are frozen by this story except checkpoint 3 of `README-install.md`.
- Story 1.7's `CHECKPOINT_BLOCK_REGEX` (`/^\d+\.\s+\*\*[^*]+\.\*\*/gm`) is reused verbatim by AC4c — do not redefine.
- Story 1.7's AC4f line (`> See Story 7.2 (Epic 7) for the full first-run walkthrough.`) is preserved verbatim by AC4c clause 5.
- Story 1.7's `get-status.test.ts` is untouched (AC4d).
- The bug Story 1.7a fixes was latent in 1.7's code from day one — 1.7's AC4f checked the README *text* but no AC actually executed the install commands. That is the lesson; AC3 + AC4b together prevent the same class of bug for any future skill addition.

### Git intelligence (recent commits informing this story)

- `b4dbaa6 chore: rename claude-dev-loop → crew everywhere (repo + plugin namespace)` — this is the rename that left the stale `sprint-orchestrator` reference in `<repo-root>/.claude-plugin/marketplace.json` (Task 1 cleans it up).
- `bbdc10c feat(1.6): atomic fs.rename state-machine primitive` — Story 1.6, orthogonal.
- `a4b2a36 feat(ship-story): persist resolve JSON, surface reviewer notes, tighten validator` — orthogonal harness work.
- The most recent feature commits target stories 1.4, 1.5, 1.6, 1.7 — none should be touched by 1.7a.

### Latest technical specifics

- **Claude Code plugin marketplace docs** (verified 2026-05-19 via Context7, `/websites/code_claude`):
  - `/plugin marketplace add <path-or-url>` registers a marketplace. A marketplace is a directory containing `.claude-plugin/marketplace.json`.
  - `/plugin install <plugin>@<marketplace>` installs a plugin from a registered marketplace. The form `/plugin install <path>` is NOT supported by Claude Code's current `/plugin` command.
  - `marketplace.json` required fields: `name`, `owner.name`, `plugins[]` with `name` and `source` per entry. `source` may be a relative directory path (resolved against the marketplace dir), a git URL, or a github reference.
  - `plugin.json` recognises top-level arrays for `skills`, `agents`, `commands`, `hooks`, plus the `mcpServers` map. Each entry in `skills` is a path relative to the plugin root pointing at a `*.md` skill file.
- **`zod`** — already a workspace dependency. No new install.
- **`vitest`** — already wired. No new install.
- **No new npm packages.** No new transitive dependencies.

### Project context reference

- PRD: `_bmad-output/planning-artifacts/prd-crew-v1.md` (FR71, FR73).
- Epic 1: `_bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md` — Story 1.7a section at lines 181–199 (4 ACs; trailing `---` is a separator, not an AC).
- Previous story spec: `_bmad-output/implementation-artifacts/1-7-status-skill-and-readme-install-path-through-the-plugin-sees-my-repo.md` — read for context on what's frozen and where the gaps are.
- Architecture project structure: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md`.
- Skill-file shape, MCP tool naming, TS code conventions: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §§4, 6, 8.
- Worktree for implementation: `/Users/jackmcintyre/projects/crew/.worktrees/1-7a-hotfix-make-the-install-path-actually-work-end-to-end`.

---

## Story Completion Status

Ultimate context engine analysis completed — comprehensive developer guide created. This story closes the install-path gap left open by Story 1.7: replaces the stale root `marketplace.json`, registers `skills/status.md` in `plugin.json`, fixes the README checkpoint 3 command sequence, and adds a static-contract vitest suite (`install-contract.test.ts`) that pins all four invariants plus an orphan-skill guard for every future skill addition. Runtime confirmation of "plugin appears in Claude Code" is acknowledged as a one-shot manual smoke step (Task 6) — not promised as an automation gate.
