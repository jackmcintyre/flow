# Story 5.30: MCP cascade halt seam in `/crew:start` + lifecycle-log diagnostic fields

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **(a) `/crew:start` to halt cleanly with a verbatim recovery line when the parent MCP child has been killed mid-cycle by Claude Code's subagent-termination cascade, and (b) the lifecycle log to carry `ppid` + `pgid` (and optional `sessionUlid`) on every event so the next process-tree incident is observable from the log file alone**,
So that **(i) the MCP-cascade failure mode stops manifesting as a stranded in-progress manifest with no operator-visible explanation, and (ii) future root-cause analyses on disconnect events take minutes rather than the multi-hour pid/log-correlation pass that surfaced the cascade in the first place**.

This story is the v1 acceptance of an architectural Claude Code defect: when a subagent's `Task` returns, the host sends SIGTERM to BOTH MCP children — the subagent's (expected) AND the parent session's (the bug). Evidence: 8/8 SIGTERMs in `~/.crew/mcp-lifecycle.log` paired ≤1ms across 4 distinct incidents. Stories 5.10/5.11/5.12 and 5.25 addressed a different failure mode (idle-reap); they do not stop this one. The fix surface lives outside the plugin (Anthropic owns it). What we ship here is **clean halt + recovery prose + diagnostic instrumentation** so the operator loses no work and the next incident is RCA'd from the log file instead of inference.

### Path-decision preamble

Three credibly-different paths were considered (full memo: `~/.claude/plans/linked-knitting-stardust.md`):

- **(A) Accept + document (this story).** SKILL.md gains a halt seam that fires on a deterministic MCP-disconnect signal during the inner cycle. The verbatim halt line tells the operator exactly what happened and exactly how to recover (restart Claude Code, re-run `/crew:start`, choose `reattach` on the orphan that Story 5.20 will surface). Lifecycle log gains the diagnostic fields that should have been there from day one. ~1 day. No behaviour change on the happy path.
- **(B) HTTP MCP daemon outside host process tree.** Convert stdio → streamable-HTTP transport; run an OS-level user daemon owning the MCP server. Daemon parentless to host process tree — cascade can't reach it. 4–7 days. Largest single ergonomic regression in the install path (first-install setup, launchd/systemd, port discovery, auth token). Solves the bug fully.
- **(D2) Detached proxy + parent-owned daemon.** Plugin manifest points at a stdio shim that `spawn(..., { detached: true, setsid: true })`s the real server and forwards JSON-RPC over a unix socket. 2–3 days. Same outcome as B for one-third the engineering. v1.1 candidate.

**Path chosen: A.** Trade-offs considered:
- Path B and D2 are real fixes but require engineering effort that the v1 proof-point cut cannot absorb (memory `project_reframe_proof_point`). Each restart loop is measured in seconds; the cost is operator UX inconvenience, not lost work — provided the halt seam fires deterministically and the orphan-recovery branch (Story 5.20) holds.
- D2 is the right v1.1 investment. The diagnostic fields shipped here are pre-work for that spike: if D2 ever happens, the lifecycle log will tell us whether the detached proxy stayed in its own process group.
- Without the halt seam, operators see "tools no longer available" mid-cycle with no actionable next step — exactly the failure that prompted the 2026-05-25 rollback. The story is small enough that deferring it for a "real fix" later costs more than shipping it now.

### What this story does (and why it needs its own story)

The MCP-cascade RCA (`~/.claude/plans/linked-knitting-stardust.md`, 2026-05-28) confirmed a process-group SIGTERM that paired the subagent's MCP child with the parent's MCP child. Today, when this fires mid-inner-cycle:

1. The dev `Task` returns. The transcript is persisted to disk by step 4.5 (Story 5.10 invariant holds — that step does not depend on MCP).
2. Step 5 calls `processDevTranscript`. The MCP child is already dead from the cascade SIGTERM emitted at `Task` return. The MCP SDK surface returns a "tools no longer available" / "MCP server has disconnected" error.
3. Today's prose layer has **no typed path** for this. The skill either retries (LLM under load) or surfaces a generic error without telling the operator what to do.
4. The in-progress manifest is left stranded. Recovery requires a Claude Code restart, but the operator must infer this from the error text — the chat surface does not say it.

