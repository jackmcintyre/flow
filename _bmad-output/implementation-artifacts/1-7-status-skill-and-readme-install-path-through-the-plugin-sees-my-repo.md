# Story 1.7: `/status` skill and README install path through "the plugin sees my repo"

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **a `/<plugin>:status` skill that prints the current adapter, plugin version, and standards-doc state, plus a README that walks me from clone through running `/status` with verifiable checkpoints**,
so that **my first install of the plugin gives me a concrete, runnable confirmation that the plugin is wired up against my repo before anything else happens (FR71, FR73, FR74)**.

This story closes Epic 1 by tying every primitive built in 1.1–1.6 into a single user-visible surface:

1. **`getStatus` MCP tool** — a new tool at `mcp-server/src/tools/get-status.ts` that composes (a) `getPluginVersion()` from Story 1.1, (b) `resolveWorkspace()` from Story 1.2, (c) `validateActiveAdapter()` from Story 1.2b, and (d) `lookupStandards()` from Story 1.3 to return a typed `StatusReport`. Registered against the MCP server via `server.registerTool(...)` in a new `mcp-server/src/tools/register.ts` that wires every tool the plugin ships (today: only `getStatus`; later stories append).
2. **`/<plugin>:status` skill** — a new slash-command Markdown file at `plugins/crew/skills/status.md` (using the skill-file shape pinned by `architecture/implementation-patterns-consistency-rules.md` §8). The skill's job: invoke the `getStatus` MCP tool, then print one canonical status block to the user.
3. **`docs/README-install.md`** — a new walkthrough at `plugins/crew/docs/README-install.md` covering install path through "the plugin sees my repo" (FR73 partial — the full install path lands in Epic 7 Story 7.2). Six checkpoints, each runnable, each with the exact expected output line.
4. **Plugin README update** — `plugins/crew/README.md` becomes a one-screen pointer to `docs/README-install.md` for the install path and to the PRD for the broader vision. The current standards-doc paragraph collapses into a single link into `README-install.md` step 3.
5. **Root README update** — `README.md` at the repo root currently still references the legacy `sprint-orchestrator` plugin (lines 1–60). Replace with a one-page pointer at `plugins/crew/docs/README-install.md`. The full first-run-in-5-minutes flow lands in Epic 7 Story 7.2; v1 of Epic 1 just retires the stale copy and points to the install walkthrough.
6. **Vitest coverage (epic AC4)** — a new integration test at `mcp-server/tests/get-status.test.ts` drives the MCP tool against (a) a fresh target repo with a missing `docs/standards.md`, (b) a configured target repo with a valid `docs/standards.md`, (c) a target repo with a malformed `docs/standards.md`. Each produces the expected status-line text per the rules pinned in this spec.

**This story does NOT** (a) introduce a "cycle" concept beyond a `current_cycle: "none"` placeholder — cycle archival lands in Epic 6 Story 6.12; (b) ship the full first-run-in-5-minutes README (Epic 7 Story 7.2); (c) wire `/status` into the orchestration loop or watch surface (Epic 5); (d) cache the status report across invocations — every call re-resolves; (e) emit telemetry from `getStatus` — `/status` is a read-only diagnostic, no `skill.invoke` event from the MCP tool layer for v1 (skills emit their own `skill.invoke` events in later stories); (f) add any new domain errors — every failure mode in this story is already covered by errors from Stories 1.2 / 1.2b / 1.3.

The seam: every install walkthrough, every recovery doc, every CI smoke check from Epic 7 onwards relies on `/status` as the single observable confirmation that the plugin sees the user's repo. This story is what makes "the plugin sees my repo" verifiable.

---

## Acceptance Criteria

**AC1 — `/<plugin>:status` against a freshly cloned repo with the plugin loaded and a valid target-repo config prints the canonical status block (FR74):**
**Given** a target repo with `<targetRepoRoot>/.crew/config.yaml` resolving cleanly (Story 1.2 AC1) and `<targetRepoRoot>/docs/standards.md` parsing cleanly against `StandardsDocSchema` (Story 1.3),
**When** the user runs `/<plugin>:status` from inside Claude Code with that target repo loaded,
**Then** the skill calls the `getStatus` MCP tool (and nothing else under the hood — no direct `fs.read` from the skill body, no shelled `node` script),
**And** the tool returns a `StatusReport` whose fields satisfy the `StatusReportSchema` defined in `mcp-server/src/schemas/status-report.ts` (see Task 1),
**And** the skill prints exactly the status block defined by the `renderStatus(report)` helper in `mcp-server/src/tools/get-status.ts`, which produces five lines in this exact order with this exact prefix grammar:

```
crew v<plugin-semver>
target repo: <absolute-path>
adapter: <adapter-name> (<ok | mismatched>)
standards: <ok | missing | malformed> — <docs/standards.md absolute-path>
cycle: <none | <ulid>>
```

