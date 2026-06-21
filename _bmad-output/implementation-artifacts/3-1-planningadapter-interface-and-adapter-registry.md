# Story 3.1: PlanningAdapter interface and adapter registry

story_shape: substrate

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **a `PlanningAdapter` TypeScript interface with the full shape pinned, plus an adapter registry that resolves the active adapter from workspace config (or first-run `detect()`)**,
so that **BMad, native, and future planning tools (Linear, GitHub Issues, plain-Markdown folders, …) can plug in behind one seam without any other code in the codebase changing.**

### What this story is, in one sentence

Bring `plugins/crew/mcp-server/src/adapters/adapter.ts` and `plugins/crew/mcp-server/src/adapters/registry.ts` into full conformance with the four ACs from the epic: add the missing `validateAgainstDiscipline` method to the `PlanningAdapter` interface, replace the `NotImplementedError`-throwing `getActiveAdapter()` stub with a real implementation that reads `adapter:` from `.crew/config.yaml`, returns the matching registered adapter or throws a typed `UnknownAdapterError`, falls back to `detect()` in registration order when no config exists (first match wins; ambiguity raises `AmbiguousAdapterError`), and pin all three branches (configured / detected / ambiguous) under a new vitest suite using two stub adapters.

### What this story fixes (and why it needs its own story)

Two pieces of debt have accumulated because Story 3.3 (BMad adapter, v1) landed before Story 3.1 was specced:

1. The `PlanningAdapter` interface at `plugins/crew/mcp-server/src/adapters/adapter.ts` is missing the `validateAgainstDiscipline` method that the epic AC pins ("…it declares `name`, `detect`, `listSourceStories`, `readSourceStory`, `resolveSourcePath`, optional `watchForChanges`, **and `validateAgainstDiscipline`**."). Story 3.5's planning-discipline validator will call this method; without it on the interface, every adapter (including the already-landed `BmadAdapter`) is structurally non-conforming and TS would fail to compile against 3.5's call site.
2. `plugins/crew/mcp-server/src/adapters/registry.ts` exports a `getActiveAdapter()` that throws `NotImplementedError("…lands in Story 3.1")`. The workspace resolver (Story 1.2) shipped its own resolver that pre-empts this surface for the config path, but the epic AC explicitly pins the registry method as the seam — and nothing in the codebase currently exposes the three-branch behaviour (configured / detected / ambiguous) at this entry point with `UnknownAdapterError` and `AmbiguousAdapterError`. Story 3.2's `scan-sources` and Story 3.5's discipline validator will both want to call `getActiveAdapter()` directly without re-running config parsing.

This story closes both gaps with the minimum-viable shape so 3.2, 3.4, and 3.5 can compile against a stable seam.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions. This story does not modify any file under `_bmad-output/implementation-artifacts/` other than authoring this spec at the path `3-1-planningadapter-interface-and-adapter-registry.md`.
- (b) Modify the BMad adapter's behaviour. Adding `validateAgainstDiscipline` to the interface requires adding a (default, no-op or simple-pass) method to `BmadAdapter` so it stays type-conformant — but the method body does NO real work in this story; the real validator lands in Story 3.5. The added method must be a thin pass-through that returns the input unmodified, with a TSDoc comment naming Story 3.5 as the owner of the real behaviour.
- (c) Re-implement workspace-config parsing. `resolveWorkspace()` in `plugins/crew/mcp-server/src/state/workspace-resolver.ts` already does this and is the canonical entrypoint when the caller has a `targetRepoRoot`. `getActiveAdapter()` in this story is a thinner, in-process accessor that operates against a registry list and a small input bag (`{ targetRepoRoot, configuredAdapterName? }`) — it does NOT re-read `.crew/config.yaml`; the caller is expected to have already resolved that and to pass `configuredAdapterName` when present.
- (d) Mutate `.crew/config.yaml`. The resolver already handles first-run config-write under Branch A; the registry does not.
- (e) Introduce a new MCP tool. The registry is internal; no `register_tool` call, no `server.ts` change.
- (f) Implement `validateAgainstDiscipline` itself. The method's full behaviour (integration-AC enforcement, explicit `depends_on`, ship-gate refusal, etc.) lands in Story 3.5. This story only pins the *signature* and provides a pass-through default body on `BmadAdapter`.
- (g) Implement `watchForChanges`. The contract leaves it optional; this story does NOT add it to `BmadAdapter`.
- (h) Rename, relocate, or remove `resolveWorkspace()` or `validateActiveAdapter()`. Those are owned by Stories 1.2 and 1.2b respectively and remain the canonical config-reading paths.
- (i) Add a `native` adapter or any native-related code. The `native` adapter is Story 3.4's territory.
- (j) Touch the `native/` directory if it already exists, or create it. (As of authoring this spec, `plugins/crew/mcp-server/src/adapters/native/` does not exist.)
- (k) Add new dependencies to `plugins/crew/mcp-server/package.json`.
- (l) Hand-edit `plugins/crew/mcp-server/dist/` — `pnpm --dir plugins/crew build` regenerates it; the dist-shipping contract from Story 1.9 still applies.
- (m) Modify `README.md`, `plugins/crew/README.md`, `plugins/crew/docs/README-install.md`, or any user-facing doc. This story has no user-facing surface.
- (n) Modify `plugins/crew/example/.crew/config.yaml` or any catalogue, persona, or permission spec file.

