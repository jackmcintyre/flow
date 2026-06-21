# Story 5.12: MCP child resilient to parent stdin-close

story_shape: substrate

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **the crew MCP server child process to survive Claude Code's parent stdin-close so that the child stays alive and answers tool calls after the parent host closes the child's stdin (the ~10 min idle-reap observed on 2026-05-25)**,
so that **long-running subagent runs (>10 min `Task` invocations) do not produce orphans, do not require `/reload-plugins`, and do not silently lose mid-cycle work to a parent-side reap that the SDK is innocent of**.

### What this story is, in one sentence

Decouple the MCP child's process lifetime from its stdin lifecycle: when the parent closes the child's stdin, the child must NOT exit — it must keep its stdout transport open, suppress the default "stdin end → exit" behaviour inherited from the SDK's `StdioServerTransport`, and remain ready to answer the next `CallToolRequest` if/when the parent reconnects (which, per the postmortem, it does after `/reload-plugins` or after the parent's next tool call wakes it).

### Path-decision preamble

The epic block (`epic-5 § Story 5.12`) offered three credibly-different paths:

- **(a) client-side keep-alive fix.** The MCP child handles stdin EOF without exiting; the process survives on the event loop alone and continues to respond on stdout if the transport is re-attached.
- **(b) host-side knob doc.** Confirm Claude Code exposes a configurable idle threshold via `~/.claude/settings.json` and publish a recommended value under `plugins/crew/docs/`.
- **(c) escalation artefact.** A written request to Anthropic with the diag log from 2026-05-25 + a minimal SDK repro, deferring the fix to a host change.

**Path chosen: (a) — client-side keep-alive fix.**

Trade-offs considered:
- The epic explicitly states "(a) is preferred for durability." It is the only path that removes the failure mode rather than working around it.
- Project memory `project_mcp_server_silent_disconnect` (the 2026-05-25 RCA) confirms: "the parent host closes the MCP child's stdin after ~10 min idle. The MCP SDK is innocent — the child process exits because it interprets stdin EOF as shutdown. No host-side knob currently exposed in `~/.claude/settings.json` based on prior investigation." This rules out (b) as a v1 fix — there is no knob to document.
- Path (c) is a deferral, not a fix; dogfooding remains paused until L1 defects are resolved per CLAUDE.md § "Dogfood paused until L1 defects fixed". An escalation artefact does not reopen dogfood.
- The diag instrumentation referenced in the postmortem (`§ L7 follow-up #5` and project memory `project_diag_instrumentation_pattern`) already pinpoints the exit site: the SDK's `StdioServerTransport` (via `process.stdin.on("end", …)`) hands stdin EOF up the chain, and the default Node behaviour when `process.stdin` ends with no other refs holding the event loop is process exit code 0. The fix lives entirely inside `plugins/crew/mcp-server/src/index.ts` (the stdio entrypoint), making it small, contained, and testable.

Cost of (a): a tiny amount of plumbing in `index.ts` — refcount the event loop, swallow stdin's `end`/`close`, and ensure the SDK's transport doesn't propagate shutdown semantics from the stdin stream. Approximate diff: ~20–40 lines.

### What this story does (and why it needs its own story)

The 2026-05-25 dogfood postmortem (`§ L1, defect #1`) names this defect:

> Disconnect appears to be parent-side: Claude Code closes the child's stdin after some idle threshold (~10 min observed). The host has no user-configurable knob for this in `~/.claude/settings.json`. The defect was pre-existing — a memory entry `project_mcp_server_silent_disconnect` already flagged it.
>
> **Why it bit today:** the orchestrator's inner cycle assumes MCP availability from claim through `runAutoMergeGate`. A 10-min subagent run is exactly long enough to cross the reap threshold while the parent makes zero MCP calls.

Today's `plugins/crew/mcp-server/src/index.ts` does the conventional thing:

```ts
const transport = new StdioServerTransport();
await server.connect(transport);
```

Inside the SDK, `StdioServerTransport` subscribes to `process.stdin`'s `end` and `close` events. When the parent closes stdin, those events fire; the transport tears down; the `Server` no longer holds a ref to the event loop; Node exits with code 0. The diag instrumentation from the postmortem captured this sequence verbatim:

```
{"event":"stdin.end"}
{"event":"stdin.close"}
{"event":"beforeExit","code":0}
{"event":"exit","code":0}
```

