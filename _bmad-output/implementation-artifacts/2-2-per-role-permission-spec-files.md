# Story 2.2: Per-role permission spec files

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **a `plugins/crew/permissions/<role>.yaml` file for each of the ten catalogue roles plus a placeholder `plugins/crew/permissions/gh-error-map.yaml`**,
so that **the tool-layer allowlist enforcement scaffolded in Story 1.4 has a concrete contract per hired role to enforce, the catalogue's `gh_allow` values from Story 2.1 are mirrored into the dispatcher's source of truth, and the generalist-reviewer's negative-capability (no merge / no close / no push) is encoded as a tested omission rather than a prose promise.**

### What this story is, in one sentence

Ship ten `permissions/<role>.yaml` files plus an empty-skeleton `gh-error-map.yaml`, derive every `gh_allow` value from the matching catalogue file shipped in Story 2.1 (no paraphrase, no drift), update the existing `permissions-enforcement.test.ts` so its shipped-roles assertions cover all ten roles, and add a new vitest harness that cross-checks catalogue ↔ permissions parity and asserts the reviewer's negative-capability omission of `pr-merge`, `pr-close`, and any push-capable subcommand.

### What this story fixes (and why it needs its own story)

Story 1.4 built the dispatcher and `gh` wrapper that refuse unlisted tools/subcommands and shipped *fixture* permission files plus two real specs (`generalist-dev.yaml`, `generalist-reviewer.yaml`) as proof-of-concept. Story 2.1 then pinned the canonical `gh_allow` values for every catalogue role in the catalogue frontmatter. Until the remaining eight `permissions/<role>.yaml` files exist:

- Story 2.3 (persona instantiation) hires roles whose dispatcher cannot find a permission spec — every `loadRolePermissions` call for `planner`, `retro-analyst`, `orchestrator`, `hiring-manager`, `security-specialist`, `test-specialist`, `docs-specialist`, or `debugger` throws `RolePermissionsMissingError`.
- Story 2.4 (`/hire`) cannot complete a hire because the hired role has no enforceable allowlist.
- The two pre-existing specs (`generalist-dev.yaml`, `generalist-reviewer.yaml`) **drift from catalogue values** — the reviewer YAML currently allows `api` and `pr-checks` and omits `pr-review`, while the Story 2.1 catalogue pins reviewer's `gh_allow` to `pr-view, pr-comment, pr-review`. The existing `permissions-enforcement.test.ts` asserts the reviewer has no `pr-review`, which directly contradicts the catalogue. **One of catalogue or permissions must move; Story 2.2 reconciles by deriving permissions from the catalogue.**
- The reviewer's negative-capability contract (FR37, FR38, NFR16) is currently encoded only as the absence of `pr-merge` / `pr-close` in the YAML — but the existing test conflates this with `pr-review` (a positive capability the reviewer *needs*). Story 2.2 fixes the test to assert the correct omissions (`pr-merge`, `pr-close`, and any `push`-bearing subcommand) and removes the incorrect `pr-review` exclusion.
- `gh-error-map.yaml` is referenced in the epic AC1 and the architecture's plugin tree (`project-structure-boundaries.md` line 45) but does not exist on disk; absence breaks any tool that resolves `permissions/gh-error-map.yaml` by path. Story 4.5 owns the **content** (NFR18 error-class table); Story 2.2 ships the **file** as an empty / placeholder YAML so the path resolves.

This is **spec + content + test reconciliation**, not behaviour — the dispatcher already enforces; this story authors the contracts it enforces against.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- (b) Modify `plugins/crew/catalogue/*.md`. The catalogue is the source of truth (Story 2.1). If a discrepancy is found, fix `permissions/<role>.yaml`, not the catalogue. The one exception is documenting (in a comment header) the catalogue version each YAML was derived from — and even that is optional, see Task 3.5.
- (c) Modify `plugins/crew/mcp-server/src/schemas/role-permissions.ts`. The shipped schema is sufficient. Do not add fields, do not loosen `.strict()`, do not change the `role` regex.
- (d) Modify `plugins/crew/mcp-server/src/state/load-role-permissions.ts` or `plugins/crew/mcp-server/src/lib/gh.ts`. The dispatcher and gh-wrapper are correct as shipped in Story 1.4; this story only changes the data they load.
- (e) Implement the NFR18 `gh-error-map` classification semantics (`defer | retry | needs-human`). That is Story 4.5. v1 ships `gh-error-map.yaml` as an empty-skeleton placeholder; the file must parse as valid YAML but its content is `entries: []` (see Task 2.11).
- (f) Author persona files, `team/` directories, hiring flows, `/hire`, `/team`, or `/ask` — those are Stories 2.3 / 2.4 / 2.5 / 2.6 / 2.7.
- (g) Add or modify any slash command (`plugins/crew/skills/*.md`) — this story does not surface a slash command. Permissions are read by the MCP dispatcher, not invoked by the operator.
- (h) Touch `plugins/crew/docs/README-install.md` — the install-path operator (Maya) never opens, copies, or sees a permissions file during install. The dispatcher reads them transparently.
- (i) Change `tools_allow` in the catalogue. Note: the catalogue's `tools_allow` (e.g. `Read, Edit, Bash, Task`) names Claude Code primitives a hired persona is permitted to use at agent time; the permission YAML's `tools_allow` names **MCP tool dispatcher methods** (e.g. `claimStory`, `recordVerdict`) the role is permitted to invoke via the MCP boundary. These are two different allowlists at two different layers and must not be conflated. Task 2.1 pins the MCP-tool repertoire per role.