- `<plugin-semver>` is the value returned by `getPluginVersion()` and MUST match the `SEMVER_REGEX` from `mcp-server/src/schemas/plugin-manifest.ts` (`^\d+\.\d+\.\d+(?:-[\w.]+)?$`).
- `<absolute-path>` MUST equal `workspace.targetRepoRoot` (already resolved-absolute by `resolveWorkspace`).
- `<adapter-name>` is `workspace.activeAdapterName`. `(ok)` is appended when `validateActiveAdapter` returns the workspace unchanged; `(mismatched)` is the rendering for the `StaleWorkspaceConfigError` case — see AC2.
- The `standards:` line shows `ok` on a clean parse, `missing` on `StandardsDocMissingError`, `malformed` on `StandardsDocMalformedError`. The path component is always the resolved absolute path `<targetRepoRoot>/docs/standards.md`, even when missing.
- The `cycle:` line is always `none` in v1 (placeholder for Epic 6 Story 6.12).

**AC2 — `/<plugin>:status` is identical across same-repo (Jack dog-fooding) and split-repo (Maya) configurations (FR74 — one code path):**
**Given** the plugin tree and a target tree pointing at the SAME repo (e.g. `targetRepoRoot === <repo-root>`),
**When** `/<plugin>:status` is invoked,
**Then** the code path is byte-identical to the split-repo case — `getStatus` accepts `targetRepoRoot` as its single input argument and does not branch on "is this the plugin's own repo,"
**And** the rendered status block uses the same five-line grammar from AC1,
**And** the integration test at `mcp-server/tests/get-status.test.ts` includes an explicit `it("same-repo and split-repo produce identical renders for identical fixture state")` case that pre-seeds two tmp dirs with byte-identical `.crew/config.yaml` + `docs/standards.md`, calls `getStatus` against each, and asserts the rendered string of the second is equal to the first after substituting the target-repo path,
**And** `/<plugin>:status` is invoked the same way (same skill file, same MCP tool name, same argument shape) in both cases — no parallel skill, no parallel tool, no environment-variable switch.

**AC3 — `docs/README-install.md` walks install through "the plugin sees my repo" with six verifiable checkpoints (FR71, FR73):**
**Given** the new walkthrough at `plugins/crew/docs/README-install.md`,
**When** a fresh reader follows the checkpoints in order,
**Then** the file contains EXACTLY these six numbered checkpoints, each with the exact runnable command and the exact expected confirmation line — checkpoint copy MUST satisfy the `CHECKPOINT_BLOCK_REGEX` from Task 3:

1. **Install Claude Code.** Command: `claude --version`. Expected confirmation: a line matching `^claude \d+\.\d+\.\d+`.
2. **Clone the repo and install plugin dependencies.** Command: `git clone https://github.com/jackmcintyre/crew.git && cd crew && pnpm --dir plugins/crew install`. Expected confirmation: the final line of `pnpm install` matches `^(Done|Already up to date)` (pnpm prints one of these on success).
3. **Load the plugin into Claude Code.** Command (inside Claude Code, from repo root): `/plugin install plugins/crew`. Expected confirmation: Claude Code prints `Plugin installed: crew@<semver>` where `<semver>` matches the `SEMVER_REGEX` from `plugin-manifest.ts`.
4. **Restart Claude Code.** Command: quit and reopen Claude Code (no shell command). Expected confirmation: after reopen, the `/crew:` slash-command namespace appears in tab-complete with at least `/crew:status` listed.
5. **Copy the standards template into your target repo.** Command: `cp plugins/crew/docs/standards-example.md <target-repo>/docs/standards.md`. Expected confirmation: `ls <target-repo>/docs/standards.md` returns the path (file now exists). The walkthrough notes that `<target-repo>` may be the same as the cloned `crew` repo (Jack's same-repo case) or a different repo (Maya's split-repo case) — no behavioural difference (back-reference AC2).
6. **Run `/<plugin>:status` and see the expected line.** Command (inside Claude Code, with `<target-repo>` loaded as the workspace): `/crew:status`. Expected confirmation: a status block whose first line matches `^crew v\d+\.\d+\.\d+(?:-[\w.]+)?$` and whose `standards:` line starts with `standards: ok`.

The walkthrough's "Expected confirmation" copy for each checkpoint MUST be a single fenced code block tagged `text`, exactly matching the literal string shape above. The file MUST NOT include any steps beyond these six — full install (running the example sprint, scanning sources, running `/start`) is explicitly out of scope and lives in Epic 7 Story 7.2 (a forward-reference note at the bottom of the file points there).

