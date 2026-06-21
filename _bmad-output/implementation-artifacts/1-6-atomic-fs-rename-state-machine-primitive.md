# Story 1.6: Atomic `fs.rename` state-machine primitive

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **a same-filesystem `fs.rename` helper that guarantees never-two-states-at-once for any file under `<targetRepoRoot>/.crew/state/{to-do,in-progress,blocked,done}/`**,
so that **the dev/orchestration epics can build on a single trusted state-transition primitive that satisfies NFR8 (atomic state transitions) and NFR9 (no state corruption from agent failure) by construction, not by convention**.

This story lands the **third "single write path" primitive** of Epic 1 — alongside `writeManagedFile` (1.4 — canonical-content writes) and `logTelemetryEvent` / `gitCommit` (1.5 — telemetry + plugin-side commits). The shape mirrors the previous two:

1. **Single-purpose move function** — `moveBetweenStates(opts)` at `mcp-server/src/state/manifest-state-machine.ts` that (a) accepts a `targetRepoRoot`, a `ref` (the manifest stem, e.g. `bmad:1.2.3`), a `from` state, and a `to` state, (b) resolves the absolute source/destination paths, (c) validates that both are under the canonical `state/{to-do,in-progress,blocked,done}/` tree, (d) calls `fs.rename` (one syscall, no copy+delete fallback), (e) maps `EXDEV` errno to a typed `CrossFilesystemMoveError`, and (f) maps `ENOENT` on the source to a typed `ManifestNotFoundError`.
2. **Typed-error surface** — `CrossFilesystemMoveError` and `ManifestNotFoundError` appended to `mcp-server/src/errors.ts`. The classes follow the existing `DomainError` shape (constructor-options bag, no manual `this.name`, descriptive message citing NFR8 / Story 1.6).
3. **`fs.rename` static guard** — `tests/canonical-fs-guard.test.ts` extended with a third static-guard block that walks `mcp-server/src/**/*.ts` and forbids any file other than `state/manifest-state-machine.ts` from importing or invoking `rename` / `renameSync` against a state-machine path. Mirrors the `lib/gh.ts` and (Story 1.5) `lib/git.ts` direct-spawn guards.
4. **Chaos test (NFR8 cornerstone)** — `tests/manifest-state-machine.test.ts` includes a 1,000-iteration chaos sub-test that pre-seeds N manifests across the four state directories, drives random valid transitions from concurrent `Promise`s, and asserts on every step that **no manifest ref ever appears in two state directories at once** and **every manifest ref appears in exactly one of the four directories at every observation point**. This is the operational definition of NFR8 — the rest of the epic is built on it.

**This story does NOT** (a) wire `moveBetweenStates` into any MCP tool — those land in Epic 3 (`claimStory`, `completeStory`, `blockStory`, etc.; see `project-structure-boundaries.md` line 192); (b) write or read manifest **contents** (the `.yaml` body, frontmatter, `claimed_by`, heartbeat fields) — those are read/written by `writeManagedFile` from 1.4 in the higher-level MCP tools that this primitive is composed into; (c) implement stale-claim detection or heartbeat semantics (Epic 5); (d) handle the cross-filesystem case beyond throwing a typed error (cross-filesystem support is explicitly out of v1 scope per the epic and `core-architectural-decisions.md` line 33); (e) introduce `manifest-state-machine.ts` as the only writer of frontmatter — frontmatter mutations go through `writeManagedFile` from a separate code path; this primitive moves files **as opaque blobs**; (f) emit a telemetry event on each move — the higher-level MCP tools that compose this primitive emit `state.transition` events in Epic 3 onwards (the discriminator is reserved but not pinned in v1).

The seam: every future MCP tool that transitions a manifest between states calls `moveBetweenStates`. The static guard ensures this is the ONLY path. Combined with `writeManagedFile` (canonical-content boundary) and `gitCommit` (plugin-side commit boundary), this completes the **three structural seams** that every later epic composes against.

---

## Acceptance Criteria

