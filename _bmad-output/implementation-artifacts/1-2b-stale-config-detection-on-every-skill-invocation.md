# Story 1.2b: Stale-config detection on every skill invocation

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **the active adapter validated against the repo on every skill invocation**,
so that **a copied-from-example config doesn't silently produce zero results when the repo doesn't match**.

This story layers a thin **stale-config-on-every-invocation** check on top of the workspace resolver Story 1.2 stood up. It does NOT change the resolver's parse/auto-detect-on-first-use behaviour, does NOT register MCP tools, does NOT touch state directories, telemetry, or skills. It produces (a) a single helper that re-runs `activeAdapter.detect(targetRepoRoot)` against the configured adapter, (b) a typed error surface when the configured adapter rejects the repo, (c) cross-checks against *other* registered adapters so the error message can redirect the user to the right one if there is one, and (d) the vitest coverage that pins the three branches. Story 1.7 (`/status`) and every later skill (Epics 2+) will call this helper before doing anything else; this story does **not** wire it into any skill — that's downstream.

## Acceptance Criteria

**AC1 — Configured adapter still matches → helper returns the workspace unchanged (happy path):**
**Given** a target repo whose `.crew/config.yaml` names an adapter and the configured adapter's `detect(targetRepoRoot)` returns `true`,
**When** `validateActiveAdapter(workspace)` is called (after `resolveWorkspace` has already returned a `Workspace`),
**Then** the helper completes without throwing and returns the same `Workspace` instance it was given (identity-preserving — callers can chain `await validateActiveAdapter(await resolveWorkspace(...))`).

**AC2 — Configured adapter mismatches, another adapter matches → helper throws with redirection:**
**Given** a target repo whose configured adapter's `detect()` returns `false`, but one or more *other* registered adapters' `detect()` returns `true`,
**When** the helper inspects,
**Then** it throws a typed `StaleWorkspaceConfigError` whose message:
- names the configured adapter (the one from `.crew/config.yaml`),
- states that its `detect()` returned `false`,
- names every *other* registered adapter whose `detect()` returned `true`,
- and points the user at `.crew/config.yaml` to update the `adapter:` key.

**AC3 — Configured adapter mismatches and no other adapter matches → helper throws with config-rewrite guidance:**
**Given** a target repo whose configured adapter's `detect()` returns `false` and no other registered adapter's `detect()` returns `true` either,
**When** the helper inspects,
**Then** it throws a typed `StaleWorkspaceConfigError` whose message:
- names the configured adapter and states `detect()` returned `false`,
- states that no other registered adapter recognises the repo,
- points the user at the workspace-config Zod schema (`mcp-server/src/schemas/workspace-config.ts`) and the canonical example in `plugins/crew/example/.crew/config.yaml`.

**AC4 (integration) — vitest covers all three branches against fixture target repos and stub adapters:**
`pnpm test` runs a new `mcp-server/tests/validate-active-adapter.test.ts` suite that:
- (a) **configured adapter matches branch:** builds a `Workspace` whose `activeAdapter` is a stub returning `detect() → true`; asserts `validateActiveAdapter(workspace)` resolves with the same `Workspace` reference (`expect(result).toBe(workspace)`);
- (b) **configured mismatches, other matches branch:** builds a `Workspace` whose `activeAdapter` is a stub `{ name: "stubA", detect: () => false, ... }` and passes an `adapters` override containing `[stubA, stubB]` where `stubB.detect → true`; asserts `StaleWorkspaceConfigError` is thrown, that the message contains `stubA`, `false`, and `stubB`, and that the error's `configuredAdapter` is `"stubA"` and `otherMatchingAdapters` is `["stubB"]`;
- (c) **configured mismatches, none others match branch:** same `stubA` configured + `adapters` override `[stubA, stubC]` where `stubC.detect → false`; asserts `StaleWorkspaceConfigError` is thrown, the message contains `stubA`, `false`, and the schema-module path (`mcp-server/src/schemas/workspace-config.ts`), and that `otherMatchingAdapters` is `[]`.

All three sub-tests pass alongside the smoke suite from Story 1.1 and the resolver suite from Story 1.2.

---

## Tasks / Subtasks