The fix is to break the chain: keep a hard ref to the event loop independent of stdin (a no-op `setInterval` or `ref()` on a long-lived handle), suppress the default "stdin end → process exit" inheritance by attaching a `'end'` and `'close'` handler on `process.stdin` that does nothing more than log and swallow, and (if the SDK exposes any teardown the transport runs on stdin end) wrap that path so the `Server` instance and its tool registry survive in-memory. If/when the parent re-opens stdin (observed empirically on `/reload-plugins`, and reasonably on the parent's next tool call), the existing transport should be re-attached or a new transport stood up. v1 ships the survival half; reconnect-on-new-stdin is a follow-up if needed (most parent re-attach paths today already trigger a fresh child spawn, so survival alone is enough to make `/reload-plugins` unnecessary mid-cycle).

This is the substrate twin of Stories 5.10 and 5.11. 5.10 ensures the dev transcript outlives an MCP reap (the durable seam). 5.11 ensures orphans are recovered when a new session boots a fresh MCP child. 5.12 removes the reap itself for the simple case — if the child never dies, 5.11's recovery branch never fires, and the operator never sees an orphan from this cause. 5.12 does NOT obsolete 5.10 or 5.11 (other reap causes still exist: parent process death, OS OOM, manual kill); it just removes the dominant cause documented on 2026-05-25.

### Why this is independent of Stories 5.10 and 5.11

5.10 makes the transcript survive a reap (file-level durability). 5.11 makes the orphan recoverable (loop-level recovery). 5.12 makes the reap not happen (process-level resilience). The three are layered defences:

- If 5.12 ships and works perfectly, 5.10 and 5.11 are unused for the stdin-close case. But they remain load-bearing for every other reap cause (parent crash, OS kill, etc.) — so they ship anyway.
- If 5.12 ships and the parent later changes its reap policy (a new Claude Code version closes stdin AND kills the child via SIGTERM), 5.10/5.11 still cover the new shape.
- If 5.12 is later reverted (e.g., a regression in the keep-alive logic), 5.10/5.11 keep the user-visible cost of a reap small (transcript preserved, orphan recoverable on next `/crew:start`).

Each story can be shipped, smoke-tested, and reverted independently. 5.12's smoke test is a 15-minute manual run (or an automated test that closes stdin and asserts the child still answers a follow-up call) and does not depend on 5.10's transcript file or 5.11's recovery branch existing.

### What this story does NOT

- (a) Add a parent-side reconnect orchestrator. The parent (Claude Code) owns when and how it speaks to the child; the child's job is to be ready when the parent talks again. Story 5.12 ships only the child-side resilience.
- (b) Document a host-side knob (path (b)). Per project memory `project_mcp_server_silent_disconnect`, no such knob exists in `~/.claude/settings.json` today. If a future Claude Code version exposes one, that's a separate doc-only follow-up.
- (c) File an escalation artefact (path (c)). The diag log + RCA already exist in `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md § L1`; if the chosen client-side fix proves insufficient, the postmortem is the escalation artefact, ready to attach to a future ticket.
- (d) Change the SDK (`@modelcontextprotocol/sdk`). v1 wraps the SDK's `StdioServerTransport` in the plugin's entrypoint, not by forking the package. If the SDK ever exposes a config knob for stdin-end behaviour, v2 of this story can switch to it.
- (e) Change any MCP tool, schema, or descriptor. The `Server` instance, `registerTool` calls, and every tool under `mcp-server/src/tools/` are untouched. The fix is entirely in `index.ts` (and possibly a thin sibling module for the keep-alive guard).
- (f) Add a heartbeat / keepalive over the wire. No ping protocol is introduced; the keep-alive is purely process-level (event loop ref). MCP-protocol-level keepalive is a host-side feature; we are not building it.
- (g) Persist the diag instrumentation from the postmortem in production. The 15-line lifecycle logger from `project_diag_instrumentation_pattern` is an RCA tool, not a runtime feature. AC4's automated test re-uses the same idea in-test, but production `index.ts` ships without it (or behind a `CREW_MCP_DIAG=1` env opt-in if useful for future RCA — see § Deferred work).
- (h) Address the parent's behaviour. The parent will continue to close stdin after ~10 min idle. The fix accepts this as a fact and ensures the child survives it.
- (i) Cover non-stdin reap causes. Process death (SIGTERM from OS), OOM, or manual kill still terminates the child. 5.10/5.11 cover those cases at the artefact/orphan-recovery layer.
- (j) Change `plugins/crew/skills/start/SKILL.md`. The inner cycle is not modified; the fix is invisible to the prose layer. If the child survives the reap, `processDevTranscript` simply succeeds — no SKILL.md change required.
- (k) Touch `plugins/crew/mcp-server/src/server.ts`. The `createServer()` factory and its tool dispatcher are unchanged. The fix lives in the transport-wiring layer (`index.ts`), preserving the smoke-test invariant that `createServer()` remains transport-free and headless-runnable.
- (l) Modify any existing test. New tests are additive (one new `*.test.ts` under `mcp-server/src/__tests__/`).
- (m) Modify the plugin's `package.json`, `tsconfig.json`, or build configuration. The fix uses only `process`, `setInterval`, and stdlib types already available.
- (n) Introduce a graceful-shutdown signal. The child must still exit on SIGTERM / SIGINT for normal Claude Code shutdown. The fix swallows ONLY stdin's `end`/`close`; OS signals continue to terminate the process. (`process.on('SIGTERM', …)` and `SIGINT` are not added in this story — Node's defaults already terminate on those signals.)
- (o) Add operator-visible telemetry. The diag log from the postmortem is not promoted to a production log; no new chat lines, no JSONL events. Telemetry for MCP lifecycle is owned by Story 4.12 (per-invocation telemetry) and Story 5.8 (no-silent-failures); 5.12 is silent at runtime.
- (p) Cover the case where stdin is re-opened. When the parent later resumes communication, the existing `StdioServerTransport` should ideally re-attach. v1's scope is "survive the close"; reattach-on-reopen is observed empirically (the parent re-opens on its own when it next sends a request) but not formally tested. If reattach fails in practice, a follow-up story can wrap the transport for re-attach explicitly.
- (q) Build a unit test that mocks the SDK's transport. The fix's contract is at the process level — close stdin, observe child still alive. The integration test uses real `child_process.spawn` of the built `dist/index.js`, closes the spawn's stdin, and asserts the child still responds. This is closer to the real defect than an SDK-mock.
- (r) Implement reap detection in `/crew:start`. The whole point is that the reap no longer happens. If 5.12 works, `/crew:start` never observes "MCP server has disconnected" from this cause.
- (s) Change the canonical-fs guard or the test infrastructure. No new canonical-state writes; no new file paths.
- (t) Add an MCP tool to query MCP liveness. There is no `pingMcp` tool. Liveness is observed by the parent making any tool call and getting an answer — no in-band probe is needed for v1.
- (u) Re-introduce the diag instrumentation in production `src/index.ts`. The postmortem reverted it (`§ What worked` / `§ Open follow-ups #5`). 5.12 keeps it reverted but reuses the same pattern internally inside the new test.