---

## Acceptance Criteria

> **Verbatim from epic.** ACs 1–3 match `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.2. AC4 is the epic's `**AC4 (integration):**` test contract.
>
> **User-surface judgement.** None of these ACs is `user-surface` per `plugins/crew/docs/user-surface-acs.md`. The permissions files live under `plugins/crew/permissions/` and are consumed by the MCP dispatcher (Story 1.4) and the gh wrapper (Story 1.4) — the v1 install-path operator (Maya) never lists this directory, never types `permissions/<role>.yaml` from any docs instruction, and never observes a Claude Code UI element produced by this story. The dispatcher's refusal messages **do** surface to the operator at runtime, but those are exercised by Stories 2.3 / 2.4 (hiring) and Epic 4 (dev/review loop), not here. AC4's `pnpm --dir plugins/crew test` invocation is dev/CI tooling, not an install-path operator command. Rubric (i)–(iv) do not apply.

**AC1:**
**Given** every catalogue role shipped in Story 2.1 (`hiring-manager`, `planner`, `generalist-dev`, `generalist-reviewer`, `retro-analyst`, `orchestrator`, `security-specialist`, `test-specialist`, `docs-specialist`, `debugger`),
**When** I list `plugins/crew/permissions/`,
**Then** I see exactly eleven files: one `<role>.yaml` per catalogue role plus `gh-error-map.yaml` — no more, no fewer, no other extensions, no other names. _(FR79)_
<!-- user-surface: AC names a directory under plugins/crew/ but the operator never lists it; the README does not instruct anyone to open these files by name. Rubric (iii) does not apply. Not user-surface. -->

**AC2:**
**Given** any of the ten per-role permission specs in `plugins/crew/permissions/`,
**When** it is parsed against `RolePermissionsSchema` (shipped in Story 1.4 at `plugins/crew/mcp-server/src/schemas/role-permissions.ts`),
**Then** it validates with: `role` matching a catalogue role id (kebab-case, exact-match against the AC1 set), `tools_allow` a non-empty list of MCP tool names, `gh_allow` a list (possibly empty) of `gh` subcommand kebab-case strings, and `gh_allow_args` an optional record (empty `{}` for v1). _(FR79)_
<!-- user-surface: AC names an internal schema file and field names the operator never observes. Not user-surface. -->

**AC3:**
**Given** the `generalist-reviewer.yaml` permission spec,
**When** I inspect its `gh_allow` list,
**Then** the strings `pr-merge`, `pr-close`, and any subcommand containing `push` (e.g. `push`, `git-push`) are **absent** — negative capability encoded as omission, mirroring the catalogue's pinned reviewer `gh_allow` of exactly `[pr-view, pr-comment, pr-review]`. _(FR37, FR38, NFR16)_
<!-- user-surface: omission is an internal contract; the operator never types or observes these subcommand strings at the surface in this story. Not user-surface. -->

**AC4 (integration):**
**Given** the ten shipped permission specs, the existing catalogue files (Story 2.1), and the updated tests,
**When** `pnpm --dir plugins/crew test` runs the new test file `plugins/crew/mcp-server/tests/permissions-catalogue-parity.test.ts` **and** the updated `permissions-enforcement.test.ts`,
**Then** vitest asserts (a) every catalogue role in `plugins/crew/catalogue/` has a same-named `<role>.yaml` under `plugins/crew/permissions/` (and vice versa, modulo the special `gh-error-map.yaml`); (b) each permission YAML parses through `RolePermissionsSchema`; (c) each permission YAML's `gh_allow` set equals the matching catalogue file's `gh_allow` set (parity); (d) the `generalist-reviewer.yaml` `gh_allow` set does not contain `pr-merge`, `pr-close`, or any string matching `/push/i`; (e) the `gh-error-map.yaml` file exists and parses as valid YAML. Any drift fails with a diagnostic naming the offending role, file path, and the catalogue-vs-permissions diff.
<!-- user-surface: AC4 names the CLI command `pnpm --dir plugins/crew test` literally, but that command is run by the dev (and CI), not by the install-path operator. The README does not instruct Maya to run pnpm test. Rubric (ii) is about operator-typed commands from docs; dev/CI tooling does not qualify. Not user-surface. -->

---

## Tasks / Subtasks

- [ ] **Task 1 — Pin the MCP-tool repertoire per role (preparation, AC: 2)**
  - [ ] 1.1 The catalogue's `tools_allow` names Claude Code primitives (Read, Edit, Bash, Task). The permission YAML's `tools_allow` names **MCP dispatcher tools** (e.g. `claimStory`, `recordVerdict`, `lookupStandards`). These are two different allowlists at two different boundaries. **Do not copy catalogue `tools_allow` into permissions YAML.**
  - [ ] 1.2 The MCP tool repertoire was established in Story 1.4 and is partially visible in the existing `permissions/generalist-dev.yaml` and `permissions/generalist-reviewer.yaml`. v1's MCP tools (the closed set the dispatcher knows about) are:
    - State machine: `claimStory`, `completeStory`, `blockStory`, `recordYield`, `heartbeat`.
    - Reading: `readSourceStory`, `lookupStandards`.
    - Review: `recordVerdict`, `classifyRiskTier`, `computeAgreement`.
    - Status/observability (Story 1.7): `getStatus`.

    For Story 2.2, every role's `tools_allow` must list **only** MCP tools that role legitimately uses in v1. Pin the per-role lists from the table in Task 2 below. If a tool the dispatcher doesn't know about appears in any YAML, vitest will not catch it (the dispatcher rejects unknown invocations at runtime, not at load time) — but Story 4 acceptance tests will fail downstream. **Use only the names above.**
  - [ ] 1.3 If a role exists in v1 that legitimately invokes **zero** MCP tools (e.g. `hiring-manager` may only operate through Claude Code primitives), the schema's `tools_allow.min(1)` constraint still requires at least one entry. In that case, list `heartbeat` — every hired role emits liveness pings (NFR via Story 1.5 telemetry plumbing) and `heartbeat` is the safe default tool no role can do without. **Do not invent placeholder tool names.**

- [ ] **Task 2 — Author the eleven YAML files (AC: 1, 2, 3, 4)**
  - [ ] 2.1 Per-role values — pinned below. **`gh_allow` lists are copied verbatim from the matching `plugins/crew/catalogue/<role>.md` frontmatter** (verified against Story 2.1 as merged). Do not paraphrase, do not reorder (set equality is what AC4(c) asserts; order does not matter, but minimising diff in code review does).

    | role | tools_allow (MCP tools) | gh_allow (from catalogue) |
    |---|---|---|
    | `hiring-manager` | `[heartbeat]` | `[]` |
    | `planner` | `[readSourceStory, lookupStandards, recordYield, heartbeat]` | `[pr-view]` |
    | `generalist-dev` | `[claimStory, completeStory, blockStory, readSourceStory, lookupStandards, recordYield, heartbeat, classifyRiskTier]` | `[pr-create, pr-view, pr-comment]` |
    | `generalist-reviewer` | `[readSourceStory, lookupStandards, recordVerdict, classifyRiskTier, computeAgreement, recordYield, heartbeat]` | `[pr-view, pr-comment, pr-review]` |
    | `retro-analyst` | `[readSourceStory, lookupStandards, recordYield, heartbeat]` | `[pr-view]` |
    | `orchestrator` | `[getStatus, recordYield, heartbeat]` | `[pr-view]` |
    | `security-specialist` | `[readSourceStory, lookupStandards, recordYield, heartbeat]` | `[pr-view, pr-comment]` |
    | `test-specialist` | `[readSourceStory, lookupStandards, recordYield, heartbeat]` | `[pr-view, pr-comment]` |
    | `docs-specialist` | `[readSourceStory, lookupStandards, recordYield, heartbeat]` | `[pr-view, pr-comment]` |
    | `debugger` | `[readSourceStory, lookupStandards, recordYield, heartbeat]` | `[pr-view, pr-comment]` |

    Notes on the table:
    - The `gh_allow` column is the load-bearing column for AC4(c) parity. The dev MUST re-read each `plugins/crew/catalogue/<role>.md` and copy the `gh_allow:` list verbatim. If a discrepancy is found between this table and the catalogue at implementation time, **trust the catalogue** (it is the merged source of truth) and update this story's task list with a one-line note.
    - `tools_allow` MCP-tool lists are conservative for v1. Specialists (`security-specialist`, `test-specialist`, `docs-specialist`, `debugger`) get the same read-side toolset as `planner` because v1 routes their work through the planner's domain (story drafts) rather than the dev's domain (claims/completions). Epic 4 may broaden these; do not pre-optimise here.
    - `orchestrator` gets `getStatus` (Story 1.7) and `recordYield`/`heartbeat` only — it observes state and yields domain back to other roles; it never claims or completes stories itself (FR per architecture §3 boundary).
    - `gh_allow_args` is `{}` for every role in v1 — Story 2.x / Epic 3 may populate placeholder substitutions; not in scope here.
  - [ ] 2.2 File template (every per-role YAML follows this exact shape; the example below is for `planner`):
    ```yaml
    role: planner
    tools_allow:
      - readSourceStory
      - lookupStandards
      - recordYield
      - heartbeat
    gh_allow:
      - pr-view
    gh_allow_args: {}
    ```
    No frontmatter, no top-level comments other than the optional catalogue-version header (Task 3.5). One file per role under `plugins/crew/permissions/<role>.yaml`.
  - [ ] 2.3 Create `plugins/crew/permissions/hiring-manager.yaml` with `tools_allow: [heartbeat]`, `gh_allow: []`, `gh_allow_args: {}`.
  - [ ] 2.4 Create `plugins/crew/permissions/planner.yaml` with the values from the table.
  - [ ] 2.5 **Update** `plugins/crew/permissions/generalist-dev.yaml` if and only if its current contents do not match the table above. The current file (as shipped in Story 1.4) has `tools_allow: [claimStory, completeStory, blockStory, readSourceStory, lookupStandards, recordYield, heartbeat, classifyRiskTier]` and `gh_allow: [pr-create, pr-view, pr-comment, pr-checks, pr-edit]`. The catalogue pins `gh_allow: [pr-create, pr-view, pr-comment]` — so **remove `pr-checks` and `pr-edit`** from `gh_allow` to achieve catalogue parity (AC4(c)). Leave `tools_allow` as-is (it matches the table). After this edit, run `pnpm --dir plugins/crew test` once — note any `permissions-enforcement.test.ts` expectations that broke (Task 4 will reconcile).
  - [ ] 2.6 **Update** `plugins/crew/permissions/generalist-reviewer.yaml`. The current file has `gh_allow: [pr-view, pr-comment, pr-checks, api]`. The catalogue pins `gh_allow: [pr-view, pr-comment, pr-review]`. Replace with the catalogue values exactly: **add `pr-review`, remove `pr-checks` and `api`**. Leave `tools_allow` as-is (it matches the table). The negative-capability AC3 (no `pr-merge`, no `pr-close`, no `push`) is satisfied by this list — neither `pr-merge` nor `pr-close` nor any push-bearing subcommand appears.
  - [ ] 2.7 Create `plugins/crew/permissions/retro-analyst.yaml` with the values from the table.
  - [ ] 2.8 Create `plugins/crew/permissions/orchestrator.yaml` with the values from the table.
  - [ ] 2.9 Create `plugins/crew/permissions/security-specialist.yaml`, `plugins/crew/permissions/test-specialist.yaml`, `plugins/crew/permissions/docs-specialist.yaml`, and `plugins/crew/permissions/debugger.yaml` with the values from the table.
  - [ ] 2.10 Confirm every `role:` field exactly matches the filename stem (e.g. `role: security-specialist` in `security-specialist.yaml`). The dispatcher does not enforce this match, but it is a debugging foothold and the AC2 parity check will rely on it.
  - [ ] 2.11 Create `plugins/crew/permissions/gh-error-map.yaml`. v1 ships an **empty skeleton**:
    ```yaml
    # gh-error-map.yaml — NFR18 error-class table.
    # Story 4.5 (Epic 4) will populate `entries` with
    # `(exit_code, stderr_regex) → defer | retry | needs-human` rows.
    # Story 2.2 ships the file so the path resolves and AC1's
    # "one YAML per role plus gh-error-map.yaml" count holds.
    entries: []
    ```
    The file must be valid YAML; `entries: []` is the only key. **Do not** invent classification rows — that is Story 4.5's contract.
  - [ ] 2.12 Delete `plugins/crew/permissions/.gitkeep` if present (the directory now has eleven tracked files; the placeholder is no longer needed). If absent, no action.

- [ ] **Task 3 — Author the new parity test (AC: 1, 2, 3, 4)**
  - [ ] 3.1 Add `plugins/crew/mcp-server/tests/permissions-catalogue-parity.test.ts`. New file. Pattern after `catalogue-shape.test.ts` (Story 2.1) for the catalogue-discovery side and after `permissions-enforcement.test.ts` § "shipped role specs (AC5e)" for the permissions-loading side.
  - [ ] 3.2 Resolve `plugins/crew/catalogue/` and `plugins/crew/permissions/` from `import.meta.url` — match the helper used in `catalogue-shape.test.ts` and `dist-shipping.test.ts`. Do NOT invent a new path-resolving helper.
  - [ ] 3.3 **Filename allowlist for permissions/ (AC1).** Explicit allowlist of eleven filenames:
    ```ts
    const PERMISSION_FILES = [
      "hiring-manager.yaml","planner.yaml","generalist-dev.yaml","generalist-reviewer.yaml",
      "retro-analyst.yaml","orchestrator.yaml","security-specialist.yaml","test-specialist.yaml",
      "docs-specialist.yaml","debugger.yaml","gh-error-map.yaml",
    ] as const;
    ```
    Assert: `readdirSync(permissionsDir)` (filtered to exclude `.gitkeep`) returns exactly this set. Diagnostic on failure names the diff (extra / missing).
  - [ ] 3.4 **Cross-directory parity (AC4(a)).** Read the ten catalogue filenames using the same helper Story 2.1 used (or the `CATALOGUE_FILES` constant if it is exported from `catalogue-shape.test.ts` — if not exported, redeclare locally and add a TODO referencing Story 2.1's allowlist). Assert that for every catalogue file `<role>.md`, a corresponding `<role>.yaml` exists in `permissions/`. Assert that for every permission file `<role>.yaml` (other than `gh-error-map.yaml`), a corresponding catalogue file exists. Diagnostic names the orphan.
  - [ ] 3.5 **Schema parse check (AC2, AC4(b)).** For each of the ten per-role YAMLs, call `loadRolePermissions({ role: <role>, pluginRoot: REAL_PLUGIN_ROOT })` (reusing the loader from Story 1.4) and assert success. A parse failure produces a diagnostic naming the file and the Zod issue path.
  - [ ] 3.6 **Catalogue-permissions `gh_allow` parity (AC4(c)).** For each role, parse the catalogue file's YAML frontmatter (reuse the `splitFrontmatter` helper from `plugins/crew/mcp-server/src/lib/markdown-frontmatter.ts` shipped in Story 2.1), extract `gh_allow`, and compare to the permission YAML's `gh_allow` as **set equality** (sort both arrays before comparing, or convert both to `Set` and compare sizes + membership). Diagnostic on mismatch shows both lists and the symmetric difference.
  - [ ] 3.7 **Reviewer negative-capability (AC3, AC4(d)).** Load `generalist-reviewer.yaml` and assert:
    ```ts
    expect(perms.gh_allow).not.toContain("pr-merge");
    expect(perms.gh_allow).not.toContain("pr-close");
    expect(perms.gh_allow.some((s) => /push/i.test(s))).toBe(false);
    ```
    Three separate assertions, three separate diagnostics on failure. Do NOT assert `not.toContain("pr-review")` — `pr-review` is a positive capability the reviewer needs (catalogue pins it).
  - [ ] 3.8 **gh-error-map exists and parses (AC4(e)).** Read `plugins/crew/permissions/gh-error-map.yaml`, parse with the `yaml` library, assert the result is an object containing an `entries` key with an array value (length 0 is fine for v1). Diagnostic on parse failure names the file path.
  - [ ] 3.9 The test file header MUST cite this story (`Story 2.2 AC1–AC4`) and reference both `plugins/crew/docs/user-surface-acs.md` and the Story 2.1 catalogue test, mirroring the comment-header convention used in `catalogue-shape.test.ts` and `pre-pr-gate.test.ts`.
  - [ ] 3.10 Run `pnpm --dir plugins/crew test`. Confirm the new test passes alongside the existing suite. Expected: 18→19 suites (one new file), all tests green.

- [ ] **Task 4 — Reconcile the existing `permissions-enforcement.test.ts` (AC: 3)**
  - [ ] 4.1 Open `plugins/crew/mcp-server/tests/permissions-enforcement.test.ts`. The "shipped role specs (AC5e)" describe block at lines 184–209 currently has two tests:
    - `"loads generalist-dev with non-empty tools_allow and gh_allow"` — no change needed; the assertions (`tools_allow.length > 0`, `gh_allow.length > 0`, `contains "claimStory"`, `contains "completeStory"`) still hold after Task 2.5.
    - `"loads generalist-reviewer and asserts negative-capability (no pr-merge/pr-close/pr-review)"` — **the title and the third assertion are wrong** per the catalogue. Update the test:
      - Rename to `"loads generalist-reviewer and asserts negative-capability (no pr-merge/pr-close/push)"`.
      - Replace `expect(perms.gh_allow).not.toContain("pr-review");` with `expect(perms.gh_allow.some((s) => /push/i.test(s))).toBe(false);`.
      - Add a positive assertion that `pr-review` IS present: `expect(perms.gh_allow).toContain("pr-review");` — this guards against accidental future drift in the other direction.
  - [ ] 4.2 The two `describe("gh wrapper enforcement", …)` tests at lines 123–182 use `test-role` (a fixture). Do NOT touch the fixture at `plugins/crew/mcp-server/tests/fixtures/permissions/test-role.yaml`. Do NOT touch the fixture-driven assertions.
  - [ ] 4.3 Run `pnpm --dir plugins/crew test`. Confirm `permissions-enforcement.test.ts` passes with the rewritten reviewer test and no other test regressed.

- [ ] **Task 5 — Build & dist verification (AC: 4)**
  - [ ] 5.1 Run `pnpm --dir plugins/crew/mcp-server build`. The new test file references `loadRolePermissions` (existing) and may add a parity helper inline (no new source code under `src/`). `tsc` must compile cleanly.
  - [ ] 5.2 Per `plugins/crew/docs/README-install.md` § Build artefacts and Story 1.9's contract, the built `mcp-server/dist/` tree is committed. **This story adds no new source files under `src/`** — it adds tests under `tests/` and YAML data under `permissions/`. Neither `tests/` nor `permissions/` is in the `dist/` build output, so `dist/` should be unchanged. If `pnpm build` produces any `dist/` diff, investigate (likely cause: an inadvertent `src/` edit). The `ci-drift-check.test.ts` enforces src-vs-dist alignment — confirm it still passes.
  - [ ] 5.3 The eleven YAML files under `permissions/` are static assets shipped as-is per `/plugin install`'s file-copy semantics. No bundling step.

- [ ] **Task 6 — Verify no other story's contract drifted (AC: 1–4)**
  - [ ] 6.1 Open `plugins/crew/catalogue/<role>.md` for each of the ten roles. Confirm the `gh_allow:` list pinned in Task 2.1's table is byte-for-byte what the catalogue ships. If it has changed since this spec was written, **update the YAML to match the catalogue, not the other way around** — the catalogue (Story 2.1) is the merged source of truth.
  - [ ] 6.2 Confirm `plugins/crew/mcp-server/src/schemas/role-permissions.ts` is unchanged. The shipped schema (`role` regex `^[a-z0-9-]+$`, `tools_allow.min(1)`, `.strict()` at every level) is sufficient.
  - [ ] 6.3 Confirm `plugins/crew/mcp-server/src/state/load-role-permissions.ts` is unchanged. The loader's behaviour (ENOENT → `RolePermissionsMissingError`, YAML/Zod failure → `RolePermissionsMalformedError`) is unchanged.
  - [ ] 6.4 No other tree is touched. Specifically: do NOT edit `plugins/crew/catalogue/*.md`, `plugins/crew/skills/*`, `plugins/crew/docs/*`, root `README.md`, or any MCP tool/server file. Permission YAML authorship and a single test rewrite are the only changes.

---

## Dev Notes

### Critical context: what was shipped before, what this story builds on

- **Story 1.1** scaffolded `plugins/crew/permissions/` (with `.gitkeep`) and the schemas directory under `mcp-server/src/`.
- **Story 1.4** is the load-bearing predecessor. It shipped:
  - `RolePermissionsSchema` at `plugins/crew/mcp-server/src/schemas/role-permissions.ts` — `.strict()`, kebab-case `role` regex, `tools_allow.min(1)`, `gh_allow` defaults to `[]`, `gh_allow_args` is a `record(string, string[])`.
  - `loadRolePermissions` at `plugins/crew/mcp-server/src/state/load-role-permissions.ts` — single-purpose IO wrapper, no caching, `pluginRoot` flows in as a parameter.
  - The dispatcher (`plugins/crew/mcp-server/src/server.ts`) refusal pattern `Role 'X' is not allowed to invoke tool 'Y'. (FR79/FR80/NFR12). See permissions/X.yaml.`.
  - The `gh` wrapper (`plugins/crew/mcp-server/src/lib/gh.ts`) refusal pattern `Role 'X' is not allowed to invoke 'gh Y'. (NFR17). See permissions/X.yaml.`.
  - Two real-world specs (`generalist-dev.yaml`, `generalist-reviewer.yaml`) as proof. **The reviewer one drifted from what Story 2.1 later pinned in the catalogue — Story 2.2 reconciles by updating the YAML.**
  - A fixture (`tests/fixtures/permissions/test-role.yaml`) — leave untouched.
  - The `permissions-enforcement.test.ts` suite — this story rewrites one assertion in the "shipped role specs (AC5e)" block (Task 4.1) and leaves the fixture-driven tests untouched.
- **Story 1.5** wired JSONL telemetry. **This story does not emit telemetry.** The dispatcher emits permission-denial events; the YAML files themselves are inert data.
- **Story 1.6** shipped the atomic-rename state machine. Permission files are read-only at runtime; they are never claimed, never moved, never have execution manifests. This story doesn't touch the state machine.
- **Story 1.7** added `/crew:status`. Status does not read permissions; out of scope.
- **Story 1.8** added the `user-surface` AC tag and pre-PR smoke gate. **Story 2.2 has zero `user-surface` ACs.** The gate parses the spec, finds no `(user-surface)`-tagged ACs, and exits 0 with `{"status":"skipped"}` per `plugins/crew/docs/user-surface-acs.md` § "How the gate uses this" step 2. No operator-paste-output step is required for this story's PR.
- **Story 1.9** committed `mcp-server/dist/`. This story does not modify `src/`, so `dist/` should be unchanged — verify in Task 5.2.
- **Story 2.1** shipped the ten catalogue files at `plugins/crew/catalogue/<role>.md` with the canonical `gh_allow` lists this story mirrors into `permissions/<role>.yaml`. **It also shipped `plugins/crew/mcp-server/src/lib/markdown-frontmatter.ts`** with a `splitFrontmatter` helper that Task 3.6 reuses for parsing catalogue frontmatter in the parity test.

### Architecture references (load these first, dev agent)

- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §1 (Frontmatter Conventions) — snake_case keys, lists as block sequences, Zod-backed schemas. Permission YAML follows the same conventions.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §6 (TypeScript Code Conventions) — only relevant if the dev wants to add a parity-test helper to `mcp-server/src/lib/` (this story does NOT require that; the test inlines its logic).
- `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` line 45 — confirms `plugins/crew/permissions/gh-error-map.yaml` is part of the shipped plugin tree.
- `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md` line 88 — pins the `gh-error-map.yaml` format as `(exit_code, stderr_regex) → defer | retry | needs-human`. **For information only — Story 4.5 owns the content; Story 2.2 ships an empty `entries: []` placeholder.**
- `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR79, FR80, FR81 — permission-enforcement contract.
- `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR37, FR38 — reviewer's authority boundaries (reviewer does not merge, does not close, does not push). NFR16 reinforces this with explicit negative-capability framing.
- `plugins/crew/docs/user-surface-acs.md` — for confirming the `user-surface` judgement above.

### Files this story creates (NEW)

- `plugins/crew/permissions/hiring-manager.yaml`
- `plugins/crew/permissions/planner.yaml`
- `plugins/crew/permissions/retro-analyst.yaml`
- `plugins/crew/permissions/orchestrator.yaml`
- `plugins/crew/permissions/security-specialist.yaml`
- `plugins/crew/permissions/test-specialist.yaml`
- `plugins/crew/permissions/docs-specialist.yaml`
- `plugins/crew/permissions/debugger.yaml`
- `plugins/crew/permissions/gh-error-map.yaml` (empty `entries: []` skeleton; Story 4.5 will populate)
- `plugins/crew/mcp-server/tests/permissions-catalogue-parity.test.ts`

### Files this story MAY modify (UPDATE, with care)

- `plugins/crew/permissions/generalist-dev.yaml` — remove `pr-checks` and `pr-edit` from `gh_allow` to achieve catalogue parity (Task 2.5). Leave `tools_allow` and `gh_allow_args` unchanged.
- `plugins/crew/permissions/generalist-reviewer.yaml` — set `gh_allow` to `[pr-view, pr-comment, pr-review]` exactly: add `pr-review`, remove `pr-checks`, remove `api` (Task 2.6). Leave `tools_allow` and `gh_allow_args` unchanged.
- `plugins/crew/mcp-server/tests/permissions-enforcement.test.ts` — rewrite one assertion in the "shipped role specs (AC5e)" reviewer test (Task 4.1). Do NOT modify any other test in this file. Do NOT modify the fixture-driven gh-wrapper tests at lines 123–182.
- `plugins/crew/permissions/.gitkeep` — delete if present, since the directory now has eleven tracked files. Optional.

### Files this story MUST NOT modify

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (orchestrator owns).
- `plugins/crew/catalogue/*.md` — Story 2.1 is the source of truth for `gh_allow`. If the catalogue and this spec disagree, fix the YAML to match the catalogue, not the other way around.
- `plugins/crew/mcp-server/src/schemas/role-permissions.ts` — shipped schema is sufficient.
- `plugins/crew/mcp-server/src/state/load-role-permissions.ts` — loader behaviour is correct.
- `plugins/crew/mcp-server/src/lib/gh.ts` — gh-wrapper behaviour is correct.
- `plugins/crew/mcp-server/src/server.ts` — dispatcher behaviour is correct.
- `plugins/crew/mcp-server/tests/fixtures/permissions/test-role.yaml` — fixture is referenced by `permissions-enforcement.test.ts` line 4–6 and by `gh` wrapper tests; do not change it.
- `plugins/crew/docs/README-install.md` — operator does not see permission files during install.
- `plugins/crew/skills/*` — no slash command surface here.
- `plugins/crew/mcp-server/dist/**` — no source changes, so no rebuild expected.
- Root `README.md`.

### Pinned `gh_allow` values from the merged catalogue (source: `plugins/crew/catalogue/<role>.md` as of Story 2.1)

```yaml
hiring-manager:     []
planner:            [pr-view]
generalist-dev:     [pr-create, pr-view, pr-comment]
generalist-reviewer:[pr-view, pr-comment, pr-review]
retro-analyst:      [pr-view]
orchestrator:       [pr-view]
security-specialist:[pr-view, pr-comment]
test-specialist:    [pr-view, pr-comment]
docs-specialist:    [pr-view, pr-comment]
debugger:           [pr-view, pr-comment]
```

These were read directly from the ten catalogue files. **The dev MUST re-verify at implementation time by re-reading the catalogue.** If any value differs in the catalogue at implementation time, update the YAML to match the catalogue and add a one-line note to the completion log.

### Negative-capability contract for `generalist-reviewer` (AC3)

The reviewer's `gh_allow` is `[pr-view, pr-comment, pr-review]`. AC3 asserts the **omission** of three categories of subcommand:

1. `pr-merge` — the reviewer never authors a merge. Merges are a separate authority (FR37, FR38).
2. `pr-close` — the reviewer never closes a PR. Closing is a planner/orchestrator authority.
3. Any `push`-bearing subcommand (`push`, `git-push`, etc.) — the reviewer never writes to a branch. NFR16: reviewer is a read-and-comment role, not a write role.

`pr-review` is a **positive capability**, not a negative one — it is the `gh pr review` subcommand that the reviewer uses to submit approving / requesting-changes verdicts via the GitHub API. It must be present in the reviewer's `gh_allow`. The existing test (`permissions-enforcement.test.ts` line 207) incorrectly asserts its absence; Task 4.1 fixes this.

### Testing standards

- **Framework:** vitest, already configured (`plugins/crew/mcp-server/vitest.config.ts`).
- **Test placement:** `plugins/crew/mcp-server/tests/<name>.test.ts` — matches every other test in the suite.
- **Run command:** `pnpm --dir plugins/crew test` — runs all suites. Single-file: `pnpm --dir plugins/crew/mcp-server exec vitest run tests/permissions-catalogue-parity.test.ts`.
- **No skips, no `.only`, no `.todo`.** New test must run cleanly alongside the existing suites.
- **Diagnostics on failure** must name the offending file path and the catalogue-vs-permissions diff so a future dev does not have to bisect.
- **Reuse, don't reinvent:** `loadRolePermissions` (Story 1.4), `splitFrontmatter` from `lib/markdown-frontmatter.ts` (Story 2.1), and the path-resolving idiom from `catalogue-shape.test.ts` (Story 2.1) are the building blocks. Do NOT add a new path-resolver, do NOT add a new YAML parser, do NOT duplicate frontmatter-splitting logic.

### Project Structure Notes

- All paths follow `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` exactly. No deviations.
- Permissions live under `plugins/crew/permissions/` (architecture §"Plugin tree" line 44–45). The dispatcher and gh-wrapper that consume them live under `plugins/crew/mcp-server/src/`.
- The "permissions are read-only at runtime" boundary means this story does not need to wire any MCP tool to write to `permissions/`. The dispatcher only reads.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md#Story 2.2: Per-role permission spec files`] — verbatim epic ACs.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR79`] — agents declare allowed tools and `gh` subcommands explicitly.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR80`] — tool-layer enforcement, not prompt alone.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR37`] — reviewer authority boundary (no merge).
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR38`] — reviewer authority boundary (no close, no push).
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md#NFR16`] — reviewer negative-capability contract.
- [Source: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md#Plugin tree`] — directory layout including `permissions/<role>.yaml + gh-error-map.yaml`.
- [Source: `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md#Error classification`] — `gh-error-map.yaml` format (Story 4.5 will populate; Story 2.2 ships placeholder).
- [Source: `plugins/crew/docs/user-surface-acs.md`] — `user-surface` tagging rubric (Story 1.8 convention).
- [Source: `plugins/crew/mcp-server/src/schemas/role-permissions.ts`] — the schema this story's YAMLs validate against.
- [Source: `plugins/crew/mcp-server/src/state/load-role-permissions.ts`] — the loader this story's parity test invokes.
- [Source: `plugins/crew/mcp-server/tests/permissions-enforcement.test.ts`] — the existing test whose reviewer assertion this story rewrites.
- [Source: `plugins/crew/mcp-server/tests/catalogue-shape.test.ts`] — the Story 2.1 sibling test whose patterns this story mirrors.
- [Source: `plugins/crew/catalogue/*.md`] — the ten catalogue files whose `gh_allow` lists this story mirrors.

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
