# Story 1.1: Scaffold the plugin skeleton

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **a load-bearing-but-empty plugin skeleton committed at `plugins/crew/`**,
so that **every later story has a stable place to land its files, schemas, and imports**.

This story is the foundation for the entire AI Engineering Team v1 plugin. It establishes every path, schema seam, and import the rest of the work depends on — but ships **zero behaviour**. No tools registered, no adapters with real logic, no skills wired up. Just the skeleton, a parseable plugin manifest, a startable (empty) MCP server, an empty `BmadAdapter`, a version-stamping helper used by later stories (2.3, 4.7, 4.9), and a vitest smoke suite that proves it all works.

## Acceptance Criteria

**AC1 — Install & build pass cleanly:**
**Given** the repo root,
**When** I run `pnpm install && pnpm build` from `plugins/crew/`,
**Then** the install and build succeed with **zero TypeScript errors** and zero warnings on the build step.

**AC2 — Directory skeleton present:**
**Given** the scaffolded `plugins/crew/`,
**When** I inspect the tree,
**Then** it contains:
- `.claude-plugin/plugin.json` (with a semver `version` field)
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `mcp-server/` (with `src/server.ts` exporting an empty MCP server)
- `catalogue/`
- `skills/`
- `permissions/`
- `docs/`
- `example/`

**AC3 — MCP server starts cleanly with zero tools:**
**Given** the scaffolded MCP server,
**When** the user loads the plugin in Claude Code,
**Then** the MCP server starts and reports **zero tools registered** with **no errors**.

**AC4 — Empty `BmadAdapter` in place:**
**Given** the scaffolded `mcp-server/src/adapters/`,
**When** I inspect `bmad/index.ts`,
**Then** it exports a `BmadAdapter` implementing `PlanningAdapter.listSourceStories` as an **empty list** (hardcoded placeholder). `detect`, `readSourceStory`, and `resolveSourcePath` may throw a typed `NotImplementedError`; only `listSourceStories` returns `[]`.

**AC5 — `getPluginVersion()` reads from manifest:**
**Given** the scaffolded server,
**When** `getPluginVersion()` exported from `mcp-server/src/lib/plugin-version.ts` is called,
**Then** it returns the semver string from `.claude-plugin/plugin.json` (used by Stories 2.3, 4.7, and 4.9 for stamping).

**AC6 — Vitest smoke suite passes (integration):**
`pnpm test` runs the vitest smoke suite which:
- (a) instantiates the MCP server,
- (b) asserts zero tools registered,
- (c) parses `.claude-plugin/plugin.json` against its Zod schema,
- (d) calls `BmadAdapter.listSourceStories()` and asserts `[]`.

All four pass.

---

## Tasks / Subtasks

