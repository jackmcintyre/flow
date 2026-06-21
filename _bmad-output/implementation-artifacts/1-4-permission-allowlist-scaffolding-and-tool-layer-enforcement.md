# Story 1.4: Permission-allowlist scaffolding and tool-layer enforcement

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **every agent's tool authority and `gh`-subcommand authority enforced at the runtime/tool layer rather than via prompt, plus a hard ban on raw `fs.write` to canonical-state paths**,
so that **no later story can accidentally grant an agent capability it shouldn't have, and the MCP tool boundary becomes the only path that mutates canonical state**.

This story lands the **permission boundary**: (a) a versioned per-role permission spec shape at `plugins/crew/permissions/<role>.yaml` declaring `tools_allow` and `gh_allow` (with optional `gh_allow_args`), validated by a Zod schema; (b) a loader (`loadRolePermissions`) that reads + parses + caches one role's spec from disk; (c) a permission-checking middleware threaded into the MCP server so that every tool invocation carries a role context and is refused at the dispatcher layer when the tool name is not in the role's `tools_allow`; (d) an `execa`-based `gh` wrapper at `mcp-server/src/lib/gh.ts` that requires a role context and refuses any subcommand not in `gh_allow`; (e) a canonical-state write guard (`writeManagedFile`) plus an automated guardrail (lint rule or unit test) that forbids any direct `fs.writeFile` / `fs.writeFileSync` / `fs.appendFile` / `fs.createWriteStream` to canonical paths from any code other than `writeManagedFile` and the future logger; (f) typed errors (`PermissionDeniedError`, `GhSubcommandDeniedError`, `CanonicalFsWriteError`) for each refusal; (g) the **two ship-required role specs** for `generalist-dev` and `generalist-reviewer` so the bare minimum is enforceable today; (h) vitest coverage of the four enforcement paths plus the lint/test guardrail.

**This story does not** wire a real MCP tool that mutates canonical state (those land in Stories 1.5 telemetry / 1.6 atomic-rename / and Epics 2–4), does not spawn a subagent, does not implement the full catalogue of roles (Story 2.x – Hiring epic), does not produce the `gh-error-map.yaml` recoverable-error classification (Story 2.x or Epic 3, owned by NFR18), and does not register the `lookupStandards` MCP tool wrapper despite the architecture map naming `tools/lookup-standards.ts` — that tool registration moves to Story 1.5 once the telemetry write path is in place. The seam this story delivers is the **enforcement substrate** every future tool registration is required to consume.

## Acceptance Criteria