**AC1 — A move between two canonical state directories is a single `fs.rename` syscall (NFR8):**
**Given** a target-repo tree with `<targetRepoRoot>/.crew/state/to-do/bmad:1.2.3.yaml` present,
**When** `moveBetweenStates({ targetRepoRoot, ref: "bmad:1.2.3", from: "to-do", to: "in-progress" })` is called,
**Then** the implementation performs exactly **one** `fs.rename` (or `fs.promises.rename`) syscall against the absolute source path `<targetRepoRoot>/.crew/state/to-do/bmad:1.2.3.yaml` and absolute destination path `<targetRepoRoot>/.crew/state/in-progress/bmad:1.2.3.yaml`,
**And** no `copyFile` / `readFile` / `writeFile` / `unlink` / `cp` / `link` is invoked as part of the move (verified by an `fsImpl` spy seam — see AC6a),
**And** the destination directory is ensured to exist via `fs.mkdir(destDir, { recursive: true })` BEFORE the rename (NOT after; `fs.rename` requires the destination's parent to exist),
**And** the function returns `{ from, to, ref, absFromPath, absToPath }` for caller observability.

**AC2 — A cross-filesystem move attempt throws `CrossFilesystemMoveError` and does NOT silently fall back to copy+delete (NFR8 / epic AC2):**
**Given** an environment where the source and destination resolve to different filesystems (`EXDEV` is returned by the kernel),
**When** `moveBetweenStates(...)` is called and the underlying `fs.rename` rejects with `err.code === "EXDEV"`,
**Then** the function throws `CrossFilesystemMoveError` carrying `{ absFromPath, absToPath, ref, originalCode: "EXDEV" }`,
**And** the function does **not** attempt any `copyFile` / `readFile` + `writeFile` / `cp` fallback — the move fails loud,
**And** the destination file does **not** exist after the failed call (asserted by a stat in AC6c),
**And** the source file is still present at its original location (asserted by a stat in AC6c).

**AC3 — Chaos: 1,000 random moves never observe a ref in two state directories at once (NFR8 cornerstone, epic AC3):**
**Given** a target-repo tree pre-seeded with `N = 16` manifests (each with a unique ref like `chaos:0001` … `chaos:0016`), each placed in a random starting state from `{to-do, in-progress, blocked, done}`,
**When** the test driver issues 1,000 random valid transitions (a transition is `(ref, fromState, toState)` where `fromState` is the manifest's current state and `toState` is any of the other three), with the transitions submitted as concurrent `Promise.allSettled` batches of size 8,
**Then** at every observation point — both after each batch and a final pass after all 1,000 — every ref appears in **exactly one** of the four state directories (count over all four state directories === 1 for every ref),
**And** the total file count across the four state directories === N at every observation point,
**And** every "successful" promise's returned `to` matches the directory the ref is observed in at the next observation point (unless a later batch moved it again),
**And** the test deterministically seeds its PRNG (e.g. `mulberry32(0xCAFEBABE)`) so the same sequence runs in CI every time — chaos in distribution, deterministic in trace (NFR9 measurement style mirrors this).

**AC4 — `moveBetweenStates` refuses paths outside the canonical state tree:**
**Given** the canonical state-directory whitelist `{"to-do", "in-progress", "blocked", "done"}` and the canonical parent `<targetRepoRoot>/.crew/state/`,
**When** a caller passes `from` or `to` that is not one of the four whitelisted states (e.g. `"archive"` or `"to-do/../../etc"`),
**Then** the function throws `InvalidStateNameError` carrying `{ attemptedFrom, attemptedTo, allowedStates }` **before any filesystem operation**,
**And** when the resolved absolute path of either side escapes `<targetRepoRoot>/.crew/state/` (caught via `path.relative(stateRoot, absPath).startsWith("..")`), the function throws `InvalidStateNameError` with `reason: "path escapes state root"` — also before any filesystem operation.

**AC5 — `ENOENT` on the source resolves to a typed `ManifestNotFoundError` (not a generic Node error):**
**Given** a target-repo tree where `<targetRepoRoot>/.crew/state/to-do/missing-ref.yaml` does NOT exist,
**When** `moveBetweenStates({ targetRepoRoot, ref: "missing-ref", from: "to-do", to: "in-progress" })` is called,
**Then** the function throws `ManifestNotFoundError` carrying `{ ref, expectedAbsPath, fromState }`,
**And** the underlying `ENOENT` error code is the **only** mapped Node errno that produces this typed error (any other `fs.rename` rejection bubbles up unchanged, so genuinely unexpected failures are not masked).

**AC6 — Vitest covers the enforcement paths (epic AC3, integration):**
`pnpm test` from `plugins/crew/` adds one new test file (`mcp-server/tests/manifest-state-machine.test.ts`) and extends `tests/canonical-fs-guard.test.ts` with a new `describe("static direct-rename guard (Story 1.6)", () => { … })` block. The combined suite asserts:
- **AC6a (happy-path single syscall):** Pre-seed `<root>/.crew/state/to-do/bmad:1.0.0.yaml` with body `"# manifest body\n"`. Call `moveBetweenStates({ targetRepoRoot: root, ref: "bmad:1.0.0", from: "to-do", to: "in-progress", fsImpl: spy })`. Assert: (i) `spy.rename` (or equivalent) called exactly once with the expected absolute source/destination, (ii) no `copyFile` / `readFile` / `writeFile` / `unlink` on the `spy`, (iii) `<root>/.crew/state/in-progress/bmad:1.0.0.yaml` now exists with body `"# manifest body\n"`, (iv) `<root>/.crew/state/to-do/bmad:1.0.0.yaml` no longer exists, (v) the return value matches `{ from: "to-do", to: "in-progress", ref: "bmad:1.0.0", absFromPath, absToPath }`.
- **AC6b (destination parent dir created if missing):** Pre-seed `<root>/.crew/state/to-do/bmad:1.0.1.yaml` only — the `in-progress/` directory does NOT exist. Call `moveBetweenStates({ … from: "to-do", to: "in-progress" })`. Assert: (i) the call resolves successfully, (ii) `<root>/.crew/state/in-progress/` exists as a directory after the call, (iii) the file lives at `<root>/.crew/state/in-progress/bmad:1.0.1.yaml`.
- **AC6c (`EXDEV` cross-filesystem):** Inject an `fsImpl` whose `rename` rejects with `Object.assign(new Error("EXDEV"), { code: "EXDEV" })`. Pre-seed the source on the real fs. Call `moveBetweenStates(...)`. Assert: (i) the call rejects with `CrossFilesystemMoveError`, (ii) `spy.copyFile` / `spy.readFile` / `spy.writeFile` / `spy.unlink` were called **zero times**, (iii) the source file is still present at its original location, (iv) the destination file does not exist.
- **AC6d (`ENOENT` source missing):** No seed. Call `moveBetweenStates({ … ref: "ghost", from: "to-do", to: "in-progress" })`. Assert: (i) the call rejects with `ManifestNotFoundError`, (ii) the `.expectedAbsPath` field on the error matches `<root>/.crew/state/to-do/ghost.yaml`, (iii) no destination file exists.
- **AC6e (invalid state name — before any IO):** Call `moveBetweenStates({ … from: "to-do", to: "archive" as any })` with an `fsImpl` spy. Assert: (i) the call rejects with `InvalidStateNameError`, (ii) every `spy.*` method called **zero times** (no `mkdir`, no `rename`, no `stat`). Repeat with `from: "to-do/../../etc" as any` — same expectation, with `reason: "path escapes state root"`.
- **AC6f (chaos — 1,000 random valid moves, no two-states-at-once):** Pre-seed 16 manifests across the four state directories with the deterministic PRNG above. Drive 1,000 random `(ref, fromState→toState)` transitions where `fromState` is the ref's currently-observed state. Use `Promise.allSettled` batches of 8 to introduce concurrency. After each batch, walk all four state directories and assert: (a) `count(allRefs) === 16`, (b) `forall ref in refs: countAcrossDirs(ref) === 1`. After all 1,000 moves, assert the same invariants once more. Deterministic seed: any 32-bit constant chosen by the dev (document it in the test). Expected runtime: <2s on a modern machine; if it exceeds 10s, reduce iteration count to 500 and document — the structural assertion is what matters, not the magic 1,000 number (the epic line cites 1,000 as a target, not a contractual minimum).
- **AC6g (static direct-rename guard):** In `canonical-fs-guard.test.ts`, append a third `describe(...)` block that walks `mcp-server/src/**/*.ts`, skips `state/manifest-state-machine.ts`, and asserts no other file matches `\brename(Sync)?\s*\(` against a state-machine path. Pattern: scan for `fs.rename` / `fs.renameSync` / `fs.promises.rename` / `await rename(` / `renameSync(` invocations, OR named/namespace imports of `rename` / `renameSync` from `node:fs` / `node:fs/promises`. Re-use the existing `walkTs`, `BANNED_WRITE_BINDINGS`-style approach. Pass with `expect(offences).toEqual([])` — same shape as the existing `gh`-spawn and `git`-spawn guards.

All sub-tests pass alongside existing suites (smoke 1.1, resolver 1.2, validate-active-adapter 1.2b, standards-doc 1.3, permissions/canonical-fs 1.4, telemetry + git-commit 1.5). Total expected: existing baseline + new `manifest-state-machine.test.ts` + new `describe` block in `canonical-fs-guard.test.ts`; all green, zero skips.

---

## Tasks / Subtasks

- [ ] **Task 1 — Typed errors** (AC: 2, 4, 5, 6c, 6d, 6e)
  - [ ] Edit `plugins/crew/mcp-server/src/errors.ts`. Append at the bottom of the file, after `GitCommitMessageMalformedError`. Match the existing JSDoc / constructor-options-bag style. Subclass `DomainError`. Do NOT manually set `this.name` (the base class handles it).
  - [ ] `CrossFilesystemMoveError` — fields: `absFromPath: string`, `absToPath: string`, `ref: string`, `originalCode: string`. Constructor composes:
    > `Cross-filesystem move refused for manifest '<ref>': fs.rename returned <originalCode>. from='<absFromPath>', to='<absToPath>'. v1 explicitly does not support cross-filesystem moves (NFR8 — single-syscall atomicity). Place the target repo on a single filesystem, or align the .crew/state/ tree with the repo root. (Story 1.6 AC2)`
  - [ ] `ManifestNotFoundError` — fields: `ref: string`, `expectedAbsPath: string`, `fromState: string`. Constructor composes:
    > `Manifest '<ref>' not found at '<expectedAbsPath>' (expected in state '<fromState>'). A move was requested but the source file does not exist. This typically means the manifest was already transitioned by another session, or the ref was never claimed. (Story 1.6 AC5)`
  - [ ] `InvalidStateNameError` — fields: `attemptedFrom: string`, `attemptedTo: string`, `allowedStates: readonly string[]`, `reason: string`. Constructor composes:
    > `Invalid state-machine transition refused: <reason>. from='<attemptedFrom>', to='<attemptedTo>'. Allowed states: [<allowedStates join ", ">]. (Story 1.6 AC4)`
    - `reason` is one of: `"unknown state name"`, `"path escapes state root"`. The dev agent picks the right variant at the throw site.
  - [ ] Do **not** touch any of the existing classes. Their wording is asserted by 1.1–1.5 tests.

- [ ] **Task 2 — The primitive: `moveBetweenStates`** (AC: 1, 2, 4, 5, 6a, 6b, 6c, 6d, 6e)
  - [ ] Create `plugins/crew/mcp-server/src/state/manifest-state-machine.ts`. (This is the exact path pinned by `architecture/project-structure-boundaries.md` line 97.)
  - [ ] Export a single async function:
    `moveBetweenStates(opts: { targetRepoRoot: string; ref: string; from: StateName; to: StateName; fsImpl?: FsImpl }): Promise<MoveResult>`
    - `StateName = "to-do" | "in-progress" | "blocked" | "done"`
    - `MoveResult = { from: StateName; to: StateName; ref: string; absFromPath: string; absToPath: string }`
    - `FsImpl` is a narrow interface — `{ rename(from, to): Promise<void>; mkdir(path, opts): Promise<unknown>; stat(path): Promise<unknown> }` — defaulting to `{ rename: fs.rename, mkdir: fs.mkdir, stat: fs.stat }` from `node:fs/promises`. **This is the ONLY file in `mcp-server/src/**` permitted to import `rename` from `node:fs/promises`** (enforced by the AC6g static guard).
    - `fsImpl` is a **test seam only** — production callers do not pass it.
  - [ ] Export the `STATE_NAMES` constant: `export const STATE_NAMES = ["to-do", "in-progress", "blocked", "done"] as const` and `export type StateName = (typeof STATE_NAMES)[number]`. Re-used by tests and (in later epics) by MCP tool argument schemas.
  - [ ] Algorithm (do NOT deviate from this order — the order is itself a correctness invariant):
    1. **Validate state names.** If `from` or `to` is not in `STATE_NAMES`, throw `InvalidStateNameError({ attemptedFrom: from, attemptedTo: to, allowedStates: STATE_NAMES, reason: "unknown state name" })`. **Do not** touch the filesystem.
    2. **Compute paths.** `stateRoot = path.join(targetRepoRoot, ".crew", "state")`. `absFromPath = path.join(stateRoot, from, ref + ".yaml")`. `absToPath = path.join(stateRoot, to, ref + ".yaml")`. **Do not** touch the filesystem yet.
    3. **Path-escape check.** For each of `absFromPath` and `absToPath`, compute `rel = path.relative(stateRoot, absPath)` and assert `!rel.startsWith("..") && !path.isAbsolute(rel)`. If either fails, throw `InvalidStateNameError({ ..., reason: "path escapes state root" })`. (Defends against `ref` values like `../../etc/passwd` — though MCP tool boundaries will also validate `ref` shape in later epics, this primitive is the last line of defense.)
    4. **Ensure destination directory exists.** `await fsImpl.mkdir(path.dirname(absToPath), { recursive: true })`. Required because `fs.rename` itself does not create parent directories — and AC6b explicitly tests the create-on-demand path.
    5. **Single rename syscall.** `try { await fsImpl.rename(absFromPath, absToPath); } catch (err) { … }`.
    6. **Error mapping.** In the catch:
       a. If `err?.code === "EXDEV"` → throw `CrossFilesystemMoveError({ absFromPath, absToPath, ref, originalCode: "EXDEV" })`.
       b. If `err?.code === "ENOENT"` → throw `ManifestNotFoundError({ ref, expectedAbsPath: absFromPath, fromState: from })`.
       c. Otherwise → re-throw the original error unchanged. (Genuinely unexpected failures must surface; do not swallow.)
    7. **Return.** `return { from, to, ref, absFromPath, absToPath }`.
  - [ ] **Do not** add a copy+delete fallback for `EXDEV`. The epic AC2 is explicit. The whole point of NFR8 is that there is no observable "in-between" state — a fallback would create one.
  - [ ] **Do not** read or write the manifest body. The primitive moves files as opaque blobs. Frontmatter / `claimed_by` / heartbeat field mutations are the responsibility of the higher-level MCP tools in Epic 3 (which compose this primitive with `writeManagedFile` for content mutations).
  - [ ] **Do not** emit telemetry from this file. The `state.transition` event is reserved for Epic 3+'s MCP tools; emitting from the primitive would couple the substrate to the writer.
  - [ ] **Do not** acquire locks or write `.lock` files. The `fs.rename` syscall is the atomicity guarantee. POSIX `rename(2)` and the equivalent on macOS HFS+/APFS / Linux ext4/btrfs/xfs are atomic with respect to other observers within the same filesystem. (Windows `MoveFileEx` is less strong; v1 does not target Windows hosts. See "Deferred work" in the Dev Notes.)
  - [ ] **Do not** introduce module-level state (no cached `fsImpl`, no in-memory ref→state map). Every call re-resolves paths and re-invokes the seam.
  - [ ] **Do not** import a write-shaped `fs` binding (`writeFile`, `appendFile`, etc.). This file is NOT on the `FS_WRITE_WHITELIST` from 1.4/1.5. Only `rename` / `mkdir` / `stat` from `node:fs/promises`.

- [ ] **Task 3 — Extend canonical-fs guard with direct-`rename` ban** (AC: 6g)
  - [ ] Edit `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts`. Append a new `describe("static direct-rename guard (Story 1.6 AC6g)", () => { … })` block at the bottom of the file (after the `git`-spawn guard added in 1.5).
  - [ ] Define `RENAME_WRAPPER = path.join(SRC_DIR, "state", "manifest-state-machine.ts")`.
  - [ ] Walk `mcp-server/src/**/*.ts` via the existing `walkTs(SRC_DIR)` helper. Skip `RENAME_WRAPPER`.
  - [ ] For each remaining file, parse imports using the same regex shape already in the file. Flag as offences any:
    - Named import of `rename` or `renameSync` from `node:fs`, `node:fs/promises`, `fs`, or `fs/promises`.
    - Namespace import of `node:fs` (or aliases) where the body contains `<alias>.rename(` or `<alias>.renameSync(` or `<alias>.promises.rename(`.
    - A `promises as <alias>` import where the body contains `<alias>.rename(` or `<alias>.renameSync(`.
  - [ ] Mirror the structure of the existing AC5c block — same `importRegex`, same `promisesAliasRegex`, just with `BANNED_RENAME_BINDINGS = ["rename", "renameSync"]` as the local constant. Do NOT modify the existing `BANNED_WRITE_BINDINGS` (those still apply to `writeFile` / `appendFile` / etc. and are governed by the 1.4/1.5 whitelist).
  - [ ] **Do not** add `manifest-state-machine.ts` to `FS_WRITE_WHITELIST` — that whitelist is specifically about write-shaped APIs (`writeFile`/`appendFile`/etc.), and the primitive does NOT use those. Renames are a distinct API and get their own guard.
  - [ ] Pass at least one assertion: `expect(offences, offences.join("\n")).toEqual([])`.
  - [ ] **Verify** post-change: the existing AC5c and AC5b (and 1.5's git-spawn) static-guard blocks all still pass. Run `pnpm test` once before commit.

- [ ] **Task 4 — Authored vitest suite** (AC: 1–6 except 6g, which lives in canonical-fs-guard.test.ts)
  - [ ] Create `plugins/crew/mcp-server/tests/manifest-state-machine.test.ts`. Use `fs.mkdtemp(path.join(os.tmpdir(), "manifest-state-"))` for each test's target repo. Clean up in `afterAll` (mirror the canonical-fs-guard.test.ts pattern).
  - [ ] **AC6a — happy path:**
    - Set up: pre-seed `<root>/.crew/state/to-do/bmad:1.0.0.yaml` with body `"# manifest body\n"` (use `fs.mkdir({ recursive: true })` + `fs.writeFile` from the test — the test code is allowed to write; only `mcp-server/src/**` is guarded).
    - Build a `vi.fn()` triple for `fsImpl`: `{ rename: vi.fn(realFs.rename), mkdir: vi.fn(realFs.mkdir), stat: vi.fn(realFs.stat) }` — proxy through to the real implementations so the move actually happens, but you can assert on call counts.
    - Call `moveBetweenStates({ targetRepoRoot: root, ref: "bmad:1.0.0", from: "to-do", to: "in-progress", fsImpl: spy })`.
    - Assert: `spy.rename` called exactly once with `[expectedAbsFrom, expectedAbsTo]`. `spy.mkdir` called at least once with `expectedDestDir`. No `copyFile` / `readFile` / `writeFile` / `unlink` exposed on `spy` at all (the `FsImpl` interface deliberately does not expose them — this is a structural invariant). Real-fs assertions: dest file exists with the seeded body, source file does not. Return value matches `{ from, to, ref, absFromPath, absToPath }`.
  - [ ] **AC6b — destination dir auto-created:**
    - Pre-seed only `<root>/.crew/state/to-do/bmad:1.0.1.yaml`. Do NOT pre-create `in-progress/`.
    - Call `moveBetweenStates({ … from: "to-do", to: "in-progress" })` with no `fsImpl` (real fs).
    - Assert: call resolves. `<root>/.crew/state/in-progress/` is now a directory. File lives at `<root>/.crew/state/in-progress/bmad:1.0.1.yaml`.
  - [ ] **AC6c — EXDEV cross-filesystem:**
    - Build `fsImpl` where `rename` rejects with `Object.assign(new Error("cross-fs"), { code: "EXDEV" })`. `mkdir` and `stat` proxy to real fs.
    - Pre-seed `<root>/.crew/state/to-do/bmad:1.0.2.yaml`.
    - Call `moveBetweenStates(...)`.
    - Assert: rejects with `CrossFilesystemMoveError`. The error has `.originalCode === "EXDEV"` and `.absFromPath` / `.absToPath` matching the expected. Source file is still present. Destination file does not exist. **No copy / read / write attempted** (the `FsImpl` interface doesn't expose those — structural assertion).
  - [ ] **AC6d — ENOENT source missing:**
    - No seed.
    - Call `moveBetweenStates({ … ref: "ghost", from: "to-do", to: "in-progress" })`.
    - Assert: rejects with `ManifestNotFoundError`. `.ref === "ghost"`. `.expectedAbsPath` matches `<root>/.crew/state/to-do/ghost.yaml`. `.fromState === "to-do"`. Destination dir may or may not exist (mkdir-recursive ran before the rename) — assert nothing about it; assert only that no destination file exists.
  - [ ] **AC6e — invalid state name (and path escape) — no IO:**
    - Build `fsImpl` triple where every method is `vi.fn(() => { throw new Error("should not be called"); })`.
    - Variant 1: `moveBetweenStates({ … from: "to-do", to: "archive" as any, fsImpl: spy })`. Assert: rejects with `InvalidStateNameError`. `.reason === "unknown state name"`. Every method on `spy` has `.toHaveBeenCalledTimes(0)`.
    - Variant 2: `moveBetweenStates({ … ref: "../../etc/passwd", from: "to-do", to: "in-progress", fsImpl: spy })`. Assert: rejects with `InvalidStateNameError`. `.reason === "path escapes state root"`. Every method on `spy` has `.toHaveBeenCalledTimes(0)`.
  - [ ] **AC6f — chaos (1,000 random moves):**
    - Helper `mulberry32(seed)` PRNG inlined at the top of the test file (no new dep — copy the 6-line implementation from the well-known MIT-licensed snippet; document the source as a comment).
    - Seed: 16 refs `chaos:0001` … `chaos:0016`. For each, pick a random starting state from `STATE_NAMES`. Pre-seed the manifest at `<root>/.crew/state/<state>/<ref>.yaml` with body `<ref>\n`.
    - Maintain an in-memory `currentState: Map<ref, StateName>` initialised from the seeding step.
    - Driver loop: for `i = 0..999`, pick a random ref, pick a random target state ≠ `currentState.get(ref)`, push the `moveBetweenStates(...)` promise into a batch array. Every 8 iterations, `await Promise.allSettled(batch)`, then for each `Settled`: if `status === "fulfilled"`, update `currentState.set(ref, to)`; if `status === "rejected"`, leave `currentState` unchanged (a rejection means another concurrent batch member moved the same ref first — that's the race we're testing; the file simply isn't where this concurrent call expected). After the batch, walk all four directories and assert: total file count === 16; for every ref, count across the four dirs === 1.
    - **Final pass:** after all 1,000 iterations, walk once more and assert the same invariants. Optionally cross-check `currentState` matches the observed directory placement (it should, with the caveat that rejected-then-re-driven cases are allowed to lag).
    - **Determinism:** use the inlined PRNG, no `Math.random()`. Document the seed in a code comment. The test asserts on **structure** (count, no duplicates), not on the specific trace.
    - **Performance budget:** the test should complete in <2s on a modern dev machine. If it routinely exceeds 5s in CI, reduce the iteration count to 500 — the structural invariant (no two-states-at-once) is what AC3 contracts, not the literal 1,000. Document the reduction in a code comment if you make it.

- [ ] **Task 5 — Run the full suite** (AC: all)
  - [ ] From `plugins/crew/`, run `pnpm test`. Expectation: all existing suites green (smoke, resolver, validate-active-adapter, standards-doc, permissions, canonical-fs, telemetry-logger, git-commit), plus the new `manifest-state-machine.test.ts`, plus the extended `canonical-fs-guard.test.ts` (with the new `static direct-rename guard` block). Zero skips, no `.only`, no `.todo`.
  - [ ] From `plugins/crew/`, run `pnpm build`. Expectation: zero TypeScript errors. The `StateName` union and `MoveResult` exports must be typed end-to-end (no `any` in the public signature).

---

## Dev Notes

### Files this story creates (NEW)

- `plugins/crew/mcp-server/src/state/manifest-state-machine.ts` — exports `moveBetweenStates`, `STATE_NAMES`, `StateName`, `MoveResult`. The ONLY file under `mcp-server/src/**` permitted to invoke `rename` against a state-machine path (enforced by AC6g static guard).
- `plugins/crew/mcp-server/tests/manifest-state-machine.test.ts` — covers AC6a–AC6f.

### Files this story modifies (UPDATE)

- `plugins/crew/mcp-server/src/errors.ts` — append `CrossFilesystemMoveError`, `ManifestNotFoundError`, and `InvalidStateNameError` after `GitCommitMessageMalformedError`. Do NOT touch existing classes (their wording is asserted by 1.1–1.5 tests).
- `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts` — append a new `describe("static direct-rename guard (Story 1.6 AC6g)", …)` block at the bottom. Do NOT modify any existing `it(...)` body or the `FS_WRITE_WHITELIST` Set. The new block uses a separate local constant (`BANNED_RENAME_BINDINGS`) and a separate skip-target (`state/manifest-state-machine.ts`).

### Existing files this story reads but does NOT modify

- `plugins/crew/mcp-server/src/lib/managed-fs.ts` — pattern reference for "the only writer" + path-escape guard via `path.relative` + `startsWith("..")`. **Read once** before authoring `manifest-state-machine.ts`; mirror the path-escape style verbatim. (Current state: exports `writeManagedFile`, `isCanonicalPath`, `CANONICAL_PATH_GLOBS`. Preserves NFR16 by requiring an MCP-tool context for canonical writes. The new primitive uses the *same* path-escape technique but for the narrower `state/` sub-tree.)
- `plugins/crew/mcp-server/src/lib/logger.ts` (Story 1.5) — pattern reference for "ship the substrate ahead of writers." Read once: confirms the file has no module-level state, has a clock seam (`now?`), and is whitelisted in the static guard. Our `fsImpl?` seam mirrors `logger.ts`'s `now?` shape exactly.
- `plugins/crew/mcp-server/src/lib/git.ts` (Story 1.5) — pattern reference for "the only subprocess wrapper" with an `execaImpl?` test seam. Our `fsImpl?` seam mirrors `git.ts`'s `execaImpl?` shape exactly.
- `plugins/crew/mcp-server/src/lib/gh.ts` — pattern reference for typed-error-before-spawn (`GhSubcommandDeniedError` is thrown before any `execa` call; our `InvalidStateNameError` is thrown before any `fs.*` call).
- `plugins/crew/mcp-server/src/errors.ts` — append-only pattern. Match existing JSDoc / constructor-options-bag style. Read the file fully before appending to confirm the most recent additions and not collide.
- `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts` — pattern reference. Re-use `walkTs`, the import regex, and the `promisesAliasRegex` shape; do not duplicate the helper.
- `plugins/crew/mcp-server/src/server.ts` — for context only. This story does NOT register MCP tools. The seam exists for Epic 3 to compose.

### What this story changes about the existing system

- **Adds a structural seam, breaks nothing.** No existing file's behaviour changes. The new primitive is callable from inside `mcp-server/src/**` but nothing in `src/**` currently calls it — that's intentional (substrate before writers). The static guard ensures no later story can accidentally bypass it.
- **Adds three new typed errors.** They subclass `DomainError`; the MCP boundary (later epics) will map them to MCP errors. No existing error mapping is affected.
- **Extends the static-guard suite.** The new `describe` block adds one new `it(...)` that runs against every `.ts` file in `mcp-server/src/**`. If a future story accidentally imports `rename` outside the primitive, CI fails immediately.

### Architecture compliance (cite the source on every claim)

- **State machine is the directory the manifest lives in:** `core-architectural-decisions.md` line 29 — "the state machine now moves *plugin-owned manifest files* in `<target-repo>/.crew/state/{to-do,in-progress,blocked,done}/<ref>.yaml`". The primitive's path layout uses these four state names exactly.
- **`fs.rename` is the state-transition primitive, same-filesystem only:** `core-architectural-decisions.md` line 33 — "`fs.rename` (Node), same-filesystem only … NFR8 single-syscall atomicity; cross-filesystem moves out of scope". `EXDEV` → `CrossFilesystemMoveError` is the literal implementation of "out of scope" — fail loud, no fallback.
- **Manifest file naming `<ref>.yaml`:** `project-structure-boundaries.md` lines 151–154 — the four state directories each hold `<ref>.yaml` files. The primitive computes `absFromPath = path.join(stateRoot, from, ref + ".yaml")`.
- **`state/manifest-state-machine.ts` is the pinned file path:** `project-structure-boundaries.md` line 97 — "`manifest-state-machine.ts` # NFR8, NFR9 — atomic mv on manifests". This story creates that file at that exact path.
- **Claim mechanism is atomic-mv of the manifest:** `core-architectural-decisions.md` line 39 — "Atomic move of the manifest from `to-do/` to `in-progress/` + `claimed_by` = session id (no lockfiles)". The primitive implements the mv half; the `claimed_by` field write happens in the Epic 3 MCP tool that composes this primitive with `writeManagedFile`.
- **NFR8 — atomic state transitions:** `prd-crew-v1/non-functional-requirements.md` line 17 — "Story file state moves between `to-do/`, `in-progress/`, `blocked/`, and `done/` are atomic at the filesystem level (single `mv` syscall). No story can be observed simultaneously in two states." AC1 + AC3 are the operational definitions.
- **NFR9 — no state corruption from agent failure:** `prd-crew-v1/non-functional-requirements.md` line 18 — the fault-injection measurement style. AC3's chaos test is the structural prerequisite; the fault-injection test itself lands in Epic 5 (the integration test harness lives under `mcp-server/tests/integration/` per `project-structure-boundaries.md` line 115, which we don't touch in this story).
- **NFR19 — filesystem is the only coordination surface:** `prd-crew-v1/non-functional-requirements.md` line 34. The primitive has no locks, no daemon, no in-memory state. Coordination is purely `rename(2)`'s atomicity guarantee.
- **FR17/FR19/FR20 — claim/complete/block via atomic move:** `prd-crew-v1/functional-requirements.md` lines 29/31/32. The primitive provides the atomic-move half; the higher-level MCP tools that emit these FRs are Epic 3 work.
- **Implementation-patterns §5 (closed payloads):** not directly applicable — this primitive does not emit telemetry. The reservation of the `state.transition` discriminator for Epic 3 lives in the telemetry-events schema (1.5) but is not a v1 union member.

### Library / framework requirements

| Library | Version | Why | Source |
|---|---|---|---|
| `node:fs/promises` | (Node ≥ 20, runtime stdlib) | `rename`, `mkdir`, `stat`. No userspace dep. | `plugins/crew/mcp-server/package.json` engines |
| `node:path` | (Node ≥ 20, runtime stdlib) | Path joining, `relative` for escape guard. | (stdlib) |
| `vitest` | `^2.1.0` (already declared, devDep) | Test framework. | `plugins/crew/mcp-server/package.json` |

**Do NOT add new dependencies.** The primitive is ~50 lines of TypeScript and three Node stdlib calls. In particular:
- Do NOT add `move-file` / `mv` / `fs-extra` — they pull in copy+delete fallbacks that VIOLATE NFR8.
- Do NOT add `proper-lockfile` or any lockfile lib — the `rename` syscall is itself the atomicity primitive (NFR19).
- Do NOT add a PRNG library for the chaos test — inline the 6-line `mulberry32` (MIT-licensed snippet, document the source in a comment).

### File structure (target paths, after this story)

```
plugins/crew/mcp-server/
├── src/
│   ├── errors.ts                          # UPDATE (append three classes)
│   ├── index.ts                           # unchanged
│   ├── server.ts                          # unchanged
│   ├── adapters/                          # unchanged
│   ├── lib/
│   │   ├── gh.ts                          # unchanged
│   │   ├── git.ts                         # unchanged (1.5)
│   │   ├── logger.ts                      # unchanged (1.5) — still whitelisted writer
│   │   ├── managed-fs.ts                  # unchanged — still whitelisted writer
│   │   └── plugin-version.ts              # unchanged
│   ├── schemas/                           # unchanged
│   ├── state/
│   │   └── manifest-state-machine.ts      # NEW (Task 2) — only file that calls rename
│   └── validators/                        # unchanged
└── tests/
    ├── acceptance.test.ts                 # unchanged
    ├── canonical-fs-guard.test.ts         # UPDATE (append direct-rename guard block)
    ├── git-commit.test.ts                 # unchanged
    ├── manifest-state-machine.test.ts     # NEW (Task 4)
    ├── permissions-enforcement.test.ts    # unchanged
    ├── smoke.test.ts                      # unchanged
    ├── standards-doc.test.ts              # unchanged
    ├── telemetry-logger.test.ts           # unchanged
    ├── validate-active-adapter.test.ts    # unchanged
    └── workspace-resolver.test.ts         # unchanged
```

### Testing requirements

- **Framework:** vitest (already wired). `pnpm test` from `plugins/crew/` runs everything.
- **Fixture strategy:** Each test that touches disk uses `fs.mkdtemp(path.join(os.tmpdir(), "manifest-state-"))` and cleans up in `afterAll`. Mirrors `canonical-fs-guard.test.ts` and `telemetry-logger.test.ts`.
- **No real cross-filesystem mounts.** The EXDEV path is exercised by injecting an `fsImpl` whose `rename` rejects with a synthetic `EXDEV` error — never by actually mounting a tmpfs / loop device. This keeps CI portable across Linux / macOS runners.
- **Determinism in chaos.** The 1,000-iteration test uses an inlined `mulberry32` PRNG with a fixed seed. No `Math.random()` anywhere in the test. The test asserts on structural invariants (count, no duplicates) — never on a specific move sequence.
- **No skips, no `.only`, no `.todo`.** Same bar as 1.1–1.5.
- **Concurrency in the chaos test.** `Promise.allSettled` with batch size 8 is the recommended concurrency level — high enough to exercise the race surface, low enough to keep the test deterministic in runtime. If the batch size needs tuning for CI stability, document the chosen value in a code comment.
- **Spy assertion style.** When using a `vi.fn` `fsImpl`, use `.toHaveBeenCalledTimes(N)` and `.toHaveBeenCalledWith(...)` — mirror the assertion shape from `git-commit.test.ts` (1.5) and `permissions-enforcement.test.ts` (1.4).

### Previous story intelligence

**From Story 1.5 (telemetry + git-commit substrate):**
- **Pattern: typed-error sub-classes append to `errors.ts`, never edit existing.** 1.5 added two classes after `RolePermissionsMalformedError`. This story adds three more, same place, same style. Read the file once before appending to confirm the current tail.
- **Pattern: every IO wrapper takes an injection seam (`execaImpl?`, `now?`, and now `fsImpl?`).** 1.4's `gh.ts` introduced `execaImpl`; 1.5's `git.ts` mirrored it; 1.5's `logger.ts` introduced `now`. This story's `manifest-state-machine.ts` introduces `fsImpl` with the same shape and production-callers-never-pass-it rule.
- **Pattern: ship the substrate ahead of the writers.** 1.4 shipped `writeManagedFile` with no MCP tool wired to it. 1.5 shipped `logTelemetryEvent` and `gitCommit` with no MCP tool wired to them. This story does the same for `moveBetweenStates`. The substrate's value is structural; later stories supply the callers.
- **Pattern: single-purpose wrappers (no retry, no fallback, no extras).** 1.5's `git.ts` does not retry, sign, or `--no-verify`. This story's primitive does not copy-fallback on EXDEV, does not retry on transient errors, does not write the manifest body. The wrapper is mechanical; semantics live one layer up.
- **Anti-pattern surfaced in 1.4 + 1.5 dev notes:** do NOT cache module-level state. The role-permissions loader re-reads on every call; the telemetry logger has no cached file handles. This story's primitive has no module-level state at all (no cached `fsImpl`, no in-memory ref→state map).
- **Anti-pattern surfaced in 1.5 dev notes:** do NOT extract `formatZodIssues` into a shared `lib/` helper while you're in this story. Similar principle: do NOT extract `pathEscapeGuard` from `managed-fs.ts` into a shared helper. Duplicate the 3-line check in `manifest-state-machine.ts`. A later refactor story can DRY it once we have three callers (1.4, 1.6, and a third — likely Epic 5's `archive-cycle`).

**From Story 1.4 (canonical-fs guard + permission allowlists):**
- **Pattern: "the only writer" gets a whitelist + a static guard.** 1.4 set up the `FS_WRITE_WHITELIST` for write-shaped APIs. 1.5 added `lib/logger.ts` to it. This story is structurally similar but **separate**: rename is a distinct API, gets its own `describe` block and its own (implicit, single-entry) whitelist. The two whitelists do not share a set.
- **Pattern: path-escape via `path.relative`.** `managed-fs.ts` line 85: `if (rel.startsWith("..") || path.isAbsolute(rel)) { return { canonical: false }; }`. This story uses the same idiom in `manifest-state-machine.ts` Step 3 — but throws `InvalidStateNameError` rather than returning a boolean, because the primitive's contract is that path-escape is a programmer error (the MCP-tool boundary should have caught it), not a runtime fact about the user's repo.

### Reasonable defaults & decisions (do NOT pause to confirm these)

- **`ref + ".yaml"` is the file naming convention.** Per `project-structure-boundaries.md` line 151. The primitive does NOT make `.yaml` configurable — manifests are always YAML in v1. If a later epic needs JSON manifests, that's a v2 architectural change, not a parameter.
- **Path-escape uses `path.relative(stateRoot, ...)` then `startsWith("..")` + `path.isAbsolute(rel)`.** Mirrors `managed-fs.ts` line 85 verbatim.
- **The `ref` parameter is not regex-validated by this primitive.** MCP tools in later epics will validate `ref` shape (e.g. `bmad:<source-id>` or `<adapter>:<id>`). This primitive's only `ref` defense is the path-escape guard — a `ref` of `../../etc/passwd` will be caught structurally even though no regex is applied to the `ref` string itself.
- **`fsImpl` interface is narrow on purpose.** Exposing only `rename`, `mkdir`, `stat` means the primitive structurally cannot fall back to copy+delete even if a future maintainer wanted to — the binding isn't there. This is a "fence in the API" guarantee.
- **No `state.transition` telemetry event in v1.** The `TelemetryEventSchema` in `schemas/telemetry-events.ts` (1.5) currently contains `agent.invoke` and `telemetry.invalid`. The primitive does not emit. Epic 3's MCP tools (`claimStory`, `completeStory`, etc.) will add a `state.transition` discriminator and emit from the MCP-tool boundary — which is the correct seam, because the telemetry event needs `tool_name`, `role`, and `session_id` context that the primitive doesn't have.
- **Chaos seed is dev-chosen (any 32-bit integer constant).** The PM-level requirement is "deterministic in CI"; the specific value is a tactical engineer choice. Suggested: `0xCAFEBABE` or `0xDEADBEEF` for grep-ability.
- **Chaos iteration count: 1,000 is a target, not a floor.** If CI runtime becomes a problem, the dev MAY reduce to 500 as long as the AC6f code comment documents the reduction and the structural invariants (no two-states-at-once, count === 16) still hold. AC3 contracts the invariant, not the literal 1,000.
- **MCP tool wiring is OUT of scope.** No `state-machine`-related MCP tool ships in this story. Epic 3's `claimStory` / `completeStory` / `blockStory` will compose this primitive with `writeManagedFile` (for the `claimed_by` / `blocked_by` frontmatter writes). Shipping the primitive without callers is the whole point.

### Project Structure Notes

- This story slots cleanly into the architecture's `project-structure-boundaries.md` map: `state/manifest-state-machine.ts` is pre-pinned at that exact path (line 97).
- No new top-level directories. No changes to `pnpm-workspace.yaml`, `tsconfig.base.json`, or `package.json` (no new deps).
- The new test sits alongside the existing test files at `mcp-server/tests/*.test.ts`. The `acceptance.test.ts` file (cross-story orchestration) does not need changes — its scope is structural, and the new artefact is covered by the per-feature test file.
- The `state/` subdirectory currently exists only as a planned tree per the architecture map; this story is the first to populate it. (After 1.6, `state/` contains exactly `manifest-state-machine.ts`. Epic 3 will add `heartbeat-store.ts`, `source-hash.ts`, and `workspace-resolver.ts` — the last of which is actually already at `mcp-server/src/state/workspace-resolver.ts` per the existing 1.2 implementation. Verify before authoring: if `state/` already exists with `workspace-resolver.ts`, the new file simply lands alongside it; if not, `path.dirname` creation happens naturally when the dev creates the file.)

### Deferred work (NOT this story)

- **Windows host support.** `MoveFileEx` on Windows has weaker atomicity guarantees than POSIX `rename(2)`. v1 of the plugin targets macOS/Linux hosts only (Jack's dog-fooding environment). A future story can add Windows-specific handling if Jack ever targets a Windows host — but that's a research task, not a 1.6 task.
- **Stale-claim detection.** The Epic-1 architecture mentions "heartbeat-based stale-claim detection" (`core-architectural-decisions.md` line 29). That mechanism is `state/heartbeat-store.ts` in Epic 5. It is NOT this story's concern.
- **Fault-injection integration harness.** NFR9's "measurement" clause requires a fault-injection test that triggers model timeouts / `gh` rate-limits / subprocess crashes and asserts on directory placement. That harness lives at `mcp-server/tests/integration/` (`project-structure-boundaries.md` line 115) and lands in Epic 5. This story's chaos test (AC6f) is a **prerequisite** — it proves the primitive's atomicity under concurrent load — but it does NOT discharge NFR9's full measurement contract.
- **MCP tool wiring (`claimStory`, `completeStory`, `blockStory`).** Epic 3. The primitive ships substrate-only.
- **`state.transition` telemetry event.** Epic 3. Emitted from the MCP-tool boundary, not from the primitive.
- **Manifest schema (`SourceStory` / `execution-manifest.yaml`).** Already partially scoped in `schemas/source-story.ts` planning per `project-structure-boundaries.md` line 88. Authoring the schema is Epic 3 work. This primitive treats manifest contents as opaque blobs.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md`#Story 1.6]
- [Source: `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md`#State Machine & Persistence (lines 27–40)]
- [Source: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md`#mcp-server tree (line 97), #target-repo tree (lines 148–160), #requirements mapping (line 192)]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md`#NFR8, #NFR9, #NFR19]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md`#FR17, #FR19, #FR20]
- [Source: `_bmad-output/implementation-artifacts/1-5-jsonl-telemetry-plumbing-via-pino.md`] (pattern precedents: `execaImpl?` / `now?` test seam, single-purpose wrapper, substrate-ahead-of-writers, append-only `errors.ts`)
- [Source: `_bmad-output/implementation-artifacts/1-4-permission-allowlist-scaffolding-and-tool-layer-enforcement.md`] (canonical-fs static-guard pattern, path-escape via `path.relative`)
- [Source: `plugins/crew/mcp-server/src/lib/managed-fs.ts`] (path-escape guard idiom — lines 79–90)
- [Source: `plugins/crew/mcp-server/src/lib/git.ts`] (`execaImpl?` seam pattern — model for `fsImpl?`)
- [Source: `plugins/crew/mcp-server/src/lib/logger.ts`] (`now?` seam pattern, no module-level state, substrate-ahead-of-writers)
- [Source: `plugins/crew/mcp-server/src/errors.ts`] (append-only style — read fully before appending)
- [Source: `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts`] (static-guard pattern — `walkTs`, `importRegex`, `promisesAliasRegex`; new block mirrors AC5c)
- [Source: `plugins/crew/mcp-server/package.json`] (declared deps; do not add)

---

## Dev Agent Record

### Agent Model Used

(to be filled in by dev agent)

### Debug Log References

### Completion Notes List

### File List