- [ ] **Task 1 — Author the `StaleWorkspaceConfigError` typed error** (AC: 2, 3)
  - [ ] Extend `plugins/crew/mcp-server/src/errors.ts` with one new subclass of `DomainError`:
    - `StaleWorkspaceConfigError` — fields: `targetRepoRoot: string`, `configuredAdapter: string`, `otherMatchingAdapters: string[]`, `schemaModule: string`.
    - Constructor composes the message from those fields. The shape must match the wording pinned in **Error message shape** below so README/`/status` (Story 1.7) can reference exact phrasings.
  - [ ] Do **not** touch `DomainError`, `NotImplementedError`, `InvalidWorkspaceConfigError`, `NoAdapterMatchedError`, or `AmbiguousAdapterError`. They were settled in 1.1/1.2.

- [ ] **Task 2 — Implement `validateActiveAdapter` helper** (AC: 1, 2, 3)
  - [ ] Create `plugins/crew/mcp-server/src/state/validate-active-adapter.ts`.
  - [ ] Export a single async function:
    `validateActiveAdapter(workspace: Workspace, opts?: { adapters?: PlanningAdapter[] }): Promise<Workspace>`
    - `adapters` defaults to the live registry `adapters` from `mcp-server/src/adapters/registry.js`. The override exists for tests (AC4b/c).
  - [ ] Algorithm:
    1. Call `workspace.activeAdapter.detect(workspace.targetRepoRoot)`.
    2. If `true` → return `workspace` (the exact same reference passed in — identity preserving).
    3. If `false` → call `detect(workspace.targetRepoRoot)` on every *other* registered adapter (i.e. `adapters.filter(a => a.name !== workspace.activeAdapterName)`). Use `Promise.all` for parallelism, same pattern as `resolveWorkspace`.
    4. Collect the names of other adapters whose `detect()` returned `true` → `otherMatchingAdapters`.
    5. Throw `StaleWorkspaceConfigError({ targetRepoRoot: workspace.targetRepoRoot, configuredAdapter: workspace.activeAdapterName, otherMatchingAdapters, schemaModule: "mcp-server/src/schemas/workspace-config.ts" })`.
  - [ ] **Pure module** — no module-level state, no caching, no IO beyond what the adapters' `detect()` implementations do.
  - [ ] **Does not** re-parse `config.yaml`, re-run `WorkspaceConfigSchema`, or otherwise duplicate `resolveWorkspace`'s job. The `Workspace` argument is trusted to already be schema-valid (the resolver returned it).
  - [ ] **Does not** mutate the workspace argument or call any state-machine, telemetry, or git wrapper. This is a pure inspector.

- [ ] **Task 3 — Re-export the helper from the state-module surface** (AC: 1)
  - [ ] If `plugins/crew/mcp-server/src/state/` already has an index/barrel after Story 1.2, add `export { validateActiveAdapter } from "./validate-active-adapter.js";` to it. If no barrel exists, **do not invent one** — leave the helper importable directly via its file path. (Match whatever pattern Story 1.2 left behind; do not reorganise.)

- [ ] **Task 4 — Author the vitest suite and stub adapters** (AC: 4)
  - [ ] Create `plugins/crew/mcp-server/tests/validate-active-adapter.test.ts`.
  - [ ] Reuse the same `makeStubAdapter({ name, detectResult })` pattern Story 1.2 used in `workspace-resolver.test.ts`. **Do not** export the helper from the production tree — duplicate the stub factory inline in the new test file (or import from the existing test file if Story 1.2 exported it; if not, duplicate to keep the production surface clean).
  - [ ] Construct synthetic `Workspace` objects directly in the test (do **not** call `resolveWorkspace` — that's covered by the 1.2 suite and would couple this suite to fixture trees it doesn't need). Each `Workspace` needs only: `targetRepoRoot: "/tmp/anything"`, `activeAdapterName: stub.name`, `activeAdapter: stub`, `adapterConfig: {}`, `pluginSettings: { agreement_threshold: 0.8, orchestration_interval_seconds: 120 }`.
  - [ ] Cover AC4a, AC4b, AC4c with one `describe` block and three `it` cases.
  - [ ] Assertions per branch:
    - AC4a — `expect(result).toBe(workspace)` (identity, not deep equality).
    - AC4b — `expect(...).rejects.toThrow(StaleWorkspaceConfigError)`; inspect the thrown error's fields (`configuredAdapter`, `otherMatchingAdapters`) and message substrings.
    - AC4c — same shape, with `otherMatchingAdapters` empty and the message containing the schema-module path.