---

## Acceptance Criteria

> **Verbatim from epic.** The four ACs below match `_bmad-output/planning-artifacts/epics/epic-3-backlog-layer-planning-adapters-story-manifests-and-the-planning-conversation.md` § Story 3.1 exactly. None of the ACs names a slash command, a CLI literal the operator types verbatim, a README-named install path, or a Claude Code UI element — every AC governs an internal TypeScript interface file, an internal registry function, typed errors thrown across an internal seam, or vitest coverage. They are therefore **all untagged** per `plugins/crew/docs/user-surface-acs.md`. (Story shape is `substrate`; review-pass budget is 3.)

**AC1:**
**Given** the adapter interface at `mcp-server/src/adapters/adapter.ts`,
**When** I inspect it,
**Then** it declares `name`, `detect`, `listSourceStories`, `readSourceStory`, `resolveSourcePath`, optional `watchForChanges`, and `validateAgainstDiscipline`. _(Architecture §Planning Adapter Model)_
<!-- Not user-surface: the AC governs an internal TypeScript interface file under mcp-server/src/. No operator types this path or opens this file; no README references it as a copy target. Rubric (iii) requires the README/install docs to name the path; this path is implementation-internal. -->

**AC2:**
**Given** the adapter registry at `mcp-server/src/adapters/registry.ts`,
**When** the active adapter is requested,
**Then** it reads `adapter:` from workspace config and returns the matching registered adapter or fails with a typed `UnknownAdapterError`.
<!-- Not user-surface: AC2 names an internal registry function and a typed error class; both are TypeScript-internal surfaces consumed by other in-process code. -->

**AC3:**
**Given** a workspace config with no `adapter:`,
**When** the registry runs `detect()` across registered adapters in registration order,
**Then** the first match wins; ambiguity raises a typed `AmbiguousAdapterError` that surfaces to the user via the calling skill.
<!-- Not user-surface: the AC governs detect-order and a typed error that the calling skill is responsible for translating into operator copy. The skill itself (where the error reaches an operator) is Story 3.4's /plan and Story 3.2's /scan; this story owns only the typed-error production path. -->

**AC4 (integration):**
vitest covers the three branches (configured / detected / ambiguous) using two stub adapters.

<!-- Numeric AC count: 4. user-surface AC count: 0. story_shape: substrate → review-pass budget: 3. -->

---

## Tasks / Subtasks