**AC4 — vitest integration coverage of `getStatus` against missing / valid / malformed standards (epic AC4):**
`pnpm test` from `plugins/crew/` adds one new test file (`mcp-server/tests/get-status.test.ts`). The suite asserts:
- **AC4a (valid standards.md):** Pre-seed `<root>/.crew/config.yaml` with a minimal valid config (re-use the fixture pattern from `workspace-resolver.test.ts`) and `<root>/docs/standards.md` with a copy of `plugins/crew/docs/standards-example.md`. Call `getStatus({ targetRepoRoot: root })`. Assert: (i) the returned `StatusReport` parses against `StatusReportSchema` with `standards.state === "ok"`, (ii) `report.adapter.state === "ok"` and `adapter.name === "bmad"`, (iii) `report.pluginVersion` matches `SEMVER_REGEX`, (iv) `renderStatus(report)` returns a string whose first line equals `crew v${report.pluginVersion}` and whose `standards:` line starts with `standards: ok — `.
- **AC4b (missing standards.md):** Pre-seed `<root>/.crew/config.yaml` only. Call `getStatus(...)`. Assert: (i) the call resolves (does NOT throw), (ii) `report.standards.state === "missing"`, (iii) `report.standards.path === path.join(root, "docs", "standards.md")`, (iv) `renderStatus(report)` produces a `standards: missing — <abs-path>` line, (v) `report.adapter.state === "ok"` (a missing standards doc does not invalidate the adapter — it just downgrades the standards line).
- **AC4c (malformed standards.md):** Re-use one of the existing standards-doc fixture trees from `mcp-server/tests/fixtures/standards/malformed-*/` (Story 1.3). Pre-seed `<root>/.crew/config.yaml`. Call `getStatus(...)`. Assert: (i) the call resolves (does NOT throw — the malformed case is a downgraded status, not a hard failure), (ii) `report.standards.state === "malformed"`, (iii) `report.standards.zodMessage` is a non-empty string surfaced from the underlying `StandardsDocMalformedError`, (iv) `renderStatus(report)` produces a `standards: malformed — <abs-path>` line.
- **AC4d (stale adapter config):** Pre-seed `<root>/.crew/config.yaml` with `adapter: bmad` but **no** BMad markers in the tree (i.e. `BmadAdapter.detect(root)` returns `false`). Pre-seed `<root>/docs/standards.md` validly. Call `getStatus(...)`. Assert: (i) the call resolves (does NOT throw — `validateActiveAdapter` is caught and projected into the report shape, not propagated), (ii) `report.adapter.state === "mismatched"`, (iii) `report.adapter.otherMatchingAdapters` is an array (possibly empty), (iv) `renderStatus(report)` produces an `adapter: bmad (mismatched)` line, (v) the `standards:` line is still `ok` (a mismatched adapter does not invalidate the standards line).
- **AC4e (same-repo / split-repo identical render):** Set up two tmp dirs A and B with byte-identical `.crew/config.yaml` + `docs/standards.md` contents. Call `getStatus({ targetRepoRoot: A })` and `getStatus({ targetRepoRoot: B })`. Substitute the absolute path of B into the rendered string for A and assert string equality with B's render. Documents the FR74 one-code-path invariant.
- **AC4f (README-install.md self-consistency):** Read `plugins/crew/docs/README-install.md` from disk. Assert: (i) the file contains exactly six checkpoint blocks matched by the `CHECKPOINT_BLOCK_REGEX` from Task 3 — `^\d+\.\s+\*\*[^*]+\.\*\*` — , (ii) checkpoint 6's "Expected confirmation" code block contains the literal substring `crew v` and the literal substring `standards: ok`, (iii) the file ends with a `> See Story 7.2 (Epic 7) for the full first-run walkthrough.` forward-reference line.

All sub-tests pass alongside existing suites (smoke 1.1, resolver 1.2, validate-active-adapter 1.2b, standards-doc 1.3, permissions/canonical-fs 1.4, telemetry + git-commit 1.5, manifest-state-machine 1.6); total expected: existing baseline + new `get-status.test.ts`; all green, zero skips.

---

## Tasks / Subtasks

- [ ] **Task 1 — `StatusReport` schema + types** (AC: 1, 2, 4)
  - [ ] Create `plugins/crew/mcp-server/src/schemas/status-report.ts`. Define `StatusReportSchema` as a Zod object:
    ```ts
    export const StatusReportSchema = z.object({
      pluginVersion: z.string().regex(SEMVER_REGEX),
      targetRepoRoot: z.string().min(1),
      adapter: z.discriminatedUnion("state", [
        z.object({ state: z.literal("ok"), name: z.string().min(1) }),
        z.object({
          state: z.literal("mismatched"),
          name: z.string().min(1),
          otherMatchingAdapters: z.array(z.string()),
        }),
      ]),
      standards: z.discriminatedUnion("state", [
        z.object({ state: z.literal("ok"), path: z.string().min(1) }),
        z.object({ state: z.literal("missing"), path: z.string().min(1) }),
        z.object({
          state: z.literal("malformed"),
          path: z.string().min(1),
          zodMessage: z.string().min(1),
        }),
      ]),
      cycle: z.union([z.literal("none"), z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)]),
    });
    export type StatusReport = z.infer<typeof StatusReportSchema>;
    ```
  - [ ] Re-export `SEMVER_REGEX` from `schemas/plugin-manifest.ts` rather than redefining; keep the source of truth single.
  - [ ] No default values. Every field is required at parse time — defenders against partial reports leaking out of the tool.

