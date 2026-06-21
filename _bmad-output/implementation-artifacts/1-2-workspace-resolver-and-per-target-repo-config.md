# Story 1.2: Workspace resolver and per-target-repo config

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **the plugin to recognise my target repo via a `.crew/config.yaml` file**,
so that **the plugin knows where to read sources and write execution state for *my* project**.

This story stands up the workspace-resolution boundary every later skill, tool, and adapter depends on. It does NOT register MCP tools, run skills, write telemetry, or move state files — those land in 1.4–1.7 and Epics 2+. It produces (a) the Zod schema for `.crew/config.yaml`, (b) a pure resolver function the MCP tool layer will call on every skill invocation, (c) the auto-detect-on-first-use flow with the registry hook, and (d) the typed error surface that downstream skills will render to the user. Story 1.2b will later layer stale-config-on-every-invocation validation on top of this primitive — keep that seam clean.

## Acceptance Criteria

**AC1 — Valid config is loaded and exposed (happy path):**
**Given** a target repo containing `.crew/config.yaml` with a valid `adapter`, `adapter_config`, and `plugin` block,
**When** the workspace resolver is invoked with the target-repo path,
**Then** it returns a `Workspace` value exposing `targetRepoRoot` (absolute), `activeAdapterName` (string), `activeAdapter` (the registered `PlanningAdapter` instance), `adapterConfig` (the validated, adapter-specific block), and `pluginSettings` (the validated `plugin` block, with defaults applied for omitted keys).

