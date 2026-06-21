# Story 1.5: JSONL telemetry plumbing via pino

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **a single write path for structured JSONL telemetry events under `<target-repo>/.crew/telemetry/<YYYY-MM>.jsonl`, plus a same-shape `gh`-style wrapper for plugin-side git commits**,
so that **every later epic can emit observable events through one boundary that's parseable without an LLM, and every canonical-state mutation can be staged + committed through one auditable seam**.

This story lands the **telemetry boundary** and the **git-commit boundary** — the two "single write path" primitives the rest of the product depends on:

1. **Telemetry pipeline** — a `pino`-backed logger at `mcp-server/src/lib/logger.ts` that (a) resolves the current month's JSONL file under `<targetRepoRoot>/.crew/telemetry/<YYYY-MM>.jsonl`, (b) creates the directory tree, (c) writes one JSON object per line with `ts` / `type` / `session_id` / `story_id?` / `agent` / `data`, and (d) rolls over cleanly when the month changes mid-process.
2. **Event-schema registry** — a discriminated-union Zod schema at `mcp-server/src/schemas/telemetry-events.ts` whose v1 closed set is `agent.invoke` (the only `type` the dev/reviewer paths emit in Epic 1; later epics extend the union). Every payload is validated at the logger boundary — invalid payloads throw `TelemetryEventInvalidError` AND are themselves recorded as a `tool-quirk`-shaped event so the failure is never silent (FR70 / NFR21 / NFR6).
3. **Logger whitelist into the canonical-fs guard** — `mcp-server/src/lib/logger.ts` is added to the `FS_WRITE_WHITELIST` in `tests/canonical-fs-guard.test.ts` (alongside `lib/managed-fs.ts`). The logger is permitted to import a write-shaped `node:fs` API because it is the *only* writer for `.crew/telemetry/**` — every other code path that wants a telemetry event must call `logTelemetryEvent(...)`.
4. **Git-commit wrapper** — `mcp-server/src/lib/git.ts` exporting a single `gitCommit(opts: { targetRepoRoot, paths, message, role })` function that (a) refuses calls without a role context, (b) runs `git -C <targetRepoRoot> add <paths>` then `git -C <targetRepoRoot> commit -m <message>` via `execa`, (c) returns `{ commitSha, stdout, stderr }`, and (d) refuses any commit message that does not match the conventional `<tool-name>: <ref-or-proposal-id>` shape required by the epic's AC4.