- [ ] **Task 5 — Verify install + build + test pipeline** (AC: 1, 2, 3, 4)
  - [ ] `pnpm install` succeeds (no new runtime deps).
  - [ ] `pnpm build` produces zero TS errors.
  - [ ] `pnpm test` runs the full suite: Story 1.1 smoke (3 tests) + Story 1.2 resolver (5 tests) + this story's new suite (3 tests). All green, zero skips.

---

## Dev Notes

### Why this story matters

The resolver (Story 1.2) trusts the configured adapter name once `config.yaml` parses cleanly. That's the right boundary for the resolver — but it means a user who copies `example/.crew/config.yaml` into a repo that *doesn't* match that adapter gets silent zero-result behaviour from every skill (no source stories found, no errors). The PRD and architecture both call this out as the highest-cost greenfield onboarding mistake. This story closes that gap with a single tiny helper that every skill (Story 1.7's `/status` first, then every Epic 2+ skill) will call as the second step of the workspace boundary — after `resolveWorkspace`, before any other work.

**Boundary discipline:** this helper is a pure inspector. It does not mutate config, it does not call the state machine, it does not write telemetry, it does not register MCP tools. It calls `detect()` and either returns the workspace or throws. Anything more belongs to a different story.

**Seam pinned by Story 1.2:** the 1.2 spec called out that 1.2b would "likely add a `validateActiveAdapter(workspace)` helper that calls `workspace.activeAdapter.detect(workspace.targetRepoRoot)`" — and that the resolver was written to keep that seam clean (the resolver does NOT do stale-config detection itself, AC anti-pattern #2 in 1.2). This story implements exactly that helper. Don't fold it into the resolver.

### Files this story touches

**NEW:**
- `plugins/crew/mcp-server/src/state/validate-active-adapter.ts`
- `plugins/crew/mcp-server/tests/validate-active-adapter.test.ts`

**UPDATE (minimal — preserve existing surface):**
- `plugins/crew/mcp-server/src/errors.ts` — add `StaleWorkspaceConfigError` only. Do not touch the four classes already there (`DomainError`, `NotImplementedError`, `InvalidWorkspaceConfigError`, `NoAdapterMatchedError`, `AmbiguousAdapterError`).
- (Optional, only if Story 1.2 created a state barrel) `plugins/crew/mcp-server/src/state/index.ts` — append the re-export. If no barrel exists, skip.

**MUST NOT touch:**
- `plugins/crew/mcp-server/src/state/workspace-resolver.ts` — the resolver's contract is fixed by Story 1.2. Stale-config logic does **not** belong inside it.
- `plugins/crew/mcp-server/src/schemas/workspace-config.ts` — the schema is settled.
- `plugins/crew/mcp-server/src/adapters/*` — no adapter contract changes. The helper uses `PlanningAdapter.detect` exactly as Story 1.2 defined it.
- `plugins/crew/mcp-server/src/server.ts`, `index.ts` — no tool registration in this story.
- `plugins/crew/mcp-server/tests/workspace-resolver.test.ts`, `tests/smoke.test.ts` — must still pass unchanged.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other status/state file — the orchestrator owns status transitions.
- Anything under `plugins/sprint-orchestrator/` — retired (2026-05-19).

### Architecture compliance — what is pinned

| Concern | Pin | Source |
|---|---|---|
| Stale-config check fires on **every** skill invocation | Helper is called by skills (Epic 2+ and Story 1.7), once per invocation, after `resolveWorkspace` | architecture/planning-adapter-model.md §First-use detection (line 129), epic-1 AC1 for Story 1.2b |
| `detect()` is the contract used | `PlanningAdapter.detect(targetRepo: string): Promise<boolean>` | architecture/planning-adapter-model.md (line 21), Story 1.2's adapter contract |
| Helper location | `mcp-server/src/state/validate-active-adapter.ts` (sits alongside `workspace-resolver.ts` in the same `state/` directory) | architecture/project-structure-boundaries.md §Plugin tree (state/ contains workspace primitives, line 100) |
| Error type | New `StaleWorkspaceConfigError extends DomainError` — *not* a reused `InvalidWorkspaceConfigError` (the config parsed fine; it's just no longer a match) | Story 1.2 anti-pattern #6: prefer distinct subclasses over discriminator strings |
| Helper is pure inspector | No state writes, no telemetry, no git wrapper, no MCP tool registration | architecture/core-architectural-decisions.md §State-machine ownership (telemetry/state lands in 1.4–1.6) |
| Identity-preserving on success | `validateActiveAdapter(ws) === ws` when detect returns true (lets callers chain `await validateActiveAdapter(await resolveWorkspace(...))`) | This story (downstream skills call sites) |

### `StaleWorkspaceConfigError` — exact shape

```typescript
// addition to mcp-server/src/errors.ts

/**
 * The configured adapter's detect() returned false for the target repo.
 * The config parsed cleanly — it is just no longer (or never was) a match
 * for this repo. Typical cause: user copied example config into a repo
 * that doesn't fit. Distinct from InvalidWorkspaceConfigError (schema fail)
 * and NoAdapterMatchedError (no config + no detect match).
 */
export class StaleWorkspaceConfigError extends DomainError {
  readonly targetRepoRoot: string;
  readonly configuredAdapter: string;
  readonly otherMatchingAdapters: string[];
  readonly schemaModule: string;

  constructor(opts: {
    targetRepoRoot: string;
    configuredAdapter: string;
    otherMatchingAdapters: string[];
    schemaModule: string;
  }) {
    const redirect =
      opts.otherMatchingAdapters.length > 0
        ? `Other registered adapters that recognise this repo: ` +
          `[${opts.otherMatchingAdapters.join(", ")}]. ` +
          `Update the 'adapter:' key in .crew/config.yaml.`
        : `No other registered adapter recognises this repo either. ` +
          `See ${opts.schemaModule} and the canonical example in ` +
          `plugins/crew/example/.crew/config.yaml.`;
    super(
      `Configured adapter '${opts.configuredAdapter}' returned detect()=false ` +
        `for ${opts.targetRepoRoot}. ${redirect}`,
    );
    this.targetRepoRoot = opts.targetRepoRoot;
    this.configuredAdapter = opts.configuredAdapter;
    this.otherMatchingAdapters = opts.otherMatchingAdapters;
    this.schemaModule = opts.schemaModule;
  }
}
```

The exact wording is load-bearing — Story 1.7 (`/status`) and the README install path will reference these phrasings. Commit to them.

### `validateActiveAdapter` — signature and shape

```typescript
// mcp-server/src/state/validate-active-adapter.ts
import type { PlanningAdapter } from "../adapters/adapter.js";
import { adapters as registryAdapters } from "../adapters/registry.js";
import { StaleWorkspaceConfigError } from "../errors.js";
import type { Workspace } from "./workspace-resolver.js";

const SCHEMA_MODULE = "mcp-server/src/schemas/workspace-config.ts";

export interface ValidateActiveAdapterOptions {
  /** Override registered adapters. Test seam; defaults to the live registry. */
  adapters?: PlanningAdapter[];
}

/**
 * Verify that the workspace's configured adapter still recognises the
 * target repo. Intended to be called by every skill, once per invocation,
 * immediately after `resolveWorkspace` and before any other work.
 *
 * Returns the same Workspace reference on success (identity-preserving),
 * so callers can chain: `await validateActiveAdapter(await resolveWorkspace(...))`.
 *
 * Throws StaleWorkspaceConfigError if the configured adapter rejects the
 * repo. The error message redirects the user to another matching adapter
 * if one exists, otherwise points at the schema and canonical example.
 */
export async function validateActiveAdapter(
  workspace: Workspace,
  opts?: ValidateActiveAdapterOptions,
): Promise<Workspace> {
  // ... implementation per Task 2 algorithm
}
```

### Error message shape — make these helpful

The user sees this error verbatim through `/status` and every other skill. Aim for one line, no jargon. Examples (matching Task 1's pinned wording):

- **Redirect case (AC2):**
  `Configured adapter 'bmad' returned detect()=false for /Users/jack/projects/foo. Other registered adapters that recognise this repo: [native]. Update the 'adapter:' key in .crew/config.yaml.`
- **Schema-rewrite case (AC3):**
  `Configured adapter 'bmad' returned detect()=false for /Users/jack/projects/foo. No other registered adapter recognises this repo either. See mcp-server/src/schemas/workspace-config.ts and the canonical example in plugins/crew/example/.crew/config.yaml.`

### Library / framework requirements

| Lib | Version | Use in this story |
|---|---|---|
| `vitest` | `^2.1.0` (pinned in 1.1) | test runner |
| `node:fs/promises`, `node:path` | stdlib | not needed in helper; tests don't touch disk |

**No new runtime deps.** No Zod usage in this story (the schema work was 1.2's). No `yaml` usage (no config read/write). `pnpm-lock.yaml` must remain unchanged.

**Use Context7** only if the dev needs to confirm `vitest`'s current `expect(...).rejects.toThrow(ErrorClass)` matcher signature; everything else is settled.

### File structure requirements

```
plugins/crew/
└── mcp-server/
    ├── src/
    │   ├── errors.ts                              # UPDATED — adds StaleWorkspaceConfigError
    │   └── state/
    │       ├── workspace-resolver.ts              # UNCHANGED (Story 1.2)
    │       └── validate-active-adapter.ts         # NEW
    └── tests/
        ├── smoke.test.ts                          # UNCHANGED (Story 1.1)
        ├── workspace-resolver.test.ts             # UNCHANGED (Story 1.2)
        └── validate-active-adapter.test.ts        # NEW
```

Stay within this list. Anything else is scope creep.

### Testing requirements

- All three sub-tests are unit-level vitest, in-process, no subprocess transport, **no disk fixtures**. The helper takes a `Workspace` as input — the test constructs synthetic workspaces directly.
- The test file must import from source paths using `.js` extensions (NodeNext): `import { validateActiveAdapter } from "../src/state/validate-active-adapter.js"` and `import { StaleWorkspaceConfigError } from "../src/errors.js"`.
- `pnpm test` from `plugins/crew/` must continue to run the existing smoke + resolver suites unchanged, plus the new 3-test suite. Total: 11 tests, all green.
- Stub adapter shape (`makeStubAdapter`) must satisfy the full `PlanningAdapter` interface (including the `defaultConfig` and `adapterConfigSchema` members 1.2 added). Use a `z.object({}).passthrough()` (or `z.any()`) for `adapterConfigSchema` since the helper does not touch `adapter_config`.

### Anti-patterns to avoid (high-cost LLM mistakes)

1. **Do not fold this logic into `resolveWorkspace`.** The 1.2 resolver explicitly excludes stale-config detection (anti-pattern #2 in 1.2's Dev Notes). The whole point of this story is the separable helper. The resolver's contract is "parse + auto-detect-on-first-use only."
2. **Do not call this helper *inside* `resolveWorkspace`.** Callers (skills, later stories) chain them: `await validateActiveAdapter(await resolveWorkspace(...))`. If you wire it inside the resolver, every test in Story 1.2's suite breaks because the stub adapters there throw `NotImplementedError` from `detect()`.
3. **Do not re-parse `config.yaml`.** The `Workspace` argument is trusted. Schema validation is the resolver's job, not this helper's.
4. **Do not register an MCP tool.** No tool layer work in this story. Skills consume the helper directly. MCP-tool wiring lands in 1.4+.
5. **Do not invent a `WorkspaceValidator` class.** Single exported function, same convention as `resolveWorkspace`.
6. **Do not derive the target repo from `process.cwd()`.** The helper takes a `Workspace` whose `targetRepoRoot` is already absolute and trusted. (See project memory `feedback_pre_tool_use_hook_cwd_drift` — same lesson as 1.2.)
7. **Do not mutate the `Workspace` argument** (e.g. to attach a `validatedAt` timestamp). Telemetry stamping lands in Story 1.5; this story is a pure pass-through on success.
8. **Do not introduce a `kind: "stale" | "invalid" | "missing"` discriminator on a single `WorkspaceError` class.** Use the distinct `StaleWorkspaceConfigError` class. Story 1.2 set the precedent — three distinct error classes already exist for the resolver's three cases; this is the fourth in the same family.
9. **Do not call `detect()` on the configured adapter twice** (once for the happy-path check, once again as part of "all adapters"). Filter the configured adapter out of the cross-check set so each registered adapter runs `detect()` at most once per invocation. (Cheap defensiveness against expensive `detect()` implementations later.)
10. **Do not swallow errors thrown by `detect()`.** If an adapter's `detect()` itself throws (e.g. unexpected filesystem error), let it propagate. The helper's contract is "configured adapter returned `false`" → `StaleWorkspaceConfigError`. A thrown exception from inside `detect()` is a different failure class and should surface as-is.
11. **Do not write a `validateActiveAdapter` overload that takes `targetRepoRoot: string` instead of a `Workspace`.** The whole point is "after `resolveWorkspace`, before anything else." Forcing the caller to hand in the resolved workspace makes the chaining contract explicit.
12. **Do not modify `_bmad-output/implementation-artifacts/sprint-status.yaml` or any state/status file** as part of this implementation. The orchestrator owns status transitions; the dev's job is the code + tests.
13. **Do not wire the helper into Story 1.7's `/status`** as part of this story. That's 1.7's job. This story ships the helper and its unit tests only.

### Previous-story intelligence (Stories 1.1 and 1.2)

- **From 1.1:** `DomainError` is in `mcp-server/src/errors.ts` and uses `new.target.name` to set `error.name` automatically. Subclassing it gives you the class name on `error.name` for free — no manual assignment needed.
- **From 1.1:** TypeScript module resolution is `NodeNext`. Relative imports inside `src/` and `tests/` must end in `.js`, even when the source is `.ts`.
- **From 1.2:** `Workspace` is exported from `mcp-server/src/state/workspace-resolver.ts`. Import the type only — don't import `resolveWorkspace` itself into the helper (this helper sits *after* the resolver, never *inside* it).
- **From 1.2:** `PlanningAdapter` is exported from `mcp-server/src/adapters/adapter.ts`. The `detect(targetRepo: string): Promise<boolean>` signature is the one to call.
- **From 1.2:** `registry.ts` exports `adapters: PlanningAdapter[] = [BmadAdapter]`. The live registry is the default for the helper's `adapters` override, same pattern as the resolver.
- **From 1.2:** The resolver's vitest suite uses an inline `makeStubAdapter({ name, detectResult })` factory. Re-use the same pattern (duplicated or imported from the existing test file, depending on what 1.2 exported). Stubs must satisfy the full `PlanningAdapter` interface including `defaultConfig` and `adapterConfigSchema`.
- **From 1.2:** The `BmadAdapter`'s `detect()` still throws `NotImplementedError` (Story 3.3 owns the real implementation). Do **not** drive AC tests against the real `BmadAdapter` — use stubs only.
- **From 1.2:** The resolver's `Workspace` includes `targetRepoRoot` (absolute), `activeAdapterName`, `activeAdapter`, `adapterConfig`, `pluginSettings`. Reuse all five fields when constructing synthetic workspaces in tests — TypeScript will flag any omission.

### Files being modified — current state and what changes

- **`mcp-server/src/errors.ts` (UPDATE):**
  - Current state: exports `DomainError`, `NotImplementedError`, `InvalidWorkspaceConfigError`, `NoAdapterMatchedError`, `AmbiguousAdapterError`. Each constructor composes a user-facing one-line message in the `super(...)` call.
  - This story adds: `StaleWorkspaceConfigError extends DomainError` with the shape pinned in **Error message shape** above. Append it at the bottom of the file, after `AmbiguousAdapterError`. Match the existing JSDoc style.
  - Must preserve: every existing class, exact `super(...)` message wording (Story 1.2's tests assert on those strings).
- **`mcp-server/src/state/workspace-resolver.ts` (READ-ONLY for this story):**
  - Current state: exports `Workspace`, `ResolveWorkspaceOptions`, `resolveWorkspace`. Pure function, no module state. Auto-detects on first use (Branch A), validates on every subsequent call (Branch B).
  - This story changes: nothing. Import only the `Workspace` type.
  - Must preserve: every behaviour. The 1.2 test suite must continue to pass unchanged.
- **`mcp-server/src/adapters/adapter.ts` (READ-ONLY for this story):**
  - Current state: exports `PlanningAdapter` interface including `name: string`, `detect(targetRepo: string): Promise<boolean>`, `defaultConfig()`, `adapterConfigSchema`, plus the not-yet-implemented `readSourceStory`/`resolveSourcePath` methods.
  - This story changes: nothing. Use the interface as-is.

### Git intelligence

- Recent commits (`e3791eb`, `fe2c20f`, `d970559`, `6a93977`, `6d14fc5`) show: ship-story is the conventional flow; commits are scope-prefixed (`feat(1-2): …`); CI watch loop runs on PR creation; worktrees live inside the repo at `.worktrees/<key>/`.
- Conventional commit for this story: `feat(1-2b): stale-config detection helper` (subject ≤72 chars).
- The plugin tree under `plugins/crew/` is the only mutation surface. `pnpm-lock.yaml` should be untouched (no new deps).
- The previous story (1.2) shipped under `feat(1-2): workspace resolver + per-target-repo config schema (#53)` — reference its file layout patterns when in doubt.

### Latest tech information

- **`vitest`:** Use Context7 only if needed. `expect(promise).rejects.toThrow(ErrorClass)` is the standard async-rejection assertion. `expect(actual).toBe(expected)` is reference equality (used in AC4a to assert identity preservation).
- **`zod`:** Not used in this story. The helper does no schema validation.
- **`yaml` (eemeli):** Not used. The helper does no IO.
- **Node version:** Node 22 LTS, `module: NodeNext`. Relative imports end in `.js`.

### Project context reference

- **PM:** Jack. Frame trade-offs in PM language (`CLAUDE.md`). Tiny story, low risk — the only PM-visible signal is "every skill now catches mis-matched configs early instead of returning empty results silently."
- **PRD (authoritative):** `_bmad-output/planning-artifacts/prd-crew-v1.md`. This story closes the silent-empty-results onboarding hole. It is a precondition for the install-path checkpoint in Story 1.7 and for every Epic 2+ skill that reads source stories.
- **Architecture (load-bearing):**
  - `_bmad-output/planning-artifacts/architecture/planning-adapter-model.md` — adapter contract; `detect()` signature (line 21); first-use detection narrative (line 129); adapter-detection-ambiguity risk (line 148).
  - `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` — `state/` directory layout (line 100, `workspace-resolver.ts` already pinned there; new helper sits alongside).
  - `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md` — boundary ordering: workspace resolution before any skill work (line 115).
- **Story 1.2 (precondition):** delivered `resolveWorkspace`, the `Workspace` type, the typed-error precedent (`Invalid…`, `NoAdapterMatched`, `Ambiguous…`), and the stub-adapter test pattern. Read `_bmad-output/implementation-artifacts/1-2-workspace-resolver-and-per-target-repo-config.md` Dev Notes before starting.
- **Story 1.7 (downstream):** `/status` skill will be the first consumer of this helper. Don't ship 1.7's wiring as part of this story — but do ensure the helper's signature lets 1.7 chain `await validateActiveAdapter(await resolveWorkspace({ targetRepoRoot }))` without ceremony.
- **Sprint-orchestrator lesson (project memory `feedback_pre_tool_use_hook_cwd_drift`):** never derive the target repo from shell `cwd`. The helper takes a `Workspace` whose `targetRepoRoot` is already absolute.

### References

- [Source: _bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md#Story 1.2b: Stale-config detection on every skill invocation]
- [Source: _bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md#Story 1.2: Workspace resolver and per-target-repo config] (precondition)
- [Source: _bmad-output/planning-artifacts/architecture/planning-adapter-model.md#Adapter contract (line 21 — `detect` signature)]
- [Source: _bmad-output/planning-artifacts/architecture/planning-adapter-model.md#First-use detection narrative (line 129)]
- [Source: _bmad-output/planning-artifacts/architecture/planning-adapter-model.md#Adapter detection ambiguity risk (line 148)]
- [Source: _bmad-output/planning-artifacts/architecture/project-structure-boundaries.md#Plugin tree, state/ directory (line 100)]
- [Source: _bmad-output/planning-artifacts/architecture/core-architectural-decisions.md#Sequencing (line 115)]
- [Source: _bmad-output/implementation-artifacts/1-1-scaffold-the-plugin-skeleton.md] (precedent: file layout, error types, NodeNext module resolution)
- [Source: _bmad-output/implementation-artifacts/1-2-workspace-resolver-and-per-target-repo-config.md] (precedent: stub-adapter test pattern, `Workspace` type, typed-error precedent, the 1.2b seam-keeping note)
- [Source: CLAUDE.md — Jack is PM; talk in PM language; planning-discipline rules apply]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