- [ ] **Task 2 — `getStatus` tool + `renderStatus` helper** (AC: 1, 2, 4)
  - [ ] Create `plugins/crew/mcp-server/src/tools/get-status.ts`. Export two functions:
    1. `async function getStatus(opts: { targetRepoRoot: string }): Promise<StatusReport>` — composes the four primitives. **Algorithm (do not deviate):**
       1. `pluginVersion = getPluginVersion()`.
       2. `let workspace; let adapterReport;`
          - Call `await resolveWorkspace({ targetRepoRoot: opts.targetRepoRoot })`. Any error from `resolveWorkspace` (`NoAdapterMatchedError`, `AmbiguousAdapterError`, `InvalidWorkspaceConfigError`) is **not** caught here — those are hard configuration failures the user must fix before `/status` is meaningful. Let them propagate up; the skill body will surface them via the standard MCP error path.
          - Call `await validateActiveAdapter(workspace)`. **Catch `StaleWorkspaceConfigError`**: project into `adapterReport = { state: "mismatched", name: workspace.activeAdapterName, otherMatchingAdapters: err.otherMatchingAdapters }`. On success: `adapterReport = { state: "ok", name: workspace.activeAdapterName }`.
          - Do not catch any other error from `validateActiveAdapter` — only `StaleWorkspaceConfigError` is the documented downgrade. Other errors are bugs and must surface.
       3. `let standardsReport;`
          - `standardsPath = path.join(workspace.targetRepoRoot, "docs", "standards.md")`.
          - `try { await lookupStandards(workspace.targetRepoRoot); standardsReport = { state: "ok", path: standardsPath }; }`
          - `catch (err) { if (err instanceof StandardsDocMissingError) standardsReport = { state: "missing", path: standardsPath }; else if (err instanceof StandardsDocMalformedError) standardsReport = { state: "malformed", path: standardsPath, zodMessage: err.zodMessage }; else throw err; }`
          - The `zodMessage` field already exists on `StandardsDocMalformedError` (Story 1.3); read it directly.
       4. Build the report: `{ pluginVersion, targetRepoRoot: workspace.targetRepoRoot, adapter: adapterReport, standards: standardsReport, cycle: "none" }`.
       5. **Validate before return:** `return StatusReportSchema.parse(report)`. Defensive — catches any future field drift between the schema and the constructor.
    2. `function renderStatus(report: StatusReport): string` — pure formatter, no IO. Returns exactly five lines joined by `\n`, in this order:
       - `crew v${report.pluginVersion}`
       - `target repo: ${report.targetRepoRoot}`
       - `adapter: ${report.adapter.name} (${report.adapter.state})`
       - `standards: ${report.standards.state} — ${report.standards.path}`
       - `cycle: ${report.cycle}`
       - **No trailing newline.** The MCP tool wraps the string in a `{ type: "text", text }` content block; the client decides how to print.
  - [ ] **Do not** add a `getStatus` cache. Every call re-resolves. The whole point of `/status` is to reflect current disk state.
  - [ ] **Do not** emit telemetry from `getStatus`. `skill.invoke` is reserved for Epic 6 Story 6.8.
  - [ ] **Do not** read `<targetRepoRoot>` directly — every read goes through the existing primitives (`resolveWorkspace`, `validateActiveAdapter`, `lookupStandards`). No new IO seam in this file.

- [ ] **Task 3 — Register `getStatus` against the MCP server** (AC: 1, 2)
  - [ ] Create `plugins/crew/mcp-server/src/tools/register.ts`. Export `registerAllTools(server: AiEngineeringTeamServer): void`. Body: a single call `server.registerTool({ name: "getStatus", description: "Return a typed status report for the resolved target repo (plugin version, adapter, standards-doc state, cycle).", inputSchema: { type: "object", properties: { targetRepoRoot: { type: "string" } }, required: ["targetRepoRoot"] }, handler: async (args) => { const root = z.string().min(1).parse(args.targetRepoRoot); const report = await getStatus({ targetRepoRoot: root }); return { content: [{ type: "text" as const, text: renderStatus(report) }] }; } })`. This file is the registration seam — every future story that ships a tool appends a `server.registerTool(...)` call here, keeping `server.ts` free of tool-specific imports.
  - [ ] Wire `registerAllTools` into `mcp-server/src/index.ts` (the stdio entrypoint): import it after `createServer(...)` and call it before `server.connect(transport)`. **Do not** call it from `createServer` itself — keeping `createServer` tool-free is what lets `acceptance.test.ts` (Story 1.1) still assert "zero tools registered" on a bare `createServer()` call. The integration test at `mcp-server/tests/get-status.test.ts` (Task 5) calls `registerAllTools` explicitly on a fresh `createServer()` to test the end-to-end MCP path.