- [x] **Task 1 — Create the plugin root and workspace plumbing** (AC: 1, 2)
  - [x] Create directory `plugins/crew/`
  - [x] Author `plugins/crew/package.json` (private, name `crew`, version `0.1.0`, scripts: `build`, `test`)
  - [x] Author `plugins/crew/pnpm-workspace.yaml` declaring `mcp-server` as a workspace package
  - [x] Author `plugins/crew/tsconfig.base.json` (strict TS, `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, `esModuleInterop: true`, `skipLibCheck: true`, `declaration: true`, `noEmit: false` in inheritors, `noUncheckedIndexedAccess: true`)
  - [x] Create empty placeholder directories: `catalogue/`, `skills/`, `permissions/`, `docs/`, `example/` (each with a `.gitkeep` so the directory is tracked)
  - [x] Author a minimal `README.md` at the plugin root with one-line "scaffold — see PRD" pointer
- [x] **Task 2 — Author `.claude-plugin/plugin.json`** (AC: 2, 3, 5)
  - [x] Create `.claude-plugin/plugin.json` with fields: `name` (`crew`), `version` (`0.1.0` — semver), `description`, `mcpServers` block pointing at the built server entrypoint, `skills: []`, `agents: []`
  - [x] Author a Zod schema for the manifest at `mcp-server/src/schemas/plugin-manifest.ts` (used by smoke test AC6c)
- [x] **Task 3 — Stand up the MCP server package** (AC: 1, 3)
  - [x] Create `plugins/crew/mcp-server/package.json` (private, name `@crew/mcp-server`, type `module`, scripts: `build`, `test`)
  - [x] Pin runtime deps: `@modelcontextprotocol/sdk` (latest stable), `zod` (^3 latest), `pino` (latest), `execa` (latest), `yaml` (eemeli latest), `ulid` (latest)
  - [x] Pin dev deps: `typescript` (^5 latest), `vitest` (latest), `@types/node` (matching Node LTS)
  - [x] Author `mcp-server/tsconfig.json` extending `../tsconfig.base.json`; `outDir: dist`, `rootDir: src`, `include: ["src/**/*"]`
  - [x] Author `mcp-server/vitest.config.ts` (defaults; `include: ["src/**/*.test.ts", "tests/**/*.test.ts"]`)
- [x] **Task 4 — Implement empty MCP server entrypoint** (AC: 3)
  - [x] Create `mcp-server/src/server.ts` exporting `createServer()` (low-level `Server`, name `crew`, version from `getPluginVersion()`, zero tools, with `getRegisteredToolNames()` and `registerTool()` introspection helpers)
  - [x] Create `mcp-server/src/index.ts` calling `createServer()` and connecting to a stdio transport (entrypoint referenced by `.claude-plugin/plugin.json`'s `mcpServers` block)
  - [x] Confirm no top-level side effects in `server.ts`
- [x] **Task 5 — Implement `getPluginVersion()`** (AC: 5)
  - [x] Create `mcp-server/src/lib/plugin-version.ts` exporting `getPluginVersion(): string`
  - [x] Resolve `.claude-plugin/plugin.json` via a stable `PLUGIN_ROOT` derived from `fileURLToPath(import.meta.url)` and `path.resolve`
  - [x] Parse with `JSON.parse`, validate against the Zod manifest schema, return `parsed.version`
  - [x] Cache the value on first read
- [x] **Task 6 — Stub the planning-adapter seam and `BmadAdapter`** (AC: 4)
  - [x] Create `mcp-server/src/adapters/adapter.ts` exporting `PlanningAdapter`, `SourceStory`, `AC`, `ChangeEvent`
  - [x] Create `mcp-server/src/adapters/registry.ts` exporting empty `adapters: PlanningAdapter[]` and `getActiveAdapter()` that throws `NotImplementedError`
  - [x] Create `mcp-server/src/adapters/bmad/index.ts` exporting `BmadAdapter` (name `bmad`, `listSourceStories: []`, other methods throw `NotImplementedError`)
  - [x] Create `mcp-server/src/errors.ts` exporting `DomainError` and `NotImplementedError`
- [x] **Task 7 — Author Zod schema for `plugin.json`** (AC: 6c)
  - [x] `PluginManifestSchema` requires `name`, `version` (semver regex), `description`, `mcpServers` (record), `skills`, `agents`
  - [x] Export schema and inferred `PluginManifest` type via `z.infer`
- [x] **Task 8 — Author the vitest smoke suite** (AC: 6)
  - [x] `mcp-server/tests/smoke.test.ts` covers AC6a–d
  - [x] `pnpm test` from plugin root runs suite via pnpm workspace
- [x] **Task 9 — Verify install + build + test pipeline locally** (AC: 1, 3, 6)
  - [x] `pnpm install` succeeds
  - [x] `pnpm build` produces `mcp-server/dist/` with zero TS errors
  - [x] `pnpm test` — all smoke tests pass (3/3)
  - [x] `.gitignore` covers `node_modules/`, `**/dist/`, `*.tsbuildinfo`, `.DS_Store`

---

## Dev Notes

### Why this story matters

This is the **foundation** for the entire `crew` plugin. The architecture (§Final Directory Layout, lines 678–805) names every file Epics 1–7 will land. This story must scaffold **all of the top-level shape** so later stories drop into stable paths. Get the layout wrong here and every later story rewrites paths.

**Zero behaviour, full structure.** No tools registered. No adapter logic. No skills wired. Just the skeleton, the version helper, and the smoke test.

### Stack pins (from architecture §MCP Server Stack, lines 195–207)

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript on Node LTS | Strict mode; `target: ES2022`; ESM (`type: "module"`) |
| Workspace | pnpm workspace at plugin root | `pnpm-workspace.yaml` lists `mcp-server` as a package |
| MCP SDK | `@modelcontextprotocol/sdk` | Latest stable; pin exact semver in `package.json` |
| Validation | `zod` | Schemas live under `mcp-server/src/schemas/` |
| Logging | `pino` (JSON output) | Not exercised in this story but pin the dep |
| `gh` wrapper | `execa` | Not exercised in this story but pin the dep |
| YAML | `yaml` (eemeli) | Not exercised in this story but pin the dep |
| Testing | `vitest` | Smoke suite under `mcp-server/tests/` |
| Error model | Typed `Error` subclasses (`DomainError`, `NotImplementedError`) | All future tools throw subclasses; MCP boundary maps to MCP errors |

**IMPORTANT — use Context7 to fetch latest stable versions** for `@modelcontextprotocol/sdk`, `zod`, `vitest`, `typescript`, `pino`, `execa`, `yaml`, and `ulid` before pinning. Do **not** rely on training-data versions. Pin exact semver (no `^`/`~`) for `@modelcontextprotocol/sdk` to make the smoke test deterministic; caret-range is fine for the rest.

### Directory layout — what MUST exist (from architecture §Plugin tree, lines 678–805)

```
plugins/crew/
├── .claude-plugin/
│   └── plugin.json                # AC2, AC5
├── .gitignore                     # ignores node_modules, dist, *.tsbuildinfo
├── README.md                      # one-line pointer
├── package.json                   # workspace root
├── pnpm-workspace.yaml            # AC2
├── tsconfig.base.json             # AC2
├── catalogue/.gitkeep             # AC2 — populated by Epic 2
├── skills/.gitkeep                # AC2 — populated by Epics 1.7, 2.x, 3.x, 4.x, 5.x, 6.x
├── permissions/.gitkeep           # AC2 — populated by Story 1.4 / 2.2
├── docs/.gitkeep                  # AC2 — populated by Story 1.3, 4.9
├── example/.gitkeep               # AC2 — populated by Story 7.1
└── mcp-server/                    # AC2
    ├── package.json
    ├── tsconfig.json
    ├── vitest.config.ts
    ├── src/
    │   ├── index.ts               # stdio-transport entrypoint
    │   ├── server.ts              # AC3 — createServer(), zero tools
    │   ├── errors.ts              # DomainError, NotImplementedError
    │   ├── adapters/
    │   │   ├── adapter.ts         # AC4 — PlanningAdapter interface + types
    │   │   ├── registry.ts        # placeholder; Story 3.1
    │   │   └── bmad/
    │   │       └── index.ts       # AC4 — empty BmadAdapter
    │   ├── lib/
    │   │   └── plugin-version.ts  # AC5 — getPluginVersion()
    │   └── schemas/
    │       └── plugin-manifest.ts # AC6c — PluginManifestSchema
    └── tests/
        └── smoke.test.ts          # AC6
```

**DO NOT create** files outside this list. Tools (`mcp-server/src/tools/`), state machine (`mcp-server/src/state/`), other adapters, catalogue files, skills, permissions YAMLs, docs, or example content all land in **later stories**. Creating their files here would be scope creep and will get reverted in review.

### `PlanningAdapter` interface — exact shape (architecture §Adapter contract, lines 533–561)

```typescript
// mcp-server/src/adapters/adapter.ts
export interface PlanningAdapter {
  name: string;
  detect(targetRepo: string): Promise<boolean>;
  listSourceStories(): Promise<SourceStory[]>;
  readSourceStory(ref: string): Promise<SourceStory>;
  resolveSourcePath(ref: string): string;
  watchForChanges?(): AsyncIterable<ChangeEvent>;
}

export type SourceStory = {
  ref: string;
  title: string;
  narrative: string;
  acceptance_criteria: AC[];
  depends_on: string[];
  implementation_notes?: string;
  raw_path: string;
  raw_frontmatter: Record<string, unknown>;
  source_hash: string;
};

export type AC = { text: string; kind: "integration" | "unit" };

export type ChangeEvent =
  | { kind: "added"; ref: string }
  | { kind: "edited"; ref: string; new_hash: string }
  | { kind: "removed"; ref: string };
```

Copy this verbatim. Story 3.1 builds the registry. Story 3.3 implements the real `BmadAdapter` methods.

### `plugin.json` shape

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

`version` is the load-bearing field — Stories 2.3, 4.7, and 4.9 stamp it onto personas, verdicts, and the verdict footer marker.

### MCP server — zero tools, clean start

`createServer()` must:
1. Instantiate `new Server({ name: "crew", version: getPluginVersion() }, { capabilities: { tools: {} } })`.
2. **Not call** `server.setRequestHandler(ListToolsRequestSchema, ...)` with any tools, OR register an explicit empty list handler. Pick the path that makes AC6b (zero-tools assertion) verifiable.
3. **Not connect** to a transport inside `createServer()`. The thin `index.ts` entrypoint does that — keeps the function unit-testable.

### Smoke test — what each sub-assertion looks like

Sketch for `mcp-server/tests/smoke.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "../src/server.js";
import { BmadAdapter } from "../src/adapters/bmad/index.js";
import { PluginManifestSchema } from "../src/schemas/plugin-manifest.js";

describe("plugin skeleton smoke", () => {
  it("instantiates the MCP server with zero tools (AC6a, AC6b)", async () => {
    const server = createServer();
    // assert via whatever introspection createServer exposes — zero tools registered
    expect(getRegisteredToolNames(server)).toEqual([]);
  });

  it("parses .claude-plugin/plugin.json against its Zod schema (AC6c)", () => {
    const manifestPath = resolve(__dirname, "../../.claude-plugin/plugin.json");
    const parsed = PluginManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
    expect(parsed.success).toBe(true);
  });

  it("BmadAdapter.listSourceStories returns [] (AC6d)", async () => {
    const stories = await BmadAdapter.listSourceStories();
    expect(stories).toEqual([]);
  });
});
```

If `@modelcontextprotocol/sdk` doesn't expose a clean "list registered tools" introspection, **wrap tool registration in a thin local helper** that records names into a private set, and have `createServer` expose `getRegisteredToolNames()` (or attach it to the returned server). This wrapper becomes the single registration point for every later story.

### Project Structure Notes

- **Plugin root:** `plugins/crew/` — sibling to the retired `plugins/sprint-orchestrator/`. Do not touch `sprint-orchestrator/`; it's legacy and orthogonal.
- **No content in `catalogue/`, `skills/`, `permissions/`, `docs/`, `example/`** beyond `.gitkeep` — those directories are populated by Epics 1.3, 1.4, 1.7, 2.x, 3.x, 7.x.
- **`pnpm-workspace.yaml` is rooted at the plugin** (not the repo root). The repo root is not a pnpm workspace; the plugin is self-contained.
- **`.gitignore`** at the plugin root must cover: `node_modules/`, `**/dist/`, `*.tsbuildinfo`, `.DS_Store`.

### Testing Requirements

- **All tests in this story are unit-level vitest** running against the in-process server and parsed manifest. No subprocess MCP transport spin-up.
- `pnpm test` from the plugin root must pass with **zero failures and zero skips**.
- Add a top-level `package.json` script `"test": "pnpm -r test"` so the workspace propagates test commands to `mcp-server`.

### Anti-patterns to avoid (high-cost LLM mistakes)

1. **Do not** scaffold tools, skills, catalogue files, permission YAMLs, telemetry plumbing, the state machine, or the example target repo. Those land in later stories. Creating placeholder files for them here causes merge conflicts down the road.
2. **Do not** publish a real `BmadAdapter.readSourceStory` / `detect` implementation. Story 3.3 owns that. Stub with `NotImplementedError`.
3. **Do not** import the MCP SDK in ways that block the smoke test from running headless. Keep `createServer()` pure — transport connection happens in `index.ts` only.
4. **Do not** start the server (call `.connect()`) at module load time. The smoke test instantiates `createServer()` and inspects it without ever connecting a transport.
5. **Do not** read `plugin.json` via `require()` (won't work in ESM) or via brittle `import.meta.url` traversal — use a path resolved from a stable `PLUGIN_ROOT` constant.
6. **Do not** pin TypeScript or vitest versions from training-data knowledge — fetch current stable via Context7 first.
7. **Do not** add CI workflows in this story. Repo-level CI is out of scope until Epic 7.
8. **Do not** add Husky / pre-commit hooks in this story.
9. **Do not** introduce ESLint / Prettier in this story unless they're effectively free to wire up — they're not in the AC list. If added, they must not block `pnpm install && pnpm build`.

### Latest tech information

Before pinning versions in `package.json` files, use Context7 (`mcp__claude_ai_Context7__resolve-library-id` then `query-docs`) to fetch the current stable versions and recent breaking-change notes for:

- `@modelcontextprotocol/sdk` — confirm the current stable `Server` API surface (constructor signature, `setRequestHandler` shape, capabilities declaration, stdio transport import path)
- `zod` — v3 vs v4 API differences (schema declaration, `safeParse` return shape)
- `vitest` — current major; default config conventions
- `typescript` — `module: NodeNext` requirements
- `pino`, `execa`, `yaml`, `ulid` — pin latest stable; no usage in this story but they're declared deps for later stories

### References

- [Source: _bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md#Story 1.1: Scaffold the plugin skeleton]
- [Source: _bmad-output/planning-artifacts/architecture.md#Final Directory Layout — Plugin tree (lines 678–805)]
- [Source: _bmad-output/planning-artifacts/architecture.md#MCP Server Stack (lines 195–207)]
- [Source: _bmad-output/planning-artifacts/architecture.md#Planning Adapter Model — Adapter contract (lines 533–561)]
- [Source: _bmad-output/planning-artifacts/architecture.md#Decision Impact Analysis — Implementation sequence (lines 263–275)]
- [Source: _bmad-output/planning-artifacts/architecture.md#First implementation story (line 1177)]
- [Source: _bmad-output/planning-artifacts/prd-crew-v1.md (whole — context only; this story implements no FR/NFR directly, it scaffolds the substrate for all of them)]
- [Source: CLAUDE.md — Jack is PM; talk in PM language; no engineering jargon dumps]

### Previous-story intelligence

No previous story in this epic (this **is** story 1 of epic 1). Repo-level prior art:
- `plugins/sprint-orchestrator/` was retired on 2026-05-19 (commit `ed66ee6`). Its decisions (TypeScript MCP server, pnpm workspace, vitest, Zod schemas) are inherited — its files are not.
- Do **not** copy code from `plugins/sprint-orchestrator/`. The architecture supersedes it.

### Git intelligence

Recent commits (`c5ccde0`, `061e4eb`, `ed66ee6`) confirm the repo is in **planning-only state** — no plugin code currently exists under `plugins/crew/`. This story is a clean greenfield scaffold. Conventional commit style: `feat(<scope>): <subject>` (e.g. `feat(1-1): scaffold crew plugin skeleton`).

### Project context reference

- **PM:** Jack. Frame trade-offs in PM language, not engineer language (CLAUDE.md).
- **PRD:** `_bmad-output/planning-artifacts/prd-crew-v1.md` (authoritative).
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` (load-bearing for layout & stack decisions).
- **Sprint state:** `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (via `bmad-dev-story` skill, executed in worktree `crew-1-1-scaffold-the-plugin-skeleton`).

### Debug Log References

- `pnpm install` initially failed with `ERR_PNPM_IGNORED_BUILDS` for esbuild's postinstall (vitest 2.1 transitive dep). Resolved by setting `allowBuilds.esbuild: true` in `pnpm-workspace.yaml` (harness-managed allowlist for postinstall scripts).
- Pinned dependency versions: `@modelcontextprotocol/sdk@1.29.0` (exact, for deterministic smoke test), `zod@^4.4.3`, `pino@^10.3.1`, `execa@^9.6.1`, `yaml@^2.9.0`, `ulid@^3.0.2`, `typescript@^5.7.0`, `vitest@^2.1.0`, `@types/node@^22.10.0` (Node 22 LTS).

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide created.
- Scaffold built end-to-end in worktree. Zero behaviour shipped: no tools registered, no skills wired, `BmadAdapter` is the only adapter and only `listSourceStories()` returns a real (empty) value.
- `createServer()` uses the low-level `Server` from `@modelcontextprotocol/sdk/server/index.js` and exposes `getRegisteredToolNames()` / `registerTool()` on the returned instance so AC6b's zero-tools assertion is verifiable without SDK internals. The `ListToolsRequestSchema` handler reads from this wrapper.
- `getPluginVersion()` resolves `PLUGIN_ROOT` three levels up from `import.meta.url` — works for both compiled `dist/lib/plugin-version.js` and source `src/lib/plugin-version.ts` (vitest path). Value is cached on first read.
- Verification:
  - `pnpm install` → green (171 packages, esbuild postinstall ran).
  - `pnpm build` → green, zero TS errors, `mcp-server/dist/` populated.
  - `pnpm test` → 1 file, 3 tests, all pass (covers AC6a, AC6b, AC6c, AC6d).
- Pinned `zod@^4` (current stable as of 2026-05; spec said `^3` based on training data). v4 record signature is `z.record(z.string(), …)`.

### File List

- `plugins/crew/.claude-plugin/plugin.json`
- `plugins/crew/.gitignore`
- `plugins/crew/README.md`
- `plugins/crew/package.json`
- `plugins/crew/pnpm-workspace.yaml`
- `plugins/crew/tsconfig.base.json`
- `plugins/crew/catalogue/.gitkeep`
- `plugins/crew/docs/.gitkeep`
- `plugins/crew/example/.gitkeep`
- `plugins/crew/permissions/.gitkeep`
- `plugins/crew/skills/.gitkeep`
- `plugins/crew/mcp-server/package.json`
- `plugins/crew/mcp-server/tsconfig.json`
- `plugins/crew/mcp-server/vitest.config.ts`
- `plugins/crew/mcp-server/src/index.ts`
- `plugins/crew/mcp-server/src/server.ts`
- `plugins/crew/mcp-server/src/errors.ts`
- `plugins/crew/mcp-server/src/adapters/adapter.ts`
- `plugins/crew/mcp-server/src/adapters/registry.ts`
- `plugins/crew/mcp-server/src/adapters/bmad/index.ts`
- `plugins/crew/mcp-server/src/lib/plugin-version.ts`
- `plugins/crew/mcp-server/src/schemas/plugin-manifest.ts`
- `plugins/crew/mcp-server/tests/smoke.test.ts`
- `plugins/crew/pnpm-lock.yaml` (generated)