This story closes that gap with two changes:
- **A typed `McpDisconnectedError` raised from a thin wrapper** around every MCP call inside the inner cycle. Catch-site in SKILL.md emits a verbatim halt line then stops. The deterministic-seam principle (memory `feedback_default_to_deterministic_seams`) applies: the error class is the contract, not the prose mandate (memory `feedback_prose_mut_steps_need_seam`).
- **`ppid` + `pgid` fields on every lifecycle log line.** Mandatory. The cascade was invisible for weeks because the log carried only `pid`. With `pgid`, the paired-SIGTERM pattern (every kill shares a process group across subagent + parent) is visible from a single `awk` pass. `sessionUlid` is optional — included if the runtime exposes it via env var; skipped without it.

### What this story does NOT

- (a) Fix the cascade. The cascade is architectural in Claude Code. We are accepting it.
- (b) Add a parent-side reconnect orchestrator. We cannot reconnect from the child side.
- (c) Convert stdio → HTTP transport. That is Path B / D2 future work.
- (d) Detach the MCP server with `setsid` / `detached: true`. That is Path D2 future work.
- (e) Add a heartbeat-based liveness check from the prose layer. AC1's typed-error wrapper catches MCP unavailability at call time; speculative liveness probes would add MCP traffic without changing the failure mode's resolution.
- (f) Change any MCP tool, schema, descriptor, or permission allowlist. The `createServer()` factory, the dispatcher, and the tool registry are unchanged. The wrapper lives in `plugins/crew/skills/start/SKILL.md` (prose) and `plugins/crew/mcp-server/src/errors.ts` (new typed error class) — neither modifies tool surfaces.
- (g) Modify any other skill prose. Only `plugins/crew/skills/start/SKILL.md` gains the halt seam — `/crew:plan`, `/crew:hire`, etc. are not in the cascade path because they do not spawn subagents.
- (h) Update README or the PRD `non-functional-requirements.md`. Those docs need a known-issues note but are explicitly out of scope here (per Jack's brief). A docs follow-up will land them once the substrate fix is in.
- (i) Auto-restart Claude Code. The halt seam tells the operator to restart — it does not invoke a restart itself. v1 keeps the human in the loop for restart events.
- (j) Add log rotation. The lifecycle log inherited from Story 5.25 is append-only with no rotation; this story does not change that.
- (k) Add a new MCP tool that exposes the disconnect state. The halt seam relies on the typed error already raised at the SDK call site — no introspection tool is needed.

### Deferred work

- **Path D2 (detached proxy + parent-owned daemon).** Half-day spike to confirm plugin manifest will route to a stdio proxy that re-execs detached; if confirmed, build it. Becomes v1.1's headline reliability story.
- **Path B (HTTP MCP daemon).** Larger surface; only worth doing if D2 turns out to be blocked by manifest constraints.
- **README + PRD non-functional-requirements note.** Documented limitation entry, two-paragraph section explaining the cascade and the operator's recovery path. Authored as a docs follow-up after this story ships so the README links to the shipped halt seam.
- **`sessionUlid` correlator field if env-var path proves brittle.** v1 of the diagnostic includes `sessionUlid` as an optional field via env var. If operators report that the value is frequently absent in production logs, a follow-up can derive it from a shared file written by `/crew:start` at session start. Not in v1 — the env-var path is the simplest fail-open seam.
- **Auto-restart UX.** If the operator-restart cadence proves disruptive in practice, a follow-up can investigate whether Claude Code exposes a programmatic restart hook. Not in v1.
- **Upstream bug report to Anthropic.** Filed separately to `/crew:*` work; tracked in the project notes.

---

## Acceptance Criteria

> ACs are reproduced from this story's epic block (`epic-5 § Story 5.29`) with per-AC implementation detail added below each one. AC markers (`artifact:` / `vitest:`) use plain unbacked-tick form per memory `project_reviewer_toolchain_gaps` (entry 1).

**AC1:**
A new typed error class `McpDisconnectedError` exists in `plugins/crew/mcp-server/src/errors.ts`, extending `DomainError`. The MCP-call wrapper used by `/crew:start`'s inner cycle (a small helper in the prose-layer's deterministic-seam set) catches the SDK's "tools no longer available" / "MCP server has disconnected" surface and re-raises as `McpDisconnectedError`. The class carries: `methodName` (which MCP call was attempted), `causeMessage` (the SDK's raw error text), and optional `ref` (the in-flight story).
artifact: plugins/crew/mcp-server/src/errors.ts