- [ ] **Task 4 — `skills/status.md`** (AC: 1, 2)
  - [ ] Create `plugins/crew/skills/status.md`. Follow the skill-file shape from `architecture/implementation-patterns-consistency-rules.md` §8:
    ```markdown
    ---
    name: crew:status
    description: Print the current plugin version, target repo, adapter, and standards-doc state.
    allowed_tools: [Read]
    ---

    # /crew:status

    # What this skill does

    Calls the `getStatus` MCP tool and prints a five-line status block confirming that the plugin sees your repo: plugin version, resolved target-repo path, active adapter (and whether its config still matches the repo), standards-doc state, and the current cycle (always `none` in v1).

    # Prerequisites

    A target repo with `.crew/config.yaml` resolved (auto-detected on first run by the workspace resolver — see `docs/README-install.md` checkpoint 5).

    # Steps

    1. Invoke the `getStatus` MCP tool with `targetRepoRoot` set to the current workspace root.
    2. Print the tool's text response verbatim (it is already the five-line status block).

    # Failure modes

    - **No `.crew/config.yaml` and no adapter matches:** the tool throws `NoAdapterMatchedError`. The skill surfaces the error message verbatim — it already tells the user to either init a planning tool the plugin understands or follow `docs/README-install.md` step 5.
    - **`.crew/config.yaml` exists but the listed adapter no longer matches the repo:** the status line shows `adapter: <name> (mismatched)` and lists any other matching adapters the user can switch to. No exception is thrown — the report itself carries the downgrade.
    - **`docs/standards.md` missing or malformed:** the `standards:` line shows `missing` or `malformed` (with the absolute path). Run `cp plugins/crew/docs/standards-example.md <target-repo>/docs/standards.md` to fix (README-install.md checkpoint 5).
    ```
  - [ ] **Do not** put any logic in the skill body beyond "call the tool, print the result." All status-string assembly lives in `renderStatus` on the TS side, which is unit-tested.
  - [ ] `allowed_tools: [Read]` is intentional — the skill only reads the MCP tool's text response. No `Bash`, no `Edit`, no `Task`. (FR81 / NFR12 — minimum-necessary surface.)

- [ ] **Task 5 — Integration test `get-status.test.ts`** (AC: 1, 2, 4)
  - [ ] Create `plugins/crew/mcp-server/tests/get-status.test.ts`. Mirror the layout of `workspace-resolver.test.ts` for tmp-dir setup. Imports: `getStatus`, `renderStatus` (from `../src/tools/get-status.js`), `StatusReportSchema` (from `../src/schemas/status-report.js`), `SEMVER_REGEX` (from `../src/schemas/plugin-manifest.js`), and the standards-doc fixtures already on disk under `mcp-server/tests/fixtures/standards/`.
  - [ ] **Test cases:**
    - `it("AC4a — valid standards.md → standards.state=ok, render starts with 'crew v', 'standards: ok — '")` — pre-seed valid config + standards, assert per AC4a.
    - `it("AC4b — missing standards.md → standards.state=missing, render contains 'standards: missing — '")` — pre-seed config only.
    - `it("AC4c — malformed standards.md → standards.state=malformed, zodMessage non-empty")` — re-use `mcp-server/tests/fixtures/standards/malformed-missing-field/docs/standards.md`.
    - `it("AC4d — stale adapter config → adapter.state=mismatched")` — pre-seed `.crew/config.yaml` with `adapter: bmad` against a tree where `BmadAdapter.detect()` returns false (re-use the technique from `validate-active-adapter.test.ts`).
    - `it("AC4e — same-repo and split-repo produce identical renders for identical fixture state")` — set up tmp dirs A and B with byte-identical content, assert string equality after path substitution.
    - `it("AC4f — docs/README-install.md is well-formed (six checkpoints, ends with Story 7.2 forward-ref)")` — read the file with `readFileSync`, run the `CHECKPOINT_BLOCK_REGEX` (line-anchored, multiline) and assert exactly six matches; assert the file ends with the literal forward-reference line.
    - `it("AC1/AC3 — render's first line matches /^crew v\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?$/ and standards line starts with 'standards: ok — '")` — anchors the README checkpoint 6 expected-confirmation copy against the actual renderer output. **This is the self-consistency test** that pins README copy to renderer output: if either drifts, the test fails loud.
    - `it("end-to-end via MCP — registerAllTools registers getStatus, ListTools includes it, CallTool returns the rendered text")` — use the in-memory transport pattern from `acceptance.test.ts`: `createServer()`, call `registerAllTools(server)`, connect, assert `ListTools` includes `{ name: "getStatus" }`, call it with `{ targetRepoRoot: <fixture-root> }`, assert the returned `content[0].text` equals `renderStatus(report)` for that same fixture.
  - [ ] **Test fixtures:** Re-use `BmadAdapter.detect`-friendly fixture trees from `workspace-resolver.test.ts` and `validate-active-adapter.test.ts`. Do not invent new adapter fixtures. The `malformed-cap-exceeded` and `malformed-missing-field` standards fixtures from 1.3 are already in tree — point at them.
  - [ ] **Determinism:** No `Date.now()`, no `Math.random()`, no network. All fixture state is on disk; the tool's only non-deterministic input is the absolute tmp path, which is substituted out in AC4e.