**AC2 — Missing config triggers `detect()` against registered adapters:**
**Given** a target repo with **no** `.crew/config.yaml`,
**When** the workspace resolver runs for the first time,
**Then** it calls `detect(targetRepoRoot)` on each adapter in `adapters/registry.ts` registration order, collects the results, and:
- exactly one `detect()` returned `true` → the resolver writes a freshly generated `.crew/config.yaml` (adapter name, the adapter's `defaultConfig()` block, and a `plugin:` block populated with documented defaults) and returns the resolved `Workspace`;
- zero adapters returned `true` → the resolver throws a typed `NoAdapterMatchedError` whose message names every registered adapter and points the user at the documented config-writing path;
- two or more adapters returned `true` → the resolver throws a typed `AmbiguousAdapterError` whose message lists every matching adapter and instructs the user to author `.crew/config.yaml` manually with one of them.

**AC3 — Invalid config halts with a precise, schema-pinned error:**
**Given** a target repo with `.crew/config.yaml` present but failing the `WorkspaceConfigSchema` (missing `adapter`, unknown adapter name, malformed `adapter_config` for the named adapter, malformed `plugin` block, non-string types, etc.),
**When** the workspace resolver is invoked,
**Then** it throws a typed `InvalidWorkspaceConfigError` whose message:
- names the offending YAML path (e.g. `adapter_config.stories_root`),
- prints the Zod issue (`expected string, received number`),
- names the schema module (`mcp-server/src/schemas/workspace-config.ts`),
- and does **not** attempt to fall back to `detect()` (invalid config is a user-fix-it situation, not a missing-config situation).

**AC4 (integration) — vitest covers all three branches against fixture target repos:**
`pnpm test` runs a `mcp-server/tests/workspace-resolver.test.ts` suite that:
- (a) **valid config branch:** loads a fixture target repo at `mcp-server/tests/fixtures/workspace-resolver/valid-bmad/` whose `.crew/config.yaml` declares `adapter: bmad`, asserts the resolver returns a `Workspace` with the expected `targetRepoRoot`, `activeAdapterName: "bmad"`, defaulted `plugin` settings, and the parsed `adapter_config`;
- (b) **no-config + unambiguous detect branch:** loads a fixture target repo with **no** `.crew/` directory; registers a deterministic stub adapter that returns `detect() → true`; asserts the resolver creates `.crew/config.yaml` on disk (in a tmp dir copy of the fixture so the source tree is untouched), parses cleanly on a second resolver call, and returns the same `Workspace` both times;
- (c) **invalid config branch:** loads a fixture target repo at `mcp-server/tests/fixtures/workspace-resolver/invalid/` whose YAML is structurally wrong (e.g. `adapter:` set to an unknown name); asserts an `InvalidWorkspaceConfigError` is thrown with the YAML path and schema module named in the message.
- (d) **no-detect-match branch:** uses an in-test adapter registry with a single stub whose `detect()` returns `false`; asserts `NoAdapterMatchedError` is thrown and that **no** `.crew/config.yaml` was written.
- (e) **ambiguous-detect branch:** uses an in-test adapter registry with two stubs both returning `detect() → true`; asserts `AmbiguousAdapterError` is thrown, its message lists both adapter names, and **no** `.crew/config.yaml` was written.

All five sub-tests pass.

---

## Tasks / Subtasks

- [ ] **Task 1 — Author `WorkspaceConfigSchema` (Zod)** (AC: 1, 3)
  - [ ] Create `mcp-server/src/schemas/workspace-config.ts` exporting:
    - `WorkspaceConfigSchema` — a strict Zod object with `adapter: z.string().min(1)`, `adapter_config: z.record(z.string(), z.unknown())` (defaults to `{}`), `plugin: PluginSettingsSchema` (defaults to `{}` then populated).
    - `PluginSettingsSchema` — `agreement_threshold: z.number().min(0).max(1).default(0.8)`, `orchestration_interval_seconds: z.number().int().positive().default(120)`, all keys optional → defaulted (the resolver returns the *resolved* settings, not the raw object).
    - Inferred types: `WorkspaceConfig`, `PluginSettings`.
  - [ ] Use Zod v4 patterns (this repo pinned `zod@^4.4.3` in Story 1.1 — see Dev Notes "Zod v4 quirks").
  - [ ] Do **not** validate `adapter_config` *contents* in this schema. The active adapter validates its own block via its own Zod schema (see Task 4). The workspace schema only validates the top-level shape.
- [ ] **Task 2 — Extend the adapter contract with `detect()` config defaults** (AC: 2)
  - [ ] Update `mcp-server/src/adapters/adapter.ts` (introduced in Story 1.1) to **add** to `PlanningAdapter`:
    - `defaultConfig(): Record<string, unknown>` — returns the adapter's default `adapter_config` block (e.g. BMad returns `{ stories_root: "_bmad-output/planning-artifacts/stories" }`).
    - `adapterConfigSchema: z.ZodTypeAny` — the Zod schema that validates the adapter's `adapter_config` block.
  - [ ] **Do not break** Story 1.1's `BmadAdapter` stub. Add minimal stubs: `defaultConfig: () => ({ stories_root: "_bmad-output/planning-artifacts/stories" })` and `adapterConfigSchema: z.object({ stories_root: z.string() })`. `detect`, `readSourceStory`, `resolveSourcePath` continue to throw `NotImplementedError` — they are out of scope for this story.
- [ ] **Task 3 — Author typed errors** (AC: 2, 3)
  - [ ] Extend `mcp-server/src/errors.ts` with three new subclasses of `DomainError`:
    - `InvalidWorkspaceConfigError` — fields: `configPath: string`, `yamlPath: string`, `zodMessage: string`, `schemaModule: string`. `.message` composes them into one human-readable line.
    - `NoAdapterMatchedError` — fields: `targetRepoRoot: string`, `registeredAdapters: string[]`. `.message` lists every adapter and points at the documented manual-config path.
    - `AmbiguousAdapterError` — fields: `targetRepoRoot: string`, `matchingAdapters: string[]`. `.message` lists all matches and instructs the user to disambiguate by authoring config manually.
  - [ ] All three are plain `extends DomainError`. No re-exports from `errors.ts` index need to change beyond adding these.
- [ ] **Task 4 — Implement `workspace-resolver.ts`** (AC: 1, 2, 3)
  - [ ] Create `mcp-server/src/state/workspace-resolver.ts` (location pinned by architecture §Plugin tree line 766).
  - [ ] Export a single function: `resolveWorkspace(opts: { targetRepoRoot: string; adapters?: PlanningAdapter[] }): Promise<Workspace>`.
    - `adapters` defaults to the live registry `adapters` import from `mcp-server/src/adapters/registry.ts`. The override exists for tests (AC4d, AC4e).
    - `targetRepoRoot` is resolved via `path.resolve(opts.targetRepoRoot)` before any IO.
  - [ ] Export the `Workspace` type: `{ targetRepoRoot: string; activeAdapterName: string; activeAdapter: PlanningAdapter; adapterConfig: unknown; pluginSettings: PluginSettings; }`.
  - [ ] Algorithm:
    1. Compute `configPath = path.join(targetRepoRoot, ".crew", "config.yaml")`.
    2. **Branch A — config file does not exist:**
       - Call `Promise.all(adapters.map(a => a.detect(targetRepoRoot)))`. Collect the indices of `true` results.
       - **0 matches:** throw `NoAdapterMatchedError`.
       - **≥2 matches:** throw `AmbiguousAdapterError`.
       - **1 match:** synthesise a `WorkspaceConfig` object: `{ adapter: matched.name, adapter_config: matched.defaultConfig(), plugin: {} }`. Run it through `WorkspaceConfigSchema.parse` to populate the `plugin` defaults. Serialise with the `yaml` package (eemeli — pinned in 1.1). `mkdir -p .crew`; write `config.yaml` with the serialised object. Then **fall through to Branch B** so the just-written config is parsed by the same code path that handles existing configs (defence against write/read drift).
    3. **Branch B — config file exists:**
       - Read it as UTF-8. Parse with `yaml.parse`. If `yaml.parse` throws (malformed YAML), wrap as `InvalidWorkspaceConfigError` with `zodMessage: <yaml-error-message>` and `yamlPath: "(root)"`.
       - Run `WorkspaceConfigSchema.safeParse`. If `!success`: throw `InvalidWorkspaceConfigError` using the **first** `issues[0]` entry — `yamlPath: issues[0].path.join('.')`, `zodMessage: issues[0].message`.
       - Look up `parsed.adapter` against the adapter list. If no adapter with that `name` is registered: throw `InvalidWorkspaceConfigError` with `yamlPath: "adapter"`, `zodMessage: "unknown adapter '<name>' — registered: [bmad, …]"`.
       - Validate `parsed.adapter_config` with the active adapter's `adapterConfigSchema`. Failure → `InvalidWorkspaceConfigError` with `yamlPath: "adapter_config.<key>"` from `issues[0]`.
       - Return the `Workspace`.
  - [ ] **Idempotency:** calling `resolveWorkspace` twice in a row on the same target repo must produce the same result. The function does no caching itself (the MCP tool layer can cache); the test in AC4b exercises this by calling twice.
  - [ ] **No side effects beyond the config-write in Branch A1-match.** No mkdir of `state/`, `telemetry/`, `sessions/`, etc. Those land in Stories 1.5–1.7.
- [ ] **Task 5 — Wire `adapters/registry.ts`** (AC: 2)
  - [ ] Story 1.1 left `mcp-server/src/adapters/registry.ts` as an empty placeholder. **Minimally update** it: export `const adapters: PlanningAdapter[] = [BmadAdapter]`. **Do not** change the existing `getActiveAdapter()` placeholder behaviour — Story 3.1 owns that. The resolver consumes `adapters` directly (not `getActiveAdapter`).
- [ ] **Task 6 — Author fixtures and the vitest suite** (AC: 4)
  - [ ] Create fixture trees under `mcp-server/tests/fixtures/workspace-resolver/`:
    - `valid-bmad/.crew/config.yaml` — a hand-authored valid config (`adapter: bmad`, full `adapter_config`, partial `plugin` block).
    - `no-config/` — empty directory (committed via `.gitkeep`).
    - `invalid/.crew/config.yaml` — YAML with `adapter:` set to a string the registry does not know (e.g. `adapter: nonexistent`).
  - [ ] Create `mcp-server/tests/workspace-resolver.test.ts` covering AC4a–e. Use `node:os` `tmpdir()` + `fs.cp` to copy fixtures to a writable tmp dir before each test that mutates the tree (AC4b writes a config file).
  - [ ] Stub-adapter pattern for AC4b/d/e: define a small `makeStubAdapter({ name, detectResult })` helper inside the test file. Pass an `adapters: [stub1, stub2]` override to `resolveWorkspace` for those branches — do **not** mutate the live `adapters` array.
- [ ] **Task 7 — Verify install + build + test pipeline** (AC: 1, 3, 4)
  - [ ] `pnpm install` succeeds (no new runtime deps; `yaml` and `zod` already pinned in 1.1).
  - [ ] `pnpm build` produces zero TS errors.
  - [ ] `pnpm test` runs the smoke suite from 1.1 **and** the new workspace-resolver suite; all green.

---

## Dev Notes

### Why this story matters

Every later skill (`/<plugin>:status`, `/<plugin>:plan`, `/<plugin>:start`, `/<plugin>:watch`, every MCP tool that touches `.crew/`) must know which target repo to read/write and which adapter is active. This story is the **single boundary** that answers both questions. Story 1.2b layers stale-config-on-every-invocation validation on top of this; Story 1.7 calls `resolveWorkspace` to populate `/status` output. Get the seam right here and every later story drops in cleanly.

**Boundary discipline:** the resolver is a pure module with no MCP-tool registration, no skill wiring, no telemetry, no state-machine work. It returns a `Workspace` value or throws a typed error — that is the entire surface.

### Files this story touches

**NEW:**
- `plugins/crew/mcp-server/src/schemas/workspace-config.ts`
- `plugins/crew/mcp-server/src/state/workspace-resolver.ts`
- `plugins/crew/mcp-server/tests/workspace-resolver.test.ts`
- `plugins/crew/mcp-server/tests/fixtures/workspace-resolver/valid-bmad/.crew/config.yaml`
- `plugins/crew/mcp-server/tests/fixtures/workspace-resolver/no-config/.gitkeep`
- `plugins/crew/mcp-server/tests/fixtures/workspace-resolver/invalid/.crew/config.yaml`

**UPDATE (minimal — preserve existing surface):**
- `plugins/crew/mcp-server/src/errors.ts` — add three typed-error subclasses. Do not change `DomainError` or `NotImplementedError`.
- `plugins/crew/mcp-server/src/adapters/adapter.ts` — add `defaultConfig` and `adapterConfigSchema` to the `PlanningAdapter` interface. Existing exports (`SourceStory`, `AC`, `ChangeEvent`) stay verbatim.
- `plugins/crew/mcp-server/src/adapters/bmad/index.ts` — add the two new interface members as minimal stubs (literal default + Zod schema). Do not implement `detect()` / `readSourceStory()` / `resolveSourcePath()` — Story 3.3 owns those.
- `plugins/crew/mcp-server/src/adapters/registry.ts` — replace empty `adapters: []` with `adapters: [BmadAdapter]`. Do not touch `getActiveAdapter()`.

**MUST NOT touch:**
- `mcp-server/src/server.ts`, `mcp-server/src/index.ts` — no tool registration in this story; the resolver is consumed by tools that don't exist yet.
- `mcp-server/src/lib/plugin-version.ts` — unrelated.
- `.claude-plugin/plugin.json`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `mcp-server/tsconfig.json`, `mcp-server/vitest.config.ts` — Story 1.1 settled these.
- `mcp-server/tests/smoke.test.ts` — must still pass unchanged.
- Anything under `plugins/sprint-orchestrator/` — that plugin is retired (2026-05-19).

### Architecture compliance — what is pinned

| Concern | Pin | Source |
|---|---|---|
| Resolver location | `mcp-server/src/state/workspace-resolver.ts` | architecture §Plugin tree (line 766) |
| Schema location | `mcp-server/src/schemas/workspace-config.ts` | architecture §Plugin tree (line 761) |
| Config path | `<target-repo>/.crew/config.yaml` | architecture §Workspace Resolution (line 212), §Configuration (line 634) |
| Config shape | `adapter`, `adapter_config`, `plugin` (with `agreement_threshold: 0.8`, `orchestration_interval_seconds: 120` defaults) | architecture §Configuration (lines 636–644) |
| First-run auto-detect | Run `detect()` against registered adapters in order; unique match writes config; ambiguity prompts user | architecture §Configuration (line 646), §Risks (line 665) |
| Same-repo / split-repo | Same code path for both. Resolver does not assume plugin-root ≠ target-root | architecture §Workspace Resolution (line 212), §Target-repo tree (line 674), PRD FR74 |
| `PlanningAdapter` interface | Already shipped by Story 1.1. This story **adds** `defaultConfig()` and `adapterConfigSchema`. No other changes. | architecture §Adapter contract (lines 533–561) |

### `WorkspaceConfigSchema` — exact shape

```typescript
// mcp-server/src/schemas/workspace-config.ts
import { z } from "zod";

export const PluginSettingsSchema = z.object({
  agreement_threshold: z.number().min(0).max(1).default(0.8),
  orchestration_interval_seconds: z.number().int().positive().default(120),
}).default({});

export const WorkspaceConfigSchema = z.object({
  adapter: z.string().min(1),
  adapter_config: z.record(z.string(), z.unknown()).default({}),
  plugin: PluginSettingsSchema,
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type PluginSettings = z.infer<typeof PluginSettingsSchema>;
```

### `Workspace` return shape

```typescript
// inside mcp-server/src/state/workspace-resolver.ts
export interface Workspace {
  targetRepoRoot: string;          // absolute path
  activeAdapterName: string;       // mirrors config.yaml `adapter`
  activeAdapter: PlanningAdapter;  // resolved from the registry by name
  adapterConfig: unknown;          // validated by the adapter's own schema; opaque to the resolver caller
  pluginSettings: PluginSettings;  // defaults applied
}
```

### Error message shape — make these helpful

The user sees these errors verbatim through `/status` and every other skill. Aim for one line, no jargon. Examples:

- `InvalidWorkspaceConfigError`:
  `.crew/config.yaml is invalid at 'adapter_config.stories_root': expected string, received number. See mcp-server/src/schemas/workspace-config.ts and the canonical example in plugins/crew/example/.crew/config.yaml.`

- `NoAdapterMatchedError`:
  `No registered adapter recognises <targetRepoRoot>. Registered adapters: [bmad]. Author .crew/config.yaml manually following plugins/crew/example/.crew/config.yaml.`

- `AmbiguousAdapterError`:
  `Multiple adapters recognise <targetRepoRoot>: [bmad, native]. Author .crew/config.yaml manually to pick one.`

The README install path (Story 1.7) will reference these exact phrasings, so commit to them.

### `yaml` package (eemeli) — usage pinned by Story 1.1

```typescript
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

// reading:
const raw = await fs.readFile(configPath, "utf8");
const parsed = yamlParse(raw); // unknown

// writing:
const text = yamlStringify(synthesisedConfig);
await fs.writeFile(configPath, text, "utf8");
```

Do **not** introduce `js-yaml` or any other YAML lib. `yaml` (eemeli) is the project's pinned choice.

### Zod v4 quirks (carry-over from Story 1.1)

- `z.record(z.string(), z.unknown())` — two-arg signature, not one-arg.
- `.safeParse(...)` returns `{ success: true, data } | { success: false, error: ZodError }`. `error.issues[0]` has `path: (string|number)[]` and `message: string`.
- `.default(value)` applies to undefined; `null` is **not** treated as undefined — the schema rejects nulls unless explicitly `nullable()`.

### Library / framework requirements

| Lib | Version | Use in this story |
|---|---|---|
| `zod` | `^4.4.3` (pinned in 1.1) | `WorkspaceConfigSchema`, `PluginSettingsSchema`, adapter-config validation |
| `yaml` (eemeli) | `^2.9.0` (pinned in 1.1) | parse / stringify `config.yaml` |
| `vitest` | `^2.1.0` (pinned in 1.1) | test runner |
| `node:fs/promises`, `node:path`, `node:os` | stdlib | file IO, path resolution, tmpdir for tests |

**Use Context7** to confirm the current `zod@4` `safeParse` issues shape and the current `yaml` package's `parse`/`stringify` defaults before final commit — Story 1.1 confirmed both work; this story extends usage, no fresh API surface.

### File structure requirements

```
plugins/crew/
└── mcp-server/
    ├── src/
    │   ├── adapters/
    │   │   ├── adapter.ts                       # UPDATED — adds defaultConfig + adapterConfigSchema
    │   │   ├── registry.ts                      # UPDATED — adapters: [BmadAdapter]
    │   │   └── bmad/index.ts                    # UPDATED — adds two stub members
    │   ├── errors.ts                            # UPDATED — adds 3 typed errors
    │   ├── schemas/
    │   │   └── workspace-config.ts              # NEW
    │   └── state/
    │       └── workspace-resolver.ts            # NEW (and the first file ever in state/)
    └── tests/
        ├── workspace-resolver.test.ts           # NEW
        └── fixtures/
            └── workspace-resolver/
                ├── valid-bmad/.crew/config.yaml   # NEW
                ├── no-config/.gitkeep                          # NEW
                └── invalid/.crew/config.yaml       # NEW
```

Stay within this list. Anything else is scope creep.

### Testing requirements

- All five sub-tests are unit-level vitest, in-process, no subprocess transport. Branch B writes to a tmp dir copy of the fixture, never to the source fixture (or it'll dirty git on every run).
- `pnpm test` from `plugins/crew/` must continue to run the smoke suite (Story 1.1, 3 tests) **plus** this story's suite (5 tests), with zero failures and zero skips.
- The test file must import `resolveWorkspace` from the source path (`../src/state/workspace-resolver.js` — note `.js` extension because of `module: NodeNext`).

### Anti-patterns to avoid (high-cost LLM mistakes)

1. **Do not** register an MCP tool for workspace resolution. The resolver is a plain TS module. Tools that call it land in Story 1.4+ (permission allowlist work) and Story 1.7 (`/status`).
2. **Do not** add stale-config detection (calling `activeAdapter.detect(targetRepoRoot)` on every invocation). That is **Story 1.2b**'s entire purpose. Adding it here will collide with 1.2b's ACs and force a rewrite. The resolver in this story trusts the configured adapter name.
3. **Do not** cache the resolved `Workspace` inside the resolver module (no module-level `Map`). The MCP tool layer or skill harness handles caching strategy.
4. **Do not** auto-create `.crew/state/`, `.crew/telemetry/`, `.crew/sessions/` — those directories are created lazily by their owning stories (1.5, 1.6, etc.). Only `.crew/config.yaml` is written by this story, and only in the Branch A unique-detect-match path.
5. **Do not** read `process.cwd()` to determine the target repo. The resolver takes `targetRepoRoot` as an argument. The skill harness / MCP layer decides what path to pass. Sprint-orchestrator's "resolve projectRoot from shell cwd" bug (see project memory `feedback_pre_tool_use_hook_cwd_drift`) is exactly what we're avoiding.
6. **Do not** write a generic `WorkspaceError` superclass and three `kind:` discriminator strings. Three distinct subclasses of `DomainError` give callers `instanceof` ergonomics and let the README install path map error → fix-it message cleanly.
7. **Do not** call into the `BmadAdapter`'s `detect()` (it throws `NotImplementedError`). The auto-detect branch (AC2) is tested with stub adapters injected via the `opts.adapters` override. The real BmadAdapter.`detect()` lands in Story 3.3.
8. **Do not** write CI workflows, husky hooks, ESLint, or Prettier configs. Same boundary as Story 1.1.
9. **Do not** invent a `WorkspaceResolver` *class*. Export the function `resolveWorkspace`. Classes add lifecycle ceremony with no payoff here.
10. **Do not** swallow YAML parse errors silently. A malformed `config.yaml` must surface as `InvalidWorkspaceConfigError`, not `NoAdapterMatchedError` (that would mask the real problem and send the user to write a fresh config when their existing one just has a typo).
11. **Do not** modify `_bmad-output/implementation-artifacts/sprint-status.yaml` or any state/status file as part of this implementation. The orchestrator owns status transitions; the dev's job is the code + tests.

### Previous-story intelligence (Story 1.1)

- `BmadAdapter` is imported as `BmadAdapter` (not `bmadAdapter`). It's a value with methods, not a class with constructor — see `mcp-server/src/adapters/bmad/index.ts`. Add the two new interface members directly to that exported object literal.
- `PlanningAdapter` interface is exported from `mcp-server/src/adapters/adapter.ts`. Add the two new members to the interface; TypeScript will flag any adapter (only `BmadAdapter` exists today) that doesn't satisfy them.
- `DomainError` and `NotImplementedError` already live in `mcp-server/src/errors.ts`. Add the three new error classes to the same file; export from the same module surface.
- `mcp-server/src/adapters/registry.ts` currently exports `adapters: PlanningAdapter[] = []` and `getActiveAdapter()` throws `NotImplementedError`. Replace `[]` with `[BmadAdapter]`. Leave `getActiveAdapter()` alone — Story 3.1 owns its real implementation.
- `tsconfig.json` is `module: NodeNext` — relative imports inside `src/` and `tests/` must end in `.js` (e.g. `import { resolveWorkspace } from "../src/state/workspace-resolver.js"`), even when the source is `.ts`.
- The `yaml` package was pinned but unused in 1.1. This story is its first real usage. Watch out for `yamlParse(undefined)` if the file read returns empty — guard with a length check or rely on `WorkspaceConfigSchema` to reject `undefined`.
- `pnpm-workspace.yaml` has `allowBuilds.esbuild: true` (set during 1.1). Do not touch that line.
- Zod is `^4.4.3` (not `^3` as the architecture text suggests). The architecture doc predates the pin decision. Story 1.1's Dev Notes confirm v4.

### Git intelligence

- Recent commits (`d970559`, `6a93977`, `6d14fc5`, `c5ccde0`) show: ship-story is the conventional flow; commits are scope-prefixed (`feat(1-1): …`); CI watch loop runs on PR creation.
- Conventional commit for this story: `feat(1-2): workspace resolver + per-target-repo config schema` (subject line ≤72 chars).
- The plugin tree under `plugins/crew/` is the only mutation surface. The repo root has no relevant config drift.
- A `pnpm-lock.yaml` already exists at `plugins/crew/pnpm-lock.yaml` from Story 1.1. This story should not modify it (no new deps).

### Latest tech information

- **`zod` v4 (`safeParse` issue shape):** Use Context7 (`mcp__claude_ai_Context7__resolve-library-id` then `query-docs`) to confirm `ZodError.issues[i].path` is `(string|number)[]` and `issues[i].message` is a string. Story 1.1 confirmed this; re-verify if Context7 surfaces any v4.5+ change.
- **`yaml` (eemeli) `parse`/`stringify` defaults:** `parse(text)` returns the parsed value (object, array, string, number, null, or `undefined` on empty input). `stringify(value)` returns a string with default block scalar formatting. Confirm via Context7 if needed.
- **`@modelcontextprotocol/sdk`:** Not used in this story. Resolver is pure TS. Server wiring lives in 1.4+.
- **Node version:** Node 22 LTS, `module: NodeNext`. Relative imports inside the package use `.js` extensions.

### Project context reference

- **PM:** Jack. Frame trade-offs in PM language, not engineer language (`CLAUDE.md`).
- **PRD (authoritative):** `_bmad-output/planning-artifacts/prd-crew-v1.md`. This story implements substrate for FR74 (same-repo vs split-repo) and is the precondition for FR43–FR46 (standards-doc lookup, Story 1.3) and FR74 surfacing (Story 1.7).
- **Architecture (load-bearing):** `_bmad-output/planning-artifacts/architecture.md` §Workspace Resolution (lines 208–222), §Configuration (lines 632–646), §Plugin tree (lines 678–805), §Adapter contract (lines 533–561).
- **Story 1.2b (next):** layers stale-config-on-every-invocation validation on the resolver. Keep the seam clean: 1.2b will likely add a `validateActiveAdapter(workspace)` helper that calls `workspace.activeAdapter.detect(workspace.targetRepoRoot)`. Do not anticipate that helper here — but also do not write the resolver in a way that makes it impossible (e.g. don't strip `targetRepoRoot` from the return value).
- **Story 1.7 (downstream):** `/status` skill renders `workspace.targetRepoRoot`, `workspace.activeAdapterName`, plugin version, and standards-doc state. The resolver must return all of those (it returns the first two; 1.7 adds plugin version + standards state on top).
- **Sprint-orchestrator lesson (project memory `feedback_pre_tool_use_hook_cwd_drift`):** never derive the target repo from shell `cwd` inside the resolver. The caller passes `targetRepoRoot` explicitly.

### References

- [Source: _bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md#Story 1.2: Workspace resolver and per-target-repo config]
- [Source: _bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md#Story 1.2b: Stale-config detection on every skill invocation] (downstream story — preserves the seam)
- [Source: _bmad-output/planning-artifacts/architecture.md#Workspace Resolution (plugin / target-repo split) (lines 208–222)]
- [Source: _bmad-output/planning-artifacts/architecture.md#Configuration (lines 632–646)]
- [Source: _bmad-output/planning-artifacts/architecture.md#Adapter contract (lines 533–561)]
- [Source: _bmad-output/planning-artifacts/architecture.md#Plugin tree (lines 678–805)]
- [Source: _bmad-output/planning-artifacts/architecture.md#Risks introduced by this model — Adapter detection ambiguity (line 665)]
- [Source: _bmad-output/planning-artifacts/prd-crew-v1.md#FR74 — same-repo vs split-repo support]
- [Source: _bmad-output/implementation-artifacts/1-1-scaffold-the-plugin-skeleton.md] (precedent: file layout, deps, error types, Zod v4 quirks)
- [Source: CLAUDE.md — Jack is PM; talk in PM language; planning-discipline rules apply]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