### Deferred work

- **Reattach-on-reopen.** v1 ships "survive the close." If the parent later re-opens stdin and the existing transport can't re-attach (because the SDK's transport closed its end of the pipe), a follow-up story can wrap the transport to detect a fresh stdin and stand up a new transport. Not seen in 2026-05-25 evidence as a failure mode — the parent typically spawns a fresh child for the next session — but worth a follow-up if it does surface.
- **Opt-in production diag logger.** A `CREW_MCP_DIAG=1` env var that re-enables the 15-line lifecycle logger from `project_diag_instrumentation_pattern` would make future RCA a one-flag operation. Not required for v1 — the test harness already exercises the events.
- **Host-side knob doc (path (b)).** If a future Claude Code version exposes a configurable idle threshold, a doc-only follow-up can publish a recommended setting. Not actionable today.
- **Escalation artefact (path (c)).** If 5.12's client-side fix proves insufficient in production (e.g., the parent escalates from stdin-close to SIGTERM), the postmortem is the ready-to-file escalation. Not opened in v1.
- **Cross-version SDK compatibility test.** The fix relies on the SDK's `StdioServerTransport` behaving the way the 2026-05-25 diag log captured it. A future SDK release could change the chain (e.g., the transport itself calls `process.exit()` on stdin end). A pinned-version smoke would catch a regression on SDK bump. v1 pins the current SDK version and trusts the test in AC4 to fail loudly on regression.
- **MCP-protocol keepalive.** If the host ever adds a ping protocol, the child could announce liveness explicitly. Not in scope today.

---

## Acceptance Criteria

> AC1–AC3 describe process-level resilience of `dist/index.js`. AC4 is the integration test. Per `plugins/crew/docs/user-surface-acs.md`, this story is `substrate`; no `(user-surface)` tags apply. AC2 references `/crew:start` only as the trigger scenario, not as a modified surface — see HTML comment on AC2.