- [ ] **Task 6 — `plugins/crew/docs/README-install.md`** (AC: 3, 4f)
  - [ ] Create the file. Top-level heading: `# Install crew`. One-paragraph intro: "Six checkpoints from clone to seeing the plugin recognise your repo. Each step has one runnable command and one expected confirmation line. If a checkpoint fails, the failure is local to that step — don't proceed."
  - [ ] Render the six checkpoints in the order pinned by AC3. Each checkpoint MUST conform to this regex (line-anchored, multiline):
    ```ts
    // Task 3-defined CHECKPOINT_BLOCK_REGEX (also used by AC4f):
    export const CHECKPOINT_BLOCK_REGEX = /^\d+\.\s+\*\*[^*]+\.\*\*/gm;
    ```
    The regex tests **only** the heading line of each checkpoint (e.g. `1. **Install Claude Code.**`). The body of each checkpoint is human-prose plus two fenced code blocks: one tagged `bash` (or `text` for the slash-command invocations and the in-Claude-Code restart step), and one tagged `text` labelled "Expected confirmation" containing the exact expected line.
  - [ ] Final line of the file: `> See Story 7.2 (Epic 7) for the full first-run walkthrough.` — exactly this text, on its own line, no trailing punctuation drift. **Asserted by AC4f.**
  - [ ] **Do not** include the example sprint, `/scan`, `/start`, `/watch`, or PR-merge steps — those are Story 7.2's surface. **Do not** include a "Troubleshooting" section — that is Story 7.5.

- [ ] **Task 7 — Update `plugins/crew/README.md`** (AC: 3)
  - [ ] Rewrite the plugin README to a one-screen pointer:
    ```markdown
    # crew

    AI Engineering Team v1 — a Claude Code plugin that drives a continuous-flow backlog of stories through dev and review subagents.

    See `_bmad-output/planning-artifacts/prd-crew-v1.md` for the PRD (local-only).

    ## Install

    Six checkpoints from clone to "the plugin sees my repo": [`docs/README-install.md`](docs/README-install.md).

    Full first-run walkthrough (running the bundled example sprint, scanning sources, opening your first PR) lands in Epic 7 Story 7.2.

    ## Standards doc

    Every reviewer verdict reads `<target-repo>/docs/standards.md`. The install walkthrough's checkpoint 5 copies the shipped template (`docs/standards-example.md`) into your target repo.
    ```
  - [ ] **Do not** keep the current "The full install walkthrough lands in Story 1.7" sentence — Story 1.7 IS this story, the walkthrough now exists, point at it.

- [ ] **Task 8 — Update root `README.md`** (AC: 3)
  - [ ] Rewrite the root README. Replace the existing sprint-orchestrator-era content (lines 1–60) with a one-screen pointer that's coherent with the current project state:
    ```markdown
    # crew

    crew is an experiment in replacing the product engineering team with AI tooling. The product being built here is **AI Engineering Team v1** — a Claude Code plugin that lets a non-engineer drive a project-shaped team of long-lived AI agents through a continuous-flow backlog.

    ## Status

    Active build. Epic 1 (plugin foundation) is in progress; the plugin is installable but not yet runnable end-to-end. See `plugins/crew/docs/README-install.md` for the install checkpoints available today.

    ## Install

    See [`plugins/crew/docs/README-install.md`](plugins/crew/docs/README-install.md).

    ## Repository layout

    ```
    plugins/crew/                  — the plugin (MCP server, skills, adapters)
    plugins/crew/docs/             — install walkthrough, standards template
    _bmad-output/                  — planning artifacts (PRD, epics, stories) — gitignored
    ```

    ## License

    MIT
    ```
  - [ ] **Do not** keep any reference to `sprint-orchestrator` — the plugin was removed on 2026-05-19 per `CLAUDE.md`. The legacy copy is a known stale-doc footgun; this story retires it.
  - [ ] **Do not** add the "Run your first example sprint in 5 minutes" section here — that's Story 7.2.