- [ ] **Task 1 — Add `validateAgainstDiscipline` to the `PlanningAdapter` interface (AC: 1)**
  - [ ] 1.1 Edit `plugins/crew/mcp-server/src/adapters/adapter.ts`. Add a `validateAgainstDiscipline` method to the `PlanningAdapter` interface, positioned after `watchForChanges?` per the architecture's declared order (Architecture §Planning Adapter Model lists it as the trailing method).
  - [ ] 1.2 Signature: `validateAgainstDiscipline(story: SourceStory): SourceStory | DisciplineViolation;`. Both the input and the success return shape are the existing `SourceStory` type — the adapter returns the same story it received (pass-through identity) when discipline is satisfied. The failure return is a new exported type alias `DisciplineViolation = { kind: "discipline-violation"; ref: string; violations: DisciplineViolationReason[]; }` and `DisciplineViolationReason = { code: "missing-integration-ac" | "implicit-depends-on" | "missing-ship-gate"; field: string; detail: string; }`. The reason codes match the four enforcement paths Story 3.5 will implement (the fourth — adapter source-side enforcement — is also `missing-integration-ac` from the adapter's perspective). Story 3.5 will expand `DisciplineViolationReason["code"]` to cover its full enumeration; the union shape is intentionally narrow now so 3.5 can widen it without breaking existing callers.
  - [ ] 1.3 The method is **synchronous** (returns a `SourceStory | DisciplineViolation`, not a `Promise<…>`). Rationale: discipline checks operate on already-normalised `SourceStory` objects in memory; no I/O is required. Story 3.5's implementation can still be tested off the synchronous boundary.
  - [ ] 1.4 Add a TSDoc block on the new method naming Story 3.5 as the owner of real enforcement, and pointing readers at `_bmad-output/planning-artifacts/epics/epic-3-...md § Story 3.5`. The TSDoc must explicitly state: "Adapters that have not yet implemented real discipline checks return the input story unchanged. This is the default conformant behaviour. Story 3.5 lands the real validator for each adapter."
  - [ ] 1.5 Export `DisciplineViolation` and `DisciplineViolationReason` from `adapter.ts` so Story 3.5 (and the registry tests in this story) can import them.
  - [ ] 1.6 Do NOT change the existing `name`, `detect`, `listSourceStories`, `readSourceStory`, `resolveSourcePath`, `watchForChanges?`, `defaultConfig`, or `adapterConfigSchema` declarations. The PRD audit (`grep -n "interface PlanningAdapter" plugins/crew/mcp-server/src/adapters/`) MUST continue to find exactly one definition.

- [ ] **Task 2 — Wire `validateAgainstDiscipline` pass-through into `BmadAdapter` (AC: 1)**
  - [ ] 2.1 Edit `plugins/crew/mcp-server/src/adapters/bmad/index.ts`. Add a `validateAgainstDiscipline` method to the `BmadAdapter` object whose body is `return story;` (literal pass-through). No other change to `BmadAdapter`.
  - [ ] 2.2 The TSDoc on this method must reference Story 3.5 and explicitly state it is a placeholder that satisfies the interface contract: "Real BMad discipline validation lands in Story 3.5. This pass-through keeps `BmadAdapter` type-conformant against Story 3.1's expanded interface."
  - [ ] 2.3 Do NOT add a real validation pass here. Story 3.5 owns that work and its own tests; surreptitiously implementing it now would entangle the two stories.
  - [ ] 2.4 The existing `BmadAdapter` test suite (`plugins/crew/mcp-server/tests/bmad-adapter.test.ts`) must continue to pass without modification after this change. If it doesn't (because, e.g., the suite asserts the exact set of keys on `BmadAdapter`), update the assertion to include the new method name — but do NOT add new behavioural assertions about the pass-through in that suite; the registry tests in Task 5 own that coverage.

- [ ] **Task 3 — Implement `getActiveAdapter()` in `registry.ts` (AC: 2, 3, 4)**
  - [ ] 3.1 Edit `plugins/crew/mcp-server/src/adapters/registry.ts`. Replace the `NotImplementedError`-throwing `getActiveAdapter()` body with a real implementation.
  - [ ] 3.2 Signature:

    ```typescript
    export interface GetActiveAdapterOptions {
      targetRepoRoot: string;
      /** Pre-resolved value of `adapter:` from .crew/config.yaml, if any. */
      configuredAdapterName?: string;
      /** Override the registry. Test seam; defaults to the live `adapters` array. */
      adapters?: PlanningAdapter[];
    }

    export async function getActiveAdapter(
      opts: GetActiveAdapterOptions,
    ): Promise<PlanningAdapter>;
    ```

    The function is `async` because it must `await` each registered adapter's `detect()` in the no-config branch. The configured branch resolves synchronously but still returns a `Promise<PlanningAdapter>` so callers have a single await shape.
  - [ ] 3.3 Behaviour:
    - **Branch A — `configuredAdapterName` is provided:** find the adapter in `adapters` whose `name` matches. If found, return it. If not found, throw the new typed `UnknownAdapterError` (Task 4). Do NOT consult `detect()` in this branch — the caller already committed to a name; respect that commitment.
    - **Branch B — `configuredAdapterName` is absent:** invoke `detect(targetRepoRoot)` on each registered adapter **in registration order** (i.e. iterate `adapters` left-to-right, awaiting each `detect()` before moving to the next). The architecture pins "first match wins"; the registry MUST short-circuit on the first `true` and return that adapter without invoking subsequent adapters' `detect()`. Rationale: a later adapter's `detect()` might be costly (filesystem walk, network); preserve the registration order's semantic of "I trust earlier adapters first".
    - **Ambiguity in Branch B:** the registry must still consult ALL registered adapters to detect ambiguity — but only when the first match is found. Hmm, this contradicts the short-circuit above. Resolve as: **do NOT short-circuit.** The four-AC contract explicitly names "ambiguity raises a typed `AmbiguousAdapterError`"; ambiguity can only be observed by consulting every adapter. So iterate all adapters in registration order, collect the set of matches, then: zero matches → throw `NoAdapterMatchedError` (re-using the existing typed error from `errors.ts`); one match → return it; ≥2 matches → throw `AmbiguousAdapterError` (re-using the existing typed error). The "first match wins" phrasing in the AC is preserved by the ambiguity-throws-instead semantics: when ambiguity does NOT obtain, the first (and only) match wins. **Document this resolution explicitly in a TSDoc block on `getActiveAdapter` so a future maintainer doesn't try to "fix" the no-short-circuit by adding one.**
    - The detect calls MAY run in parallel (`Promise.all`) for performance, since order matters only for the ambiguity report. If parallel, the resulting `matches` array MUST still be ordered by registration index; preserve order by mapping detect-results back to their input index before filtering.
  - [ ] 3.4 Throws (typed, all from `mcp-server/src/errors.ts`):
    - `UnknownAdapterError` — new error class, added in Task 4. Thrown when a configured `adapter:` name doesn't match any registered adapter.
    - `AmbiguousAdapterError` — already exists in `errors.ts`. Thrown when no config exists and ≥2 adapters' `detect()` returns `true`.
    - `NoAdapterMatchedError` — already exists in `errors.ts`. Thrown when no config exists and zero adapters' `detect()` returns `true`. The epic AC does not explicitly name this branch — but the function must not return `undefined` and re-throwing a generic `Error` would violate the "typed errors" convention. Use the existing `NoAdapterMatchedError`.
  - [ ] 3.5 Add a TSDoc block on `getActiveAdapter` that:
    - Names the four typed errors it can throw.
    - States the no-short-circuit ambiguity rule from 3.3.
    - Cross-references `resolveWorkspace()` as the canonical config-reading path: "Most callers should use `resolveWorkspace()` (Story 1.2), which parses `.crew/config.yaml` and returns a fully-populated `Workspace`. Use `getActiveAdapter()` directly only when the caller has already resolved the configured adapter name (or wants the no-config detect-only path) and just needs the adapter instance."
  - [ ] 3.6 The existing `export const adapters: PlanningAdapter[] = [BmadAdapter];` stays. Do NOT reorder the array; Story 3.4 will append `NativeAdapter` later. Registration order is load-bearing per 3.3.

- [ ] **Task 4 — Add `UnknownAdapterError` to `errors.ts` (AC: 2)**
  - [ ] 4.1 Edit `plugins/crew/mcp-server/src/errors.ts`. Add a new `UnknownAdapterError` class extending `DomainError`. The class must follow the existing pattern in this file (see `NoAdapterMatchedError`, `AmbiguousAdapterError` for the closest precedents): structured constructor opts, `readonly` fields for the salient context, a human-readable composed `message`.
  - [ ] 4.2 Constructor opts: `{ configuredAdapterName: string; registeredAdapterNames: string[]; configPath: string; }`. Stored as readonly fields with the same names.
  - [ ] 4.3 Composed message: `` `'.crew/config.yaml' declares adapter '${configuredAdapterName}' at ${configPath}, but no adapter with that name is registered. Registered adapters: [${registeredAdapterNames.join(", ")}]. Either install the matching adapter or edit the 'adapter:' key in ${configPath}.` ``. Match the tone of the other adapter errors — terse, names the offending field, names the corrective action.
  - [ ] 4.4 Export `UnknownAdapterError` from `errors.ts`. Confirm by `grep -n "export class UnknownAdapterError" plugins/crew/mcp-server/src/errors.ts` after the edit returns exactly one hit.
  - [ ] 4.5 Do NOT modify the existing `NoAdapterMatchedError` or `AmbiguousAdapterError` classes. They are already shaped correctly for their roles.
  - [ ] 4.6 The MCP tool layer / calling skill is responsible for surfacing this error to the operator with its full message. This story does not touch the surfacing layer.

- [ ] **Task 5 — Vitest coverage of the three branches (AC: 4)**
  - [ ] 5.1 Add a new test file `plugins/crew/mcp-server/tests/adapter-registry.test.ts`. Style: vitest `describe` / `it` / `expect`, ESM imports with `.js` extension (NodeNext resolution), `import.meta.url`-derived `__dirname` if any filesystem assertions are needed (the registry tests in this story do NOT need fs; see 5.4). The closest precedent is `plugins/crew/mcp-server/tests/validate-active-adapter.test.ts` — match its stub-adapter pattern verbatim.
  - [ ] 5.2 Define a `makeStubAdapter({ name, detectResult })` helper at the top of the file that returns a `PlanningAdapter` whose `detect` returns `detectResult`, and whose other methods throw `NotImplementedError` (matching `validate-active-adapter.test.ts`'s pattern). Critically, the helper MUST also stub `validateAgainstDiscipline` to a pass-through `(story) => story` — this is the new interface method from Task 1 and must be present on the stub for the stub to be type-conformant.
  - [ ] 5.3 The test suite must have exactly these `it` blocks (one per epic-AC branch plus the unknown-adapter branch from AC2):
    - **`AC2 / configured branch — match`**: stubs `[stubA, stubB]`; `getActiveAdapter({ targetRepoRoot: "/tmp/anything", configuredAdapterName: "stubB", adapters: [stubA, stubB] })` resolves to `stubB`. Assert: returns the same reference (`expect(result).toBe(stubB)`), `stubA.detect` was NOT called, `stubB.detect` was NOT called.
    - **`AC2 / configured branch — unknown name throws UnknownAdapterError`**: stubs `[stubA, stubB]`; calling with `configuredAdapterName: "stubMissing"` rejects with `UnknownAdapterError`. Assert: error is `instanceof UnknownAdapterError`, `error.configuredAdapterName === "stubMissing"`, `error.registeredAdapterNames` equals `["stubA", "stubB"]`, error message contains both `"stubMissing"` and `"stubA"`.
    - **`AC3 / detect branch — single match wins`**: stubs `[stubA(detect=false), stubB(detect=true), stubC(detect=false)]`; `getActiveAdapter({ targetRepoRoot: "/tmp/anything", adapters: [stubA, stubB, stubC] })` (no `configuredAdapterName`) resolves to `stubB`. Assert: all three `detect()` were called exactly once (no-short-circuit semantic from Task 3.3).
    - **`AC3 / detect branch — ambiguity throws AmbiguousAdapterError`**: stubs `[stubA(detect=true), stubB(detect=true)]`; same call shape. Rejects with `AmbiguousAdapterError`. Assert: `error.matchingAdapters` equals `["stubA", "stubB"]` (preserves registration order), error message names both.
    - **`detect branch — zero matches throws NoAdapterMatchedError`**: stubs `[stubA(detect=false), stubB(detect=false)]`; same call shape. Rejects with `NoAdapterMatchedError`. Assert: error type matches; `error.registeredAdapters` equals `["stubA", "stubB"]`.
  - [ ] 5.4 The tests do NOT touch the filesystem. `targetRepoRoot: "/tmp/anything"` is a placeholder string the stubs ignore in their `detect()` bodies. Do NOT create real directories; do NOT call `resolveWorkspace()`. The registry is the unit under test.
  - [ ] 5.5 The detect-call-count assertion in the `single match wins` test requires the stubs to track call counts. Add a `let callCount = 0; detect: async () => { callCount++; return detectResult; }` shape (similar to `validate-active-adapter.test.ts`'s call-counter pattern) — or restructure `makeStubAdapter` to expose a `callCount` accessor. Either pattern is acceptable; pick the one that reads cleanly.
  - [ ] 5.6 Run `pnpm --dir plugins/crew test` and confirm the new suite passes alongside every existing suite. Zero new skips, zero new flakes. Specifically confirm:
    - `validate-active-adapter.test.ts` still passes (Task 1's interface change adds a method; the suite's stub helper at line 8–31 already declares stubs without `validateAgainstDiscipline` — those stubs will become non-conformant. **Update them** by adding `validateAgainstDiscipline: (s: SourceStory) => s` to the stub builder. This is the only change permitted to `validate-active-adapter.test.ts`.)
    - `bmad-adapter.test.ts` still passes (Task 2 added a method; if the suite asserts the precise set of keys on `BmadAdapter`, extend the assertion to include the new key).
    - `validate-active-adapter.test.ts`'s call-graph isn't affected by adding `validateAgainstDiscipline` to the stubs — the existing tests don't call `validateAgainstDiscipline`.

- [ ] **Task 6 — Conformance audit of existing adapter consumers**
  - [ ] 6.1 `grep -rn "PlanningAdapter" plugins/crew/mcp-server/src plugins/crew/mcp-server/tests` and verify every site that constructs a `PlanningAdapter` object literal (mostly test files using ad-hoc stubs) is updated to declare `validateAgainstDiscipline`. The expected hit list as of authoring this spec: `adapter.ts` (the definition), `registry.ts` (uses the type), `bmad/index.ts` (implements it — Task 2 adds the missing method), `state/workspace-resolver.ts` (uses the type as a return shape — no method addition needed), `state/validate-active-adapter.ts` (uses the type), and the test files `validate-active-adapter.test.ts` and any other suite that builds an ad-hoc stub.
  - [ ] 6.2 For every test file that constructs an ad-hoc `PlanningAdapter` stub (object literal cast to `PlanningAdapter` or implementing the interface directly), add `validateAgainstDiscipline: (s) => s` (pass-through) and any other missing methods. Do NOT modify behavioural assertions in those tests; the only change is structural conformance.
  - [ ] 6.3 If any test stub also lacks `defaultConfig` or `adapterConfigSchema` (added by Story 1.2), add those too in the same pass — pick the minimum-viable values: `defaultConfig: () => ({})` and `adapterConfigSchema: z.record(z.string(), z.unknown())`.
  - [ ] 6.4 Run `pnpm --dir plugins/crew typecheck` (or `tsc --noEmit` via the existing script) and confirm zero TypeScript errors after the interface change.

- [ ] **Task 7 — Rebuild and commit dist (Story 1.9 contract)**
  - [ ] 7.1 Run `pnpm --dir plugins/crew build` from the plugin root after all source changes. The committed `dist/` must reflect the new source.
  - [ ] 7.2 `git add plugins/crew/mcp-server/dist/`. CI's `git diff --exit-code mcp-server/dist` step (Story 1.9, Story 8741e80/52cdf1b) will fail the PR otherwise.
  - [ ] 7.3 Confirm by `git status` that the staged changes include: `adapter.ts` (interface change), `registry.ts` (real impl), `errors.ts` (new error class), `bmad/index.ts` (pass-through method), new `tests/adapter-registry.test.ts`, any conformance-only edits to other test files, and the rebuilt `plugins/crew/mcp-server/dist/` tree. Nothing under `_bmad-output/implementation-artifacts/` should be staged (other than this spec itself, which the orchestrator handles).

- [ ] **Task 8 — Self-check before handoff**
  - [ ] 8.1 `pnpm --dir plugins/crew test` — all suites green.
  - [ ] 8.2 `pnpm --dir plugins/crew typecheck` — zero errors.
  - [ ] 8.3 `pnpm --dir plugins/crew build` — clean build, `dist/` updated.
  - [ ] 8.4 `grep -n "validateAgainstDiscipline" plugins/crew/mcp-server/src/adapters/adapter.ts` returns exactly one hit (the interface declaration).
  - [ ] 8.5 `grep -n "validateAgainstDiscipline" plugins/crew/mcp-server/src/adapters/bmad/index.ts` returns at least one hit (the implementation).
  - [ ] 8.6 `grep -n "UnknownAdapterError" plugins/crew/mcp-server/src/errors.ts` returns the class declaration; `grep -rn "UnknownAdapterError" plugins/crew/mcp-server/src plugins/crew/mcp-server/tests` returns at least three hits (declaration, throw site in `registry.ts`, test usage).
  - [ ] 8.7 No file under `_bmad-output/implementation-artifacts/` other than this spec is touched. No file under `_bmad-output/planning-artifacts/` is touched.

---

## Dev Notes

### Why this story is sequenced AFTER Story 3.3 in the actual development order (even though it's numbered 3.1)

Story 3.3 (BMad adapter v1) was authored and shipped before this story was specced. The interface and registry scaffolding it relied on already exist in `plugins/crew/mcp-server/src/adapters/` — but with two gaps the epic AC explicitly pins:

1. The interface is missing `validateAgainstDiscipline` (AC1's enumerated list).
2. The registry's `getActiveAdapter()` is a `NotImplementedError` stub (AC2, AC3).

This story's job is to backfill those two surfaces without disturbing the live BMad adapter, the live workspace resolver, or any in-flight downstream work (Story 3.2's `scan-sources`, Story 3.5's discipline validator). The sequencing inversion is deliberate: Story 3.3 was the load-bearing first-light proof that the seam works; this story locks the seam against the epic AC contract before 3.2/3.4/3.5 build on top.

### Why the no-short-circuit ambiguity rule

The epic AC3 phrases the detect branch as "the first match wins; ambiguity raises a typed `AmbiguousAdapterError`". Reading literally, "first match wins" suggests short-circuit on first true. But ambiguity detection by definition requires consulting every adapter — you can't detect a second match if you stopped on the first. The semantically sound resolution is: iterate all adapters; if exactly one matches, return it (the "first" — really "only" — match); if zero or ≥2 match, throw the typed errors.

The performance cost is small: `detect()` is a cheap filesystem check (BMad: one `readdir` of `_bmad-output/planning-artifacts/stories`; native: one `stat` of `.crew/native-stories`; future adapters: comparable). Running them in parallel via `Promise.all` (Task 3.3 explicitly permits this) costs at most one round-trip's worth of latency per detect call.

The TSDoc block on `getActiveAdapter` MUST document this resolution explicitly so a future maintainer doesn't "optimise" by adding a short-circuit and accidentally hide ambiguity bugs.

### Why `validateAgainstDiscipline` is sync and pass-through here

The architecture document does not pin a signature for `validateAgainstDiscipline` (the interface block at planning-adapter-model.md:18–26 doesn't list it; the architecture treats it as part of the "trailing" set the adapter exposes). Story 3.5 is the owner of the real behaviour. This story pins the *minimum-viable* signature so 3.5 has something to implement against and 3.3's `BmadAdapter` stays type-conformant.

The choice of synchronous-returns-`SourceStory | DisciplineViolation` (rather than `async` throwing on violation) is deliberate:

- **Sync because no I/O.** The validator operates on already-normalised `SourceStory` objects in memory. No file reads, no network. Synchronous returns are clearer to test and easier for callers to compose (no `await` ladder when a tool needs to validate a batch of stories).
- **Return a discriminated union, not throw.** Discipline violations are an *expected* outcome of validation — Story 3.5's planner refuses-to-commit-on-violation is the load-bearing UX, and the planner needs to inspect *which* violations occurred to surface them to the user. Throwing would discard that structure. The discriminated union (`SourceStory | DisciplineViolation`) is the cleanest TypeScript pattern for "either valid or invalid with structured reason".

Story 3.5 can widen `DisciplineViolationReason["code"]` without breaking this story's contract because that union is open-ended-by-design — adding string-literal members is a non-breaking change.

### Why this story does NOT re-read `.crew/config.yaml`

`resolveWorkspace()` (Story 1.2) is the canonical config-reading path. It parses the YAML, validates it against `WorkspaceConfigSchema`, validates the adapter-specific `adapter_config` block against the adapter's own Zod schema, applies plugin-settings defaults, and returns a fully-populated `Workspace`. Adding a second config-read inside `getActiveAdapter()` would (a) duplicate that work, (b) introduce a divergence risk (the two paths could disagree about what "the configured adapter name" is), and (c) couple the registry to YAML parsing — which it has no business knowing about.

The seam is: `resolveWorkspace()` does the config-reading and returns a `Workspace` that already includes the `activeAdapter` instance. `getActiveAdapter()` is for callers who DON'T have a `Workspace` in hand — typically because they want the no-config detect-only path (e.g. an init-time check) or they have the configured name from elsewhere (e.g. a CLI flag in a hypothetical future). The TSDoc cross-reference (Task 3.5) makes this clear.

Could `resolveWorkspace()` internally delegate to `getActiveAdapter()`? Yes, and a future refactor might do exactly that. This story does NOT do that refactor — it's a one-line change but risks destabilising every test that depends on `resolveWorkspace()`'s current behaviour. Keep the surfaces independent for now; consolidate later if/when both paths grow more behaviour.

### What `validate-active-adapter.test.ts` will need

The existing test file at `plugins/crew/mcp-server/tests/validate-active-adapter.test.ts` constructs a `PlanningAdapter` stub via `makeStubAdapter` (lines 8–31). That stub does NOT currently declare `validateAgainstDiscipline`. After Task 1 lands, the stub is structurally non-conformant against the widened interface — TypeScript will reject every `makeStubAdapter` call site.

The fix is one line in the stub helper: add `validateAgainstDiscipline: (s: SourceStory) => s,` to the returned object literal. This is a conformance-only change; the existing tests' behavioural assertions are unaffected.

Additionally, the inline stubs at lines 112–151 of `validate-active-adapter.test.ts` (the `AC1` test's hand-rolled adapter objects) need the same treatment. They are slightly more verbose because they were inlined for the call-counting assertion; the fix is the same one-line addition.

### What `bmad-adapter.test.ts` and other tests will need

Audit during Task 6: any test that builds an ad-hoc `PlanningAdapter` (object literal cast to the interface, or `as PlanningAdapter`) needs the same one-line pass-through addition. As of authoring this spec, the candidate files are:

- `plugins/crew/mcp-server/tests/validate-active-adapter.test.ts` (covered above)
- `plugins/crew/mcp-server/tests/bmad-adapter-acceptance.test.ts` (small file; likely uses the real `BmadAdapter` rather than a stub — verify and only edit if it stubs)
- Any other test that imports `PlanningAdapter` directly

Do NOT add `validateAgainstDiscipline` to tests that import the real `BmadAdapter` — Task 2 makes the real adapter conformant.

### What's NEW vs UPDATE

**NEW files:**
- `plugins/crew/mcp-server/tests/adapter-registry.test.ts` — Task 5's vitest suite.

**UPDATE files:**
- `plugins/crew/mcp-server/src/adapters/adapter.ts` — add `validateAgainstDiscipline` to the interface; export `DisciplineViolation` and `DisciplineViolationReason` types. The existing interface fields, the `AC`, `SourceStory`, and `ChangeEvent` type exports are unchanged.
- `plugins/crew/mcp-server/src/adapters/registry.ts` — replace `getActiveAdapter()` stub with real implementation; add `GetActiveAdapterOptions` interface. The `adapters` array export is unchanged in shape and contents.
- `plugins/crew/mcp-server/src/adapters/bmad/index.ts` — add a `validateAgainstDiscipline` pass-through method to the `BmadAdapter` object. Nothing else.
- `plugins/crew/mcp-server/src/errors.ts` — add `UnknownAdapterError`. Other classes unchanged.
- `plugins/crew/mcp-server/tests/validate-active-adapter.test.ts` — add `validateAgainstDiscipline: (s) => s` to the stub helper and to the two hand-rolled stubs in the `AC1` test. **No other change.**
- `plugins/crew/mcp-server/dist/**` — rebuilt by `pnpm build`, committed per Story 1.9.

**MUST NOT TOUCH:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- Any other spec under `_bmad-output/implementation-artifacts/` (no cross-story spec edits).
- `_bmad-output/planning-artifacts/**` — read-only.
- `plugins/crew/mcp-server/src/state/workspace-resolver.ts` — owned by Story 1.2. The resolver's behaviour does not change.
- `plugins/crew/mcp-server/src/state/validate-active-adapter.ts` — owned by Story 1.2b. The validator's behaviour does not change.
- `plugins/crew/mcp-server/src/adapters/bmad/parse-bmad-story.ts` — owned by Story 3.3.
- `plugins/crew/mcp-server/src/adapters/bmad/map-bmad-status.ts` — owned by Story 3.3.
- `plugins/crew/mcp-server/src/adapters/bmad/fixtures/**` — owned by Story 3.3.
- `plugins/crew/mcp-server/src/tools/**` — no new tools, no edits to existing tools.
- `plugins/crew/mcp-server/src/schemas/workspace-config.ts` — config schema unchanged.
- `plugins/crew/mcp-server/src/server.ts` — server registration unchanged.
- `plugins/crew/mcp-server/package.json` — no new deps.
- `plugins/crew/.claude-plugin/plugin.json`, `marketplace.json`, plugin manifests.
- `plugins/crew/catalogue/**`, `plugins/crew/permissions/**`, `plugins/crew/skills/**` — no role, permission, or skill change.
- `plugins/crew/example/**` — example workspace unchanged.
- `README.md`, `plugins/crew/README.md`, `plugins/crew/docs/README-install.md`, `plugins/crew/docs/user-surface-acs.md` — no user-facing doc change.
- `.claude/skills/**`, `_bmad/**` — third-party / planning tool internals.
- The repo-root `CLAUDE.md` — no PM-facing process change in this story.

### Why no `watchForChanges` here

The contract leaves `watchForChanges` optional. Story 3.2 will use polling on skill invoke as the v1 change-detection mechanism. Adding a watcher to `BmadAdapter` would (a) add a dep (`chokidar` or similar), (b) duplicate work 3.2's polling does correctly, (c) introduce a long-lived background concern the MCP server's request/response model doesn't need. Defer.

### Why parallel `Promise.all` is permitted but not required for detect

Performance is not the load-bearing concern (detect runs at most once per first-skill-invocation per session). Clarity is. If a developer finds the sequential `for…of` loop more readable, that's also fine — the AC says nothing about parallelism, just about ordering of the resulting `matches` array. Pick whichever shape is simpler in the implementation file; document the choice with a one-line comment.

### Why we keep `NoAdapterMatchedError` even though the epic AC doesn't name it

The AC3 says "first match wins; ambiguity raises `AmbiguousAdapterError`" — silent about the zero-match branch. But `getActiveAdapter()` must return *something* or throw; returning `undefined` (a) breaks the `Promise<PlanningAdapter>` return type, (b) pushes a `null`-check responsibility onto every caller, (c) drops the structured error context the operator needs to fix the situation (which adapters were tried, what target repo was checked). The existing `NoAdapterMatchedError` in `errors.ts` already carries exactly that context, so reuse it. This is consistent with how `resolveWorkspace()` already handles the zero-match branch.

### Testing standards

- vitest, run via `pnpm --dir plugins/crew test`. The new `adapter-registry.test.ts` joins the existing suites; it does NOT replace `validate-active-adapter.test.ts` (which tests a different surface — the *post-config* validation gate, not the *pre-config* registry resolution).
- Match the stub-adapter pattern from `validate-active-adapter.test.ts`. Do NOT introduce a separate stub-building library; one local helper per test file is the convention.
- `Promise.all` parallelism in `getActiveAdapter()` makes call-order assertions tricky. The "single match wins" test asserts call *count* (3 calls, one per adapter), not call *order*. If a future test needs call-order, switch the registry implementation to sequential `for…of` and document the trade-off.
- Don't snapshot-test the typed errors. Assert specific fields and substring matches in the message (`.toContain`), matching the existing pattern in `validate-active-adapter.test.ts`.

### Project Structure Notes

- The adapter directory at `plugins/crew/mcp-server/src/adapters/` already exists. This story touches only `adapter.ts` and `registry.ts` (UPDATE), and `bmad/index.ts` (one-line UPDATE).
- The committed `dist/` will gain a recompiled `adapters/adapter.js` + `.d.ts` (interface change), `adapters/registry.js` + `.d.ts` (new function body), `adapters/bmad/index.js` + `.d.ts` (one-line addition), and `errors.js` + `.d.ts` (new class). The `dist-shipping.test.ts` sentinel from Story 1.9 will catch a partial build.
- `errors.ts` is at `plugins/crew/mcp-server/src/errors.ts` (currently ~20.5K — already crowded). The new `UnknownAdapterError` adds ~25–30 lines following the existing pattern. Position it adjacent to `NoAdapterMatchedError` and `AmbiguousAdapterError` for thematic grouping.
- TypeScript-internal: no new `tsconfig.json` change needed. The interface widening is non-breaking from a `.d.ts`-shipped perspective (callers that don't yet call `validateAgainstDiscipline` are unaffected; implementations now have one more required method, which is the breaking surface — and Tasks 2 and 6 sweep all in-tree implementations).

### References

- Epic: [Source: _bmad-output/planning-artifacts/epics/epic-3-backlog-layer-planning-adapters-story-manifests-and-the-planning-conversation.md § Story 3.1]
- Adapter contract: [Source: _bmad-output/planning-artifacts/architecture/planning-adapter-model.md § Adapter contract, § Configuration]
- Workspace resolver (config-reading path): [Source: plugins/crew/mcp-server/src/state/workspace-resolver.ts; Story 1.2 spec at _bmad-output/implementation-artifacts/1-2-workspace-resolver-and-per-target-repo-config.md]
- Stale-config validator: [Source: plugins/crew/mcp-server/src/state/validate-active-adapter.ts; Story 1.2b]
- Existing typed errors: [Source: plugins/crew/mcp-server/src/errors.ts § AmbiguousAdapterError, § NoAdapterMatchedError]
- BMad adapter (which gains a pass-through method here): [Source: plugins/crew/mcp-server/src/adapters/bmad/index.ts; Story 3.3 spec at _bmad-output/implementation-artifacts/3-3-bmad-adapter-v1-reference-implementation.md]
- Project structure tree: [Source: _bmad-output/planning-artifacts/architecture/project-structure-boundaries.md § Plugin tree]
- User-surface AC rubric: [Source: plugins/crew/docs/user-surface-acs.md] — no AC in this story qualifies.
- Dist-shipping contract: [Source: _bmad-output/implementation-artifacts/1-9-ship-a-pre-built-dist-with-the-plugin.md § Task 2, § Build artefacts]
- Test precedent: [Source: plugins/crew/mcp-server/tests/validate-active-adapter.test.ts]
- Story 3.2 (downstream consumer): _bmad-output/planning-artifacts/epics/epic-3-...md § Story 3.2
- Story 3.5 (real `validateAgainstDiscipline` owner): _bmad-output/planning-artifacts/epics/epic-3-...md § Story 3.5

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