<!-- Implementation: the typed error class is the contract. The prose-layer wrapper does NOT need to live in the MCP server — it lives wherever the SKILL.md prose calls MCP from. The cleanest placement is a small helper in `plugins/crew/mcp-server/src/lib/` exported for use by any future SKILL.md call site, but if SKILL.md prose can directly try/catch the SDK's error and throw `McpDisconnectedError`, that also satisfies AC1. Dev's choice — what matters is the typed surface, not the helper file's location. The error text should be: `MCP child unavailable mid-cycle — likely SIGTERM cascade on subagent Task return. See ~/.crew/mcp-lifecycle.log for paired-SIGTERM evidence.` -->

**AC2:**
`plugins/crew/skills/start/SKILL.md` gains a new "Failure modes" entry for `McpDisconnectedError`. When this error is caught at any MCP call site inside the inner cycle (steps 5, 8a, 9, 10a, 10b, 11, 12 per the SKILL.md numbering), the prose layer emits the following verbatim halt line and stops:

```
[mcp-cascade-halted] MCP child killed by subagent Task termination — restart Claude Code and re-run /crew:start. The in-progress manifest will surface as an orphan; choose "reattach" to resume without losing work.
```

The halt line is searchable in `plugins/crew/skills/start/SKILL.md` (exact string match). After emitting the line, the inner cycle MUST stop — no further MCP calls are attempted; the manifest is left in `in-progress/` for Story 5.20's orphan-recovery branch to surface on the next restart. The failure-mode entry also references memory `project_mcp_cascade_sigterm` for operator follow-up.
artifact: plugins/crew/skills/start/SKILL.md

<!-- Implementation: add the failure-mode entry in the "Failure modes" section alongside the existing entries (around line 181 of SKILL.md). The verbatim halt line must appear in the SKILL.md file as a fenced code block so the artifact check can grep for it. The MCP-call-site coverage is broad — every MCP call between step 5 (processDevTranscript) and step 12 (runAutoMergeGate) is in scope; dev may either wrap each call individually or wrap the inner-cycle body in a single try/catch as long as the halt seam is fired exactly once per cycle. Step 4.5 (Write tool — Story 5.10) is NOT in scope because Write is not an MCP call. -->

**AC3 (integration):**
A vitest test in `plugins/crew/mcp-server/src/__tests__/mcp-lifecycle-log.test.ts` (extending the existing file) asserts that every event emitted by `createLifecycleLog().log(...)` and `createLifecycleLog().logSync(...)` carries `ppid` and `pgid` fields. The test covers every event-name the server emits today: `boot`, `transport.connected`, `tool.call`, `keepalive.sent`, `keepalive.response`, `keepalive.error`, `stdin.end`, `stdin.close`, `stdout.error`, `transport.onclose`, `signal`, `uncaughtException`, `unhandledRejection`, `beforeExit`, `exit`. `sessionUlid` MAY be present when `CREW_SESSION_ULID` env var is set; the test covers both presence and absence cases.
vitest: plugins/crew/mcp-server/src/__tests__/mcp-lifecycle-log.test.ts

<!-- Implementation: the simplest path is to modify `plugins/crew/mcp-server/src/lib/lifecycle-log.ts` to bake `ppid` and `pgid` into the `buildLine` function so they appear on every line without per-call-site changes. `process.ppid` is available synchronously on every platform; `process.getpgrp()` is POSIX-only but `os.platform() !== 'win32'` gates the call (return undefined on Windows — the test should skip pgid assertion on Windows or set it to a sentinel). The integration test in `mcp-lifecycle-log.test.ts` can extend the existing event-sequence assertion to also assert `ppid` is a number and `pgid` is a number (or undefined on Windows). -->