- [ ] **Task 9 — Smoke verification (no automated test gate — manual sanity check)**
  - [ ] From `plugins/crew/`: `pnpm install && pnpm build && pnpm test`. All suites green, including the new `get-status.test.ts`.
  - [ ] Spot-check the rendered status block by running `node` against a minimal harness — left as a dev-aid, not committed:
    ```ts
    import { getStatus, renderStatus } from "./mcp-server/dist/tools/get-status.js";
    const report = await getStatus({ targetRepoRoot: process.cwd() });
    console.log(renderStatus(report));
    ```
    Expected output against the crew repo itself (Jack's same-repo case):
    ```
    crew v0.1.0
    target repo: /Users/jackmcintyre/projects/crew
    adapter: bmad (ok)
    standards: missing — /Users/jackmcintyre/projects/crew/docs/standards.md
    cycle: none
    ```
    (Standards is `missing` because `docs/standards.md` at the repo root does not exist yet — the install walkthrough's checkpoint 5 is what creates it. This is the v1 expected state; checkpoint 6 of the README assumes the user has just run checkpoint 5.)

---

## Dev Notes

### Files to create

- `plugins/crew/mcp-server/src/schemas/status-report.ts` (NEW)
- `plugins/crew/mcp-server/src/tools/get-status.ts` (NEW)
- `plugins/crew/mcp-server/src/tools/register.ts` (NEW — the tool-registration seam future stories extend)
- `plugins/crew/skills/status.md` (NEW)
- `plugins/crew/docs/README-install.md` (NEW)
- `plugins/crew/mcp-server/tests/get-status.test.ts` (NEW)

### Files to modify

- `plugins/crew/mcp-server/src/index.ts` — import `registerAllTools` and call it before `server.connect`. Do NOT touch `createServer` in `server.ts` (Story 1.1 acceptance asserts a bare `createServer()` registers zero tools).
- `plugins/crew/README.md` — rewrite to a one-screen pointer per Task 7.
- `README.md` (repo root) — rewrite to retire sprint-orchestrator references per Task 8.

### Files NOT to modify (read-only context)

- `mcp-server/src/server.ts` — already complete (Story 1.1 + 1.4 dispatcher). The tool-registration seam goes through `registerTool` on the wrapper; `server.ts` itself stays tool-free.
- `mcp-server/src/lib/plugin-version.ts` — already complete (Story 1.1). Just call `getPluginVersion()`.
- `mcp-server/src/state/workspace-resolver.ts` — already complete (Story 1.2). Just call `resolveWorkspace`.
- `mcp-server/src/state/validate-active-adapter.ts` — already complete (Story 1.2b). Just call `validateActiveAdapter`.
- `mcp-server/src/state/lookup-standards.ts` — already complete (Story 1.3). Just call `lookupStandards`.
- `mcp-server/src/validators/standards-doc.ts` — already complete (Story 1.3). The `zodMessage` field on `StandardsDocMalformedError` is the contract this story consumes.
- `mcp-server/src/errors.ts` — no new errors needed. Every failure mode is already typed by prior stories.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — **do not touch.** The orchestrator owns status transitions for this story (per the constraints handed to story creation).

### Architectural compliance

- **Skill-file shape** (`architecture/implementation-patterns-consistency-rules.md` §8): YAML frontmatter with `name`, `description`, `allowed_tools`; body sections `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes`. Task 4's status.md content satisfies this exactly.
- **MCP tool naming** (§4): `camelCase` verb-noun, flat namespace, reader prefix (`get*`). `getStatus` complies.
- **TS code conventions** (§6): `kebab-case.ts` filenames, named exports only, no `any`, no default exports, no path aliases. All Task 1–5 files comply.
- **Frontmatter conventions** (§1): N/A — `StatusReport` is an in-memory shape, not a persisted artifact.
- **Locked phrases** (§7): N/A — `/status` output is diagnostic, not part of the verdict / handoff / yield grammar.

### Self-consistency invariants (mandatory — these are the cross-check between spec and implementation)

The following constants appear in this spec and MUST be the exact strings the implementation emits / matches:

1. **`SEMVER_REGEX`**: `^\d+\.\d+\.\d+(?:-[\w.]+)?$` — sourced from `mcp-server/src/schemas/plugin-manifest.ts`. Re-used in `StatusReportSchema.pluginVersion`, AC3 checkpoint 3 expected confirmation, AC3 checkpoint 6 expected confirmation, AC4a render assertion.
2. **Status block grammar (five lines)** — see AC1. The example status block in Task 9 satisfies every line of this grammar (`crew v0.1.0`, `target repo: <abs>`, `adapter: bmad (ok)`, `standards: missing — <abs>`, `cycle: none`).
3. **`CHECKPOINT_BLOCK_REGEX`**: `^\d+\.\s+\*\*[^*]+\.\*\*` (gm). Every checkpoint heading in `docs/README-install.md` (e.g. `1. **Install Claude Code.**`, `6. **Run `/<plugin>:status` and see the expected line.**`) matches it. **Verification:** the regex requires a digit, a dot-space, two literal `**`, at least one non-`*` char, a literal `.`, and two literal `**`. Each of the six AC3 checkpoint headings (as written in this spec) has this exact shape — verify by eye-scanning AC3 lines 1–6.
4. **README-install.md final line**: `> See Story 7.2 (Epic 7) for the full first-run walkthrough.` — exactly this string. Asserted by AC4f.

If the implementation deviates from any of the four above, both the spec example and the test will fail together — that's the point.

### Deferred (out of scope, captured here for traceability)

- **Cycle ULID** in the `cycle:` line — `none` placeholder until Epic 6 Story 6.12 introduces cycle archival.
- **Full first-run walkthrough** (example sprint, scan, start, PR merge) — Epic 7 Story 7.2.
- **Troubleshooting guide** — Epic 7 Story 7.5.
- **`skill.invoke` telemetry for `/status`** — Epic 6 Story 6.8.
- **`/status` integration with watch / orchestration** — Epic 5.

### Previous story intelligence (Stories 1.1–1.6)

- Story 1.1 — `getPluginVersion()` and `PluginManifestSchema` already exist; this story re-exports `SEMVER_REGEX` from `plugin-manifest.ts` rather than redefining.
- Story 1.2 — `resolveWorkspace()` returns a typed `Workspace`; `targetRepoRoot` is already resolved-absolute. This story takes the absolute path verbatim.
- Story 1.2b — `validateActiveAdapter()` returns the same workspace on success; throws `StaleWorkspaceConfigError` with `otherMatchingAdapters` on failure. **This is the field this story projects into `report.adapter.otherMatchingAdapters`.**
- Story 1.3 — `lookupStandards()` throws `StandardsDocMissingError` (`ENOENT`) or `StandardsDocMalformedError` (with `zodMessage`); both are imported by this story for the catch-and-downgrade pattern.
- Story 1.4 — `writeManagedFile` is the canonical-fs boundary; `/status` is read-only and does not invoke it.
- Story 1.5 — `logTelemetryEvent` and `gitCommit` exist; `/status` does NOT emit telemetry (see "This story does NOT" point e).
- Story 1.6 — `moveBetweenStates` exists; `/status` does NOT move manifests (it only reads adapter/standards state).

### Git intelligence (recent commits informing this story)

- `b4dbaa6 chore: rename claude-dev-loop → crew everywhere (repo + plugin namespace)` — confirms plugin name is `crew`, slash-command namespace is `/crew:`. The skill's `name: crew:status` reflects this.
- `bbdc10c feat(1.6): atomic fs.rename state-machine primitive` — last completed story; this story closes Epic 1.
- `a4b2a36 feat(ship-story): persist resolve JSON, surface reviewer notes, tighten validator` — orthogonal harness work, no impact on this story.

### Latest technical specifics

- **`zod`** — already a dependency (used by every schema file under `mcp-server/src/schemas/`). No new dependency for this story.
- **`@modelcontextprotocol/sdk`** — already wired through `server.ts`; `registerAllTools` consumes the existing `registerTool` seam.
- **No new npm packages.** No new transitive dependencies. The standards-doc paths and adapter fixtures are already on disk under `mcp-server/tests/fixtures/`.

### Project context reference

- PRD: `_bmad-output/planning-artifacts/prd-crew-v1.md` (FR71, FR73, FR74).
- Epic 1: `_bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md` — Story 1.7 section at lines 159–179.
- Architecture project structure: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` — `skills/status.md` at line 38; `docs/README-install.md` at line 124.
- Skill-file shape: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §8.
- MCP tool naming: same file, §4.
- TS code conventions: same file, §6.
- Worktree for implementation: `/Users/jackmcintyre/projects/crew/.worktrees/1-7-status-skill-and-readme-install-path-through-the-plugin-sees-my-repo`.

---

## Story Completion Status

Ultimate context engine analysis completed — comprehensive developer guide created. This story closes Epic 1 by tying every primitive built in 1.1–1.6 into a single user-visible surface (`/<plugin>:status`) and the README path that takes a fresh installer from clone to seeing the plugin recognise their repo.