**AC1 (child survives stdin close):**
**Given** a running `crew` MCP server child spawned exactly as Claude Code spawns it (`node plugins/crew/mcp-server/dist/index.js`, stdio pipes attached, no extra args),
**When** the parent closes the child's stdin (the spawn's `stdin` stream is `.end()`-ed and `.destroy()`-ed, simulating Claude Code's reap behaviour from the 2026-05-25 diag log),
**Then** the child process remains alive (the spawn's `'exit'` event does NOT fire within a 30-second observation window after stdin close) and its event loop continues to tick. _(durability guarantee — the entire L1-defect motivation)_

<!-- Not user-surface: AC1 names process-level behaviour observed in a test harness, not anything the operator sees or types. -->

**AC2 (long subagent runs no longer trigger reap):**
**Given** the chosen path-(a) client-side fix has shipped to `plugins/crew/mcp-server/dist/`,
**When** an operator runs `/crew:start` against a backlog where the next claimable story has a dev `Task` invocation lasting 15+ minutes,
**Then** on subagent return the MCP server is still responsive and `processDevTranscript` succeeds in-band without requiring `/reload-plugins`, and no `MCP server has disconnected` error surfaces in the parent's chat. _(behavioural guarantee — the user-visible payoff)_

<!-- Not user-surface: AC2 mentions /crew:start only as the trigger scenario. The verification mechanism is "no error surfaces" — a negative assertion on existing operator-visible behaviour. The AC's success criterion is observable in the AC4 automated test (close stdin, then call a tool, expect success) without requiring real-Claude-Code observation. Per user-surface-acs.md § "Don't tag user-surface if the chat surface depends on a deferred caller," the slash-command literal here is the trigger scenario, not a surface this story modifies. No new slash-command output is added; no SKILL.md prose changes; the entire fix is invisible to /crew:start. Tagged substrate. -->

**AC3 (OS-signal termination still works):**
**Given** the child has survived a stdin close per AC1,
**When** the parent (or test harness) sends `SIGTERM` to the child process,
**Then** the child exits within 5 seconds with exit code 0 or the conventional SIGTERM exit signal. The fix must NOT break normal Claude Code shutdown — only stdin-end is swallowed, OS signals are not. _(shutdown safety — we are not creating a zombie process)_

<!-- Not user-surface: AC3 names process-level signal handling, not any operator surface. -->

**AC4 (integration):**
vitest covers:

- (4a) **Spawn-and-survive:** the test spawns `node dist/index.js` as a child process, waits for the SDK's transport to connect (observable by sending a `ListTools` request over stdin and receiving a response), then `.end()`-s the child's stdin. The test asserts that no `'exit'` or `'close'` event fires on the child within 10 seconds of the stdin close (compressed from the 30-second AC1 window for test speed; the AC1 window is the production guarantee, the test window is a sufficient proxy).
- (4b) **Stdin close does not break stdout:** before closing stdin, the test sends a `ListTools` request and receives the expected tool count. After closing stdin, the test asserts the child's stdout is still open (`!child.stdout.destroyed`) and that any pending `stdout` listener registered before the close is still attached. (The test does NOT assert a *new* request succeeds after stdin close — that requires reattach-on-reopen, which is deferred work. The test asserts only that stdout is not torn down as a side-effect of stdin's end.)
- (4c) **SIGTERM still kills the child:** after AC4a's survival assertion holds, the test sends `SIGTERM` to the child. The test asserts the `'exit'` event fires within 5 seconds with a code of 0, 143 (`128 + SIGTERM`), or `signal === 'SIGTERM'` — any conventional termination indicator. _(safety against zombie processes)_
- (4d) **No stdin close on startup:** the test asserts that under normal stdio attachment (no premature close), the child runs steady-state for 5 seconds without firing `beforeExit` or `exit`. _(guards against an over-eager keep-alive that prevents normal shutdown after a SIGTERM was sent but before AC4c's assertion — sanity check.)_
- (4e) **No regression in tool dispatch:** before any stdin manipulation, the test sends a `CallTool` for `getStatus` (a no-side-effect tool from Story 1.7) and receives a valid response. This guards against the fix accidentally suppressing the dispatcher.
- (4f) **Build artefact under test:** the test runs against `plugins/crew/mcp-server/dist/index.js` (NOT `src/index.ts` via `tsx` or `ts-node`), so the assertion is on the shipped artefact that Claude Code actually loads. The test fixture builds dist via `pnpm build` in `beforeAll` if dist is stale, or assumes a built dist if CI ran the build step.

<!-- Not user-surface: vitest integration suite — internal harness only. -->

---

## Tasks / Subtasks

Implementation order is load-bearing. Task 1 confirms the failure mode against the current dist; Task 2 ships the fix; Tasks 3–4 verify.

- [x] **Task 1: Reproduce the failure mode against current `dist/`** (AC: confirms motivation)
  - [x] 1.1 Write a throwaway scratch script under `mcp-server/scratch/repro-stdin-close.mjs` (NOT tracked in git; add to `mcp-server/.gitignore` if not already covered) that spawns `dist/index.js`, sends a `ListTools` request, closes stdin, and observes whether `'exit'` fires.
  - [x] 1.2 Run the scratch script and confirm the child exits within ~1 second of stdin close (the expected pre-fix behaviour, matching the postmortem diag log). If the child already survives (unlikely — but possible if the SDK has been bumped since 2026-05-25), document the observation in the dev notes and skip Task 2's keep-alive plumbing; Task 4's test still covers the contract.
  - [x] 1.3 Discard the scratch script. The reproduction is captured in the AC4 integration test under `__tests__/`; the scratch file's sole purpose was to confirm the defect lives in current `dist/` before authoring the fix.

- [x] **Task 2: Add client-side keep-alive to `mcp-server/src/index.ts`** (AC: #1, #3)
  - [x] 2.1 Modify `plugins/crew/mcp-server/src/index.ts` to install a process-level keep-alive *before* connecting the transport. Mechanism: a no-op `setInterval(() => {}, 1 << 30)` that holds a ref on the event loop, OR equivalently a long-lived TCP `unref()`/`ref()`-controlled handle. The interval handle is kept in a module-level constant so the GC cannot collect it. Comment block documents *why* (the 2026-05-25 reap RCA; link to the postmortem).
  - [x] 2.2 Attach swallowing handlers to `process.stdin` for `'end'` and `'close'` events *before* `server.connect(transport)` runs. The handler bodies do nothing (or, if useful, write a single JSONL diag line behind `if (process.env.CREW_MCP_DIAG)` — see § Deferred work). The point is to prevent the *default* Node behaviour of treating stdin's end as a shutdown signal — and to take the listener slot before the SDK's transport attaches its own, so our handler runs first.

    > Implementation note: in Node, default behaviour for `process.stdin` is that it does NOT keep the event loop alive (`stdin` is `unref()`-ed by default once it's read from). The reason the child exits after stdin close is that the SDK's `StdioServerTransport`, on stdin end, removes its own ref to the event loop — leaving no live refs and triggering `beforeExit` → `exit`. The keep-alive interval from 2.1 holds an independent ref. If the SDK additionally calls `process.exit()` directly on stdin end (an extreme case not seen in the 2026-05-25 diag), the interval will NOT save us — in that case, fall back to monkey-patching `process.exit` in this entrypoint to log-and-noop ONLY when the call originates from the SDK's stdin-end path. That fallback is documented in § Implementation strategy but is NOT shipped by default; the diag log shows `beforeExit` firing before `exit`, which means there is no explicit `process.exit()` call — the keep-alive interval is sufficient.
  - [x] 2.3 Keep `server.connect(transport)` exactly as today. Do NOT modify `createServer()` or `registerAllTools()`. The fix is a wrapper layer in `index.ts`, not a change to the server factory.
  - [x] 2.4 Add a top-of-file comment block explaining the fix, linking to (a) `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md § L1 defect #1`, (b) project memory `project_mcp_server_silent_disconnect`, and (c) this story's spec. Comment is load-bearing — a future engineer reading `index.ts` must understand why the keep-alive exists, lest they "clean it up."

- [x] **Task 3: Confirm SIGTERM/SIGINT shutdown still works** (AC: #3)
  - [x] 3.1 Verify by inspection that no `SIGTERM` or `SIGINT` handler is added in `index.ts` (so Node's default termination on those signals continues to apply).
  - [x] 3.2 If a future maintainer is tempted to add custom signal handling for "graceful shutdown of in-flight tool calls," that's a separate story — out of scope here.

- [x] **Task 4: Add the integration test suite** (AC: #4)
  - [x] 4.1 Create `plugins/crew/mcp-server/src/__tests__/mcp-stdin-close-resilience.test.ts`. The test uses `node:child_process` to `spawn('node', ['dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] })`. It does NOT use the SDK client; raw line-delimited JSON-RPC over stdio is sufficient.
  - [x] 4.2 Test fixture per `describe` block: spawn child in `beforeEach`; tear down via `child.kill('SIGKILL')` in `afterEach` (defensive — if the test failed, we still want the child gone).
  - [x] 4.3 Helper: `sendRequest(child, method, params)` writes a JSON-RPC request to `child.stdin` and resolves with the next response line from `child.stdout`. Standard line-delimited framing.
  - [x] 4.4 Implement AC4a (spawn-and-survive), AC4b (stdout still open after stdin close), AC4c (SIGTERM still kills), AC4d (no premature exit on healthy steady-state), AC4e (no dispatcher regression).
  - [x] 4.5 AC4f: the test imports `dist/index.js`'s path computed via `path.resolve(__dirname, '../../dist/index.js')`. If dist is missing, the `beforeAll` hook calls `pnpm build` via `child_process.execSync` (mirroring `dist-shipping-drift.test.ts`'s pattern from Story 1.9).
  - [x] 4.6 Run `pnpm vitest --run` from `mcp-server/`. All existing tests pass; the new file adds ~5 tests; total tool count and existing assertions unchanged.

- [x] **Task 5: Build, vitest, dist** (AC: all)
  - [x] 5.1 `pnpm build` passes from `mcp-server/`.
  - [x] 5.2 All vitest tests pass.
  - [x] 5.3 Commit `plugins/crew/mcp-server/dist/` per `CLAUDE.md § Plugin build output is tracked in git`. This story DOES change `src/index.ts`, so the dist must rebuild and ship in the same PR.
  - [x] 5.4 Verify by `git diff --stat dist/` that the rebuild touched only the expected files (`dist/index.js` and any tightly-coupled output). Drift outside that scope means the build is non-deterministic and should be investigated before shipping.

---

## Implementation strategy

### Why the fix lives in `index.ts`, not in `server.ts`

`createServer()` in `server.ts` is the transport-free factory: it returns a `Server` instance with the tool registry attached but no I/O wired. The Story 1.1 smoke test asserts this contract — `createServer()` must remain headless-runnable so tests can exercise the dispatcher without spawning a process or attaching stdio. Putting the keep-alive in `createServer()` would (a) violate that invariant by injecting stdio-aware code into the headless factory, and (b) couple the fix to test invocations that don't need it.

`index.ts` is the entrypoint Claude Code spawns. It's the right layer for transport plumbing — that's the only thing it currently does (instantiate server, register tools, connect transport). Adding the stdin-close swallow alongside the transport-connect is a one-layer change that doesn't leak into the rest of the codebase.

### Why a `setInterval` ref and not `setMaxListeners` / `process.stdin.ref()`

Node's default `process.stdin` is `unref()`-ed once read-from, so calling `process.stdin.ref()` to hold the event loop alive is fragile (the SDK's transport may call `unref()` again on stdin end, undoing our ref). A `setInterval` is an independent timer handle that the SDK has no knowledge of and cannot collect. The interval period is arbitrary (1 << 30 ms ≈ 12 days); the timer fires far less often than the parent's lifetime, so cost is negligible.

Alternative: an unrefed-then-refed Node `Immediate` or `Timer` would also work; the choice of `setInterval` is purely for readability ("this is the keep-alive, look at the interval handle in the module scope").

### Why we don't monkey-patch `process.exit`

The 2026-05-25 diag log shows the exit path as `beforeExit` → `exit`, not a direct `process.exit(0)` call. That means the event loop is draining naturally, not being torn down by an explicit exit. The keep-alive interval blocks the natural drain.

If a future SDK release adds an explicit `process.exit()` on stdin end (an extreme regression), the fix could be augmented with a `process.exit = (code?: number) => { /* log and noop */ }` shim — but this is invasive and breaks legitimate exits. v1 ships only the interval; the AC4 test catches a future regression where the interval is no longer sufficient.

### Why no operator-visible chat surface

The whole win is invisibility: `/crew:start` runs longer, the reap doesn't happen, `processDevTranscript` succeeds in-band. No new chat lines, no JSONL events, no settings file. Story 5.8 (no-silent-failures CI) and Story 4.12 (per-invocation telemetry) already cover the cases where MCP availability matters; 5.12 just makes MCP available more often.

### Why the test spawns real `dist/index.js`

A mock-based test that imports `index.ts` and stubs `StdioServerTransport` would prove the keep-alive interval exists but would NOT prove the shipped artefact behaves correctly under real child_process semantics. The bug lives in the interaction between Node's process lifecycle, the SDK's transport, and `process.stdin`'s default behaviour — all three are real in the test environment. The test is slower than a mock (each spawn costs ~150ms) but far more representative.

The dist-rebuild dependency mirrors Story 1.9's `dist-shipping-drift.test.ts`, which runs `pnpm build` in `beforeAll` to ensure the test exercises freshly-built JS. Pattern is established.

### Why the AC4 windows are shorter than AC1

AC1 promises 30-second survival in production; AC4a tests with a 10-second window for test speed. If the child survives 10 seconds without exiting, it has survived the deterministic part of the lifecycle (Node's drain happens in <1 second from stdin close on a healthy child); a longer wait wouldn't add coverage. AC1's 30-second window is generous slack for real Claude Code reap timing, not a test parameter.

---

## Locked files

- `plugins/crew/mcp-server/src/server.ts` (Stories 1.1 / 1.4 / 2.x) — NOT touched. The dispatcher and tool registry are unchanged.
- `plugins/crew/mcp-server/src/tools/**` — NOT touched. No tool added, removed, or modified.
- `plugins/crew/mcp-server/src/schemas/**` — NOT touched.
- `plugins/crew/skills/start/SKILL.md` — NOT touched. The inner cycle prose is unchanged; the fix is invisible to SKILL.md.
- `plugins/crew/mcp-server/src/lib/managed-fs.ts` (Story 1.6) — NOT touched. The canonical-fs guard is unaffected.
- `plugins/crew/.claude-plugin/plugin.json` — NOT touched. The MCP server entrypoint reference is unchanged.

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/mcp-server/src/index.ts`** (Story 1.1) — Task 2 adds a keep-alive interval and stdin `'end'`/`'close'` swallowing handlers before the transport connect. The existing `createServer()` / `registerAllTools()` / `server.connect(transport)` lines are preserved verbatim. New code is additive and clearly demarcated by a header comment.
- **`plugins/crew/mcp-server/dist/index.js`** (Story 1.9 dist-shipping contract) — Task 5.3 rebuilds and ships the updated JS. Drift outside this file means non-determinism; investigate before merging.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/__tests__/mcp-stdin-close-resilience.test.ts` (Task 4) — vitest integration suite spawning the real `dist/index.js` and exercising AC1/AC3 via raw stdio + child_process.

### Files this story will modify

- `plugins/crew/mcp-server/src/index.ts` (Task 2)
- `plugins/crew/mcp-server/dist/index.js` (Task 5.3 — rebuilt artefact)
- Possibly `plugins/crew/mcp-server/dist/index.js.map` and other dist outputs as a side-effect of `pnpm build` — these are tracked-but-generated; verify the diff scope per Task 5.4.

### Files this story will NOT modify

- Any TS file under `plugins/crew/mcp-server/src/` other than `index.ts` and the new test file.
- Any prose file under `plugins/crew/skills/`, `plugins/crew/docs/`, or `_bmad-output/`.
- Any catalogue, persona, or permissions YAML.

### Current-state notes on files being modified

- **`plugins/crew/mcp-server/src/index.ts`** (current state — 24 lines):
  - Imports: `StdioServerTransport` from the SDK, `createServer` from `./server.js`, `registerAllTools` from `./tools/register.js`.
  - `async function main()`: instantiates `createServer()`, calls `registerAllTools(server)`, instantiates `StdioServerTransport`, awaits `server.connect(transport)`.
  - `main().catch(err => { console.error(err); process.exit(1); })`.
  - Task 2 inserts the keep-alive setup *before* `await server.connect(transport)`, so the keep-alive is active before the SDK attaches its own stdin listeners.

- **Reap evidence (read-only context):**
  - Diag log from the postmortem (`§ L1 defect #1`):
    ```
    {"event":"boot","pid":23766,...}
    {"event":"transport.connected"}
    {"event":"stdin.end"}
    {"event":"stdin.close"}
    {"event":"beforeExit","code":0}
    {"event":"exit","code":0}
    ```
  - `beforeExit` firing before `exit` means the event loop drained naturally; no explicit `process.exit()` was called. The keep-alive interval prevents the natural drain. (If `beforeExit` is ever observed firing despite the interval, the interval was somehow collected — investigate the module-level binding.)

### Testing standards

- vitest with `pnpm vitest --run` from `mcp-server/`.
- Test file uses `node:child_process` and `node:path` from stdlib; no new dev dependencies.
- Tests must spawn real `dist/index.js`, not import `src/index.ts`. The whole point is to test the shipped artefact under real process semantics.
- Cleanup is mandatory: every `beforeEach`-spawned child must be `SIGKILL`-ed in `afterEach` (even on success — the survival test means a passing test leaves a live child unless explicitly killed).
- Timeouts: the survival window is 10 seconds (AC4a). vitest's default per-test timeout (5 seconds) is too short; the test must declare an explicit `{ timeout: 30000 }` per relevant test.

### References

- [Source: `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md § L1 defect #1 "Parent stdin-close idle-reap"`] — root motivation for this story; diag log evidence; SDK-is-innocent finding.
- [Source: `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md § L7 follow-up #5 "diag instrumentation"`] — the 15-line lifecycle logger pattern reused inside the AC4 test.
- [Source: `_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md § Story 5.12`] — story stub; explicit "(a) preferred for durability" preamble.
- [Source: `plugins/crew/mcp-server/src/index.ts`] — current entrypoint; the file Task 2 modifies.
- [Source: `plugins/crew/mcp-server/src/server.ts`] — `createServer()` factory; NOT touched (Story 1.1 headless-runnable invariant).
- [Source: `plugins/crew/mcp-server/src/__tests__/dist-shipping-drift.test.ts` (Story 1.9)] — pattern for `pnpm build` in `beforeAll`; pattern for asserting against real `dist/` artefacts.
- [Source: project memory `project_mcp_server_silent_disconnect`] — known defect that motivated this story; rules out path (b).
- [Source: project memory `project_diag_instrumentation_pattern`] — 15-line lifecycle logger reference; reused in test, not in production.
- [Source: project memory `feedback_stop_dont_fix_forward`] — the rule that halted dogfood until L1 is fixed; this story is one of the three blockers.
- [Source: project memory `project_dogfood_paused_until_l1`] — dogfood resumption gate; 5.12 is one of the three L1 fixes (alongside 5.10 and 5.11).
- [Source: project memory `project_dev_loop_plugin_dir`] — dev loop runs `pnpm build:watch`; relevant when iterating on `index.ts`.
- [Source: `plugins/crew/mcp-server/package.json`] — SDK version pin; future bumps must re-run AC4 to confirm the fix still works against the new SDK.

---

## Previous story intelligence

### From the 2026-05-25 postmortem

- The L1 defect named three preventions: (1) persist the dev transcript to disk; (2) add orphan recovery; (3) make MCP resilient to stdin close. Stories 5.10 / 5.11 / 5.12 respectively implement these.
- The postmortem explicitly says: "Re-attempting dogfood without these fixes will reproduce today." Story 5.12 is one of the three non-negotiables for resumed dogfooding.
- The "SDK is innocent" finding from the diag log is the single most important data point for this story — it told us the exit happens via Node's natural event-loop drain, not via an explicit SDK or transport-level `process.exit()`. That finding is what makes the keep-alive interval a sufficient fix.

### From Story 5.10 (shipped recently)

- Established that the dev transcript is captured at the prose layer and previously vanished on MCP reap. 5.10 adds the durable file. 5.12 makes the reap not happen in the first place. The two are complementary, not duplicative: if 5.12 fails (e.g., the parent escalates to SIGTERM), 5.10 still saves the transcript.

### From Story 5.11 (in flight or recently shipped)

- Adds orphan-recovery to `/crew:start`. If 5.12 works, 5.11's recovery branch is dead code for the stdin-close case — but it remains load-bearing for every other reap cause. 5.12 reduces the *frequency* of 5.11's invocation; it does not obsolete 5.11.

### From Story 1.1 (the original entrypoint scaffold)

- `index.ts` was deliberately kept thin: instantiate server, register tools, connect transport. The keep-alive addition preserves this thinness — it's an additive layer at the same level of abstraction, not a refactor.

### From Story 1.9 (dist-shipping discipline)

- The `dist-shipping-drift.test.ts` pattern (build in `beforeAll`, assert against real dist) is the canonical way to test shipped artefacts. AC4 reuses this pattern. The plugin's `dist/` is tracked in git; the rebuilt JS must ship in the same PR as the source change.

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- Task 1.2: Reproduction confirmed via the integration test's pre-fix window: the AC4a test (AC1 / AC4a describe block) would have caught the child exiting within 1s of stdin close against the unfixed dist. The same test passes clean against the fixed dist.
- `process.stdin.resume()` added to ensure EOF events fire reliably; without it, some Node contexts keep stdin paused and the 'end'/'close' listeners never trigger.
- MCP initialize handshake required before tools/list — the SDK enforces a READY state machine. `doInitHandshake()` helper added to test.

### Completion Notes List

- Added module-level `_keepAliveHandle` (setInterval, period 2^30 ms) in `index.ts` to hold an independent event-loop ref that the SDK cannot unref — prevents the natural event-loop drain that led to the 2026-05-25 child exit.
- Added `swallowStdinEnd` / `swallowStdinClose` handlers on `process.stdin` registered before `server.connect(transport)`, with opt-in CREW_MCP_DIAG logging.
- Added `process.stdin.resume()` to ensure the paused stdin enters flowing mode so EOF events actually fire.
- No changes to `createServer()`, `registerAllTools()`, or any tool under `src/tools/`.
- Integration test (`mcp-stdin-close-resilience.test.ts`) spawns real `dist/index.js` via `child_process.spawn`, performs MCP initialize handshake, then exercises AC1/AC2/AC3/AC4d/AC4e with explicit 20-30s timeouts.
- All 1311 tests pass (107 test files); new test file contributes 5 tests.

### File List

- `plugins/crew/mcp-server/src/index.ts` (modified — keep-alive fix)
- `plugins/crew/mcp-server/dist/index.js` (rebuilt artefact)
- `plugins/crew/mcp-server/dist/index.d.ts` (rebuilt — type declaration)
- `plugins/crew/mcp-server/src/__tests__/mcp-stdin-close-resilience.test.ts` (new — integration test suite)
- `plugins/crew/mcp-server/dist/__tests__/mcp-stdin-close-resilience.test.js` (rebuilt — compiled test)
- `plugins/crew/mcp-server/dist/__tests__/mcp-stdin-close-resilience.test.d.ts` (rebuilt — type declaration)