**AC4 (integration):**
A vitest test in `plugins/crew/mcp-server/src/__tests__/start-skill-mcp-disconnect.test.ts` (new file) simulates an MCP disconnect during the inner cycle and asserts that (a) the verbatim halt line is emitted, and (b) no further MCP calls are attempted after the halt. The test uses a stub MCP boundary that throws on the second call (after `claimNextStory` succeeds and `processDevTranscript` is invoked); the prose-layer wrapper must catch and re-raise as `McpDisconnectedError`; the test asserts the halt-line string is present in the captured chat output and that no third MCP call is made.
vitest: plugins/crew/mcp-server/src/__tests__/start-skill-mcp-disconnect.test.ts

<!-- Implementation: the existing test pattern in `plugins/crew/mcp-server/src/__tests__/start-skill-blocked-recovery.test.ts` is the closest precedent — it tests SKILL.md prose behaviour by invoking the wrapper helpers directly. The new test should follow that shape: import the wrapper helper (or `McpDisconnectedError` class), simulate the SDK throwing the disconnect-text error, assert the typed error is raised with the expected fields, and assert the verbatim halt-line constant matches the string in SKILL.md. If the halt line is only present in SKILL.md prose (not as an exported constant), the test reads SKILL.md, greps for the verbatim line, and asserts it exists. The "no further MCP calls" assertion is implemented by counting calls on a spy harness — exact call count = 2 (the successful first call + the throwing second call). -->

---

## Tasks / Subtasks

Implementation order is load-bearing. Task 1 ships the diagnostic fields first (independently valuable — improves observability on any future incident, including any other disconnect class). Task 2 ships the typed error class. Task 3 wires the halt seam into SKILL.md. Task 4 ships the tests.

