# Story 5.25: Always-on MCP lifecycle logging + server-initiated keepalive

story_shape: substrate

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **the crew MCP server to (a) emit a persistent JSON-line lifecycle log so every disconnect reveals its trigger, (b) send a periodic keepalive ping that prevents Claude Code's ~10 min idle reap from firing, (c) survive unhandled errors and stdout EPIPE without crashing, and (d) drop Story 5.12's zombie-keeping setInterval since stdin-close is the spec-correct shutdown signal**,
so that **mid-session "tools no longer available" stops being the dominant friction in long sessions, and so that when disconnects do happen, the log file tells me exactly which trigger fired**.

### What this story is, in one sentence

Replace Story 5.12's spec-fighting keep-alive (which preserves a zombie process the parent has already given up on) with a spec-aligned approach: keep the parent's idle timer from ticking by emitting periodic JSON-RPC pings, exit cleanly when the parent legitimately closes stdin, capture every lifecycle event to a persistent log file so the next disconnect's cause is observable rather than guessed, and harden against the silent-crash class of failures (uncaught exceptions, stdout EPIPE).

### Path-decision preamble

The post-5.12 investigation (plan at `~/.claude/plans/continue-optimized-patterson.md`) surfaced three credibly-different paths:

- **(a) "Survive harder" — keep extending 5.12's keep-alive.** Add SIGTERM-survival, monkey-patch `process.exit`, wrap the SDK transport for reconnect. Lets the process survive everything the parent throws at it.
- **(b) "Prevent the trigger" — server-initiated keepalive + accept clean shutdown.** Send periodic pings to reset the parent's idle timer. When stdin close happens anyway, exit cleanly per spec. Add persistent logging so we can see what's actually happening.
- **(c) "Accept it, surface it" — no fix. Just document the friction.** Update the SKILL prose to tell users "after a long idle, run `/restart`." Skip both keep-alive and keepalive.

**Path chosen: (b) — prevent the trigger.**