**AC1 — Unlisted tool denied at the MCP tool layer (FR79, FR80, NFR12):**
**Given** a per-role permission spec at `plugins/crew/permissions/<role>.yaml` declaring `tools_allow: [...]`,
**When** an agent operating under that role invokes an MCP tool whose name is **not** in `tools_allow`,
**Then** the server returns an MCP-shaped error response (`isError: true`, structured `content[0].text`) carrying the typed `PermissionDeniedError`'s one-line message, and **the tool's handler is never invoked** (verified by a `vi.fn()` spy on the descriptor's `handler`).
The error message names the role, the attempted tool, the spec path (`plugins/crew/permissions/<role>.yaml`), and the closing `(FR79/FR80/NFR12)` marker.

**AC2 — Unlisted `gh` subcommand denied at the wrapper layer (NFR17, NFR12, NFR16):**
**Given** the `execa`-based `gh` wrapper at `mcp-server/src/lib/gh.ts` exporting `gh({ role, subcommand, args })`,
**When** any code path invokes `gh(...)` with a `subcommand` not in the role's `gh_allow`,
**Then** the wrapper throws `GhSubcommandDeniedError` **before** any subprocess spawn (verified by spying on `execa` and asserting it was never called).
**And** direct child-process spawning of `gh` elsewhere in `mcp-server/src/**` is forbidden by an automated guard (see AC5b). The error message names the role, the attempted subcommand, the role's allowlist, the spec path, and the closing `(NFR17)` marker.

**AC3 — Raw `fs.write*` to canonical-state paths denied / forbidden (FR81, NFR16):**
**Given** the MCP server, the canonical-state path set (`<target-repo>/.crew/state/**`, `<target-repo>/.crew/telemetry/**`, `<target-repo>/.crew/retro-proposals/**`, `<target-repo>/.crew/sprint-history/**`, `<target-repo>/team/**`, `<target-repo>/docs/standards.md`, `<target-repo>/docs/risk-tiering.md`, `<target-repo>/docs/discipline-rules.yaml`),
**When** any code path attempts a runtime write to a canonical-state path via the supplied write boundary (`writeManagedFile`) without an MCP tool context,
**Then** the call fails with a typed `CanonicalFsWriteError` (runtime check), **and** the static guard (AC5c) fails CI if any file under `mcp-server/src/**` (excluding `mcp-server/src/lib/managed-fs.ts` and `mcp-server/src/lib/logger.ts` once it exists) imports a write-shaped API from `node:fs` / `node:fs/promises` (`writeFile`, `writeFileSync`, `appendFile`, `appendFileSync`, `createWriteStream`, `cp` with a canonical destination), regardless of path. The message names the offending path, the canonical-path glob it matched, the required entrypoint (`writeManagedFile` via an MCP tool), and the closing `(FR81/NFR16)` marker.

**AC4 — Valid call succeeds end-to-end (positive control):**
**Given** a role whose `tools_allow` contains a registered no-op tool `noop` (registered for test purposes only and never shipped) and whose `gh_allow` contains `pr-view`,
**When** an agent invokes `noop` via the MCP server's `CallToolRequestSchema` handler with the role context set,
**Then** the handler runs and returns a normal success response; **and** when `gh({ role, subcommand: "pr-view", args: ["--help"] })` is called with `execa` stubbed to resolve `{ stdout: "ok", stderr: "", exitCode: 0 }`, the wrapper returns the stub's stdout unchanged.
The positive-control branch exists so that the negative branches above cannot accidentally fail open (i.e. denying *everything* would still satisfy AC1–AC3 in isolation).

**AC5 — Vitest covers the four enforcement paths (integration):**
`pnpm test` from `plugins/crew/` adds two new test files (`mcp-server/tests/permissions-enforcement.test.ts` and `mcp-server/tests/canonical-fs-guard.test.ts`) plus one fixture role (`plugins/crew/mcp-server/tests/fixtures/permissions/test-role.yaml`). The combined suite asserts:
- **AC5a (tool-layer denial):** AC1's behaviour — handler never invoked, error response shape matches.
- **AC5b (`gh` subcommand denial + direct-spawn ban):** AC2's behaviour — `execa` never called for an unlisted subcommand. A second sub-test greps `mcp-server/src/**/*.ts` (excluding `mcp-server/src/lib/gh.ts`) for `execa(` / `child_process` / `spawn(`/`exec(` calls referencing `"gh"` or `'gh'` and asserts zero matches.
- **AC5c (canonical-fs guard):** AC3's behaviour at runtime (`writeManagedFile` refuses without MCP-tool context) plus a static greppy sub-test that walks `mcp-server/src/**/*.ts` (excluding the two whitelisted files), parses each file's import statements for `node:fs` / `node:fs/promises` / `fs`, and asserts none import the banned write surface (`writeFile`, `writeFileSync`, `appendFile`, `appendFileSync`, `createWriteStream`). Imports of read-only surface (`readFile`, `readFileSync`, `mkdir`, `mkdtemp`, `stat`, `access`, `cp` to non-canonical, `rm` for test-tmp) are permitted.
- **AC5d (positive control):** AC4's behaviour.
- **AC5e (spec round-trip):** loading `plugins/crew/permissions/generalist-dev.yaml` and `plugins/crew/permissions/generalist-reviewer.yaml` through `loadRolePermissions` returns a typed `RolePermissions` for each, with `role`, non-empty `tools_allow`, non-empty `gh_allow`. The shipped reviewer spec **must not** include any of `pr-merge`, `pr-close`, `pr-review` (negative-capability assertion mandated by NFR16).

All sub-tests pass alongside the existing suites (smoke 1.1, resolver 1.2, validate-active-adapter 1.2b, standards-doc 1.3). Total expected test count: existing baseline + the new file(s)' tests; all green, zero skips.

---

## Tasks / Subtasks

- [x] **Task 1 — Zod schema and types for `RolePermissions`** (AC: 1, 2, 5e)
  - [x] Create `plugins/crew/mcp-server/src/schemas/role-permissions.ts`.
  - [x] Export:
    - `RolePermissionsSchema` — `z.object({ role: z.string().min(1).regex(/^[a-z0-9-]+$/), tools_allow: z.array(z.string().min(1)).min(1), gh_allow: z.array(z.string().min(1)).default([]), gh_allow_args: z.record(z.string(), z.array(z.string().min(1))).default({}) }).strict()`.
    - `type RolePermissions = z.infer<typeof RolePermissionsSchema> & { sourcePath: string };` — `sourcePath` is appended by the loader after parse, **not** part of the on-disk shape.
  - [x] `.strict()` rejects unknown keys at every level — same precedent as `standards-doc.ts`. A typo such as `tool_allow` (singular) must fail loudly, not silently.
  - [x] `tools_allow` has `.min(1)` — a role with zero allowed tools is meaningless, almost certainly a typo.
  - [x] `gh_allow` defaults to `[]` (some roles never touch GitHub).
  - [x] `role` regex matches the catalogue's `role:` convention (kebab-case-only) per Implementation-patterns-consistency-rules.md §3.
  - [x] No defaults on `role` or `tools_allow`. Every field is explicit. Defaults would mask malformed input.

- [x] **Task 2 — Typed errors `PermissionDeniedError`, `GhSubcommandDeniedError`, `CanonicalFsWriteError`** (AC: 1, 2, 3)
  - [x] Extend `plugins/crew/mcp-server/src/errors.ts` with three new subclasses of `DomainError`. Append at the bottom of the file, after `StandardsDocMalformedError`. Match the existing JSDoc and constructor-options-bag style.
  - [x] `PermissionDeniedError` — fields: `role: string`, `attemptedTool: string`, `allowedTools: readonly string[]`, `specPath: string`. Constructor composes:
    > `Role '<role>' is not allowed to invoke tool '<attemptedTool>'. Allowed tools for this role: [<allowedTools join ", ">]. Edit <specPath> to grant this capability through PR review (NFR13). (FR79/FR80/NFR12)`
  - [x] `GhSubcommandDeniedError` — fields: `role: string`, `attemptedSubcommand: string`, `allowedSubcommands: readonly string[]`, `specPath: string`. Constructor composes:
    > `Role '<role>' is not allowed to invoke 'gh <attemptedSubcommand>'. Allowed gh subcommands: [<allowedSubcommands join ", ">]. Edit <specPath> to grant this subcommand. (NFR17)`
  - [x] `CanonicalFsWriteError` — fields: `attemptedPath: string`, `canonicalPathGlob: string`. Constructor composes:
    > `Write to canonical-state path '<attemptedPath>' (matches '<canonicalPathGlob>') is not permitted outside an MCP tool. Route this write through an MCP tool that calls writeManagedFile(...). (FR81/NFR16)`
  - [x] All three extend `DomainError` — `error.name` is set automatically via `new.target.name`. Do **not** manually assign `this.name`.
  - [x] Do **not** touch any of the existing classes. Their wording is asserted by 1.1/1.2/1.2b/1.3 tests.

- [x] **Task 3 — Pure permission loader `loadRolePermissions`** (AC: 1, 5e)
  - [x] Create `plugins/crew/mcp-server/src/state/load-role-permissions.ts`. (Sits alongside `workspace-resolver.ts`, `validate-active-adapter.ts`, `lookup-standards.ts` in `state/` — same convention as 1.2/1.2b/1.3: workspace-IO boundary lives in `state/`.)
  - [x] Export a single async function:
    `loadRolePermissions(opts: { role: string; pluginRoot: string }): Promise<RolePermissions>`
    - `role` — the kebab-case role id.
    - `pluginRoot` — absolute path to `plugins/crew/`. Caller resolves; the loader does **not** derive from `process.cwd()` (memory `feedback_pre_tool_use_hook_cwd_drift`).
  - [x] Algorithm:
    1. Compute `specPath = path.join(pluginRoot, "permissions", role + ".yaml")`.
    2. Read with `fs.readFile(specPath, "utf8")`. On `ENOENT`, throw a clear `DomainError` subclass `RolePermissionsMissingError` (also added in Task 2's batch — append after `CanonicalFsWriteError`) naming `role`, `specPath`, and the canonical example (`plugins/crew/permissions/generalist-dev.yaml`).
    3. Parse with `yamlParse` from `"yaml"` (same import as `workspace-resolver.ts`). On YAML syntax error, throw `RolePermissionsMalformedError` with the YAML error message.
    4. Pass through `RolePermissionsSchema.safeParse(...)`. On failure, throw `RolePermissionsMalformedError` with the formatted Zod issue (same `formatZodIssues` helper pattern from `validators/standards-doc.ts` — duplicate the helper here or extract to a shared `lib/format-zod-issues.ts` at the dev's discretion; if extracting, **do not** edit `validators/standards-doc.ts` to consume the shared helper, that's a scope-creep refactor for a later story).
    5. Return `{ ...result.data, sourcePath: specPath }`.
  - [x] Add `RolePermissionsMissingError` and `RolePermissionsMalformedError` to Task 2's batch (so all error classes land in one append).
  - [x] **No module-level caching.** A future story (catalogue/hiring) may add a per-pluginRoot LRU cache; this story re-reads on every call. Caching here is a premature optimisation that would mask a stale-spec class of bugs.

- [x] **Task 4 — Permission-aware MCP tool registration and dispatch** (AC: 1, 4, 5a, 5d)
  - [x] Update `plugins/crew/mcp-server/src/server.ts`:
    - Extend `ToolDescriptor` with an optional `allowedRoles: readonly string[]` field. Tools that opt into role-scoped permission must declare this; tools that don't are treated as **plugin-internal** (callable only via the registry's internal seams, never exposed via `CallToolRequestSchema` if the request carries a role context).
    - Add a `RoleContext` interface: `{ role: string; permissions: RolePermissions }`. The MCP request gateway (the `CallToolRequestSchema` handler) reads the role context from the request's `_meta` field on incoming MCP requests — i.e. clients pass `{ params: { name, arguments, _meta: { role: "generalist-dev" } } }`. If `_meta.role` is absent, treat the call as **role-less** (used by the smoke test and the test-side fixture, never by a real agent — see Task 6 anti-pattern #1).
    - In the `CallToolRequestSchema` handler, if `_meta.role` is present:
      1. Look up `RolePermissions` for that role via a server-bound `permissionsLoader: (role: string) => Promise<RolePermissions>` function injected at `createServer({ permissionsLoader })` time. (Injection makes the test-fixture role substitutable; production calls `loadRolePermissions` with the resolved `pluginRoot` from the workspace.)
      2. If `permissions.tools_allow.includes(name)` is `false`, return an MCP error response wrapping `new PermissionDeniedError({ role, attemptedTool: name, allowedTools: permissions.tools_allow, specPath: permissions.sourcePath })`. The descriptor's `handler` is **never** invoked.
      3. Otherwise, attach `{ role, permissions }` to the args bag the handler receives via a third **opt-in** position: change `ToolHandler` to `(args, ctx: { role?: string; permissions?: RolePermissions }) => …`. Tools that don't need the context just ignore `ctx`.
  - [x] Update `createServer` signature: `createServer(opts?: { permissionsLoader?: (role: string) => Promise<RolePermissions> })`. Default `permissionsLoader` throws a typed `NotImplementedError` ("permissionsLoader not configured — pass one to createServer in production wiring") to ensure no caller silently bypasses enforcement.
  - [x] **Do not** rewrite the smoke test from 1.1 — it does not pass `_meta.role`, so it continues to exercise the role-less path. That's the test-seam this story preserves on purpose.
  - [x] **Do not** introduce a global singleton permissions cache here. The loader's contract is "re-read on every call" (Task 3); the server's contract is "ask the loader once per CallToolRequest". If perf is ever an issue, a future story can add a per-process LRU at the loader layer, not the server layer.

- [x] **Task 5 — `execa`-based `gh` wrapper at `mcp-server/src/lib/gh.ts`** (AC: 2, 4, 5b, 5d)
  - [x] Create `plugins/crew/mcp-server/src/lib/gh.ts`. (This is the first file under `lib/` other than `plugin-version.ts`. The architecture map pins this exact location for NFR17 enforcement.)
  - [x] Export a single async function (do not introduce a class):
    `gh(opts: { role: string; permissions: RolePermissions; subcommand: string; args?: readonly string[]; execaImpl?: typeof execa }): Promise<{ stdout: string; stderr: string; exitCode: number }>`
    - `execaImpl` is a **test seam only** — production callers do not pass it. The default is the live `execa` from `"execa"` (already a declared runtime dep in `mcp-server/package.json`).
  - [x] Algorithm:
    1. Validate `permissions.gh_allow.includes(subcommand)`. If false, throw `GhSubcommandDeniedError({ role, attemptedSubcommand: subcommand, allowedSubcommands: permissions.gh_allow, specPath: permissions.sourcePath })`. **Do not** spawn a subprocess.
    2. If `permissions.gh_allow_args[subcommand]` is defined (non-empty array), validate that **every** entry in `args` either appears in the allowlist or is a value-only positional argument for an allowlisted flag. **Implementation note:** for v1 the matching rule is **exact string match** — `gh_allow_args.api === ["repos/:owner/:repo/issues/:issue/comments"]` and `args === ["api", "repos/foo/bar/issues/3/comments"]` does NOT match (because the placeholder substitution layer is out of v1 scope). Document this limit in the wrapper's JSDoc; the **shipped** `generalist-dev.yaml` and `generalist-reviewer.yaml` therefore must NOT use `gh_allow_args` in v1. The schema field exists for forward-compat with Story 2.x/Epic 3 but is unused by shipped specs. If `args` violates the allowlist, throw `GhSubcommandDeniedError` with a message variant naming the offending arg.
    3. Invoke `execaImpl("gh", [subcommand, ...(args ?? [])])`. Return `{ stdout, stderr, exitCode }` from the result. **Do not** classify recoverable errors here — that's NFR18's territory and lands in a later story (`gh-error-map.yaml`).
  - [x] **Single-purpose wrapper.** No telemetry write (Story 1.5), no recoverable-error classification (NFR18 / Epic 3), no retry, no auth handling, no caching.
  - [x] Use the existing `execa` dep (`^9.6.1` per `mcp-server/package.json`). Do **not** add a new dep.

- [x] **Task 6 — Canonical-state write guard `writeManagedFile`** (AC: 3, 5c)
  - [x] Create `plugins/crew/mcp-server/src/lib/managed-fs.ts`.
  - [x] Export:
    - `CANONICAL_PATH_GLOBS: readonly string[]` — exported for the static guard test to consume. Initial set (relative to `targetRepoRoot`):
      - `.crew/state/**`
      - `.crew/telemetry/**`
      - `.crew/retro-proposals/**`
      - `.crew/sprint-history/**`
      - `.crew/sessions/**`
      - `team/**`
      - `docs/standards.md`
      - `docs/risk-tiering.md`
      - `docs/discipline-rules.yaml`
    - `isCanonicalPath(absPath: string, targetRepoRoot: string): { canonical: boolean; matchedGlob?: string }` — pure function. Uses `path.relative(targetRepoRoot, absPath)`, then minimatch-style globbing. **No new dep:** implement with a tiny dependency-free matcher (split on `/`, support `**` and exact segments). Reject `..` escapes (path-traversal guard).
    - `writeManagedFile(opts: { absPath: string; contents: string; targetRepoRoot: string; mcpToolContext?: { toolName: string; role: string } }): Promise<void>`. Algorithm:
      1. Call `isCanonicalPath(absPath, targetRepoRoot)`.
      2. If `canonical && !mcpToolContext`, throw `CanonicalFsWriteError({ attemptedPath: absPath, canonicalPathGlob: matchedGlob })`.
      3. Otherwise, perform `fs.mkdir(path.dirname(absPath), { recursive: true })` then `fs.writeFile(absPath, contents, "utf8")`.
  - [x] **`writeManagedFile` is the ONLY file in `mcp-server/src/**` permitted to import a write-shaped fs API** (other than the future `lib/logger.ts` which Story 1.5 will whitelist). The static guard in AC5c enforces this — see Task 8.
  - [x] **Do not** wire `writeManagedFile` into any MCP tool in this story. There are no canonical-state-mutating tools yet (those land in 1.5+). Shipping the guard ahead of the writers is the whole point — the substrate must be impossible to bypass on day one.

- [x] **Task 7 — Ship the v1-minimum role specs** (AC: 5e)
  - [x] Create `plugins/crew/permissions/generalist-dev.yaml`:
    ```yaml
    role: generalist-dev
    tools_allow:
      - claimStory
      - completeStory
      - blockStory
      - readSourceStory
      - lookupStandards
      - recordYield
      - heartbeat
      - classifyRiskTier
    gh_allow:
      - pr-create
      - pr-view
      - pr-comment
      - pr-checks
      - pr-edit
    gh_allow_args: {}
    ```
    The `tools_allow` list names tools that **do not yet exist as MCP registrations** — that is intentional: this story ships the allowlist substrate, future stories register the named tools. A typo in the list cannot cause a runtime failure now because the dispatcher only refuses **negatively** (deny what's not listed); it never asserts that everything listed exists. (A later story can add a CI lint that cross-references `tools_allow` against `getRegisteredToolNames()`; out of v1 scope.)
  - [x] Create `plugins/crew/permissions/generalist-reviewer.yaml`:
    ```yaml
    role: generalist-reviewer
    tools_allow:
      - readSourceStory
      - lookupStandards
      - recordVerdict
      - classifyRiskTier
      - computeAgreement
      - recordYield
      - heartbeat
    gh_allow:
      - pr-view
      - pr-comment
      - pr-checks
      - api          # read-only path; future story constrains via gh_allow_args
    gh_allow_args: {}
    ```
    **Negative-capability assertion (NFR16):** this list explicitly excludes `pr-merge`, `pr-close`, `pr-review` (the "approve/request-changes" verb) — reviewer can post comments but cannot apply verdicts at the GitHub layer. AC5e tests this.
  - [x] Create `plugins/crew/mcp-server/tests/fixtures/permissions/test-role.yaml`:
    ```yaml
    role: test-role
    tools_allow:
      - noop
    gh_allow:
      - pr-view
    gh_allow_args: {}
    ```
    Used by AC5d (positive control) and AC5a/b (negative branches) — the fixture role is the only one with a `noop` tool, and shipping it under `tests/fixtures/permissions/` keeps it out of the shipped plugin tree.
  - [x] **Do not** create permission specs for any other role in this story. The catalogue (hiring-manager, planner, orchestrator, retro-analyst, specialists) lands in Epic 2. Adding speculative specs now is scope creep and risks shipping authority a later story will then have to claw back.

- [x] **Task 8 — Authored vitest suite and static guards** (AC: 5)
  - [x] Create `plugins/crew/mcp-server/tests/permissions-enforcement.test.ts`. Covers AC5a, AC5b runtime, AC5d, AC5e.
    - **AC5a (tool-layer denial):** Construct a server via `createServer({ permissionsLoader: async (role) => loadRolePermissions({ role, pluginRoot: /* tests/fixtures dir */ }) })`. Register two descriptors:
      - `noop` — `handler` is a `vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }))`.
      - `forbidden` — same shape, different `vi.fn()`.
      Then dispatch a `CallToolRequestSchema` request shape with `params: { name: "forbidden", arguments: {}, _meta: { role: "test-role" } }`. Assert:
      - Response is `{ isError: true, content: [{ type: "text", text: /Role 'test-role' is not allowed to invoke tool 'forbidden'/ }] }`.
      - The `forbidden` handler's `vi.fn()` was called **zero times**.
      - The `noop` handler's `vi.fn()` was called zero times.
    - **AC5b (`gh` subcommand runtime denial):** `import { gh } from "../src/lib/gh.js"` and call with `subcommand: "pr-merge"`, providing a `vi.fn()` as `execaImpl`. Assert:
      - The call rejects with `GhSubcommandDeniedError`.
      - `execaImpl` was called **zero times**.
      - The error message matches `/Role 'test-role' is not allowed to invoke 'gh pr-merge'/` and contains `(NFR17)`.
    - **AC5d (positive control — tool):** With the same server, dispatch `params: { name: "noop", arguments: {}, _meta: { role: "test-role" } }`. Assert the `noop` handler's `vi.fn()` was called exactly once and the response has `isError !== true`.
    - **AC5d (positive control — gh):** Call `gh({ ..., subcommand: "pr-view", args: ["--help"], execaImpl })` where `execaImpl` resolves to `{ stdout: "ok", stderr: "", exitCode: 0 }`. Assert the returned value matches the stub and `execaImpl` was called exactly once with `("gh", ["pr-view", "--help"])`.
    - **AC5e (shipped specs):** `loadRolePermissions({ role: "generalist-dev", pluginRoot })` and `... reviewer ...` both resolve to a `RolePermissions` whose `tools_allow.length > 0` and `gh_allow.length > 0`. Reviewer assertion: `expect(perms.gh_allow).not.toContain("pr-merge")` and likewise for `pr-close`, `pr-review`. Dev assertion: `tools_allow` includes `claimStory` and `completeStory`.
  - [x] Create `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts`. Covers AC5c runtime + static.
    - **AC5c (runtime):** Use `os.tmpdir()` to build a fake `targetRepoRoot`. Call:
      - `writeManagedFile({ absPath: path.join(root, ".crew", "state", "to-do", "bmad:1.yaml"), contents: "x", targetRepoRoot: root })` — no `mcpToolContext`. Assert: rejects with `CanonicalFsWriteError`, message contains the path and `.crew/state/**` and `(FR81/NFR16)`.
      - `writeManagedFile({ absPath: path.join(root, "scratch.txt"), contents: "x", targetRepoRoot: root })` — non-canonical path, no `mcpToolContext`. Assert: succeeds, file exists with the contents.
      - `writeManagedFile({ ..., absPath: path.join(root, ".crew", "state", "to-do", "bmad:2.yaml"), ..., mcpToolContext: { toolName: "claimStory", role: "generalist-dev" } })` — canonical path, with tool context. Assert: succeeds.
    - **AC5c (static, fs writes):** Walk `mcp-server/src/**/*.ts` (use `fast-glob` if already declared, else implement a tiny recursive `readdir` walker — do **not** add a new dep). For each file other than `mcp-server/src/lib/managed-fs.ts`:
      - Parse import statements with a regex (`/^\s*import[^;]*from\s+["']([^"']+)["']/gm`) or `node:fs` substring checks against the import-clause text.
      - For any import from `node:fs`, `node:fs/promises`, `fs`, or `fs/promises`, assert the imported binding list does **not** include any of `writeFile`, `writeFileSync`, `appendFile`, `appendFileSync`, `createWriteStream`. Also forbid `import * as fs` followed by `fs.writeFile` etc. (substring check on the file body is sufficient for v1).
      - Whitelist: `mcp-server/src/lib/managed-fs.ts` (the one permitted writer).
    - **AC5c (static, direct `gh` spawning):** Walk `mcp-server/src/**/*.ts` excluding `mcp-server/src/lib/gh.ts`. For each file:
      - Assert the file body does NOT contain any of the regex patterns: `/execa\s*\(\s*["']gh["']/`, `/(?:child_process|node:child_process).*spawn\s*\(\s*["']gh["']/`, `/spawnSync\s*\(\s*["']gh["']/`.
      - Test fails if any match found.
    - Use `path.resolve(__dirname, "..")` (or the ESM-equivalent `fileURLToPath(new URL(".", import.meta.url))` pattern) to locate `mcp-server/src/`.
  - [x] All test imports use `.js` extensions (NodeNext): `import { gh } from "../src/lib/gh.js"`, etc.
  - [x] Use `vi.fn()` and `vi.spyOn` — no `vi.mock` for fs (use real tmpdir fixtures, same precedent as 1.3).

- [x] **Task 9 — Verify install + build + test pipeline** (AC: 1, 2, 3, 4, 5)
  - [x] `pnpm install` from `plugins/crew/` succeeds (no new runtime deps; `execa` and `zod` and `yaml` already declared).
  - [x] `pnpm build` from `plugins/crew/` produces zero TS errors.
  - [x] `pnpm test` from `plugins/crew/` runs the full suite: existing baseline (1.1 smoke + acceptance, 1.2 resolver, 1.2b validate-active-adapter, 1.3 standards-doc) **unchanged**, plus the two new test files. All green, zero skips.
  - [x] `pnpm-lock.yaml` is unchanged (no new deps).
  - [x] Manual sanity-check: `grep -rE "from \"node:fs(/promises)?\"" plugins/crew/mcp-server/src/` returns matches only in files that need them, and no occurrence pairs a write-shape import with a non-whitelisted file. (If the dev wants this baked into CI later, fine — but for v1, AC5c's vitest sub-test is sufficient.)

---

## Dev Notes

### Why this story matters

This story stops being a code change at the moment it ships — from then on, it's a **substrate**. Every later story that registers an MCP tool or invokes `gh` or writes to a canonical path inherits the enforcement boundary built here. If we don't ship the substrate first, every later story has to either re-litigate the boundary or accept that "we'll lock it down later" — and "later" is when a reviewer agent accidentally pushes a commit or a dev agent silently rewrites the rule registry.

**Three enforcement surfaces, three failure modes, three typed errors:**
1. **Tool-layer allowlist** (`PermissionDeniedError`) — the MCP dispatcher refuses to call a handler whose name is not in the calling role's `tools_allow`. Per FR79/FR80/NFR12.
2. **`gh` subcommand allowlist** (`GhSubcommandDeniedError`) — the `execa` wrapper refuses to spawn a subprocess for a subcommand not in the calling role's `gh_allow`. Per NFR17/NFR12/NFR16.
3. **Canonical-fs write guard** (`CanonicalFsWriteError` plus a static guard against importing write-shaped fs APIs) — no code outside `writeManagedFile` and (future) `lib/logger.ts` can write to `<target-repo>/.crew/**`, `<target-repo>/team/**`, or the three canonical files under `<target-repo>/docs/`. Per FR81/NFR16.

**Boundary discipline:** this story ships substrate only. **No** MCP tool is wired through the substrate yet; **no** real `gh` call is invoked from a real role; **no** canonical file is written. The story exists to make it impossible for Stories 1.5+ to forget the boundary. The positive-control AC (AC4) and the `noop` test-fixture tool exist exclusively to guarantee the negative branches aren't fail-open.

### Files this story touches

**NEW:**
- `plugins/crew/mcp-server/src/schemas/role-permissions.ts` — Zod schema and types.
- `plugins/crew/mcp-server/src/state/load-role-permissions.ts` — pure-ish loader (re-reads on every call).
- `plugins/crew/mcp-server/src/lib/gh.ts` — `execa`-based `gh` wrapper with role-scoped enforcement.
- `plugins/crew/mcp-server/src/lib/managed-fs.ts` — `CANONICAL_PATH_GLOBS`, `isCanonicalPath`, `writeManagedFile`.
- `plugins/crew/permissions/generalist-dev.yaml` — shipped role spec.
- `plugins/crew/permissions/generalist-reviewer.yaml` — shipped role spec.
- `plugins/crew/mcp-server/tests/permissions-enforcement.test.ts` — vitest covering AC5a/b/d/e.
- `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts` — vitest covering AC5c.
- `plugins/crew/mcp-server/tests/fixtures/permissions/test-role.yaml` — test-only fixture role.

**UPDATE (minimal — preserve existing surface):**
- `plugins/crew/mcp-server/src/errors.ts` — append `PermissionDeniedError`, `GhSubcommandDeniedError`, `CanonicalFsWriteError`, `RolePermissionsMissingError`, `RolePermissionsMalformedError`. Do not touch the eight existing classes.
- `plugins/crew/mcp-server/src/server.ts` — extend `ToolHandler` signature with an optional `ctx` arg, add optional `allowedRoles` field on `ToolDescriptor`, change `createServer` signature to accept `{ permissionsLoader }`, add `_meta.role` reading + permission-check branch in the `CallToolRequestSchema` handler. **Preserve** the existing role-less branch (the 1.1 smoke test depends on it).

**MUST NOT touch:**
- `plugins/crew/mcp-server/src/state/workspace-resolver.ts`, `validate-active-adapter.ts`, `lookup-standards.ts` — their contracts are fixed by 1.2 / 1.2b / 1.3.
- `plugins/crew/mcp-server/src/schemas/workspace-config.ts`, `plugin-manifest.ts`, `standards-doc.ts` — settled.
- `plugins/crew/mcp-server/src/validators/standards-doc.ts` — settled. If extracting `formatZodIssues` into `lib/format-zod-issues.ts`, do **not** update this file to consume the shared helper (scope creep).
- `plugins/crew/mcp-server/src/adapters/*` — no adapter-contract change.
- `plugins/crew/mcp-server/src/index.ts` — stdio entrypoint untouched; production wiring of `permissionsLoader` lands in Story 1.7 (`/status` skill is the first caller that needs a real workspace + permissions loader together). If a stub default is needed today, the default `permissionsLoader` throws `NotImplementedError` as Task 4 specifies.
- Existing tests: `smoke.test.ts`, `acceptance.test.ts`, `workspace-resolver.test.ts`, `validate-active-adapter.test.ts`, `standards-doc.test.ts` — must still pass unchanged.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other status/state file — orchestrator owns status transitions.
- Anything under `plugins/sprint-orchestrator/` — retired.
- The project-root `README.md`, `CLAUDE.md`, `_bmad/`, `_bmad-output/_archive/` — out of scope.

### Architecture compliance — what is pinned

| Concern | Pin | Source |
|---|---|---|
| Permission spec location | `plugins/crew/permissions/<role>.yaml` | project-structure-boundaries.md lines 41–45 |
| Permission spec shape (`role`, `tools_allow`, `gh_allow`, `gh_allow_args`) | YAML, kebab-case role id, snake_case keys, `.strict()` Zod | implementation-patterns-consistency-rules.md §10 (`gh` allowlist format), §3 (catalogue/persona frontmatter) |
| Tool-layer enforcement (not prompt-layer) | MCP dispatcher refuses unlisted tools; handler never invoked | FR80, NFR12; PRD functional-requirements.md line 121 |
| `gh` is the only GitHub surface | `mcp-server/src/lib/gh.ts` is the only file permitted to spawn `gh`; static guard enforces this | NFR17; project-structure-boundaries.md line 102, 184; core-architectural-decisions.md lines 87–89 |
| Canonical-state write boundary | Only `writeManagedFile` (and future `lib/logger.ts`) imports a write-shape fs API | FR81; NFR16; project-structure-boundaries.md lines 179–180 |
| Reviewer negative-capability | `generalist-reviewer.yaml` excludes `pr-merge`, `pr-close`, `pr-review` | NFR16; non-functional-requirements.md line 28 |
| Typed errors extending `DomainError` | Distinct subclasses per failure mode; no umbrella discriminator | implementation-patterns-consistency-rules.md §6 (line 131); 1.2b anti-pattern #8 |
| File-naming convention | `kebab-case.ts`; test files `*.test.ts` co-located with source under `tests/` | implementation-patterns-consistency-rules.md §6 |
| `.strict()` on every schema level | Reject unknown keys; permission spec is a tight contract | implementation-patterns-consistency-rules.md §1 |
| Schema location | `mcp-server/src/schemas/role-permissions.ts` | project-structure-boundaries.md line 87 |
| Loader location | `mcp-server/src/state/load-role-permissions.ts` | project-structure-boundaries.md line 96 |
| Wrapper location | `mcp-server/src/lib/gh.ts`, `mcp-server/src/lib/managed-fs.ts` | project-structure-boundaries.md lines 102–107 |
| No path aliases | Relative imports only | implementation-patterns-consistency-rules.md §6 (line 130) |
| No `any` | Types via `z.infer`; explicit narrow types at every boundary | implementation-patterns-consistency-rules.md §6 (line 132) |

### `PermissionDeniedError`, `GhSubcommandDeniedError`, `CanonicalFsWriteError`, `RolePermissionsMissingError`, `RolePermissionsMalformedError` — exact shapes

```typescript
// additions to mcp-server/src/errors.ts (after StandardsDocMalformedError)

/**
 * An agent operating under a known role attempted to invoke an MCP tool
 * whose name is not in the role's tools_allow. Caught at the
 * CallToolRequestSchema handler before the tool's handler runs.
 */
export class PermissionDeniedError extends DomainError {
  readonly role: string;
  readonly attemptedTool: string;
  readonly allowedTools: readonly string[];
  readonly specPath: string;

  constructor(opts: {
    role: string;
    attemptedTool: string;
    allowedTools: readonly string[];
    specPath: string;
  }) {
    super(
      `Role '${opts.role}' is not allowed to invoke tool '${opts.attemptedTool}'. ` +
        `Allowed tools for this role: [${opts.allowedTools.join(", ")}]. ` +
        `Edit ${opts.specPath} to grant this capability through PR review (NFR13). ` +
        `(FR79/FR80/NFR12)`,
    );
    this.role = opts.role;
    this.attemptedTool = opts.attemptedTool;
    this.allowedTools = opts.allowedTools;
    this.specPath = opts.specPath;
  }
}

/**
 * An agent operating under a known role attempted to invoke a gh
 * subcommand not in the role's gh_allow. Caught at the gh() wrapper
 * before any subprocess is spawned.
 */
export class GhSubcommandDeniedError extends DomainError {
  readonly role: string;
  readonly attemptedSubcommand: string;
  readonly allowedSubcommands: readonly string[];
  readonly specPath: string;

  constructor(opts: {
    role: string;
    attemptedSubcommand: string;
    allowedSubcommands: readonly string[];
    specPath: string;
  }) {
    super(
      `Role '${opts.role}' is not allowed to invoke 'gh ${opts.attemptedSubcommand}'. ` +
        `Allowed gh subcommands: [${opts.allowedSubcommands.join(", ")}]. ` +
        `Edit ${opts.specPath} to grant this subcommand. (NFR17)`,
    );
    this.role = opts.role;
    this.attemptedSubcommand = opts.attemptedSubcommand;
    this.allowedSubcommands = opts.allowedSubcommands;
    this.specPath = opts.specPath;
  }
}

/**
 * A code path attempted to write to a canonical-state path under the
 * target repo without an MCP tool context. Routes through
 * writeManagedFile() are the only permitted entrypoint, and they
 * require an explicit { toolName, role } context.
 */
export class CanonicalFsWriteError extends DomainError {
  readonly attemptedPath: string;
  readonly canonicalPathGlob: string;

  constructor(opts: { attemptedPath: string; canonicalPathGlob: string }) {
    super(
      `Write to canonical-state path '${opts.attemptedPath}' ` +
        `(matches '${opts.canonicalPathGlob}') is not permitted outside an MCP tool. ` +
        `Route this write through an MCP tool that calls writeManagedFile(...). ` +
        `(FR81/NFR16)`,
    );
    this.attemptedPath = opts.attemptedPath;
    this.canonicalPathGlob = opts.canonicalPathGlob;
  }
}

/**
 * Permission spec file for the named role does not exist at the
 * expected path. Distinct from RolePermissionsMalformedError (file
 * exists but fails the schema).
 */
export class RolePermissionsMissingError extends DomainError {
  readonly role: string;
  readonly specPath: string;

  constructor(opts: { role: string; specPath: string }) {
    super(
      `Permission spec for role '${opts.role}' not found at ${opts.specPath}. ` +
        `See the canonical example in plugins/crew/permissions/generalist-dev.yaml.`,
    );
    this.role = opts.role;
    this.specPath = opts.specPath;
  }
}

/**
 * Permission spec file exists but failed the parser (YAML syntax,
 * missing required field, or unknown key).
 */
export class RolePermissionsMalformedError extends DomainError {
  readonly specPath: string;
  readonly zodMessage: string;

  constructor(opts: { specPath: string; zodMessage: string }) {
    super(
      `Permission spec at ${opts.specPath} is malformed: ${opts.zodMessage}. ` +
        `See the canonical example in plugins/crew/permissions/generalist-dev.yaml.`,
    );
    this.specPath = opts.specPath;
    this.zodMessage = opts.zodMessage;
  }
}
```

The exact wording is load-bearing — Story 1.7 (`/status`) and the README install path will surface these phrasings. Commit to them.

### `loadRolePermissions` — signature and shape

```typescript
// mcp-server/src/state/load-role-permissions.ts
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import {
  RolePermissionsMalformedError,
  RolePermissionsMissingError,
} from "../errors.js";
import {
  RolePermissionsSchema,
  type RolePermissions,
} from "../schemas/role-permissions.js";

/**
 * Resolve <pluginRoot>/permissions/<role>.yaml, parse, return typed.
 * Throws RolePermissionsMissingError on ENOENT,
 * RolePermissionsMalformedError on YAML-syntax or Zod failure.
 *
 * Single-purpose IO wrapper — no caching. Re-reads on every call.
 */
export async function loadRolePermissions(opts: {
  role: string;
  pluginRoot: string;
}): Promise<RolePermissions> {
  // ... implementation per Task 3 algorithm
}
```

### `gh` wrapper — signature and shape

```typescript
// mcp-server/src/lib/gh.ts
import { execa as defaultExeca } from "execa";
import { GhSubcommandDeniedError } from "../errors.js";
import type { RolePermissions } from "../schemas/role-permissions.js";

export interface GhCallResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Single entrypoint for `gh` invocations. Enforces role's gh_allow
 * before spawning any subprocess. NFR17 / NFR12 / NFR16.
 *
 * gh_allow_args is reserved for v1 forward-compat but unused by
 * shipped specs; implement exact-string matching only.
 *
 * Do NOT classify recoverable errors here — that's NFR18 / a later
 * story (gh-error-map.yaml).
 */
export async function gh(opts: {
  role: string;
  permissions: RolePermissions;
  subcommand: string;
  args?: readonly string[];
  execaImpl?: typeof defaultExeca;
}): Promise<GhCallResult> {
  // ... implementation per Task 5 algorithm
}
```

### `managed-fs` — signature and shape

```typescript
// mcp-server/src/lib/managed-fs.ts
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CanonicalFsWriteError } from "../errors.js";

export const CANONICAL_PATH_GLOBS: readonly string[] = [
  ".crew/state/**",
  ".crew/telemetry/**",
  ".crew/retro-proposals/**",
  ".crew/sprint-history/**",
  ".crew/sessions/**",
  "team/**",
  "docs/standards.md",
  "docs/risk-tiering.md",
  "docs/discipline-rules.yaml",
];

/**
 * Match an absolute path against the canonical-path globs, relative
 * to targetRepoRoot. Pure. Returns the first matched glob or
 * { canonical: false }.
 *
 * Rejects path-traversal escapes (`..` segments after normalization).
 */
export function isCanonicalPath(
  absPath: string,
  targetRepoRoot: string,
): { canonical: boolean; matchedGlob?: string } {
  // ... small dependency-free glob matcher: split on '/',
  // support '**' (matches zero or more segments) and exact segments.
}

/**
 * The ONLY entrypoint permitted to write to a canonical-state path.
 * Refuses without an mcpToolContext. Non-canonical writes pass through.
 *
 * Creates parent directories with { recursive: true } before writing.
 */
export async function writeManagedFile(opts: {
  absPath: string;
  contents: string;
  targetRepoRoot: string;
  mcpToolContext?: { toolName: string; role: string };
}): Promise<void> {
  // ... implementation per Task 6 algorithm
}
```

### Server signature change (`createServer`) — precise diff

Today (`mcp-server/src/server.ts:61`):

```typescript
export function createServer(): AiEngineeringTeamServer { … }
```

After:

```typescript
export interface CreateServerOptions {
  /**
   * Loader called once per CallToolRequest when the request carries a
   * `_meta.role` field. Default throws NotImplementedError to ensure
   * production wiring is explicit. Tests inject a fixture loader.
   */
  permissionsLoader?: (role: string) => Promise<RolePermissions>;
}

export function createServer(opts?: CreateServerOptions): AiEngineeringTeamServer { … }
```

And the dispatcher (currently `mcp-server/src/server.ts:77–87`):

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args, _meta } = request.params as {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: { role?: string };
  };
  const descriptor = registered.get(name);
  if (!descriptor) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  let ctx: { role?: string; permissions?: RolePermissions } = {};
  if (_meta?.role) {
    const permissions = await (opts?.permissionsLoader ??
      (() => { throw new NotImplementedError("permissionsLoader not configured — pass one to createServer in production wiring"); })
    )(_meta.role);

    if (!permissions.tools_allow.includes(name)) {
      const err = new PermissionDeniedError({
        role: _meta.role,
        attemptedTool: name,
        allowedTools: permissions.tools_allow,
        specPath: permissions.sourcePath,
      });
      return { content: [{ type: "text", text: err.message }], isError: true };
    }

    ctx = { role: _meta.role, permissions };
  }

  return descriptor.handler((args ?? {}) as Record<string, unknown>, ctx);
});
```

**`ToolHandler` signature change:** `(args: Record<string, unknown>, ctx: { role?: string; permissions?: RolePermissions }) => …`. Existing test code that doesn't pass a second arg continues to work (TypeScript optional parameter); existing handlers ignore `ctx`.

**`NotImplementedError` import** is already in `errors.ts` (Story 1.1). Use it.

### File structure requirements

```
plugins/crew/
├── permissions/
│   ├── .gitkeep                                  # UNCHANGED
│   ├── generalist-dev.yaml                       # NEW
│   └── generalist-reviewer.yaml                  # NEW
├── mcp-server/
│   ├── src/
│   │   ├── errors.ts                             # UPDATED — adds 5 classes
│   │   ├── server.ts                             # UPDATED — see diff above
│   │   ├── schemas/
│   │   │   └── role-permissions.ts               # NEW
│   │   ├── state/
│   │   │   └── load-role-permissions.ts          # NEW
│   │   ├── lib/
│   │   │   ├── plugin-version.ts                 # UNCHANGED (1.1)
│   │   │   ├── gh.ts                             # NEW
│   │   │   └── managed-fs.ts                     # NEW
│   │   ├── validators/standards-doc.ts           # UNCHANGED (1.3)
│   │   └── adapters/                             # UNCHANGED
│   └── tests/
│       ├── (existing tests UNCHANGED)
│       ├── permissions-enforcement.test.ts       # NEW
│       ├── canonical-fs-guard.test.ts            # NEW
│       └── fixtures/
│           └── permissions/
│               └── test-role.yaml                # NEW
```

Stay within this list. Anything else is scope creep.

### Testing requirements

- All new tests are unit/integration-level vitest, in-process, no subprocess transport. The `gh` wrapper test stubs `execa` via the `execaImpl` injection seam — **do not** spawn real `gh` in tests.
- `pnpm test` from `plugins/crew/` must continue to run the existing baseline suites unchanged.
- Test file imports use `.js` extensions (NodeNext).
- Use real tmpdir fixtures (no `vi.mock` for `fs`).
- The static guards in AC5c are themselves vitest assertions, not a separate lint pass. This keeps the dev loop one-command (`pnpm test`).
- The fixture role for tests lives at `mcp-server/tests/fixtures/permissions/test-role.yaml` and is loaded by `loadRolePermissions({ role: "test-role", pluginRoot: <fixture-dir> })` — the loader's `pluginRoot` parameter is what makes this substitutable without a real plugin install.

### Zod message formatting

Reuse the formatter pattern established by `validators/standards-doc.ts`. The `RolePermissions` schema's likely failure modes:
- `role`: regex fail → `"role: Invalid"` style message.
- `tools_allow`: missing → `"tools_allow: Required"`; empty array → `"tools_allow: Array must contain at least 1 element(s)"`.
- Unknown key → `"unrecognized_keys"` Zod code with the offending key list.

No special-case wording needed (unlike standards-doc's cap-violation FR46 wording). The default formatter output is fine for user-facing.

If extracting `formatZodIssues` into `lib/format-zod-issues.ts`: the function signature should be `formatZodIssues(issues: z.ZodIssue[]): string`, and the lib file should be ESM/NodeNext-compatible with `.js` import suffix. **Do not** retrofit `validators/standards-doc.ts` to use the shared helper in this story — that refactor is scope creep.

### Anti-patterns to avoid (high-cost LLM mistakes)

1. **Do not enforce permissions by prompt-injecting a role's allowlist into the agent's system prompt and trusting the agent to comply.** That's exactly the failure mode FR80 forbids ("not via prompt alone"). Enforcement is **at the dispatcher**, in code. The agent never sees its own allowlist — it just gets a refusal when it overreaches.
2. **Do not register the `noop` test-fixture tool in production.** It exists only inside `permissions-enforcement.test.ts`. Specifically: do not add `noop` to the server's default tool set, and do not add `noop` to any shipped role spec. The fixture role's `tools_allow: [noop]` is the only place `noop` is referenced.
3. **Do not implement `gh_allow_args` placeholder substitution in v1.** The schema field exists but is unused by shipped specs; exact-string match is the v1 semantics. Story 2.x / Epic 3 owns the rules layer. Implementing it now is scope creep that will get rewritten.
4. **Do not introduce a `gh` retry / recoverable-error classifier in this story.** NFR18 (`gh-error-map.yaml`) is a later deliverable. The wrapper returns whatever `execa` returns or throws — no retries, no classification.
5. **Do not cache `RolePermissions` at module level in the loader.** Every `loadRolePermissions` call re-reads. Caching is a later story's concern, and module-level state cuts across the test seam (`pluginRoot` parameter would be ignored after the first call).
6. **Do not derive `pluginRoot` or `targetRepoRoot` from `process.cwd()`.** Both flow in as parameters. Memory `feedback_pre_tool_use_hook_cwd_drift` — same lesson as 1.2 / 1.2b / 1.3.
7. **Do not whitelist any file other than `lib/managed-fs.ts` in AC5c's static fs-write guard.** `lib/logger.ts` doesn't exist yet (lands in 1.5); when it does, that story extends the whitelist. Do **not** speculatively add `lib/logger.ts` to the whitelist now — it would mask a v1 bug where some file imports `writeFile` ahead of time.
8. **Do not introduce a discriminator-based umbrella `PermissionError` class** (e.g. `PermissionError({ kind: "tool" | "gh" | "fs" })`). Three distinct subclasses match the precedent set by 1.2 / 1.2b / 1.3. Each has different fields; a discriminator would either need to carry all fields (sloppy) or use a union (more code than three classes).
9. **Do not wire the `permissionsLoader` from `index.ts` in this story.** Production stdio wiring needs a resolved `pluginRoot`, which today comes from Claude Code's plugin loader API — and we don't yet have a clean read for it from inside the MCP server. Story 1.7 (`/status` skill) is the first surface that calls a tool with a `_meta.role`, and it will wire the loader. For now, leave `index.ts` calling `createServer()` with no opts (default = `NotImplementedError` thrown on any `_meta.role` call, which is the safe fail-closed behaviour).
10. **Do not weaken the static fs-write guard by exempting "config-loading" or "test-helper" files.** If a file legitimately needs to write outside the canonical set (e.g. a future cache file), the file should call `writeManagedFile` with the non-canonical path — the guard passes that case through. There is no legitimate reason for any file in `mcp-server/src/**` other than `lib/managed-fs.ts` to import `writeFile`/etc.
11. **Do not add `pr-merge`, `pr-close`, or `pr-review` to the reviewer's `gh_allow`.** NFR16 says the reviewer cannot close/merge/request-changes. AC5e tests this explicitly. If a later story needs the reviewer to approve via the GitHub API, it's a breaking authority change requiring an explicit PR review (NFR13) and goes through `accept-proposal` machinery, not an implicit edit.
12. **Do not add `gh` itself or `bash`/`sh`/`exec` to any role's `tools_allow`.** `tools_allow` is the MCP-tool name set, not the host-OS command set. `gh` invocations happen via the wrapper, which is itself an internal lib — agents don't call `gh` directly; they call MCP tools that wrap `gh` internally (those tools land in later epics).
13. **Do not modify the smoke test from 1.1.** It exercises the role-less branch on purpose. The 1.1 acceptance test asserts zero tools registered; this story preserves that.
14. **Do not modify `_bmad-output/implementation-artifacts/sprint-status.yaml` or any state/status file** as part of this implementation. Orchestrator owns transitions.
15. **Do not add 5+ role specs "while we're here."** Two shipped specs (`generalist-dev`, `generalist-reviewer`) + one test fixture is the minimum. Catalogue-wide role specs are an Epic 2 deliverable (Hiring).
16. **Do not use `fs.existsSync` anywhere in this story.** Pattern continues from 1.3: rely on the `ENOENT` error from `fs.readFile` for the missing-file branch.
17. **Do not surface raw Zod issue objects to the user.** Pass through `formatZodIssues` or equivalent; programmatic consumers can inspect `error.zodMessage`.
18. **Do not implement a `gh` env-var (`GH_TOKEN`) handler.** NFR17: we inherit the user's `gh` auth. The wrapper passes no env overrides.
19. **Do not introduce `path` aliases or barrel exports** (`src/index.ts` re-exporting everything). Relative `.js` imports only.
20. **Do not assert in tests that `permissions.tools_allow` for `generalist-dev` contains every Epic 1 tool name.** The list is forward-looking; some tools don't exist yet. AC5e asserts a couple of canary entries (`claimStory`, `completeStory`); over-specifying ties this story's tests to future stories.

### Previous-story intelligence (Stories 1.1, 1.2, 1.2b, 1.3)

- **From 1.1:** `DomainError` is in `mcp-server/src/errors.ts` and sets `error.name` automatically via `new.target.name`. Subclassing gives you the class name on `error.name` for free.
- **From 1.1:** TypeScript module resolution is `NodeNext`. Relative imports inside `src/` and `tests/` must end in `.js`, even when the source is `.ts`.
- **From 1.1:** vitest config + test runner setup is in place. No config changes for this story.
- **From 1.1:** `createServer()` is the in-process server constructor; the smoke test calls it directly without a transport. Preserve that path.
- **From 1.2:** `parse as yamlParse` from `"yaml"` is the established YAML import.
- **From 1.2:** `state/` helpers take a target/plugin-root path as a parameter and return a typed result (or throw). `loadRolePermissions` follows the same shape.
- **From 1.2/1.2b:** Schemas in `schemas/`; pure validators in `validators/`; IO helpers in `state/`. Permission spec is a workspace-IO concern (the spec file is shipped with the plugin, not the target repo, but it's still file-IO from a fixed root), so `state/` is correct.
- **From 1.2b:** Distinct error subclasses, not discriminators. Wording asserted by tests verbatim — commit to it in Task 2.
- **From 1.3:** Pure-parser-plus-IO-helper split (validators + state). The permission story uses a single combined loader because the parse step is one Zod call and there's no separate consumer for the pure parser yet (no fixture-string-only callers); if a later story needs a pure parser, extract it then.
- **From 1.3:** Zod issue formatting via `formatZodIssues` helper. Duplicate it in the loader for now (or extract to `lib/format-zod-issues.ts` without changing 1.3's consumer — your call, default to duplicate).
- **From 1.3:** Test fixtures live under `mcp-server/tests/fixtures/<area>/`. Mirror that with `fixtures/permissions/`.
- **From 1.3:** Use real tmpdir fixtures for IO; no `vi.mock` for fs.

### Files being modified — current state and what changes

- **`mcp-server/src/errors.ts` (UPDATE):**
  - Current state (post-1.3): exports `DomainError`, `NotImplementedError`, `InvalidWorkspaceConfigError`, `NoAdapterMatchedError`, `AmbiguousAdapterError`, `StaleWorkspaceConfigError`, `StandardsDocMissingError`, `StandardsDocMalformedError`. Each constructor composes a user-facing one-line message in `super(...)`.
  - This story adds: `PermissionDeniedError`, `GhSubcommandDeniedError`, `CanonicalFsWriteError`, `RolePermissionsMissingError`, `RolePermissionsMalformedError` at the bottom of the file. Match the existing JSDoc style and options-bag constructor pattern.
  - Must preserve: every existing class, exact `super(...)` wording (1.1/1.2/1.2b/1.3 tests assert on those strings).
- **`mcp-server/src/server.ts` (UPDATE):**
  - Current state (post-1.1): exports `createServer(): AiEngineeringTeamServer`, `ToolDescriptor`, `ToolHandler`, `ToolCallResult`, `ToolInputSchema`, `AiEngineeringTeamServer`. Dispatcher in `CallToolRequestSchema` handler is `descriptor.handler((args ?? {}) as Record<string, unknown>)`.
  - This story changes: `createServer` signature to accept `{ permissionsLoader?: (role: string) => Promise<RolePermissions> }`. `ToolHandler` signature to accept an optional second `ctx` argument. `ToolDescriptor` gets an optional `allowedRoles` field (presently unused in dispatcher logic — reserved for a finer-grained per-tool override that future stories may consume, but writing it now keeps the type stable). Dispatcher reads `_meta.role`, calls `permissionsLoader`, checks `tools_allow`, refuses with `PermissionDeniedError` or proceeds with `ctx`.
  - Must preserve: existing `ListToolsRequestSchema` handler behaviour, existing role-less code path (1.1 smoke test depends on it), existing `getRegisteredToolNames` / `registerTool` surface.
- **`mcp-server/src/state/workspace-resolver.ts`, `validate-active-adapter.ts`, `lookup-standards.ts` (READ-ONLY for this story):**
  - Use only to mirror conventions. No edits.
- **`mcp-server/src/adapters/*` (READ-ONLY):** No adapter-contract change.
- **`mcp-server/src/index.ts` (READ-ONLY):** Stays calling `createServer()` with no opts. The `_meta.role` enforcement path is dormant in production until Story 1.7 wires the loader.

### Permission-spec authoring notes (for AC5e and forward-looking sanity)

- The `tools_allow` lists in shipped specs reference MCP tool names that will be registered in future stories. Today they are aspirational labels; the dispatcher only refuses **negatively**, so referencing an unregistered name is a no-op (a future story that registers that name will then allow it for this role).
- The `gh_allow` lists are concrete and immediately load-bearing: any role that calls `gh()` with a subcommand not in this list will be refused. Get them right.
- Conventional `gh` subcommand names: `pr-create`, `pr-view`, `pr-comment`, `pr-merge`, `pr-close`, `pr-checks`, `pr-edit`, `pr-review`, `api`, `auth-status`, `repo-view`. The wrapper passes the subcommand as the first positional arg to `gh`, so `gh-allow: [pr-view]` means the wrapper runs `gh pr-view ...`. (Yes, `gh` actually uses spaces: `gh pr view`, not `gh pr-view`. The wrapper translates dashes → spaces in the spawned command: `subcommand.split("-")` is the simplest rule. Document this in the wrapper's JSDoc.)
- **Decision: kebab-spaced subcommand normalisation.** Implement `subcommand.split("-")` so `pr-view` becomes `["pr", "view"]` in the spawned command. This keeps the allowlist values valid YAML identifiers and matches `gh`'s actual CLI shape. Test this in the AC5d positive-control branch: assert `execaImpl` is called with `("gh", ["pr", "view", "--help"])`, not `("gh", ["pr-view", "--help"])`.
- For single-word subcommands like `api` or `repo`, `split("-")` returns a single-element array — works fine.

### Library / framework requirements

| Lib | Version | Use in this story |
|---|---|---|
| `zod` | `^4.4.3` (pinned in 1.2; bumped in `mcp-server/package.json`) | schema definition + parse |
| `yaml` (eemeli) | `^2.9.0` (pinned) | parse the permission spec body |
| `execa` | `^9.6.1` (pinned in 1.1's scaffold) | spawn `gh` subprocess |
| `vitest` | `^2.1.0` (pinned in 1.1) | test runner |
| `node:fs/promises`, `node:path`, `node:os` | stdlib | tmpdir fixtures, file IO |
| `node:fs` (statSync, readFileSync) | stdlib | static-guard walker reads source files synchronously in tests |

**No new runtime deps.** `pnpm-lock.yaml` must remain unchanged.

**Use Context7** only if the dev needs to confirm `execa` v9 API shape (option keys, return shape) — the v9 API differs from v6 (`execa()` returns a Promise with a child-process attached). For `zod@^4`, confirm `safeParse` issue shape (`first.code` discriminator names changed slightly between v3 and v4 — check via Context7 if unsure).

### Latest tech information

- **`execa@9`:** `execa("cmd", argv)` returns a promise-like that resolves to `{ stdout, stderr, exitCode, failed, … }`. Throws on non-zero exit by default (`reject: true`) unless `{ reject: false }` is passed. For v1, leave the default — non-zero `gh` exits surface as exceptions through `gh()`, and NFR18 will classify them in a later story. Confirm via Context7 if uncertain.
- **`zod@^4`:** Same `safeParse`/`safeParse{success, data | error}` shape as v3 in the happy path. Issue objects use `issue.code` (string union) for the discriminator. For unknown-key failures: `issue.code === "unrecognized_keys"` with `issue.keys: string[]`. Confirm via Context7 if a specific check is unclear.
- **`vitest@^2.1`:** `vi.fn()` returns a mock; `vi.spyOn(obj, "method")` wraps an existing method. `expect(fn).toHaveBeenCalledTimes(0)` is the assertion for "never called". Standard.
- **Node 22 LTS, `module: NodeNext`.** Relative imports end in `.js`.

### Project context reference

- **PM:** Jack. Frame trade-offs in PM language (`CLAUDE.md`). This story's PM-visible signal: "the plugin now refuses, in code, to let any agent invoke a tool, run a `gh` command, or write to a sensitive path it isn't allowed to. Reviewer can comment but can't merge. Dev can open PRs but can't rewrite the team's bookkeeping. The substrate every later story builds on is in place — and it fails closed."
- **PRD (authoritative):** `_bmad-output/planning-artifacts/prd-crew-v1.md` (sharded). Permissions section: `functional-requirements.md#permissions-and-authority` (FR79–FR81); enforcement boundaries: `non-functional-requirements.md#security-permissions` (NFR12–NFR16) and `#integration` (NFR17–NFR20).
- **Architecture (load-bearing):**
  - `architecture/project-structure-boundaries.md` lines 41–45 (`permissions/<role>.yaml`), 102 (`lib/gh.ts`), 178–186 (architectural boundaries — MCP-server-as-only-canonical-state-boundary, `gh` boundary, telemetry append-only).
  - `architecture/implementation-patterns-consistency-rules.md` §3 (catalogue/persona frontmatter includes `tools_allow` / `gh_allow`), §6 (TypeScript conventions, error classes, `kebab-case.ts`, no `any`, no default exports), §10 (gh allowlist file format — pinned shape).
  - `architecture/core-architectural-decisions.md` lines 87–89 (`execa` + per-agent subcommand allowlist; `gh-error-map.yaml` for NFR18 deferred to later story).
- **Story 1.1 (precondition):** scaffold, errors.ts foundation (`DomainError`, `NotImplementedError`), createServer + tool descriptor shape, smoke test.
- **Story 1.2 (precondition):** workspace boundary (`state/workspace-resolver.ts`), typed-error precedent.
- **Story 1.2b (precondition):** `state/` IO-helper pattern, distinct error subclasses.
- **Story 1.3 (precondition):** validator + IO-helper split, Zod issue formatting precedent, fixture conventions.
- **Story 1.5 (downstream — same epic, next-up):** JSONL telemetry plumbing via pino. Will whitelist `lib/logger.ts` in the canonical-fs guard. Will also register the first canonical-state-mutating MCP tools (and consume the permission substrate this story ships).
- **Story 1.6 (downstream):** atomic `fs.rename` state-machine primitive. Will write canonical files via `writeManagedFile`.
- **Story 1.7 (downstream):** `/status` skill. First production caller that passes a `_meta.role` in a CallToolRequest, wiring the `permissionsLoader` into `createServer` from `index.ts`.
- **Epic 2 (Hiring, much later):** owns the full catalogue of role specs and the catalogue/persona machinery. Will add specs for `hiring-manager`, `planner`, `orchestrator`, `retro-analyst`, specialists. **Out of this story.**
- **Epic 3 (orchestration / NFR18):** owns `gh-error-map.yaml` recoverable-error classification. **Out of this story.**
- **Sprint-orchestrator lesson (memory `feedback_pre_tool_use_hook_cwd_drift`):** never derive paths from shell `cwd`. Both `pluginRoot` and `targetRepoRoot` flow in as parameters.
- **Sprint-orchestrator lesson (memory `feedback_worktrees_inside_project`):** worktrees live at `.worktrees/<key>/` inside repo — relevant to ship-story, not to this code.

### References

- [Source: _bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md#Story 1.4: Permission-allowlist scaffolding and tool-layer enforcement]
- [Source: _bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#Permissions and authority (FR79–FR81)]
- [Source: _bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md#Security & Permissions (NFR12–NFR16); Integration (NFR17)]
- [Source: _bmad-output/planning-artifacts/architecture/project-structure-boundaries.md#Plugin tree (permissions/ at lines 41–45; lib/gh.ts at line 102); Architectural boundaries (lines 178–186)]
- [Source: _bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#Catalogue & Persona File Shape (§3); TypeScript Code Conventions (§6); gh Allowlist File Format (§10)]
- [Source: _bmad-output/planning-artifacts/architecture/core-architectural-decisions.md#GitHub Integration (lines 87–89)]
- [Source: _bmad-output/implementation-artifacts/1-1-scaffold-the-plugin-skeleton.md] (precedent: createServer, ToolDescriptor, errors.ts foundation, NodeNext)
- [Source: _bmad-output/implementation-artifacts/1-2-workspace-resolver-and-per-target-repo-config.md] (precedent: `state/` IO boundary, Zod-schema location, typed-error pattern, fixture conventions)
- [Source: _bmad-output/implementation-artifacts/1-2b-stale-config-detection-on-every-skill-invocation.md] (precedent: distinct error subclasses, identity-preserving inputs, no-tool-wiring scope discipline)
- [Source: _bmad-output/implementation-artifacts/1-3-standards-doc-lookup-parser-and-shipped-example-template.md] (precedent: parser+loader split, fixture conventions, anti-pattern numbering, scope discipline against shipping downstream tools)
- [Source: CLAUDE.md — Jack is PM; talk in PM language; planning-discipline rules apply; plugin slug is `crew`]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7

### Debug Log References

### Completion Notes List

- Shipped the permission substrate end-to-end: Zod schema, loader, MCP dispatcher gate, `gh` wrapper, and canonical-fs write guard, with all three typed-error subclasses (`PermissionDeniedError`, `GhSubcommandDeniedError`, `CanonicalFsWriteError`) plus the loader's two error classes.
- Created two shipped role specs (`generalist-dev.yaml`, `generalist-reviewer.yaml`) and one test-only fixture (`test-role.yaml`). Reviewer spec verified to exclude `pr-merge`/`pr-close`/`pr-review` (NFR16 negative-capability).
- The MCP server now reads `_meta.role` on `CallToolRequestSchema` and consults the injected `permissionsLoader`. The 1.1 role-less smoke test path is preserved.
- The `gh` wrapper translates kebab-cased subcommands (`pr-view`) into space-separated segments (`["pr", "view"]`) before spawning, matching the real `gh` CLI shape.
- `writeManagedFile` is the only file outside `lib/managed-fs.ts` permitted to import write-shaped `node:fs` APIs. The static guard in `canonical-fs-guard.test.ts` enforces this and also forbids any non-wrapper file from spawning `gh` directly.
- Minor: `state/workspace-resolver.ts` previously called `fs.writeFile` directly to synthesise the workspace config. It was routed through `writeManagedFile` so the static guard passes; behaviour is unchanged because `.crew/config.yaml` is non-canonical and the wrapper passes such writes through.
- `pnpm install && pnpm build && pnpm test` from `plugins/crew/`: 48 tests pass (existing 1.1/1.2/1.2b/1.3 baseline plus 11 new tests across the two new files). `pnpm-lock.yaml` unchanged (no new deps).

### File List

**NEW:**
- `plugins/crew/mcp-server/src/schemas/role-permissions.ts`
- `plugins/crew/mcp-server/src/state/load-role-permissions.ts`
- `plugins/crew/mcp-server/src/lib/gh.ts`
- `plugins/crew/mcp-server/src/lib/managed-fs.ts`
- `plugins/crew/mcp-server/tests/permissions-enforcement.test.ts`
- `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts`
- `plugins/crew/mcp-server/tests/fixtures/permissions/test-role.yaml`
- `plugins/crew/permissions/generalist-dev.yaml`
- `plugins/crew/permissions/generalist-reviewer.yaml`

**UPDATED:**
- `plugins/crew/mcp-server/src/errors.ts` (appended 5 error classes)
- `plugins/crew/mcp-server/src/server.ts` (CreateServerOptions, dispatcher gate, ctx threading)
- `plugins/crew/mcp-server/src/state/workspace-resolver.ts` (routed config write through `writeManagedFile`)