- [ ] **Task 1: Add ppid + pgid (+ optional sessionUlid) to every lifecycle log line** (AC: #3)
  - [ ] 1.1 Modify `plugins/crew/mcp-server/src/lib/lifecycle-log.ts`. In the `buildLine` helper, after the existing `pid` field, add `ppid: process.ppid` and `pgid: <pgid>` where `<pgid>` is `process.getpgrp()` on POSIX and `undefined` on Windows (gate via `os.platform() !== 'win32'`).
  - [ ] 1.2 Add an optional `sessionUlid` field: if `process.env.CREW_SESSION_ULID` is set, include it; otherwise omit the key (do not write `sessionUlid: undefined`).
  - [ ] 1.3 Extend the existing unit test at `plugins/crew/mcp-server/src/lib/__tests__/lifecycle-log.test.ts` to assert `ppid` and `pgid` appear on every logged line, and that `sessionUlid` is honoured when `CREW_SESSION_ULID` is set.
  - [ ] 1.4 Extend the existing integration test at `plugins/crew/mcp-server/src/__tests__/mcp-lifecycle-log.test.ts` (per AC3) to assert the new fields on each event-type the server emits. Cover both the `log` (async) and `logSync` (sync) code paths.

- [ ] **Task 2: Add `McpDisconnectedError` typed error class** (AC: #1)
  - [ ] 2.1 In `plugins/crew/mcp-server/src/errors.ts`, declare `export class McpDisconnectedError extends DomainError`. Constructor takes `{ methodName: string; causeMessage: string; ref?: string }`. Message template: `MCP child unavailable mid-cycle — likely SIGTERM cascade on subagent Task return. methodName=<methodName>, cause=<causeMessage><optional " ref=" + ref>. See ~/.crew/mcp-lifecycle.log for paired-SIGTERM evidence.`
  - [ ] 2.2 Add a small detection helper in `plugins/crew/mcp-server/src/lib/` (suggested filename: `detect-mcp-disconnect.ts`): export `isMcpDisconnectError(err: unknown): boolean` that returns true if the error's message matches the SDK's disconnect surface (`tools no longer available`, `MCP server has disconnected`, `connection closed`, or similar). The helper is the contract for the prose-layer wrapper — SKILL.md uses it.
  - [ ] 2.3 Unit-test the helper at `plugins/crew/mcp-server/src/lib/__tests__/detect-mcp-disconnect.test.ts` with at least 3 positive matches and 2 negatives (a generic Error, a domain error from `errors.ts`).

- [ ] **Task 3: Wire the halt seam into `/crew:start` SKILL.md** (AC: #2)
  - [ ] 3.1 In `plugins/crew/skills/start/SKILL.md`, add a new entry in the "Failure modes" section for `McpDisconnectedError`. Place it after the `Write` failure entry (around line 211) so the cascade entry sits with the other "MCP died mid-cycle" entries. Reference memory `project_mcp_cascade_sigterm`.
  - [ ] 3.2 Add the verbatim halt line as a fenced code block in the failure-mode entry. The exact line: `[mcp-cascade-halted] MCP child killed by subagent Task termination — restart Claude Code and re-run /crew:start. The in-progress manifest will surface as an orphan; choose "reattach" to resume without losing work.`
  - [ ] 3.3 In the "Inner cycle" section, add a one-paragraph invariant note above the existing invariants (around line 80) stating: every MCP call inside the inner cycle MUST be wrapped such that `isMcpDisconnectError(err)` true cases throw `McpDisconnectedError`; the catch-site surfaces the verbatim halt line and stops. Reference the deterministic-seam principle (memory `feedback_default_to_deterministic_seams`) so future prose changes do not regress to ad-hoc retry loops.
  - [ ] 3.4 Verify the verbatim halt line appears EXACTLY once in SKILL.md (grep `[mcp-cascade-halted]`). The artifact check in AC2 greps for this exact string.

- [ ] **Task 4: Test suite** (AC: #3, #4)
  - [ ] 4.1 Per AC3, extend `plugins/crew/mcp-server/src/__tests__/mcp-lifecycle-log.test.ts` and `plugins/crew/mcp-server/src/lib/__tests__/lifecycle-log.test.ts` to cover `ppid` + `pgid` + `sessionUlid` per Task 1.3/1.4.
  - [ ] 4.2 Per AC4, create `plugins/crew/mcp-server/src/__tests__/start-skill-mcp-disconnect.test.ts`. Use the spy-harness pattern from `start-skill-blocked-recovery.test.ts`. Assert: (a) `isMcpDisconnectError(err)` returns true on the SDK's disconnect-text error; (b) `McpDisconnectedError` is raised with the expected `methodName` / `causeMessage` fields; (c) the verbatim halt line appears in SKILL.md (read the file, grep the exact string); (d) the wrapper does not attempt a third MCP call after the halt fires (call-count assertion = 2).
  - [ ] 4.3 `pnpm vitest --run` from `mcp-server/` — full suite must pass. No new failures.

- [ ] **Task 5: Build, dist, drift check** (AC: all)
  - [ ] 5.1 `pnpm build` from `mcp-server/` — produces clean dist (tsc + normalise-dist.mjs, per Story 5.28).
  - [ ] 5.2 Second `pnpm build` confirms byte-identical output (Story 5.24 determinism invariant holds).
  - [ ] 5.3 Commit `plugins/crew/mcp-server/dist/` changes alongside src changes (CLAUDE.md § Plugin build output is tracked in git).

---

## Implementation strategy

### Why the typed error class, not a prose-only check

Memory `feedback_default_to_deterministic_seams` and `feedback_prose_mut_steps_need_seam` both apply. The SKILL.md prose alone — "if you see a disconnect error, halt" — is not load-bearing under LLM-under-load conditions. The typed error class is the contract: any MCP call that disconnects throws a specific class; the catch-site is one line of prose pointing at one line of code. Future reviewers can grep for `McpDisconnectedError` and see every catch-site at once.

### Why the halt line is verbatim, not templated

Jack's standing preference (memory `project_locked_phrase_grammar_drift`): operator-facing halt lines that downstream tooling (or operator muscle memory) keys off must be byte-stable. The line is short, scannable, and contains the operator action verbatim ("restart Claude Code and re-run `/crew:start`"). Templating it would invite "MCP server unavailable: <method>"-style drift that breaks the searchable contract.

### Why ppid + pgid are mandatory, not optional

The cascade pattern was invisible for weeks because the lifecycle log carried only `pid`. With `pgid`, the paired-SIGTERM pattern (every kill shares a process group across subagent + parent) is visible from a single `awk` pass. With `ppid`, the parent-child relationship to the host (vs. to a subagent's host fork) is unambiguous. These two fields are the difference between "the next disconnect's RCA is minutes" and "weeks." Optional fields invite "I forgot to set the env var" drift; mandatory fields do not.

### Why `sessionUlid` is optional

It's the most operator-visible field but the hardest to thread through. The MCP server is spawned by Claude Code; we cannot inject env vars at spawn time without modifying the plugin manifest (which we are not doing in this story). The env-var path (`CREW_SESSION_ULID`) is fail-open: if the operator's harness sets it, it shows up; if not, the absence is documented. v1 ships the simplest seam; if operators report the field is frequently absent, a follow-up can derive it from a shared file.

### Why we don't wrap step 4.5 (Write tool)

Step 4.5 of SKILL.md is the dev-transcript persistence write — it uses Claude Code's built-in `Write` tool, not MCP. The cascade kills the MCP child but not the host's built-in tools. Story 5.10's invariant (transcript persists before any MCP call) is the design that makes the cascade survivable in the first place. The wrapper only needs to cover the MCP calls.

### Why the test reads SKILL.md for the halt line

The halt line is prose, not code. Asserting it from a unit test requires either (a) extracting it into an exported constant and asserting against that, or (b) reading the file and greping. Option (a) means the SKILL.md prose is a downstream of the code — but the prose is the operator-facing surface, so it should be the source of truth. Option (b) treats SKILL.md as the contract and the test asserts the contract is met. Choosing (b) — keeps the prose canonical.

---

## Locked files

- `plugins/crew/mcp-server/src/server.ts` — NOT touched. The `createServer()` factory, the dispatcher, and the tool registry are unchanged.
- `plugins/crew/mcp-server/src/tools/**` — NOT touched.
- `plugins/crew/mcp-server/src/schemas/**` — NOT touched.
- `plugins/crew/permissions/**` — NOT touched. No allowlist changes (`McpDisconnectedError` does not need permission scaffolding; it is a thrown class, not an MCP tool).
- `plugins/crew/.claude-plugin/plugin.json` — NOT touched. The manifest is the surface that would change for Path D2; this story stays on Path A.
- `plugins/crew/mcp-server/package.json` — NOT touched. No new dependencies; everything is Node stdlib + existing exports.
- `plugins/crew/skills/start/SKILL.md` is NOT locked for this story — it is the primary modify surface for AC2.

### Declared-locked-file changes (explicit exceptions)

- `plugins/crew/mcp-server/src/lib/lifecycle-log.ts` (Story 5.25) — Task 1 adds `ppid` / `pgid` / `sessionUlid` to `buildLine`. No other behaviour changes; the existing fail-open semantics and disabled-on-error path are preserved.
- `plugins/crew/mcp-server/src/errors.ts` (Story 1.4 and successors) — Task 2 adds `McpDisconnectedError`. Additive only; no existing classes modified.
- `plugins/crew/skills/start/SKILL.md` (Story 4.2 and successors) — Task 3 adds the failure-mode entry and an inner-cycle invariant note. Additive only.
- `plugins/crew/mcp-server/dist/**` (Story 1.9 dist-shipping contract) — Task 5 rebuilds and ships.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/lib/detect-mcp-disconnect.ts` (Task 2.2) — small helper exporting `isMcpDisconnectError(err: unknown): boolean`. ~15 lines.
- `plugins/crew/mcp-server/src/lib/__tests__/detect-mcp-disconnect.test.ts` (Task 2.3) — unit test for the helper.
- `plugins/crew/mcp-server/src/__tests__/start-skill-mcp-disconnect.test.ts` (Task 4.2) — integration test per AC4.

### Files this story will modify

- `plugins/crew/mcp-server/src/lib/lifecycle-log.ts` (Task 1) — add `ppid` / `pgid` / optional `sessionUlid` to `buildLine`.
- `plugins/crew/mcp-server/src/lib/__tests__/lifecycle-log.test.ts` (Task 1.3) — extend assertions.
- `plugins/crew/mcp-server/src/__tests__/mcp-lifecycle-log.test.ts` (Task 1.4) — extend assertions.
- `plugins/crew/mcp-server/src/errors.ts` (Task 2.1) — add `McpDisconnectedError`.
- `plugins/crew/skills/start/SKILL.md` (Task 3) — add failure-mode entry + invariant note.
- `plugins/crew/mcp-server/dist/**` (Task 5) — rebuilt artefacts.

### Files this story will NOT modify

- `src/server.ts`, `src/tools/`, `src/schemas/`, `src/permissions/` (see Locked files).
- `plugins/crew/.claude-plugin/plugin.json` — Path D2 territory.
- `plugins/crew/README.md`, PRD `non-functional-requirements.md` — docs follow-up.
- Any other skill prose (`plugins/crew/skills/plan/`, `plugins/crew/skills/hire/`, etc.) — only `/crew:start` has the cascade exposure.

### Current-state notes on files being modified

- `plugins/crew/mcp-server/src/lib/lifecycle-log.ts` (post-5.25, 122 lines): `buildLine` at lines 64–72 currently writes `{ event, ts, pid, ...fields }`. Task 1 adds `ppid` and conditional `pgid`/`sessionUlid` between `pid` and `...fields`. Field order is observed by the existing log file — keep `pid` first for backwards compatibility with any external `awk` scripts. Putting `ppid`/`pgid` immediately after `pid` keeps related fields contiguous.
- `plugins/crew/mcp-server/src/errors.ts` (post-5.27, large file): the existing pattern for typed errors is `class Foo extends DomainError`. Each class carries readonly fields and a constructor template. `McpDisconnectedError` follows the same shape.
- `plugins/crew/skills/start/SKILL.md` (post-5.21, 245 lines): the "Failure modes" section starts at line 181 with one-line entries per error class. The new entry should be ~3 lines (one for the title, one for the body, one for the verbatim halt-line fenced block). The "Inner cycle" section starts at line 69 with bolded "**Invariant: ...**" entries — the new invariant note follows that pattern.

### Spec citations and evidence (read-only context)

- 8/8 paired SIGTERMs in `~/.crew/mcp-lifecycle.log` across 4 distinct incidents (RCA memo at `~/.claude/plans/linked-knitting-stardust.md`).
- Story 5.10's transcript-persistence invariant means the dev-side work survives the cascade — the operator loses no completed work, only the in-flight reviewer cycle.
- Story 5.20's orphan-recovery branch handles the dev-shipped+reviewer-retry case: on restart, `/crew:start` surfaces the stranded manifest as an orphan with `hasOpenPR=true` and `hasTranscript=true`; the operator chooses `reattach` and the reviewer-only spawn drives the rework. No second MCP child boots during reviewer-only spawn, so no second cascade.
- MCP-cascade RCA confirms idle-reap (Story 5.12/5.25) is a different failure mode — the keepalive code is innocent and was responding green up to the kill in every observed incident.

### Testing standards

- vitest, `pnpm vitest --run` from `mcp-server/`.
- The new integration test (AC4) uses the spy-harness pattern from `start-skill-blocked-recovery.test.ts` — no real MCP child spawned; the wrapper is tested by simulating the SDK's error surface and asserting the typed throw + halt-line presence.
- The lifecycle-log integration test (AC3) extends the existing event-sequence pattern from `mcp-lifecycle-log.test.ts` — spawns the real dist, drives a tools/list, sends SIGTERM, asserts ppid+pgid fields on every logged line.
- All new tests declare explicit `{timeout: 15000}` for any test that spawns a child process; under 5s for pure logic tests.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md § Story 5.30`] — this story's epic block.
- [Source: `~/.claude/plans/linked-knitting-stardust.md`] — the RCA memo behind this story, including alternative paths B and D2.
- [Source: `_bmad-output/implementation-artifacts/5-25-always-on-mcp-lifecycle-logging.md`] — Story 5.25 spec for the lifecycle log this story extends.
- [Source: `_bmad-output/implementation-artifacts/5-10-persist-dev-transcript-to-disk-before-any-mcp-call.md`] — the transcript-persistence invariant that makes the cascade survivable.
- [Source: `_bmad-output/implementation-artifacts/5-20-orphan-recovery-reviewer-only-respawn.md`] — the orphan-recovery branch that this story's halt seam relies on.
- [Source: `plugins/crew/skills/start/SKILL.md`] — current `/crew:start` prose; Task 3 modifies it.
- [Source: `plugins/crew/mcp-server/src/lib/lifecycle-log.ts`] — current lifecycle logger; Task 1 modifies it.
- [Source: `plugins/crew/mcp-server/src/errors.ts`] — typed error hierarchy; Task 2 extends it.
- [Source: project memory `project_mcp_cascade_sigterm`] — the RCA distilled.
- [Source: project memory `project_mcp_server_silent_disconnect`] — two-causes framing (idle-reap fixed; cascade pending).
- [Source: project memory `project_diag_instrumentation_pattern`] — lifecycle instrumentation pattern.
- [Source: project memory `feedback_default_to_deterministic_seams`] — typed errors as load-bearing contracts.
- [Source: project memory `feedback_prose_mut_steps_need_seam`] — Claude skips prose-only "MUST call X" under load.
- [Source: project memory `project_reviewer_toolchain_gaps`] — AC marker convention (plain `artifact:` / `vitest:`, no backticks).
- [Source: project memory `project_locked_phrase_grammar_drift`] — verbatim operator-facing halt lines.

---

## Previous story intelligence

### From Story 5.25 (lifecycle log)

- The lifecycle logger is a fail-open seam: an unwritable log path silently disables further writes without crashing. Task 1's additions must preserve this: `process.getpgrp()` exists on POSIX but throws if called outside a process; the Windows fallback is `undefined`. Both paths must remain fail-open.
- The `logSync` code path (used in signal handlers) appends via `fs.appendFileSync` and bypasses the `WriteStream`. Task 1's field additions must reach both code paths — `buildLine` is the shared helper, so changes there are sufficient.

### From Story 5.20 (orphan-recovery — reviewer-only respawn)

- The orphan-recovery branch handles three sub-cases at `reattach`: (i) `hasTranscript=true` (replay dev transcript), (ii) `hasTranscript=false` + `hasOpenPR=true` (reviewer-only spawn), (iii) neither (block as no-transcript). This story's halt seam relies on case (ii) for the cascade-recovery flow — operator restarts, `/crew:start` surfaces the orphan, operator chooses `reattach`, reviewer-only spawn drives the rework loop. No second MCP child boots during reviewer-only spawn, so the cascade does not re-fire.

### From Story 5.21 (reviewer first-call deterministic seam)

- Established the pattern of moving load-bearing decisions out of LLM prose and into typed errors. `ReviewerFirstCallSkippedError` is the model `McpDisconnectedError` follows.

### From Story 5.10 (transcript persistence)

- The principle: critical state must be written to disk before any MCP call. Step 4.5 of SKILL.md persists the dev transcript via the built-in `Write` tool, independent of MCP. This story's halt seam preserves that invariant — the wrapper only covers MCP calls, and the persisted transcript is what makes the operator's restart survivable.

### From Story 5.12 (MCP child resilient to parent stdin-close)

- The original "MCP dies mid-cycle" failure mode. Stories 5.12 and 5.25 fixed idle-reap; this story addresses the architecturally different cascade-on-Task-return mode. Both fixes coexist — 5.25's keepalive prevents idle-reap; this story's halt seam contains the cascade.

### From Story 5.24 (Zod-determinism dist drift)

- The dist build is byte-identical across clean rebuilds. New source in this story uses plain TypeScript constructs (no `z.enum`) so determinism holds. Task 5's two-build check confirms.

### From Story 5.28 (build:watch normaliser chaining)

- `pnpm build:watch` now normalises after every tsc emit. Substrate dev loop is drift-free; no manual normaliser passes needed during this story's work.

---

## Dev Agent Record

### Agent Model Used

_(populated by dev)_

### Debug Log References

_(populated by dev)_

### Completion Notes List

_(populated by dev)_

### File List

_(populated by dev)_