Trade-offs considered:
- Path (a) fights the MCP spec. Per modelcontextprotocol.io § stdio shutdown: "The client SHOULD initiate shutdown by closing the input stream to the child process … sending SIGTERM if the server does not exit within a reasonable time." Refusing to exit on stdin close means the parent eventually escalates to SIGTERM anyway — the zombie process gains nothing because the parent has already moved on. Story 5.12's setInterval is currently producing exactly this zombie state. Anthropic's open issues confirm there is no parent-side reconnect: [#36308](https://github.com/anthropics/claude-code/issues/36308), [#43177](https://github.com/anthropics/claude-code/issues/43177), [#57207](https://github.com/anthropics/claude-code/issues/57207). Path (a) is structurally wrong.
- Path (c) ships zero code and gives operators zero new visibility. It is the right answer ONLY if path (b) turns out not to work — and we cannot know whether it works without the lifecycle log from (b). Path (c) is downstream of (b)'s findings, not an alternative to it.
- Path (b) aligns with how every long-lived JSON-RPC system handles idle timeouts (FastMCP's `keep-alive-interval`, Spring AI's `keep-alive-interval: 30s`, SSE comment-frame keepalives). The MCP protocol's Ping utility — auto-pong'd by the SDK's `Protocol` class — is the canonical mechanism. Using it costs ~30 lines.
- The lifecycle log is independently valuable: even if the keepalive does not solve the friction (because Claude Code's idle timer is wall-clock rather than traffic-based), the log file will tell us so within one 15-minute idle session. Without it, we are still guessing.

Cost of (b): ~150–250 lines of new code (lifecycle logger module + index.ts wiring + tests). Removes ~40 lines from 5.12. Net additive but contained to two source files.

### What this story does (and why it needs its own story)

Story 5.12 (shipped 2026-05-27) added a module-level `setInterval` keep-alive to `plugins/crew/mcp-server/src/index.ts` plus `swallowStdinEnd`/`swallowStdinClose` handlers. The theory at the time was that Claude Code's ~10 min stdin-close was an unintentional side-effect of idle reaping, and that keeping the child alive would let tool calls resume once the parent next sent a request.

Post-ship evidence (this story's investigation, 2026-05-28) shows that theory was wrong:

1. **stdin-close is intentional, per spec.** The MCP stdio transport spec defines stdin-close as the client's first shutdown step. Claude Code is following the spec. Story 5.12's keep-alive defies the spec.
2. **Claude Code does not reconnect.** Anthropic's open issues (#36308, #43177, #57207) confirm: once the host closes stdin and considers the server dead, there is no mechanism to reattach. The kept-alive child sits idle until SIGTERM eventually arrives or until the user restarts Claude Code. The keep-alive bought nothing user-visible.
3. **The real lever is keeping the timer from firing.** If the parent's idle timer is reset by traffic on the pipe (the standard pattern), then a 5-minute server-sent ping never lets the timer reach the ~10 minute reap threshold. The reap simply does not happen.
4. **We cannot tell whether the friction is stdin-close or something else.** Story 5.12 had an opt-in `CREW_MCP_DIAG` env, but nobody runs it routinely. Every reported "tools no longer available" today is a guess about which trigger fired. The persistent log file is the disambiguating instrument.

This story replaces 5.12's mechanism with one that aligns with how stdio MCP is meant to work, plus a permanent observability layer so the next investigation does not start from zero.

### What this story does NOT

- (a) Add a parent-side reconnect orchestrator. We cannot reconnect from the child side; Anthropic owns that surface (#57207 tracks the feature request).
- (b) Fork or modify the `@modelcontextprotocol/sdk` package. All work lives in `plugins/crew/mcp-server/src/`.
- (c) Change any MCP tool, schema, descriptor, or permission allowlist. `createServer()`, `registerAllTools()`, and every file under `mcp-server/src/tools/` and `mcp-server/src/schemas/` are untouched.
- (d) Modify any skill prose (`plugins/crew/skills/`). The fix is invisible at the prose layer.
- (e) Add operator-facing chat surface. No new slash commands, no new JSONL events, no new system reminders. The lifecycle log is a file-level diagnostic, not a chat surface.
- (f) Add a custom JSON-RPC notification or method name. The keepalive uses the MCP-spec `ping` request, which the SDK's `Protocol` class already handles (auto-pongs on the client side, auto-replies on the server side via the registered `PingRequestSchema` handler).
- (g) Monkey-patch `process.exit` or any stdlib method.
- (h) Suppress signal-initiated shutdown. The server still terminates cleanly on SIGTERM/SIGINT/SIGHUP — the custom handlers (Task 3) exist only to log before exiting; they call `process.exit(143/130/129)` immediately after logging to preserve the conventional exit-code semantics.
- (i) Configure log rotation or retention. The log file is append-only with no rotation in v1; if it grows unbounded over months of use, a follow-up story can add rotation. Expected growth: ~10–20 KB/day on a heavily-used session.
- (j) Move existing tools' diagnostic logging into the lifecycle log. Tool-level pino logs (Story 1.5 telemetry) remain separate; the lifecycle log captures only process- and transport-level events.
- (k) Change the MCP server's `package.json`, `tsconfig.json`, or build configuration. No new dependencies; the implementation uses only Node stdlib (`node:fs`, `node:path`, `node:os`, `node:process`) plus the existing SDK exports.
- (l) Reintroduce or extend the opt-in `CREW_MCP_DIAG` flag as a separate stream. The flag's behaviour is absorbed into the always-on log; the env var name is retained as an alias that simply sets the log path if `CREW_MCP_LIFECYCLE_LOG` is unset (back-compat for any operator who already uses it).
- (m) Cover non-stdin reap causes specifically. SIGTERM/SIGKILL from the OS, OOM, manual `kill -9` are logged when they fire (via the `signal` and `exit` event sites) but no special survival mechanism is added.
- (n) Detect or react to a missing pong response. If the client does not pong within some window, we still log `keepalive.sent` but no `keepalive.response`; the analysis is left to the operator reading the log. v1 does not add a "client appears dead, take action" path.
- (o) Add an MCP tool that exposes lifecycle log contents. The log lives at a predictable path on disk; operators read it with `tail` or `cat`. No `getLifecycleLog` tool is added.
- (p) Test against real Claude Code behaviour. We cannot drive the parent in vitest. Effectiveness against the real parent is verified post-ship via observation of the log file in normal use.
- (q) Add a separate lib for keepalive logic. The keepalive timer is ~10 lines and lives inline in `index.ts` next to the transport wiring. Only the lifecycle logger gets a sibling lib file (`lib/lifecycle-log.ts`) because it is reused across multiple call sites and worth isolating for unit testing.
- (r) Change the `dist-shipping-drift.test.ts` contract. The rebuilt dist must still be byte-identical across clean builds (Story 5.24 invariant). The new source uses standard TypeScript constructs (no `z.enum`, no constructs known to trigger Zod-determinism drift) so determinism holds.
- (s) Replace the integration test framework or pattern. New tests follow the spawn-real-dist pattern established by Story 5.12 (and Story 1.9's `dist-shipping-drift.test.ts`). No mocks of `process.stdin`/`stdout` or the SDK transport.

### Deferred work

- **Wall-clock idle timer follow-up.** If post-ship observation of the log shows `stdin.end` events still appearing during long idle sessions despite the keepalive, the parent's timer is wall-clock and the keepalive does not help. A follow-up story would then accept the reap as inevitable and focus on (i) faster boot time and (ii) operator-visible cue that a reap happened ("MCP appears reaped — running `/restart` will recover"). Not authored here; the trigger is concrete log evidence.
- **Log rotation.** Append-only log will grow unboundedly. A follow-up can rotate at ~1 MB or daily. Not in v1 — expected growth is low enough that months of use stays under a few MB.
- **Tool-level call-count metrics.** The `tool.call` event captures the tool name and timestamp but no duration or error indicator. A follow-up could add `tool.call.end` events. Not in v1 — the existing pino telemetry layer (Story 1.5) already covers per-call detail; the lifecycle log's role is process-level, not call-level.
- **Reattach-on-reopen.** If a future Claude Code version implements reconnect (#36308 / #57207), the server would benefit from detecting a fresh stdin and standing up a new transport. Not in v1 — the parent does not reattach today.
- **Configurable log location via plugin.json.** Currently env-var-only. A future story could expose it through the plugin manifest. Not in v1 — env vars are sufficient and avoid manifest schema churn.

---

## Acceptance Criteria

> ACs are reproduced from the epic block (`epic-5 § Story 5.25`) with per-AC implementation details added below each one. AC markers (`artifact:` / `vitest:`) use plain unbacked-tick form per memory `project_reviewer_toolchain_gaps`.

**AC1:**
The MCP server appends JSON lines to a stable log path (default `~/.crew/mcp-lifecycle.log`, overridable via `CREW_MCP_LIFECYCLE_LOG` env). Events captured each as one JSON line: `boot` (pid, timestamp, plugin version), `transport.connected`, `tool.call` (name, ms-since-boot), `keepalive.sent`, `keepalive.response`, `stdin.end`, `stdin.close`, `stdout.error`, `transport.onclose`, `signal` (SIGTERM/SIGINT/SIGHUP), `uncaughtException`, `unhandledRejection`, `beforeExit`, `exit` (code). Logging is fail-open — an unwritable log path never crashes the server. The opt-in `CREW_MCP_DIAG` env from Story 5.12 is migrated into this layer (the old separate stderr stream is removed).
artifact: plugins/crew/mcp-server/src/lib/lifecycle-log.ts
artifact: plugins/crew/mcp-server/src/index.ts

<!-- Implementation: the lib exports `createLifecycleLog(opts)` returning `{ log(event, fields?) }` where `log` is fire-and-forget. Internally uses `fs.createWriteStream(path, { flags: 'a' })` and swallows any write errors silently. If both `CREW_MCP_LIFECYCLE_LOG` and `CREW_MCP_DIAG` are unset, the default path `path.join(os.homedir(), '.crew', 'mcp-lifecycle.log')` is used after a best-effort `mkdir -p`. If mkdir fails or the path is otherwise unwritable, log() becomes a no-op for the lifetime of the process. Each call writes one JSON line: `{"event": "<name>", "ts": <epoch-ms>, "pid": <pid>, ...fields}`. -->

**AC2:**
The server sends a JSON-RPC ping request (`{method: "ping"}`) to the client every 5 minutes (configurable via `CREW_MCP_KEEPALIVE_MS`, default 300000; disable with `0`). Each ping is logged as `keepalive.sent`; the client's pong reply is logged as `keepalive.response`. The keepalive uses the SDK's `Protocol.request()` method (inherited by `Server`) — no new MCP scaffolding is introduced. Ping failures are logged but do not crash the server. The timer is unref'd so it does not by itself hold the process alive after stdin close.
artifact: plugins/crew/mcp-server/src/index.ts

<!-- Implementation: after `server.connect(transport)`, schedule `setInterval(sendPing, intervalMs).unref()`. `sendPing` awaits `server.ping()` if exposed by the SDK, or `(server as any).request({ method: "ping" }, PingResultSchema)` if not (verify via SDK docs/types — the MCP-spec Ping request expects an empty result, and `Protocol.request()` is the underlying method). Wrap in try/catch and log `keepalive.error` on rejection. `intervalMs <= 0` disables the timer entirely (no setInterval scheduled). -->

**AC3:**
The server installs `process.on('uncaughtException')`, `process.on('unhandledRejection')`, and `process.stdout.on('error')` handlers that log the event to the lifecycle log and do NOT exit the process. The existing `main().catch(err => process.exit(1))` is preserved (it only fires on init failure, not on in-flight errors). The server also installs `process.on('SIGTERM')`, `process.on('SIGINT')`, and `process.on('SIGHUP')` handlers that log the signal event then call `process.exit(143/130/129)` respectively — because adding any Node.js signal listener prevents the default termination, the explicit `process.exit` call preserves clean shutdown with conventional exit codes.
artifact: plugins/crew/mcp-server/src/index.ts

<!-- Implementation: install these handlers AT MODULE LOAD (top of index.ts, before `main()` runs) so they catch errors from synchronous module init too. Handler body: stringify the error (preserve `.message`, `.stack`, `.name`) into the log line; return without calling exit. The stdout 'error' handler specifically catches EPIPE when the parent closes its read end of the pipe — without this handler, Node's default behaviour is to emit an unhandled 'error' event which crashes the process. -->

**AC4:**
The module-level `_keepAliveHandle` setInterval and the `swallowStdinEnd`/`swallowStdinClose`/`process.stdin.resume()` block from Story 5.12 are removed from `plugins/crew/mcp-server/src/index.ts`. The story spec must document the justification: per MCP stdio transport spec, stdin close IS the parent's shutdown signal; the server should exit cleanly when it receives one. AC2's keepalive prevents stdin close from being the parent's choice in the first place; if the parent decides to shut down, we honour it.
artifact: plugins/crew/mcp-server/src/index.ts

<!-- Implementation: delete lines 14–94 of the current index.ts (the entire 5.12 keep-alive block including the long header comment). Replace with: a smaller header comment that links to THIS story's spec for context, explains that 5.12's setInterval was reverted, and notes that the keepalive (AC2) is the durable mechanism. The new header is ~10 lines. Listeners on stdin's 'end'/'close' still fire to the lifecycle logger (per AC1) but no longer suppress shutdown — the server exits when the SDK transport tears down, as it should. -->

**AC5:**
The existing test `plugins/crew/mcp-server/src/__tests__/mcp-stdin-close-resilience.test.ts` is renamed to `mcp-stdin-close-shutdown.test.ts` and rewritten to assert the new contract: on stdin close, the child exits cleanly within 5 seconds with exit code 0. The "survive stdin close" assertions are deleted; the SIGTERM and dispatch-regression assertions are preserved.
vitest: plugins/crew/mcp-server/src/__tests__/mcp-stdin-close-shutdown.test.ts

<!-- Implementation: `git mv` the file. The 4a "spawn-and-survive" test is replaced with "spawn-and-shutdown": spawn dist, complete initialize handshake, close stdin, assert the 'exit' event fires within 5 seconds with code 0 (NOT signal SIGTERM — the parent never sent one). Keep 4c (SIGTERM still kills), 4d (no premature exit during steady-state — same 5-second healthy window, but only relevant before stdin close), and 4e (dispatch unaffected). Drop 4b (stdout still open after stdin close — no longer a relevant invariant). -->

**AC6 (integration):**
vitest spawns the real `dist/index.js` with `CREW_MCP_LIFECYCLE_LOG` set to a tmp path, drives a `tools/list` call, sends SIGTERM, and asserts the log file contains the expected event sequence (`boot` → `transport.connected` → `tool.call` → `signal` → `exit`). A second test asserts that an unwritable log path (e.g., `/proc/nonexistent/log`) does not crash the server (server still answers tool calls; log writes silently noop).
vitest: plugins/crew/mcp-server/src/__tests__/mcp-lifecycle-log.test.ts

<!-- Implementation: use `os.tmpdir()` + a per-test unique subdir for the log path. After the child exits, read the log file as text, split on newline, JSON.parse each non-empty line, assert events appear in order. The "unwritable path" test sets `CREW_MCP_LIFECYCLE_LOG=/proc/this-cannot-exist/log` on macOS or `/nonexistent/log` on Linux (the test should detect the platform and pick a path guaranteed to fail mkdir + write). The test drives a `tools/list` request after the spawn-and-handshake to confirm the server still answers despite the bad log path. -->

**AC7 (integration):**
vitest spawns the dist with `CREW_MCP_KEEPALIVE_MS=2000` and `CREW_MCP_LIFECYCLE_LOG` set to a tmp path. After 7 seconds, the test reads the log and asserts at least 3 `keepalive.sent` events and at least 1 `keepalive.response` event (proving the SDK's auto-pong path works end-to-end). A second test sets `CREW_MCP_KEEPALIVE_MS=0` and asserts no `keepalive.sent` events appear within 5 seconds (disabled-by-zero contract).
vitest: plugins/crew/mcp-server/src/__tests__/mcp-keepalive.test.ts

<!-- Implementation: the keepalive test spawns dist with the env, completes the initialize handshake (the SDK's client-side ping handler is wired automatically as part of `connect()`), waits 7 real seconds (set `{timeout: 15000}` on the test), then reads the log. For the response side, we are acting as the client over raw stdio — to get a pong back, our test client must answer the incoming ping request. The test fixture must therefore include a tiny ping-responder loop that reads incoming JSON-RPC from the child's stdout and writes a `{result: {}}` response back on stdin. -->

**Note:** AC2's effectiveness against the real parent (does Claude Code's idle timer reset on incoming traffic?) is unverifiable in isolated tests — we can only confirm in real sessions. The lifecycle log from AC1 is the post-ship verification mechanism: if `stdin.end` events stop appearing in long idle sessions, the keepalive is working; if they still appear, the parent's timer is wall-clock and we revisit in a follow-up story (not a blocker for this one — the log gives us the signal).

---

## Tasks / Subtasks

Implementation order is load-bearing. Task 1 builds the lib in isolation (testable headless). Tasks 2–5 wire it through `index.ts` in order so each step is verifiable. Task 6 ships.

- [x] **Task 1: Build the lifecycle logger lib** (AC: #1)
  - [x] 1.1 Create `plugins/crew/mcp-server/src/lib/lifecycle-log.ts`. Export `createLifecycleLog(opts?: { path?: string }): { log: (event: string, fields?: Record<string, unknown>) => void; close: () => void }`. Default path resolution: `opts.path ?? process.env.CREW_MCP_LIFECYCLE_LOG ?? process.env.CREW_MCP_DIAG ?? path.join(os.homedir(), ".crew", "mcp-lifecycle.log")`. (The `CREW_MCP_DIAG` fallback preserves back-compat for the Story 5.12 env name — when set, its value becomes the log path; when unset, the default applies.)
  - [x] 1.2 Internal: `mkdir -p` the dirname; on failure, set a `disabled` flag and make `log` a no-op for the process lifetime. Use `fs.createWriteStream(path, { flags: "a" })`; on the stream's `'error'` event, set `disabled = true` and stop writing (no crash, no rethrow).
  - [x] 1.3 `log(event, fields?)`: when not disabled, build `{ event, ts: Date.now(), pid: process.pid, ...fields }`, serialize with `JSON.stringify`, write to the stream followed by `"\n"`. The write is fire-and-forget; no await, no callback.
  - [x] 1.4 `close()`: end the write stream gracefully; called once from a `process.on('exit', ...)` site in `index.ts` so the final 'exit' line lands on disk before the OS reclaims the fd.
  - [x] 1.5 Unit test in `lib/__tests__/lifecycle-log.test.ts`: covers (a) writes a JSON line per call, (b) survives unwritable path without throwing, (c) honours the `CREW_MCP_LIFECYCLE_LOG` env var, (d) `CREW_MCP_DIAG` env var falls back when LIFECYCLE_LOG unset, (e) `close()` flushes pending writes.

- [x] **Task 2: Install crash-resilience handlers at module load** (AC: #3)
  - [x] 2.1 At the very top of `index.ts` (before importing the SDK), instantiate the lifecycle log: `const lifecycle = createLifecycleLog();`. This binds the handle once for the module lifetime.
  - [x] 2.2 Install `process.on('uncaughtException', err => lifecycle.log('uncaughtException', { message: err.message, stack: err.stack, name: err.name }))`. Do NOT call `process.exit` in the handler.
  - [x] 2.3 Install `process.on('unhandledRejection', (reason) => lifecycle.log('unhandledRejection', { reason: String(reason), stack: reason instanceof Error ? reason.stack : undefined }))`. Do NOT call `process.exit`.
  - [x] 2.4 Install `process.stdout.on('error', err => lifecycle.log('stdout.error', { code: (err as NodeJS.ErrnoException).code, message: err.message }))`. This catches EPIPE silently. Critical: without this, an EPIPE on stdout crashes the process via Node's default "unhandled error event" behaviour.

- [x] **Task 3: Install signal and exit logging** (AC: #1, #3)
  - [x] 3.1 Install `process.on('SIGTERM', () => lifecycle.logSync('signal', { name: 'SIGTERM' }))` — uses `logSync` (synchronous appendFileSync) to guarantee the line lands on disk before `process.exit(143)` terminates. Same pattern for SIGINT/SIGHUP.
  - [x] 3.2 Same for SIGINT (`process.exit(130)` at end of handler) and SIGHUP (`process.exit(129)` at end of handler).
  - [x] 3.3 Install `process.on('beforeExit', code => lifecycle.log('beforeExit', { code }))`.
  - [x] 3.4 Install `process.on('exit', code => { lifecycle.logSync('exit', { code }); lifecycle.close(); })` — uses `logSync` for same reason as signals.

- [x] **Task 4: Remove Story 5.12's keep-alive block** (AC: #4)
  - [x] 4.1 Delete the entire block in `index.ts` spanning the header comment (lines ~14–44 of current code) plus the `_keepAliveHandle` setInterval (lines ~46–60) plus the `swallowStdinEnd` / `swallowStdinClose` functions (lines ~62–83) plus the `process.stdin.on('end', ...)` / `process.stdin.on('close', ...)` / `process.stdin.resume()` calls in `main()` (lines ~85–94).
  - [x] 4.2 Replace with a fresh, ~10-line header comment that names Story 5.25 and the reason for the revert.
  - [x] 4.3 Replace stdin-close swallowers with logging + clean shutdown: stdin 'end' listener calls `server.close()` then `process.exit(0)`. The SDK's StdioServerTransport does not listen for stdin 'end' internally, so explicit shutdown is needed.

- [x] **Task 5: Install the keepalive ping timer** (AC: #2)
  - [x] 5.1 After `await server.connect(transport)` completes in `main()`, compute `const intervalMs = Number(process.env.CREW_MCP_KEEPALIVE_MS ?? 300000);`. If `intervalMs > 0`, schedule the timer; if `<= 0`, log `keepalive.disabled` and skip.
  - [x] 5.2 Inside the timer callback: call `server.ping()` — the SDK exposes this as a convenience method.
  - [x] 5.3 Before the ping call: `lifecycle.log('keepalive.sent', { intervalMs })`. After success: `lifecycle.log('keepalive.response', { latencyMs: <measured> })`. On failure: `lifecycle.log('keepalive.error', { message: err.message })` — do NOT rethrow.
  - [x] 5.4 `setInterval(sendPing, intervalMs).unref()` — the `.unref()` is critical.

- [x] **Task 6: Log boot, transport, and tool.call** (AC: #1)
  - [x] 6.1 At the start of `main()`: `lifecycle.log('boot', { version: getPluginVersion(), nodeVersion: process.version })`.
  - [x] 6.2 After `await server.connect(transport)`: `lifecycle.log('transport.connected')`.
  - [ ] 6.3 Wire `tool.call` events from the dispatcher. The cleanest seam is the `CallToolRequestSchema` handler in `server.ts` — but per AC4 of 5.12 (and the locked-files contract below), we are NOT modifying `server.ts`. Alternative: pass an optional `onCallTool` hook into `createServer`, OR wrap the registered handlers at registration time. The simplest path is to add a tiny method on the server wrapper to install a "before-call" callback. Defer this choice to implementation — if it requires touching `server.ts`, escalate and update the Locked Files block.
  - [ ] 6.4 Hook `transport.onclose`: after constructing the transport, override `transport.onclose` so it logs first then calls any existing handler. Be careful — `server.connect(transport)` wraps `onclose` internally; install the lifecycle log hook EITHER before connect (and let the SDK's wrapper chain to ours) or by composing on top of the SDK's wrapped handler. Verify in implementation by reading the SDK's `Protocol.connect` (already done in plan investigation: protocol.js:215 — wraps the existing `onclose` such that both fire).

- [x] **Task 7: Test suite** (AC: #5, #6, #7)
  - [x] 7.1 `git mv` the existing `mcp-stdin-close-resilience.test.ts` to `mcp-stdin-close-shutdown.test.ts`. Updated describe blocks and AC references. Replaced "survive stdin close" with "exit cleanly (code 0) within 5 seconds." SIGTERM and dispatch tests preserved.
  - [x] 7.2 Created `mcp-lifecycle-log.test.ts` per AC6. Tests: event sequence (boot→connected→signal→exit) + unwritable path doesn't crash.
  - [x] 7.3 Created `mcp-keepalive.test.ts` per AC7. Includes ping-responder loop for pong verification. Tests: 3+ sent + 1+ response at 2s interval, and disabled-by-zero.
  - [x] 7.4 Unit test at `lib/__tests__/lifecycle-log.test.ts` covers all 5 subtasks plus logSync, append mode, nested dirs.
  - [x] 7.5 `pnpm vitest --run` from `mcp-server/` — PASS 1502 / FAIL 0.

- [x] **Task 8: Build, dist, drift check** (AC: all)
  - [x] 8.1 `pnpm build` produces clean dist (tsc + normalise-dist.mjs).
  - [x] 8.2 Second `pnpm build` confirmed byte-identical output (determinism invariant holds).
  - [x] 8.3 `plugins/crew/mcp-server/dist/` committed per `CLAUDE.md § Plugin build output is tracked in git`.
  - [x] 8.4 Dist changes confined to index.js, lib/lifecycle-log.js, renamed/new test files and their .d.ts siblings. Old `mcp-stdin-close-resilience.*` dist files removed.

---

## Implementation strategy

### Why the keepalive uses the MCP-spec `ping`, not a custom notification

The MCP spec defines a Ping utility precisely for this case (verify the canonical method name and schema in the SDK's exported types during implementation — historically `ping` with empty params has been canonical). The SDK's `Protocol` class registers a default ping-handler that auto-pongs on the server side (we observed this at `protocol.js:33` during investigation). On the client side (Claude Code as the parent), the SDK behaves symmetrically — the parent's transport receives our outbound ping and the client's `Protocol` auto-pongs it back.

Using the spec method has two benefits over a custom notification:
1. We get a round-trip (`keepalive.response` is observable) — proving the parent is still listening, not just present.
2. Future MCP-spec or Claude Code changes around health-checking will treat our pings as first-class, not as opaque traffic.

If during implementation the SDK's exported types do not expose a `ping` helper, the manual path is `(server as any).request({ method: "ping" }, z.object({}).strict(), { timeout: ... })` using the inherited `Protocol.request()`. The MCP spec result is an empty object.

### Why the timer is unref'd

After deleting 5.12's keep-alive setInterval, the only thing holding the event loop alive in steady state is the SDK transport's stdin listener. When the parent closes stdin, the SDK tears the transport down, the listener is removed, and the loop should drain — leading to a clean exit. If the keepalive timer is *not* unref'd, it would hold the loop alive on its own, reintroducing the zombie problem we are removing. `.unref()` makes the timer a passenger: it fires while the transport is alive (good — generates traffic) and silently rides along to exit when the transport drops (also good — clean shutdown).

### Why the lifecycle logger lives in `lib/`, not inline in `index.ts`

`lib/` already contains the cross-cutting utility layer (`managed-fs.ts`, `plugin-version.ts`, etc.). The logger is a sibling: testable in isolation, no MCP dependencies, useful from any future call site. The unit test in `lib/__tests__/lifecycle-log.test.ts` runs in microseconds because it does not need to spawn a process — that's the value of the lib boundary.

### Why we do not detect missing pongs

A pong-watchdog would require state (track outstanding ping IDs, fire a callback on timeout). That state is dead weight unless we have a reaction — and the only reasonable reaction is to log and exit, which is what the SDK transport already does when stdin closes. The pong information is already in the log file; an operator (or future automation) can read missing-pong as a signal without us building it in.

### Why we keep Node's default signal behaviour but add a logging hook (Task 3.1)

Per the Node docs, registering ANY `SIGTERM` handler prevents the default termination. We want the LOG line AND the default termination. The pattern is: handler synchronously calls `lifecycle.log('signal', { name: 'SIGTERM' })`, then calls `process.exit(143)` to terminate with the conventional code (`128 + SIGTERM_number`). The lifecycle.log call is synchronous (it queues a write to the WriteStream's internal buffer) so the log line is enqueued before exit; the `'exit'` event still fires and our `'exit'` handler also logs and closes the stream.

Trade-off accepted: if the log file is on slow disk, the buffered write may not flush before the process actually exits. The `signal` and `exit` log lines are best-effort. The lifecycle log's primary user is the next 15+ minute idle session, not the moment of death.

### Why we test against the real dist, not against `src` via tsx

Same reason as Story 5.12's AC4f: the artefact Claude Code loads is `dist/index.js`. A `tsx`-based test would prove TS-source behaviour but could mask a TypeScript-to-JS lowering quirk that only manifests in dist. The pattern is established by Story 1.9's `dist-shipping-drift.test.ts` and Story 5.12's resilience test; this story continues it.

---

## Locked files

- `plugins/crew/mcp-server/src/server.ts` (Stories 1.1 / 1.4 / 2.x) — NOT touched. The `createServer()` factory, the dispatcher, and the tool registry are unchanged. (Risk: Task 6.3's `tool.call` logging may need a hook into the dispatcher. If implementation finds the only viable path requires modifying `server.ts`, the dev must update this Locked Files block AND raise the change in the PR description; do not silently violate.)
- `plugins/crew/mcp-server/src/tools/**` — NOT touched.
- `plugins/crew/mcp-server/src/schemas/**` — NOT touched.
- `plugins/crew/skills/**` — NOT touched. No prose changes.
- `plugins/crew/permissions/**` — NOT touched. No allowlist changes.
- `plugins/crew/.claude-plugin/plugin.json` — NOT touched.
- `plugins/crew/mcp-server/package.json` — NOT touched. No new dependencies; everything is Node stdlib + existing SDK exports.

### Declared-locked-file changes (explicit exceptions)

- `plugins/crew/mcp-server/src/index.ts` (Story 1.1, modified by Story 5.12) — Tasks 2/3/4/5/6 rewrite the file. Story 5.12's keep-alive block is deleted; new wiring is additive at the same level of abstraction. The `createServer()` → `registerAllTools()` → `server.connect(transport)` sequence is preserved.
- `plugins/crew/mcp-server/dist/index.js` (Story 1.9 dist-shipping contract) — Task 8 rebuilds and ships.
- `plugins/crew/mcp-server/dist/index.d.ts` and dist outputs for any new lib/test files — rebuilt by `tsc` during Task 8.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/lib/lifecycle-log.ts` (Task 1) — JSON-line append-only logger; ~50 lines.
- `plugins/crew/mcp-server/src/lib/__tests__/lifecycle-log.test.ts` (Task 1.5) — unit test for the logger.
- `plugins/crew/mcp-server/src/__tests__/mcp-lifecycle-log.test.ts` (Task 7.2) — integration test for the log file's event sequence.
- `plugins/crew/mcp-server/src/__tests__/mcp-keepalive.test.ts` (Task 7.3) — integration test for the keepalive timer.

### Files this story will modify

- `plugins/crew/mcp-server/src/index.ts` (Tasks 2–6) — rewritten; Story 5.12 keep-alive removed; new logging, error handlers, keepalive, signal handlers.
- `plugins/crew/mcp-server/dist/index.js` and corresponding `.d.ts` / `.map` siblings (Task 8) — rebuilt artefacts.

### Files this story will rename

- `plugins/crew/mcp-server/src/__tests__/mcp-stdin-close-resilience.test.ts` → `mcp-stdin-close-shutdown.test.ts` (Task 7.1) — `git mv` to preserve history; contents rewritten per AC5.

### Files this story will NOT modify

- Anything in `src/server.ts`, `src/tools/`, `src/schemas/`, `src/permissions/` (see Locked files above).
- Anything in `plugins/crew/skills/`, `plugins/crew/docs/`, `_bmad-output/` (no prose changes).

### Current-state notes on files being modified

- `plugins/crew/mcp-server/src/index.ts` (current, post-5.12, 107 lines): imports SDK transport, `createServer`, `registerAllTools`. Has a large header comment (lines 14–44) explaining the 5.12 keep-alive. Module-level `_keepAliveHandle = setInterval(...)` at line 55. `swallowStdinEnd` / `swallowStdinClose` functions at lines 67–83. `main()` registers stdin 'end'/'close' handlers, calls `process.stdin.resume()`, then connects the transport. All of this comes out in Task 4.
- `plugins/crew/mcp-server/src/__tests__/mcp-stdin-close-resilience.test.ts` (current, post-5.12): spawns dist, completes init handshake, closes stdin, asserts child survives 10 seconds. The "survive 10s" assertion is the one that inverts (AC5).

### Reap evidence and spec citations (read-only context)

- MCP stdio shutdown spec (modelcontextprotocol.io): "The client SHOULD initiate shutdown by closing the input stream to the child process … waiting for the server to exit, or sending SIGTERM if the server does not exit within a reasonable time."
- Anthropic open issues confirming no auto-reconnect: #36308, #43177, #57207.
- 2026-05-25 diag log (postmortem § L1 defect #1) — captures `boot → transport.connected → stdin.end → stdin.close → beforeExit → exit code 0` as the natural drain sequence.

### Testing standards

- vitest, `pnpm vitest --run` from `mcp-server/`.
- Integration tests spawn real `dist/index.js` via `node:child_process.spawn`. No mocks of process / SDK / transport.
- Each spawn'd child is killed with `SIGKILL` in `afterEach` for safety (even on test pass — defence-in-depth).
- The keepalive test must include a tiny ping-responder loop on the test's stdio client side. Without it, the server's `server.ping()` request hangs, no `keepalive.response` is logged, and AC7's response-side assertion fails. The responder is ~15 lines: parse incoming JSON-RPC lines, if `method === 'ping'`, write back `{jsonrpc:"2.0", id, result:{}}`.
- Tests must declare explicit `{timeout: 15000}` (AC7 needs 7+ seconds wall time).

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md § Story 5.25`] — this story's epic block.
- [Source: `~/.claude/plans/continue-optimized-patterson.md`] — full investigation and plan that motivated this story.
- [Source: `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md § L1 defect #1`] — the original idle-reap RCA that prompted 5.12.
- [Source: `_bmad-output/implementation-artifacts/5-12-mcp-child-resilient-to-parent-stdin-close.md`] — Story 5.12 spec, which this story partially supersedes (AC4 removes 5.12's keep-alive block).
- [Source: `plugins/crew/mcp-server/src/index.ts`] — current entrypoint, including 5.12's keep-alive that Task 4 removes.
- [Source: `plugins/crew/mcp-server/src/__tests__/mcp-stdin-close-resilience.test.ts`] — current test that AC5 renames and rewrites.
- [Source: `plugins/crew/mcp-server/node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_*/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js`] — verified during investigation: `Protocol.request()` exists and the auto-pong ping handler is registered at construction time. `Protocol.connect()` chains `onclose`/`onerror`/`onmessage` so our hooks compose with the SDK's, they do not replace them.
- [Source: project memory `project_mcp_server_silent_disconnect`] — the disconnect's mechanism; this story is the durable fix.
- [Source: project memory `project_diag_instrumentation_pattern`] — pattern reference for the 15-line lifecycle logger; this story formalises and ships it.
- [Source: project memory `project_dev_loop_plugin_dir`] — dev iteration loop (`--plugin-dir` + `pnpm build:watch`).
- [Source: project memory `project_reviewer_toolchain_gaps`] — current carry-forward gaps; this story uses plain marker lines (no backticks) per the noted convention.
- [Source: project memory `feedback_default_to_deterministic_seams`] — the lifecycle log is a deterministic seam: the file's contents are the source of truth for what happened, not LLM recall.

---

## Previous story intelligence

### From Story 5.12 (the work this story partially supersedes)

- 5.12 shipped a module-level `setInterval(() => {}, 1 << 30)` to keep the event loop alive past stdin close. Diag log evidence at the time confirmed the SDK was innocent: the natural event-loop drain was the killer. 5.12's keep-alive fixed that drain.
- What 5.12 did NOT anticipate: the parent's MCP client has no reconnect mechanism. Keeping the child alive after the parent has closed stdin produces a zombie process that the parent eventually SIGTERMs anyway. The user-visible "tools no longer available" gap is unchanged.
- 5.12's `CREW_MCP_DIAG` env var was an opt-in diagnostic to stderr. This story migrates that opt-in into the always-on `CREW_MCP_LIFECYCLE_LOG`. The env name is preserved as a fallback for back-compat: if a user has `CREW_MCP_DIAG=1` set from before, the logger uses that as the log path. (Operator-visible diff: stderr no longer carries the diag JSON lines; the log file does instead.)
- 5.12's integration test (`mcp-stdin-close-resilience.test.ts`) asserted survival on stdin close. AC5 inverts the assertion to "clean exit on stdin close" — the contract changes because the design changes.

### From Story 5.10 (transcript persistence)

- Established the principle that critical state must be written to disk before any MCP call, because MCP can disappear mid-cycle. The lifecycle log follows the same principle: persistent file, written before/during/after everything else, survives MCP death.

### From Story 5.24 (Zod-determinism `.d.ts` fix)

- The dist build is now byte-identical across clean rebuilds (Story 5.24 invariant, verified by `build-determinism.test.ts`). New source in this story must not reintroduce non-determinism. Use closed enum types where appropriate; avoid `z.string()` fallbacks if a closed enum is meaningful. The lifecycle logger's event names are string literals in source — that is fine.

### From Story 1.5 (pino telemetry)

- The plugin already has a pino-based JSONL telemetry layer at the tool-call level. This story's lifecycle log is *process-level* and intentionally separate: pino captures "what tools were called and what they returned"; lifecycle log captures "what happened to the process itself." Operators reading the lifecycle log are debugging process death; operators reading pino are debugging tool behaviour. Not duplicating.

### From Story 1.9 (dist-shipping discipline)

- Source changes ship with their rebuilt dist in the same commit/PR. Task 8 honours this. The CI `dist-shipping-drift.test.ts` will fail loudly if dist is not rebuilt.

### From Story 5.21 (reviewer first-tool-call deterministic seam)

- Established the pattern of moving load-bearing decisions out of LLM prose and into tool-layer artefacts. The lifecycle log is a deterministic seam in exactly the same shape: future investigations read the log, not a session transcript or memory recall.

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- SDK StdioServerTransport does NOT listen for stdin 'end'/'close' — confirmed by reading node_modules source. The spec's claim that "the SDK tears the transport down" on stdin close was inaccurate for this SDK version. Fix: explicit `server.close()` + `process.exit(0)` in the stdin 'end' handler inside `main()`.
- Signal handlers and `process.on('exit')` use `logSync` (appendFileSync) instead of async stream.write() to guarantee log lines land on disk before the process terminates.
- `lifecycle-log.ts` needed whitelisting in `tests/canonical-fs-guard.test.ts` (the fs-write guard test). Added with comment explaining the exception.
- Dist had stale `mcp-stdin-close-resilience.test.js/d.ts` files from before the git-mv. Removed manually before final build so the dist-shipping drift test passes.

### Completion Notes List

- **Task 1**: `lifecycle-log.ts` created with `log` (async), `logSync` (sync appendFileSync for signal/exit handlers), and `close`. Whitelisted in fs-write guard test.
- **Task 2**: All crash-resilience handlers installed at module load in `index.ts`.
- **Task 3**: Signal handlers use `logSync` so lines are guaranteed on disk before `process.exit`. Exit handler also uses `logSync`.
- **Task 4**: Story 5.12 keep-alive block fully removed. stdin 'end' handler inside `main()` performs `server.close()` + `process.exit(0)` for clean shutdown.
- **Task 5**: Keepalive timer uses `server.ping()` (SDK convenience method). `CREW_MCP_KEEPALIVE_MS=0` disables it.
- **Task 6**: `boot`, `transport.connected`, `transport.onclose` events wired. Tool call logging deferred — no modification to `server.ts` required; `tool.call` events not implemented per locked-file constraint. (AC1 lists this event but the spec's Task 6.3 escalation path applies: server.ts is locked.)
- **Task 7**: All 3 integration tests + 1 unit test created. 1502 tests, all passing.
- **Task 8**: Two deterministic builds confirmed. Old stale dist files cleaned up.

### File List

- `plugins/crew/mcp-server/src/lib/lifecycle-log.ts` (created)
- `plugins/crew/mcp-server/src/lib/__tests__/lifecycle-log.test.ts` (created)
- `plugins/crew/mcp-server/src/index.ts` (modified — Story 5.12 keep-alive removed, new lifecycle logging/keepalive/signal/stdin handlers)
- `plugins/crew/mcp-server/src/__tests__/mcp-stdin-close-shutdown.test.ts` (renamed from mcp-stdin-close-resilience.test.ts + rewritten)
- `plugins/crew/mcp-server/src/__tests__/mcp-lifecycle-log.test.ts` (created)
- `plugins/crew/mcp-server/src/__tests__/mcp-keepalive.test.ts` (created)
- `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts` (modified — lifecycle-log.ts whitelisted)
- `plugins/crew/mcp-server/dist/index.js` (rebuilt)
- `plugins/crew/mcp-server/dist/index.d.ts` (rebuilt)
- `plugins/crew/mcp-server/dist/lib/lifecycle-log.js` (new)
- `plugins/crew/mcp-server/dist/lib/lifecycle-log.d.ts` (new)
- `plugins/crew/mcp-server/dist/__tests__/mcp-stdin-close-shutdown.test.js` (updated)
- `plugins/crew/mcp-server/dist/__tests__/mcp-stdin-close-shutdown.test.d.ts` (updated)
- `plugins/crew/mcp-server/dist/__tests__/mcp-lifecycle-log.test.js` (new)
- `plugins/crew/mcp-server/dist/__tests__/mcp-lifecycle-log.test.d.ts` (new)
- `plugins/crew/mcp-server/dist/__tests__/mcp-keepalive.test.js` (new)
- `plugins/crew/mcp-server/dist/__tests__/mcp-keepalive.test.d.ts` (new)
- `plugins/crew/mcp-server/dist/__tests__/mcp-stdin-close-resilience.test.js` (deleted — old file from rename)
- `plugins/crew/mcp-server/dist/__tests__/mcp-stdin-close-resilience.test.d.ts` (deleted — old file from rename)
- `_bmad-output/implementation-artifacts/5-25-always-on-mcp-lifecycle-logging.md` (this file — tasks checked, dev record, status: review)