**This story does NOT** (a) register any MCP tool that *calls* the logger (those land in 1.6 atomic-rename and Epics 2–4 — this story ships the substrate ahead of the writers), (b) implement the `recoverable-error` classification (`gh-error-map.yaml`, NFR18, Epic 3), (c) wire the cycle-archive flow (FR69, Epic 5), (d) implement the agreement metric or outcome-stats helpers (FR67–FR68, Epic 6 — those *read* the JSONL this story produces but don't change its shape), (e) ship payloads for every event-type discriminator (only `agent.invoke` is pinned in v1; later epics add `reviewer.verdict`, `state.transition`, `yield.handoff`, etc. through extensions of the same `TelemetryEventSchema` union), or (f) implement asynchronous / buffered writes — v1 uses synchronous pino destinations so a crash before flush doesn't lose events.

The seam: every future MCP tool that records an observable action calls `logTelemetryEvent`. Every future MCP tool that mutates canonical state calls `writeManagedFile` (already shipped 1.4) **then** `gitCommit`. Both routes are role-gated and Zod-validated at the boundary.

---

## Acceptance Criteria

**AC1 — Telemetry events append as one JSON line per call (NFR21):**
**Given** the logger at `mcp-server/src/lib/logger.ts` exporting `logTelemetryEvent(opts: { targetRepoRoot, event })` where `event` is a `TelemetryEvent` carrying a `type` discriminator,
**When** a caller invokes `logTelemetryEvent` with a valid `agent.invoke` event,
**Then** the event is appended as a single JSON line (terminated by `\n`, no trailing comma, no array wrapper) to `<targetRepoRoot>/.crew/telemetry/<YYYY-MM>.jsonl`,
**And** the file is created if it does not exist (and its parent directory is created recursively),
**And** the line is strict-JSON-parseable (`JSON.parse(line.trimEnd())` returns the same shape that was logged, with the `ts` field stamped as an ISO-8601 string with millisecond precision in UTC).

**AC2 — Event with payload that fails its Zod schema is rejected AND recorded (Pattern enforcement / NFR6):**
**Given** an event whose `data` payload fails its `type`-specific Zod schema (for example, `agent.invoke` with `runtime_ms: "fast"` instead of a number),
**When** `logTelemetryEvent` is called,
**Then** the call **throws `TelemetryEventInvalidError`** carrying the offending Zod issue path and message,
**And** a `tool-quirk`-shaped failure event (literal `type: "telemetry.invalid"`) IS written to the current month's JSONL file with `data: { attempted_type, zod_path, zod_message }`,
**And** the original (invalid) event is NOT written.

**AC3 — Month rollover produces two files with no cross-month interleaving:**
**Given** the logger is constructed with a clock seam (`now?: () => Date`, default `() => new Date()`),
**When** events are emitted across two consecutive months (driven by the clock seam in tests),
**Then** the telemetry directory contains exactly two files (`<YYYY-MM>.jsonl` each), with all month-A events in the month-A file and all month-B events in the month-B file (no cross-month interleaving, no events lost on rollover),
**And** the rollover happens transparently inside `logTelemetryEvent` (no `rotate()` method exposed to callers, no per-month logger instances leaked).

**AC4 — Git-commit wrapper is the only path for plugin-side commits (epic AC4):**
**Given** the wrapper at `mcp-server/src/lib/git.ts` exporting `gitCommit(opts: { targetRepoRoot, paths, message, role, execaImpl? })`,
**When** any MCP tool calls `gitCommit` with a `message` matching `/^[a-z][a-z0-9-]*: [^\s].+$/` (a `<tool-name>: <ref-or-proposal-id>` shape),
**Then** the wrapper invokes `execa("git", ["-C", targetRepoRoot, "add", ...paths])` then `execa("git", ["-C", targetRepoRoot, "commit", "-m", message])`, returning `{ commitSha, stdout, stderr }` where `commitSha` is parsed from the post-commit `git -C <targetRepoRoot> rev-parse HEAD`,
**And** a `message` that fails the regex throws `GitCommitMessageMalformedError` **before any subprocess spawn** (verified by an `execaImpl` spy),
**And** a call with `paths: []` throws `GitCommitMessageMalformedError` (empty path set is meaningless),
**And** direct child-process spawning of `git` elsewhere in `mcp-server/src/**` is forbidden by a static guard mirroring AC5b from Story 1.4 (extended to `git` in this story — see AC6c).

**AC5 — Logger boundary is the ONLY file (other than `managed-fs.ts`) that imports a write-shaped fs API for telemetry paths:**
**Given** the static guard in `tests/canonical-fs-guard.test.ts`,
**When** the guard walks `mcp-server/src/**/*.ts`,
**Then** the whitelist set contains exactly `lib/managed-fs.ts` AND `lib/logger.ts` — no other file imports `writeFile` / `writeFileSync` / `appendFile` / `appendFileSync` / `createWriteStream` from `node:fs` or `node:fs/promises`. (Adding the logger to the whitelist is the substantive change in this story.)

**AC6 — Vitest covers telemetry + git enforcement paths (integration):**
`pnpm test` from `plugins/crew/` adds three new test files (`mcp-server/tests/telemetry-logger.test.ts`, `mcp-server/tests/git-commit.test.ts`, and a new sub-test inside the existing `canonical-fs-guard.test.ts` for the `git` direct-spawn ban) plus extends `tests/canonical-fs-guard.test.ts` to allow `lib/logger.ts` in the whitelist. The combined suite asserts:
- **AC6a (happy-path JSONL):** Emit a single `agent.invoke` event to a `mkdtemp`'d target repo. Read the file back; assert it has exactly one trailing-`\n`-terminated line; assert `JSON.parse` of that line round-trips to the original event with the `ts` stamped, monotonic, UTC, millisecond-precise.
- **AC6b (Zod failure path):** Emit an invalid `agent.invoke` event. Assert (i) `logTelemetryEvent` throws `TelemetryEventInvalidError`, (ii) the JSONL file contains exactly one line, (iii) `JSON.parse` of that line has `type: "telemetry.invalid"` with `data.attempted_type === "agent.invoke"`, `data.zod_path === "runtime_ms"` (for the example payload), and `data.zod_message` non-empty.
- **AC6c (month rollover):** Construct the logger with a fake clock that returns `2026-04-30T23:59:59.500Z` then `2026-05-01T00:00:00.500Z`. Emit one event under each clock. Assert exactly two files exist (`2026-04.jsonl`, `2026-05.jsonl`), each with exactly one line, contents partitioned correctly.
- **AC6d (git-commit happy path):** Stub `execaImpl` as a `vi.fn()` that resolves with `{ stdout: "<sha>", stderr: "", exitCode: 0 }`. Call `gitCommit({ targetRepoRoot, paths: ["docs/standards.md"], message: "regenerateStandards: bmad:1.2.3", role: "generalist-dev", execaImpl: spy })`. Assert spy called with `["git", ["-C", root, "add", "docs/standards.md"]]` then `["git", ["-C", root, "commit", "-m", "regenerateStandards: bmad:1.2.3"]]` then `["git", ["-C", root, "rev-parse", "HEAD"]]` — in that order — and the returned `commitSha` matches the stub's stdout.
- **AC6e (git-commit malformed message):** Call `gitCommit` with `message: "no colon here"`. Assert it throws `GitCommitMessageMalformedError` and `execaImpl` was called **zero times**. Repeat with `paths: []`; same expectation.
- **AC6f (`git` direct-spawn ban — static):** Extend the existing direct-spawn static-guard sub-test in `canonical-fs-guard.test.ts` so that it walks `mcp-server/src/**` and asserts no file other than `lib/git.ts` matches `execa(\s*["']git["']` / `spawn(\s*["']git["']` / `spawnSync(\s*["']git["']` / `exec(\s*["']git\s`.
- **AC6g (canonical-fs whitelist updated):** The whitelist `Set<string>` in `tests/canonical-fs-guard.test.ts` now contains `lib/managed-fs.ts` AND `lib/logger.ts`, and the static-import scan still passes (i.e. no further bleed of fs writes into other files).

All sub-tests pass alongside existing suites (smoke 1.1, resolver 1.2, validate-active-adapter 1.2b, standards-doc 1.3, permissions/canonical-fs 1.4). Total expected test count: existing baseline + the three new files' tests; all green, zero skips.

---

## Tasks / Subtasks

- [ ] **Task 1 — Zod schemas for the v1 telemetry event union** (AC: 1, 2, 3, 6a, 6b)
  - [ ] Create `plugins/crew/mcp-server/src/schemas/telemetry-events.ts`.
  - [ ] Export `TelemetryEventBase` — `z.object({ ts: z.string().datetime({ offset: false }).refine(s => s.endsWith("Z"), "must be UTC"), session_id: z.string().min(1), agent: z.string().min(1).regex(/^[a-z0-9-]+$/), story_id: z.string().min(1).optional() }).strict()` — fields common to every event.
  - [ ] Export `AgentInvokeEventSchema` — `TelemetryEventBase.extend({ type: z.literal("agent.invoke"), data: z.object({ runtime_ms: z.number().int().nonnegative(), tokens_in: z.number().int().nonnegative().optional(), tokens_out: z.number().int().nonnegative().optional() }).strict() }).strict()`. (Matches FR65: agent type, story id, runtime, timestamp. `agent` is already on the base; `story_id` is optional on the base; `runtime_ms` on data.)
  - [ ] Export `TelemetryInvalidEventSchema` — `TelemetryEventBase.extend({ type: z.literal("telemetry.invalid"), data: z.object({ attempted_type: z.string().min(1), zod_path: z.string(), zod_message: z.string().min(1) }).strict() }).strict()`. This is the failure-recording event from AC2.
  - [ ] Export `TelemetryEventSchema` — `z.discriminatedUnion("type", [AgentInvokeEventSchema, TelemetryInvalidEventSchema])`. **Closed set in v1.** Adding a new event type is a new schema entry plus a `type` literal — no implicit extension.
  - [ ] Export `type TelemetryEvent = z.infer<typeof TelemetryEventSchema>`.
  - [ ] **Do not** introduce a generic `data: z.record(...)` escape hatch. Every payload is closed (`.strict()`). Implementation-patterns §5 mandates closed payloads.
  - [ ] **Do not** introduce a discriminator name other than `type`. Implementation-patterns §5 pins it.
  - [ ] **Do not** add fields not in the FR65 + Implementation-patterns §5 contract. PII / diff contents are explicitly excluded by NFR14.

- [ ] **Task 2 — Typed errors** (AC: 2, 4, 6b, 6e)
  - [ ] Extend `plugins/crew/mcp-server/src/errors.ts`. Append at the bottom of the file, after `RolePermissionsMalformedError`. Match the existing JSDoc / constructor-options-bag style. Match the existing pattern: subclass `DomainError`, no manual `this.name`.
  - [ ] `TelemetryEventInvalidError` — fields: `attemptedType: string`, `zodPath: string`, `zodMessage: string`. Constructor composes:
    > `Telemetry event of type '<attemptedType>' failed schema validation at '<zodPath>': <zodMessage>. The invalid event was NOT written; a 'telemetry.invalid' failure event was recorded in its place. (NFR21)`
  - [ ] `GitCommitMessageMalformedError` — fields: `message: string`, `paths: readonly string[]`, `reason: string`. Constructor composes:
    > `git commit refused: <reason>. message='<message>', paths=[<paths join ", ">]. Required shape: '<tool-name>: <ref-or-proposal-id>' (lowercase tool name, colon, space, non-empty body). (Story 1.5 AC4)`
    - `reason` is one of: `"message does not match required shape"`, `"paths must not be empty"`. The dev agent picks the right variant at the throw site.
  - [ ] Do **not** touch any of the existing classes. Their wording is asserted by 1.1 / 1.2 / 1.2b / 1.3 / 1.4 tests.

- [ ] **Task 3 — Telemetry logger `logTelemetryEvent`** (AC: 1, 2, 3, 5, 6a, 6b, 6c)
  - [ ] Create `plugins/crew/mcp-server/src/lib/logger.ts`.
  - [ ] Export a single async function:
    `logTelemetryEvent(opts: { targetRepoRoot: string; event: Omit<TelemetryEvent, "ts"> & { ts?: string }; now?: () => Date }): Promise<void>`
    - `event.ts` is **optional from the caller's perspective** — the logger stamps it if absent. If the caller supplies `ts`, the logger validates it (must be UTC ISO-8601 with `Z` suffix, ms precision) and uses it as-is (test seam for deterministic round-trips).
    - `now` is a clock seam, default `() => new Date()`. Tests pass a fake clock to drive month rollover.
  - [ ] Algorithm:
    1. Resolve the stamped event: `const stamped = { ...event, ts: event.ts ?? toIsoMillisUtc(now()) }`. `toIsoMillisUtc` is a tiny helper in this file (no new dep): `d.toISOString()` already produces ms-precise UTC.
    2. Validate via `TelemetryEventSchema.safeParse(stamped)`.
    3. **On failure:**
       a. Compose a `telemetry.invalid` failure event via `TelemetryInvalidEventSchema.parse({ ts: stamped.ts, type: "telemetry.invalid", session_id: stamped.session_id, agent: stamped.agent, story_id: stamped.story_id, data: { attempted_type: String(stamped.type ?? "<missing>"), zod_path: result.error.issues[0]?.path.join(".") ?? "<root>", zod_message: result.error.issues[0]?.message ?? "(no issue details)" } })`. If composing the failure event itself fails (defensive — should be impossible since session_id/agent are taken from the caller and are validated separately), let that throw bubble up; do NOT recurse.
       b. Write the failure event via the writer (step 5).
       c. Throw `TelemetryEventInvalidError({ attemptedType, zodPath, zodMessage })`.
    4. **On success:** write the validated event via the writer (step 5).
    5. Writer:
       a. Compute the month bucket from `stamped.ts`: `const month = stamped.ts.slice(0, 7)` (`YYYY-MM`). Do not re-parse the date — use the string we just produced. Test for `month` matching `/^\d{4}-\d{2}$/` defensively; throw if not (would indicate caller passed a `ts` we somehow accepted but is malformed — should be unreachable post-validation).
       b. Compute the absolute file path: `path.join(targetRepoRoot, ".crew", "telemetry", `${month}.jsonl`)`.
       c. Ensure the directory exists: `fs.mkdir(path.dirname(filePath), { recursive: true })`.
       d. **Append a single line:** `fs.appendFile(filePath, JSON.stringify(validated) + "\n", "utf8")`. (`fs.appendFile` is the banned binding everywhere else; the logger is the whitelisted file per AC5/AC6g.) `JSON.stringify` with no spacing argument produces strict single-line JSON.
  - [ ] **Why not `pino.destination()` per se?** `pino` is a declared dep (`^10.3.1` in `mcp-server/package.json`) and the architecture pins it for this story. The minimum viable pino integration in v1: import pino's `pino-pretty`-free path — concretely, use `pino.destination({ dest: filePath, sync: true, mkdir: false })` to produce a `SonicBoom` writer per-emit call. **However**, pino's main appeal is throughput; this story emits a handful of events per story, so a synchronous `fs.appendFile` keeps the code path one function long and side-steps SonicBoom's worker-thread + month-rollover semantics. **Dev decision (default unless dev finds a blocking reason to switch):** ship `fs.appendFile` in v1; keep pino as the declared dep so a later story can swap the writer without touching callers. Document this in the file's leading JSDoc so the next dev knows why a pino-named module isn't actually constructing a pino logger.
  - [ ] **No module-level state.** Each call resolves the month, ensures the directory, appends, and returns. No cached file handles, no in-memory queue, no per-process rollover registry. (A future story can add SonicBoom-backed buffering when emit-rate becomes a problem; v1 doesn't.)
  - [ ] **No locking.** The plugin runtime is single-process v1 (continuous flow; no concurrent agent sessions writing telemetry from separate processes). If a future story adds multi-process emission, atomic-append on POSIX `O_APPEND` is the natural next step.
  - [ ] **No log levels.** Telemetry is observation, not diagnostic. The schema's `type` discriminator carries all the meaning. (If a debug channel becomes useful later, it goes through a separate file, not this one.)

- [ ] **Task 4 — `gitCommit` wrapper at `mcp-server/src/lib/git.ts`** (AC: 4, 6d, 6e, 6f)
  - [ ] Create `plugins/crew/mcp-server/src/lib/git.ts`. (Second file under `lib/`, alongside `gh.ts`. The architecture map pins this exact location.)
  - [ ] Export a single async function:
    `gitCommit(opts: { targetRepoRoot: string; paths: readonly string[]; message: string; role: string; execaImpl?: typeof execa }): Promise<{ commitSha: string; stdout: string; stderr: string }>`
    - `execaImpl` is a **test seam only** — production callers do not pass it. Default is the live `execa` from `"execa"` (already a runtime dep).
    - `role` is accepted but NOT yet checked against a permission allowlist (no `git_allow` field exists on `RolePermissions` in v1 — the architecture's permission spec scopes role authority via `tools_allow` for MCP tools and `gh_allow` for `gh` subcommands; git is internal-only and reached only from MCP tools that themselves were already gated). The `role` parameter exists so the wrapper can emit a richer telemetry event in a later story; for now it is recorded in the JSDoc as a "future use" field and not consumed.
  - [ ] Algorithm:
    1. Validate `paths.length > 0`. If false, throw `GitCommitMessageMalformedError({ message, paths, reason: "paths must not be empty" })`. **Do not** spawn a subprocess.
    2. Validate `message` against `/^[a-z][a-z0-9-]*: [^\s].+$/`. If false, throw `GitCommitMessageMalformedError({ message, paths, reason: "message does not match required shape" })`. **Do not** spawn a subprocess.
    3. Spawn 1: `await execaImpl("git", ["-C", targetRepoRoot, "add", ...paths])`. Capture `stdout` / `stderr`.
    4. Spawn 2: `await execaImpl("git", ["-C", targetRepoRoot, "commit", "-m", message])`. Capture `stdout` / `stderr` (accumulate; the returned `stdout` is the commit-step output, since that's what carries the human-meaningful information).
    5. Spawn 3: `const rev = await execaImpl("git", ["-C", targetRepoRoot, "rev-parse", "HEAD"])`. `commitSha = rev.stdout.trim()`.
    6. Return `{ commitSha, stdout: <commit-step stdout>, stderr: <commit-step stderr> }`.
  - [ ] **Single-purpose wrapper.** No retry, no `--no-verify`, no `-S` signing, no `--amend`. The dev agent's PR-side commits are governed by the dev catalogue / `gh` allowlist; this wrapper exists for **plugin-side** mutations only (e.g. `regenerateStandards`, `appendPersonaKnowledge` — which the dev agent doesn't write to directly).
  - [ ] Use the existing `execa` dep (`^9.6.1`). **Do not** add `simple-git` or `nodegit` — the wrapper is three subprocess calls, no abstraction needed.
  - [ ] **Do not** wire `gitCommit` into any MCP tool in this story. There are no plugin-side canonical-state-mutating tools yet (those land in Epics 2–6). Shipping the wrapper ahead of the writers is the whole point — the substrate must be impossible to bypass on day one.

- [ ] **Task 5 — Update canonical-fs guard whitelist** (AC: 5, 6g)
  - [ ] Edit `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts`.
  - [ ] **Existing line to modify:** the `FS_WRITE_WHITELIST` `Set<string>` currently contains `path.join(SRC_DIR, "lib", "managed-fs.ts")` and a comment placeholder for the future logger. **Add** `path.join(SRC_DIR, "lib", "logger.ts")` to the Set; **remove** the "Future" comment.
  - [ ] **No other change** to the existing tests in this file — the static-import scan logic stays as-is. Adding `lib/logger.ts` to the whitelist is the substantive shift; the assertion is then satisfied automatically when Task 3 lands.
  - [ ] **Verify** post-change: the existing static-import scan still passes (i.e. no other file accidentally picked up a write-shaped fs import during this story's work). Run `pnpm test` once before commit.

- [ ] **Task 6 — Extend canonical-fs guard with `git` direct-spawn ban** (AC: 4, 6f)
  - [ ] Edit the same file (`tests/canonical-fs-guard.test.ts`), specifically the `describe("static direct-gh-spawn guard …")` block.
  - [ ] Add a parallel `describe("static direct-git-spawn guard (Story 1.5 AC6f)", () => { … })` block at the bottom of the file. Pattern: walk `mcp-server/src/**/*.ts`, skip `lib/git.ts`, fail on any match for `execa(\s*["']git["']` / `spawn(\s*["']git["']` / `spawnSync(\s*["']git["']` / `exec(\s*["']git\s`.
  - [ ] Re-use the same `walkTs` helper that's already in the file — do not duplicate it.
  - [ ] **Pass at least one assertion** in the new block by structuring it as one `it(...)` with an `expect(offences).toEqual([])` — same shape as the `gh`-spawn ban.

- [ ] **Task 7 — Authored vitest suites** (AC: 1, 2, 3, 4, 6)
  - [ ] Create `plugins/crew/mcp-server/tests/telemetry-logger.test.ts`. Covers AC6a, AC6b, AC6c.
    - Use `fs.mkdtemp(os.tmpdir() + "/telemetry-logger-")` for each test's target repo. Clean up in `afterAll`.
    - AC6a: import `logTelemetryEvent` from `../src/lib/logger.js`. Construct an `agent.invoke` event with a fixed `session_id`, `agent: "generalist-dev"`, `story_id: "bmad:1.5"`, `data: { runtime_ms: 1234 }`. Do NOT pass `ts`. Call `await logTelemetryEvent({ targetRepoRoot, event })`. Read the resulting file. Assert: exactly one line, line ends with `\n`, `JSON.parse(line.trimEnd())` returns an object whose `ts` is a UTC ISO string ending in `.<3-digit-ms>Z` and whose other fields match the input.
    - AC6b: construct an invalid `agent.invoke` event (e.g. `data: { runtime_ms: "fast" }` cast through `as unknown as ...` to bypass TS — or omit `runtime_ms` entirely). Call `await logTelemetryEvent(...)`. Assert (i) the call rejects with `TelemetryEventInvalidError`, (ii) the file contains exactly one line, (iii) `JSON.parse` of that line has `type: "telemetry.invalid"`, `data.attempted_type === "agent.invoke"`, `data.zod_path` non-empty, `data.zod_message` non-empty.
    - AC6c: clock seam — pass `now: () => new Date("2026-04-30T23:59:59.500Z")` for the first call, `now: () => new Date("2026-05-01T00:00:00.500Z")` for the second. After both, list the telemetry directory. Assert exactly two `.jsonl` files (`2026-04.jsonl`, `2026-05.jsonl`), each containing exactly one line.
  - [ ] Create `plugins/crew/mcp-server/tests/git-commit.test.ts`. Covers AC6d, AC6e.
    - AC6d: build a `vi.fn()` `execaImpl` that returns different stubs based on the argv: for `["add", ...]` return `{ stdout: "", stderr: "", exitCode: 0 }`; for `["commit", "-m", …]` return `{ stdout: "[main 0123abc] regenerateStandards: bmad:1.2.3", stderr: "", exitCode: 0 }`; for `["rev-parse", "HEAD"]` return `{ stdout: "0123abcdef...\n", stderr: "", exitCode: 0 }`. Call `gitCommit({ targetRepoRoot: "/tmp/fake", paths: ["docs/standards.md"], message: "regenerateStandards: bmad:1.2.3", role: "generalist-dev", execaImpl: spy })`. Assert: spy called three times in the expected order with the expected argv; returned `commitSha === "0123abcdef..."` (trimmed).
    - AC6e variant 1: `gitCommit(..., message: "no colon here", execaImpl: spy)` — assert throws `GitCommitMessageMalformedError`, `spy` called **zero times**.
    - AC6e variant 2: `gitCommit(..., paths: [], message: "valid: ref", execaImpl: spy)` — assert throws `GitCommitMessageMalformedError`, `spy` called **zero times**.

- [ ] **Task 8 — Run the full suite** (AC: all)
  - [ ] From `plugins/crew/`, run `pnpm test`. Expectation: all existing suites green, plus the new `telemetry-logger.test.ts` and `git-commit.test.ts`, plus the extended `canonical-fs-guard.test.ts` (with the new `git`-spawn-ban describe block, and the `lib/logger.ts` added to the whitelist). Zero skips.
  - [ ] From `plugins/crew/`, run `pnpm build`. Expectation: zero TypeScript errors.

---

## Dev Notes

### Files this story creates (NEW)

- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` — discriminated-union Zod schema for the v1 event set.
- `plugins/crew/mcp-server/src/lib/logger.ts` — `logTelemetryEvent` writer. ONLY file (besides `managed-fs.ts`) permitted to import a write-shaped `node:fs` API.
- `plugins/crew/mcp-server/src/lib/git.ts` — `gitCommit` wrapper. Only path for plugin-side commits.
- `plugins/crew/mcp-server/tests/telemetry-logger.test.ts` — covers AC6a–c.
- `plugins/crew/mcp-server/tests/git-commit.test.ts` — covers AC6d–e.

### Files this story modifies (UPDATE)

- `plugins/crew/mcp-server/src/errors.ts` — append `TelemetryEventInvalidError` and `GitCommitMessageMalformedError` after `RolePermissionsMalformedError`. Do not touch existing classes (their wording is asserted by 1.1–1.4 tests).
- `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts` — (a) add `lib/logger.ts` to the `FS_WRITE_WHITELIST` `Set`; (b) append a new `describe(... static direct-git-spawn guard ...)` block at the bottom. Do not modify any existing `it(...)` body.

### Existing files this story reads but does NOT modify

- `plugins/crew/mcp-server/src/lib/managed-fs.ts` — model for "the only writer" pattern. The logger uses the same shape: one file whitelisted, every other caller routed through a single helper.
- `plugins/crew/mcp-server/src/lib/gh.ts` — model for "the only subprocess wrapper" pattern. `git.ts` mirrors this shape (single function export, `execaImpl` test seam, role param, typed error before spawn).
- `plugins/crew/mcp-server/src/errors.ts` — append-only pattern. Match existing JSDoc / constructor-options-bag style.
- `plugins/crew/mcp-server/src/server.ts` — for context only. This story does NOT register MCP tools.

### Architecture compliance (cite the source on every claim)

- **JSONL one-event-per-line, no trailing comma:** `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §5. `JSON.stringify(event) + "\n"` is the literal implementation.
- **`type` discriminator dotted (`domain.event`):** §5. The schema uses `z.discriminatedUnion("type", [...])` and the v1 closed set is `agent.invoke` + `telemetry.invalid`. Later epics extend the union by adding new entries.
- **Telemetry path layout `<target-repo>/.crew/telemetry/<YYYY-MM>.jsonl`:** `architecture/project-structure-boundaries.md` lines 156, 216. The logger constructs this path; nobody else does.
- **Telemetry is append-only:** `architecture/project-structure-boundaries.md` line 185 — "Events written via `logger.ts`; never edited." `fs.appendFile` is the operation; no rewrite, no truncate, no rotation-by-rename.
- **No PII / no diff contents in telemetry (NFR14):** §5. The v1 schema deliberately has no `body` / `contents` / `diff` field. Token counts are numbers; no string payloads carry user content.
- **Pino is the declared logger lib:** `architecture/core-architectural-decisions.md` line 52, `architecture-validation-results.md` line 5. Already in `mcp-server/package.json` at `^10.3.1`. **In v1 we use `fs.appendFile` rather than `pino.destination()`** because (a) emit rate is low, (b) month-rollover semantics are simpler in our own code path, (c) we avoid SonicBoom worker-thread + buffering complexity, (d) we keep the logger entirely synchronous so a crash before flush doesn't lose events (the architecture-validation-results.md line 5 commits to "pino" as the library; this story honours that by keeping the dep declared and the module name `logger.ts`, while implementing the v1 writer directly — a later story can swap to SonicBoom without touching callers).
- **Git wrapper at `mcp-server/src/lib/git.ts`:** epic-1 AC4 (line 137 in the epic file) and `architecture/project-structure-boundaries.md` (implicit via "the gh boundary" treatment — git deserves the same single-wrapper discipline). Commit-message shape `<tool-name>: <ref-or-proposal-id>` is from epic-1 AC4 verbatim.

### Library / framework requirements

| Library | Version | Why | Source |
|---|---|---|---|
| `pino` | `^10.3.1` (already declared) | Pinned as the telemetry logger lib by the architecture (`core-architectural-decisions.md` line 52). Kept as a dep even though v1 uses `fs.appendFile` directly — see "pino is the declared logger lib" above. | `plugins/crew/mcp-server/package.json` |
| `execa` | `^9.6.1` (already declared) | Single subprocess wrapper for the `git.ts` wrapper. Mirrors `gh.ts`'s usage. | `plugins/crew/mcp-server/package.json` |
| `zod` | `^4.4.3` (already declared) | Event-schema validation at the logger boundary. Mirrors existing schemas in `mcp-server/src/schemas/`. | `plugins/crew/mcp-server/package.json` |
| `yaml` | `^2.9.0` (already declared) | NOT used in this story. | — |
| `vitest` | `^2.1.0` (already declared, devDep) | Test framework. | `plugins/crew/mcp-server/package.json` |

**Do NOT add new dependencies.** The dep set above is sufficient. In particular:
- Do NOT add `simple-git` — the wrapper is three `execa` calls.
- Do NOT add `pino-pretty` — telemetry is JSONL, not human-readable.
- Do NOT add `chokidar` or any watcher — the logger is per-call.

### File structure (target paths, after this story)

```
plugins/crew/mcp-server/
├── src/
│   ├── errors.ts                       # UPDATE (append two classes)
│   ├── index.ts                        # unchanged
│   ├── server.ts                       # unchanged
│   ├── adapters/                       # unchanged
│   ├── lib/
│   │   ├── gh.ts                       # unchanged
│   │   ├── git.ts                      # NEW (Task 4)
│   │   ├── logger.ts                   # NEW (Task 3) — whitelisted writer
│   │   ├── managed-fs.ts               # unchanged (still whitelisted)
│   │   └── plugin-version.ts           # unchanged
│   ├── schemas/
│   │   ├── plugin-manifest.ts          # unchanged
│   │   ├── role-permissions.ts         # unchanged
│   │   ├── standards-doc.ts            # unchanged
│   │   ├── telemetry-events.ts         # NEW (Task 1)
│   │   └── workspace-config.ts         # unchanged
│   ├── state/                          # unchanged
│   └── validators/                     # unchanged
└── tests/
    ├── acceptance.test.ts              # unchanged
    ├── canonical-fs-guard.test.ts      # UPDATE (whitelist add + git-spawn ban block)
    ├── git-commit.test.ts              # NEW (Task 7)
    ├── permissions-enforcement.test.ts # unchanged
    ├── smoke.test.ts                   # unchanged
    ├── standards-doc.test.ts           # unchanged
    ├── telemetry-logger.test.ts        # NEW (Task 7)
    ├── validate-active-adapter.test.ts # unchanged
    └── workspace-resolver.test.ts      # unchanged
```

### Testing requirements

- **Framework:** vitest (already wired). `pnpm test` from `plugins/crew/` runs everything.
- **Fixture strategy:** Each test that touches disk uses `fs.mkdtemp(os.tmpdir() + "/<test-name>-")` and cleans up in `afterAll`. Mirrors the pattern in `canonical-fs-guard.test.ts`.
- **No real `git` subprocesses.** Every test in `git-commit.test.ts` stubs `execaImpl`. The static-guard sub-test in `canonical-fs-guard.test.ts` does not spawn anything — it greps source.
- **Determinism:** the clock seam (`now`) is the only path the logger has to non-determinism. Tests pass a fixed `now`; the only float in the output is the `ts` string, which the test asserts to be exactly what the fake clock returned (when explicit) or "an ISO-8601 UTC ms-precise string" (when not).
- **Coverage expectation:** every AC1–AC6 sub-condition has a named `it(...)` block. Total new `it(...)` count: ~8 (3 in telemetry-logger, 3 in git-commit, 2 in canonical-fs-guard extensions).
- **No skips, no `.only`, no `.todo`.** Same bar as 1.1–1.4.

### Previous story intelligence (Story 1.4 — Permission-allowlist scaffolding)

- **Pattern: typed-error sub-classes append to `errors.ts`, never edit existing.** 1.4 added five classes by appending. This story adds two more, same place, same style. Reading the file once before editing confirms which classes are already there (and you should never need to modify their wording — 1.1–1.4 tests assert on it).
- **Pattern: every IO wrapper takes an injection seam (`execaImpl?`, `now?`).** 1.4's `gh.ts` introduced `execaImpl`; this story's `git.ts` mirrors it; this story's `logger.ts` introduces `now`. Production callers never pass the seam; tests always do.
- **Pattern: "the only writer" gets whitelisted in the static guard.** 1.4 set up the whitelist with `managed-fs.ts` as the sole entry; this story adds `logger.ts` as the second (and almost certainly final, in v1) entry. The whitelist pattern is the structural defense — bypassing it requires a static-test failure plus a runtime failure, both visible in CI.
- **Pattern: single-purpose wrappers.** 1.4's `gh.ts` did NOT classify recoverable errors, retry, or write telemetry — those are out-of-scope for the wrapper. This story's `git.ts` mirrors that discipline: no retry, no `--no-verify`, no signing. The wrapper is mechanical.
- **Pattern: ship the substrate ahead of the writers.** 1.4 shipped `writeManagedFile` with NO MCP tool wired to it. This story does the same for `logTelemetryEvent` and `gitCommit`. The substrate's value is structural; later stories supply the callers.
- **Anti-pattern surfaced in 1.4 dev notes (also relevant here):** do NOT extract `formatZodIssues` into a shared `lib/` helper while you're in this story. The 1.4 dev notes explicitly mark this as scope creep. If you find yourself duplicating it across `state/load-role-permissions.ts` and (now) `lib/logger.ts`, that's fine — duplicate it for now. A later story can refactor.
- **Anti-pattern surfaced in 1.4 dev notes:** do NOT cache module-level state. The role-permissions loader re-reads on every call by design. The telemetry logger has no module-level state at all (no cached file handles, no in-memory queue). Caching at this layer would mask stale-spec / wrong-month bugs.

### Project context references

- **Implementation-patterns-consistency-rules.md §5 (JSONL Event Schema):** the closed-payload + dotted-discriminator + no-PII contract the schema enforces.
- **core-architectural-decisions.md (Telemetry & Observability):** the file-layout + monthly-rollover + parseable-without-LLM contract.
- **project-structure-boundaries.md (Architectural boundaries):** "Telemetry is append-only. Events written via `logger.ts`; never edited."
- **FR65 (per-agent-invocation entry):** the minimum payload shape (agent type, story id, runtime, timestamp) that `AgentInvokeEventSchema` enforces.
- **NFR14 (no PII in telemetry):** schema-enforced by closing every `data` payload.
- **NFR21 (structured telemetry, parseable without LLM):** schema-enforced by JSONL + `JSON.parse` round-trip in AC6a.
- **NFR6 (no silent failures):** AC2's "the failure event is recorded even when the original is rejected" contract.
- **Epic-1 AC4 ("…committed via `mcp-server/src/lib/git.ts` with a structured commit message…"):** the git-wrapper requirement + commit-message shape.
- **Implementation-readiness-report-2026-05-19.md C4:** flags that this story bundles two primitives. We acknowledge and ship both — splitting was deferred as a "nice to have"; the story is well-bounded as written.

### Reasonable defaults & decisions (do NOT pause to confirm these)

- `agent` field regex: kebab-case-only (`/^[a-z0-9-]+$/`). Matches the catalogue's `role:` convention and the `RolePermissions` role regex from 1.4.
- `session_id`: opaque string from caller (will be a ULID per the architecture's `session_id: "<ulid>"` example, but the logger doesn't enforce ULID shape — that's the caller's responsibility, validated at the MCP tool boundary in later stories).
- `story_id`: optional, opaque string (will be a `<adapter>:<source-id>` ref per the architecture's `story_id: "<ulid>"` example; same reasoning as `session_id` — not enforced here).
- `ts` format: `Date#toISOString()` (always ms-precise UTC ending in `Z`). The schema's `.datetime({ offset: false }).refine(s => s.endsWith("Z"), ...)` enforces this.
- Month bucket derivation: string slice of `ts.slice(0, 7)`. No `Date` re-parse — the boundary just produced this string.
- Failure-event `data` shape: only the surfacing fields (`attempted_type`, `zod_path`, `zod_message`). NOT the full invalid payload. Including the invalid payload risks PII leaking into telemetry (NFR14) — we deliberately drop it.
- Git-wrapper `role` param: accepted but not yet allowlist-checked. The catalogue's `tools_allow` already gates which MCP tool can call `gitCommit`, so an extra git-side allowlist would be redundant in v1.
- Commit-message regex: `/^[a-z][a-z0-9-]*: [^\s].+$/`. Lower-case tool name (kebab-allowed), colon, single space, non-whitespace first character of the body, at least one more character. Matches `regenerateStandards: bmad:1.2.3` (the architecture's example) and `appendPersonaKnowledge: <ulid>` (anticipated later usage). The CLAUDE.md note about Jack's PM-language framing — these regexes are tactical (engineer-level decisions); they do not need PM ratification.
- **`pino` named in the story title vs `fs.appendFile` in the implementation:** kept the story title to honor the planning contract; documented the decision in the file's leading JSDoc. A later story can swap to a SonicBoom-backed writer without changing callers.

### Project Structure Notes

- This story slots cleanly into the architecture's `project-structure-boundaries.md` map: `lib/logger.ts` and `lib/git.ts` are both pre-pinned at those exact paths.
- No new top-level directories. No changes to `pnpm-workspace.yaml`, `tsconfig.base.json`, or `package.json` (deps already declared).
- The new tests sit alongside the existing test files at `mcp-server/tests/*.test.ts`. The `acceptance.test.ts` file (which orchestrates cross-story acceptance checks) does not need changes — its scope is structural, and the new artefacts are covered by per-feature test files.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md`#Story 1.5]
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md`#5. JSONL Event Schema]
- [Source: `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md`#Telemetry & Observability]
- [Source: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md`#Architectural boundaries]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md`#FR65, FR70]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md`#NFR6, NFR14, NFR21]
- [Source: `_bmad-output/implementation-artifacts/1-4-permission-allowlist-scaffolding-and-tool-layer-enforcement.md`] (pattern precedents)
- [Source: `plugins/crew/mcp-server/src/lib/managed-fs.ts`] (writer-whitelist pattern)
- [Source: `plugins/crew/mcp-server/src/lib/gh.ts`] (single-purpose wrapper pattern)
- [Source: `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts`] (static-guard pattern + whitelist Set to edit)
- [Source: `plugins/crew/mcp-server/package.json`] (declared deps; do not add)

---

## Dev Agent Record

### Agent Model Used

(to be filled in by dev agent)

### Debug Log References

### Completion Notes List

### File List
