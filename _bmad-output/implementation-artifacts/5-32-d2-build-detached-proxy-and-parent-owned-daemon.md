# Story 5.32: Path D2 build — detached proxy + parent-owned MCP daemon

risk_tier: medium

Status: ready-for-dev

<!--
Authored 2026-05-28 as the v1.1 reliability build. Story 5.31's half-day spike
de-risked D2 (notes file at `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md`;
verdict `proceed-with-d2`). This story implements the five patterns the spike locked in.

Risk tier is medium per the brief: this changes the boot path of the entire MCP
server — every MCP call from every Claude Code session against the crew plugin
flows through the new proxy. The blast radius if the proxy is broken is "the
plugin's MCP surface is completely unreachable, in every session, immediately on
manifest pickup". The medium tier triggers the reviewer's stricter rubric and
the auto-merge pause per Story 4.10b.

The story does NOT remove Story 5.30's halt seam — the seam is still load-bearing
for non-cascade MCP disconnects (idle reap, crash, OS kill). D2 only retires the
cascade-specific restart cost. The verbatim `[mcp-cascade-halted]` line should
stop appearing for cascade reasons in steady state but the seam itself stays.
-->

## Story

As a **plugin operator running `/crew:start` cycles with subagent fan-out**,
I want **the MCP server to survive the SIGTERM cascade that the Claude Code host fires when a subagent `Task` returns, by relocating the real server into its own process group behind a stdio proxy shim**,
So that **`/crew:start` no longer halts on every subagent return, the verbatim `[mcp-cascade-halted]` line shipped by Story 5.30 never appears for cascade reasons in steady state, and one Claude Code session can drain the backlog without per-story restarts**.

### What this story is, in one paragraph

Today the plugin manifest at `plugins/crew/.claude-plugin/plugin.json` registers `command: "node"` + `args: [".../dist/index.js"]` — Claude Code spawns the MCP server as a direct stdio child in the host's own process group. When a subagent's `Task` tool returns, the host SIGTERMs that pgid; the MCP server dies (8/8 paired SIGTERMs in `~/.crew/mcp-lifecycle.log` across 4 incidents — the RCA-named cascade). This story replaces that direct spawn with a thin proxy shim. The shim becomes the host's stdio child; on first connection it `spawn(daemon, { detached: true, stdio: 'ignore' })`s the real MCP server, putting the daemon in its own pgid; the shim then byte-forwards JSON-RPC frames between its stdio (where Claude Code listens) and a per-user unix socket at `~/.crew/mcp-daemon.sock` (where the daemon listens). When the host SIGTERMs the shim's pgid at subagent `Task` return, the shim dies; the daemon — being in a different pgid — does not receive the signal. The next subagent's MCP traffic reconnects to the same socket and finds the daemon still running. Story 5.31's spike confirmed all of this is buildable on darwin with no host changes; this story is the 2–3 day build.

### Why now (sequencing)

- Story 5.30 (sibling) ships the halt seam — it stops the cascade gracefully but every cascade still costs one Claude Code restart. That is a daily-friction patch, not a fix.
- Story 5.31 (sibling) de-risked D2. All five blocking questions (Q1–Q5) answered with concrete evidence; verdict `proceed-with-d2`.
- Resuming `/crew:start` autonomous-drain (currently paused — see memory `project_reviewer_toolchain_gaps`) requires the cascade not to fire mid-drain. D2 is the structural fix; without it, autonomous drain is bounded by the first subagent return.

### What this story does NOT

- (a) Modify any tool-layer code in `plugins/crew/mcp-server/src/tools/`. The shim is transport-layer infrastructure; no tool semantics change.
- (b) Remove the halt seam from Story 5.30 (`plugins/crew/skills/start/SKILL.md` + `McpDisconnectedError`). The seam stays as the safety net for non-cascade MCP disconnects (idle reap, crash, OS kill). D2 only retires the cascade-specific restart cost.
- (c) Build a launchd/systemd-supervised daemon (Path B). The daemon is parent-owned (the shim spawns it; the OS reparents to init when the shim exits). No system-level service manager is introduced.
- (d) Add a token-handshake or any TLS/auth scheme to the socket. Per Q5's verdict (`socket-auth: filesystem-permission-only`), `0600` on the socket + `0700` on `~/.crew/` is the auth control. Defence-in-depth peer-EUID check via `getsockopt(LOCAL_PEEREUID)` is wired but optional.
- (e) Support Linux or Windows. Per Q5's scoping, darwin is the reference platform for v1.1. AC3's integration test is `skipIf(process.platform !== 'darwin')`. Cross-platform follow-up is deferred until non-darwin operators surface.
- (f) Change the keepalive ping or lifecycle log behaviour. Those live in `index.ts` and continue to run inside the daemon. The shim is transport-only and emits no lifecycle events of its own beyond a single line on boot/exit (for diagnostics).
- (g) Migrate the build to a different bundler. The proxy source lives under `plugins/crew/mcp-proxy/src/` and reuses the existing tsc + `normalise-dist.mjs` pattern that `mcp-server` uses today. No new build tooling.
- (h) Bump `@modelcontextprotocol/sdk` or any other dependency. The proxy is pure-Node (`child_process`, `net`, `fs`, `process`); it imports nothing from the SDK.

### Deferred work

- **Linux / Windows platform validation.** Out of scope per Q5. Follow-up spike covers the platform-specific deltas (no `LOCAL_PEEREUID` on Linux; `SO_PEERCRED` instead; Windows has no unix sockets — named pipes required).
- **Graceful daemon shutdown on operator command.** If an operator wants to manually kill the daemon today, `pkill -f mcp-server/dist/index.js` or `kill $(cat ~/.crew/mcp-daemon.pid)` works. A `/crew:stop-daemon` skill is a v1.2 nicety, not v1.1 baseline.
- **Multi-version daemon coordination.** If two plugin versions are installed (e.g., during an upgrade), the second shim will reuse the first daemon — which may be running an older server version. v1.1 ships single-version semantics; a version-stamp negotiation between shim and daemon is deferred.
- **Removing the Story 5.30 halt seam.** Once D2 has been running in steady state with no cascade halts observed for several weeks, the seam can be removed. v1.1 keeps both belts and braces.
- **Telemetry on shim spawn cost.** A timing record (`shim.spawn.duration_ms`) emitted to the lifecycle log on first daemon spawn would help validate the perf budget. Defer to v1.2 if cold-start latency becomes a complaint.

---

## Acceptance Criteria

> ACs are reproduced from this story's epic block (`epic-5 § Story 5.32`) with per-AC implementation detail added below each one. AC markers (`artifact:` / `vitest:`) use plain unbacked-tick form per memory `project_reviewer_toolchain_gaps` (entry 1). Each `vitest:` marker resolves to a file under `plugins/crew/mcp-server/src/__tests__/` (unit) or `plugins/crew/mcp-server/tests/` (integration) so the existing `pnpm -F @crew/mcp-server test` script picks them up.

**AC1 (proxy shim spawn — detached child + JSON-RPC initialize forward):**
A vitest unit test asserts the proxy shim's spawn path. Given a fake stdio pair (in-memory streams), when the proxy starts with no daemon present, it (a) spawns a child process via `child_process.spawn` with `detached: true` and `stdio: 'ignore'`, (b) calls `child.unref()`, (c) writes a JSON-RPC `initialize` request through stdio and confirms it reaches the daemon via the unix socket, (d) the spawned child's pid is recorded in the PID file. Test must inject the daemon binary path (env var or constructor arg) so the test daemon is a tiny vitest fixture, not the real MCP server.
vitest: plugins/crew/mcp-server/src/__tests__/proxy-spawn.test.ts

<!--
Implementation: factor the proxy into a `ProxyHarness` class (or a `createProxy(opts)` factory)
so the test can inject:
  - daemonCommand: string (path to a vitest fixture daemon, not the real one)
  - daemonArgs: string[]
  - socketPath: string (under a per-test tmpdir, not ~/.crew/)
  - pidPath: string (same tmpdir)
  - lockPath: string (same tmpdir)
  - stdin / stdout: NodeJS.ReadableStream / WritableStream (fake in-memory streams)

The vitest fixture daemon is a tiny Node script (under `tests/fixtures/echo-daemon.mjs`) that
binds the supplied socket path, accepts one connection, reads one JSON-RPC frame, writes back
a fixed initialize-response frame, then sleeps for 10s (so the test can verify the spawn-detach
behaviour without the daemon exiting before the assertions run). The daemon writes its own
pid to `process.env.PID_FILE` if set so the test can assert PID-file contents.

Spawn assertion shape (using vitest's vi.spyOn on child_process.spawn):
  - Call count: 1
  - Args[0]: daemonCommand
  - Args[1]: daemonArgs
  - Args[2].detached: true
  - Args[2].stdio: 'ignore'
  - Returned child object: .unref() was called once

JSON-RPC initialize-forward assertion: write the canonical initialize frame to the proxy's
stdin (the in-memory writable), poll the in-memory stdout for the initialize-response frame,
assert it matches the fixture's response within a 2s timeout.

Keep this test deterministic — no real spawn, no real socket, all injected. The integration
test in AC3 is where the real moving parts get exercised.
-->

**AC2 (lockfile lifecycle — spawn, reuse, respawn-on-stale):**
A vitest unit test exercises three flows against the proxy's daemon-acquisition logic: (a) no PID file exists → proxy spawns daemon, writes PID file, connects socket; (b) PID file exists and `kill(pid, 0)` returns truthy AND connect-probe succeeds → proxy reuses, no spawn; (c) PID file exists but `kill(pid, 0)` returns ESRCH (stale PID, daemon crashed) → proxy unlinks PID + socket, spawns new daemon. Each branch asserts the observed action (spawn count, PID-file contents, connect attempts) against a vitest mock of `child_process.spawn`, `process.kill`, and `net.connect`. The flock-based concurrent-spawn race (per Q4 hybrid recommendation) is exercised by a fourth case asserting that two concurrent acquire calls result in one spawn, one wait-and-reuse.
vitest: plugins/crew/mcp-server/src/__tests__/proxy-lockfile.test.ts

<!--
Implementation: factor the daemon-acquisition logic into a pure function
`acquireDaemon(opts): Promise<{ socket: net.Socket; daemonPid: number; spawned: boolean }>`
that takes injected versions of:
  - spawn: typeof child_process.spawn (mock in the test)
  - kill: (pid: number, sig: number | string) => void (mock; throws ESRCH-tagged Error for stale-pid case)
  - connect: (path: string) => net.Socket (mock; returns a stub socket per case)
  - statSync, unlinkSync, writeFileSync: from node:fs (mock as needed)
  - flock primitive (use `proper-lockfile` package if it exists in workspace; otherwise hand-roll
    on `fs.openSync(lockPath, 'wx')` with cleanup on release — note this is best-effort on macOS
    where O_EXCL on local fs is reliable but flaky on NFS).

Four named test cases (one `describe` per case):
  1. "spawns daemon when no PID file exists"
     - statSync(pidPath) throws ENOENT
     - Expect: spawn called once; pid file written with returned child.pid; connect called after
       spawn; returned object: { spawned: true, daemonPid: <child.pid> }
  2. "reuses daemon when PID file exists, kill(0) truthy, connect succeeds"
     - statSync(pidPath) returns stat object
     - readFileSync(pidPath) returns "12345\n"
     - kill(12345, 0) does NOT throw (alive)
     - connect succeeds (mock returns ready socket)
     - Expect: spawn called zero times; returned object: { spawned: false, daemonPid: 12345 }
  3. "respawns when PID file exists but kill(0) throws ESRCH"
     - statSync(pidPath) returns stat object
     - readFileSync(pidPath) returns "12345\n"
     - kill(12345, 0) throws { code: 'ESRCH' }
     - Expect: unlinkSync called on pidPath and socketPath; spawn called once; new pid written
  4. "concurrent acquire calls — one spawn, one wait-and-reuse"
     - Simulate two parallel acquireDaemon() calls
     - First call acquires the flock, spawns the daemon, writes pidfile, releases flock
     - Second call's flock acquire blocks until first releases, then connect succeeds (no spawn)
     - Expect: spawn called exactly once across both calls

Q4's hybrid recommendation also includes the "hung daemon" case (kill(0) alive, connect times out).
That is NOT in this AC's required matrix but the build SHOULD include the code path — add a
fifth test case asserting that on connect-probe timeout (1s, mocked via vi.useFakeTimers), the
proxy SIGKILLs the hung daemon, unlinks files, and respawns. Mark it as a `it()` (not
`it.skip()`) — the test guards the code path.
-->

**AC3 (end-to-end — daemon survives proxy SIGTERM):**
A vitest integration test under `tests/` (not `src/__tests__/`) drives the real proxy script (`plugins/crew/mcp-proxy/bin/mcp-proxy.js`) against the real built MCP daemon (`plugins/crew/mcp-server/dist/index.js`). The test (a) starts the proxy with stdio piped, (b) sends one JSON-RPC `initialize` request, awaits the response, (c) captures the daemon's pid from the PID file, (d) sends `SIGTERM` to the proxy via `process.kill(proxy.pid, 'SIGTERM')`, (e) waits 2 seconds, (f) asserts `process.kill(daemonPid, 0)` returns truthy (daemon alive) and the daemon's ppid is now 1 (reparented to init). Cleanup: SIGKILL the daemon at test end. Test is darwin-only (`describe.skipIf(process.platform !== 'darwin')`); Linux/Windows are out of scope for v1.1 per the spike's platform scoping.
vitest: plugins/crew/mcp-server/tests/proxy-daemon-survives-sigterm.integration.test.ts

<!--
Implementation: place this in tests/ (not src/__tests__/) per the existing convention for
heavyweight integration tests (e.g., create-smoke-scratch-repo.integration.test.ts,
smoke.test.ts). Mirrors the Q2 spike repro at `/tmp/d2-detach-repro/run.sh` but in vitest
form, against the real proxy + real daemon.

Test outline:
  - beforeAll: ensure plugins/crew/mcp-server/dist/index.js exists (otherwise run pnpm build
    OR skip with a clear message — prefer skip to avoid CI flakiness from build timing)
  - beforeAll: ensure plugins/crew/mcp-proxy/bin/mcp-proxy.js exists (same)
  - Test body:
      1. Create per-test tmpdir; export HOME=tmpdir so ~/.crew/ resolves under tmp
      2. Spawn the proxy: `spawn('node', [proxyPath], { stdio: 'pipe' })`
      3. Wait for the proxy to emit a "ready" signal on stdout, OR for the PID file
         (tmpdir/.crew/mcp-daemon.pid) to appear (poll every 100ms, timeout 5s)
      4. Read the daemon's pid from the PID file
      5. Send initialize request to proxy's stdin; await response on stdout (timeout 3s)
      6. SIGTERM the proxy: `process.kill(proxy.pid, 'SIGTERM')`
      7. Wait 2s
      8. Assert: process.kill(daemonPid, 0) does NOT throw (daemon alive)
      9. Read /proc/<daemonPid>/status on Linux or `ps -o ppid= -p <daemonPid>` on darwin
         — assert ppid === 1 (orphaned to init; Q2 confirmed this transition happens within
         ~3s post-SIGTERM on darwin)
  - afterAll / finally: SIGKILL the daemon if still alive; rm -rf tmpdir; clear HOME override

Critical: the test MUST set process.env.HOME to the tmpdir BEFORE spawning the proxy so the
proxy's ~/.crew/ resolves to tmpdir/.crew/. Otherwise the test will leak state into the real
user's ~/.crew/ and conflict with the real plugin runtime.

skipIf rationale: darwin's `ps -o ppid= -p` flag set differs from Linux's; the canonical
parent-reparenting check on Linux is /proc/<pid>/status. The spike scoped to darwin and so
does this AC. The build's runtime works on Linux too (detached:true + setsid is POSIX) but
the test only asserts on darwin until a follow-up spike covers Linux explicitly.

Test runtime budget: ~6 seconds (spawn + init + sleep 2s + cleanup). Add an explicit
vi.setConfig({ testTimeout: 15_000 }) at top of file. The runVitestCheck reviewer harness
respects per-file timeouts per Story 5.27's workspace-aware cwd resolution.
-->

**AC4 (plugin manifest points at proxy):**
`plugins/crew/.claude-plugin/plugin.json` is updated so `mcpServers.crew.command` is `${CLAUDE_PLUGIN_ROOT}/mcp-proxy/bin/mcp-proxy.js` (no `args`, no `node` wrapper — the shim file begins with a `#!/usr/bin/env node` shebang and is executable). The `cwd` field stays as `${CLAUDE_PLUGIN_ROOT}`. The manifest file's structure is otherwise unchanged.
artifact: plugins/crew/.claude-plugin/plugin.json

<!--
Implementation: replace the existing 12-line file with the D2 shape. Diff:

  Before:
    "mcpServers": {
      "crew": {
        "command": "node",
        "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js"],
        "cwd": "${CLAUDE_PLUGIN_ROOT}"
      }
    }

  After:
    "mcpServers": {
      "crew": {
        "command": "${CLAUDE_PLUGIN_ROOT}/mcp-proxy/bin/mcp-proxy.js",
        "cwd": "${CLAUDE_PLUGIN_ROOT}"
      }
    }

Q1 of the spike confirmed `${CLAUDE_PLUGIN_ROOT}` expansion is supported in `command` per the
docs ("Expansion locations: `command` - The server executable path"). The Claude-Code-as-MCP
example in the same docs also confirms `command` can be an arbitrary executable, not just
`node`.

Verify after edit:
  - JSON is valid (`node -e "JSON.parse(require('fs').readFileSync('plugins/crew/.claude-plugin/plugin.json'))"`)
  - The "name", "version", "description" fields are untouched
  - No `args` array remains (the proxy script takes no args — it self-locates the daemon)
-->

**AC5 (proxy script exists, executable, shebang):**
The file `plugins/crew/mcp-proxy/bin/mcp-proxy.js` exists, begins with `#!/usr/bin/env node`, and has mode `0755` (executable bit set; `fs.statSync(path).mode & 0o111` is truthy). The source is checked in under `plugins/crew/mcp-proxy/src/` (TypeScript) and built/normalised into `plugins/crew/mcp-proxy/bin/` per the existing `mcp-server/scripts/normalise-dist.mjs` pattern. The committed `bin/mcp-proxy.js` is the runtime artefact the manifest points at.
artifact: plugins/crew/mcp-proxy/bin/mcp-proxy.js

<!--
Implementation: new sub-package under plugins/crew/mcp-proxy/. Suggested layout:

  plugins/crew/mcp-proxy/
    package.json              — name: @crew/mcp-proxy, type: module, main: bin/mcp-proxy.js
    tsconfig.json             — extends ../tsconfig.base.json, outDir: bin/
    src/
      index.ts                — the shim entry: parse env, acquire daemon, pipe stdio↔socket
      acquire-daemon.ts       — the pure function from AC2 (testable in isolation)
      daemon-paths.ts         — resolves ~/.crew/{mcp-daemon.sock, mcp-daemon.pid, mcp-daemon.lock}
                                 honouring process.env.HOME (for tests + non-default homes)
    bin/
      mcp-proxy.js            — built output, shebang prepended, chmod 0755
    scripts/
      normalise-dist.mjs      — copy of mcp-server's normaliser, adapted for the proxy

The shebang is NOT added by tsc. The build script must prepend `#!/usr/bin/env node\n` to
the compiled bin/mcp-proxy.js and chmod it to 0755. Two options:
  (a) Add a post-build step in the proxy package's `build` script:
      "build": "tsc -p tsconfig.json && node scripts/normalise-dist.mjs"
      The normalise-dist.mjs script does: read bin/index.js, prepend shebang line, rename to
      mcp-proxy.js, fs.chmodSync(target, 0o755), then delete bin/index.js.
  (b) Use a build tool with shebang support (esbuild's --banner) — but adds a dep, avoid.

Prefer (a). The mcp-server already has a normalise-dist.mjs script that does similar work
(import-extension fixes); copy and adapt it.

Wire the build into the workspace's top-level build:watch chain per Story 5.28: the watcher
that triggers tsc on mcp-server source changes must also trigger the proxy's build when
proxy source changes. Update plugins/crew/mcp-server/scripts/watch-and-normalise.mjs (the
workspace's build orchestrator) to also watch plugins/crew/mcp-proxy/src/.

Verify after build:
  - `head -1 plugins/crew/mcp-proxy/bin/mcp-proxy.js` is `#!/usr/bin/env node`
  - `stat -f "%Lp" plugins/crew/mcp-proxy/bin/mcp-proxy.js` (darwin) returns 755 (or any
    mode with 0o111 bits set — the executable bit is what AC5 asserts)
  - `node plugins/crew/mcp-proxy/bin/mcp-proxy.js < /dev/null` runs without ImportError or
    syntax error (it will fail to acquire a daemon because no daemon binary path is resolved
    from a fake-empty home, but the boot path must not crash on import)

Locked-file note: this story commits new files under plugins/crew/mcp-proxy/. The proxy
package's bin/ output is tracked in git for the same reason mcp-server/dist/ is — /plugin
install copies the tree as-is and won't run a build step. See plugins/crew/docs/README-install.md
§ Build artefacts.
-->

**AC6 (unix socket bound at mode 0600 under ~/.crew/):**
A vitest unit test asserts the daemon's socket-binding path. When the daemon starts, it (a) creates `~/.crew/` with mode `0700` if missing, (b) binds the unix socket at `~/.crew/mcp-daemon.sock`, (c) `fs.statSync(socketPath).mode & 0o777` equals `0o600`. The test uses a temp `HOME` env override (`process.env.HOME = tmpdir`) so the real `~/.crew/` is not touched. Per Q5's verdict (`socket-auth: filesystem-permission-only`), no token-handshake is implemented; the daemon optionally verifies peer EUID via `getsockopt(LOCAL_PEEREUID)` as defence-in-depth (covered by the same test asserting the verify hook is wired, even if the verify call is a no-op on platforms without the API).
vitest: plugins/crew/mcp-server/src/__tests__/daemon-socket-mode.test.ts

<!--
Implementation: a new module `plugins/crew/mcp-server/src/lib/socket-server.ts` exposes
`startSocketServer(opts): Promise<net.Server>` that:
  1. Computes ~/.crew/ path from opts.home (default process.env.HOME)
  2. fs.mkdirSync(crewDir, { recursive: true, mode: 0o700 })
  3. fs.chmodSync(crewDir, 0o700)  // belt-and-braces if dir existed with wider mode
  4. Unlinks any stale socket file
  5. Calls fs.umask(0o177) immediately before net.createServer().listen(socketPath)
     OR creates the server then fs.chmodSync(socketPath, 0o600) post-bind
     (chmod post-bind is simpler and more portable; umask is racy if other threads alloc fds)
  6. Optional: server.on('connection', socket => verifyPeerEuid(socket))
     where verifyPeerEuid is a no-op on platforms without LOCAL_PEEREUID and a getsockopt-
     based check on darwin. The hook MUST be wired so the AC6 assertion "verify hook is wired"
     passes — pure existence of the listener is enough; the listener can be a no-op.

The daemon's main() (plugins/crew/mcp-server/src/index.ts) calls startSocketServer() in place
of the StdioServerTransport bootstrap. The daemon no longer uses stdio — it listens on the
unix socket and wraps each accepted socket in a SocketServerTransport (an SDK-compatible
transport that reads/writes line-delimited JSON-RPC frames over a net.Socket).

This means a new transport class. Implementation:
  - Look at @modelcontextprotocol/sdk/server/stdio.js (which the production daemon uses today)
    for the contract. The transport must implement: start(), send(msg), close(), and emit
    'message', 'close', 'error' events.
  - The SDK's `ReadBuffer` (quoted in Q3 of the spike notes) handles the framing — import
    it and feed socket 'data' events through it; emit deserialized messages on the transport.
  - For send: serializeMessage(msg) + socket.write(buf).

The vitest test at AC6's path:
  - Creates a tmpdir, sets process.env.HOME = tmpdir
  - Calls startSocketServer({})
  - Asserts:
      * fs.statSync(`${tmpdir}/.crew`).mode & 0o777 === 0o700
      * fs.statSync(`${tmpdir}/.crew/mcp-daemon.sock`).mode & 0o777 === 0o600
      * The server object exposes `verifyPeerEuid` or `connectionHandler` (assert the wiring,
        not the behaviour) — e.g., server.listenerCount('connection') >= 1
  - Cleanup: server.close(), rm -rf tmpdir, restore HOME

The Q5 verdict's defence-in-depth note: macOS exposes LOCAL_PEEREUID via
`getsockopt(SOL_LOCAL, LOCAL_PEEREUID, ...)`. Node's net.Socket does NOT expose getsockopt
directly — wrapper packages exist (`unix-dgram`, `node-getsockopt`) but adding a dep for
a defence-in-depth check is over-budget. The implementation should wire the verify hook
as a no-op function call (`verifyPeerEuid(socket)`) that returns true unconditionally with
a TODO comment naming the LOCAL_PEEREUID API. The AC asserts the wiring; a follow-up story
can land the getsockopt call.
-->

---

## Tasks / Subtasks

Implementation order is bottom-up: build the daemon's socket transport first (the daemon must work in isolation before the proxy can connect), then the proxy's daemon-acquisition logic, then the byte-forwarding glue, then the manifest swap, then the integration test.

- [ ] **Task 1: Scaffold the mcp-proxy sub-package** (AC: #5)
  - [ ] 1.1 Create `plugins/crew/mcp-proxy/` with `package.json` (name: `@crew/mcp-proxy`, type: module, main: `bin/mcp-proxy.js`, build script per AC5 implementation comment).
  - [ ] 1.2 Create `plugins/crew/mcp-proxy/tsconfig.json` extending `../tsconfig.base.json`, outDir `bin/`.
  - [ ] 1.3 Create `plugins/crew/mcp-proxy/scripts/normalise-dist.mjs` (copy from `mcp-server/scripts/normalise-dist.mjs`, adapt: rename `index.js` → `mcp-proxy.js`, prepend `#!/usr/bin/env node\n`, `fs.chmodSync(target, 0o755)`).
  - [ ] 1.4 Update `plugins/crew/pnpm-workspace.yaml` to include `mcp-proxy` (verify it already uses `mcp-*` glob; if so, no change needed).
  - [ ] 1.5 Run `pnpm install` from `plugins/crew/` to register the new workspace member.

- [ ] **Task 2: Build the daemon-side socket transport** (AC: #6)
  - [ ] 2.1 Create `plugins/crew/mcp-server/src/lib/socket-server.ts` exporting `startSocketServer(opts: { home?: string }): Promise<net.Server>`.
  - [ ] 2.2 Implement directory + socket creation per the AC6 implementation comment (mkdir 0700, unlink stale socket, chmod 0600 post-bind).
  - [ ] 2.3 Create `plugins/crew/mcp-server/src/lib/socket-transport.ts` exporting `SocketServerTransport` — implements the SDK's Transport contract over a `net.Socket`, using the SDK's `ReadBuffer` for framing (line-delimited JSON-RPC per Q3 verdict). Reference: `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js`.
  - [ ] 2.4 Wire `startSocketServer` to wrap each accepted socket in a `SocketServerTransport` and call `server.connect(transport)`. The existing tools registered in `registerAllTools(server)` work unchanged — they only see the `server` handle.
  - [ ] 2.5 Add a no-op `verifyPeerEuid(socket): boolean` function (TODO comment naming the LOCAL_PEEREUID getsockopt path); wire it as a `'connection'` listener on the server.

- [ ] **Task 3: Refactor the daemon's main() to use socket transport** (AC: #6)
  - [ ] 3.1 In `plugins/crew/mcp-server/src/index.ts`, replace the `StdioServerTransport` bootstrap with `startSocketServer({ home: process.env.HOME })`.
  - [ ] 3.2 Write the daemon's pid to `~/.crew/mcp-daemon.pid` after the socket binds successfully. Unlink on `process.on('exit')`.
  - [ ] 3.3 Keep all existing lifecycle log, keepalive, signal-handler code unchanged. The cascade-target was stdin-close from the host; now the daemon has no stdio — it ignores stdin closure entirely (stdio is `ignore` in the proxy's spawn opts).
  - [ ] 3.4 Remove the `stdin.on('end')` and `stdin.on('close')` handlers that triggered `server.close() + process.exit(0)` — they're irrelevant once stdio is detached. The daemon's clean-shutdown trigger is now SIGTERM via `kill $(cat ~/.crew/mcp-daemon.pid)`, handled by the existing SIGTERM handler.

- [ ] **Task 4: Build the proxy's daemon-acquisition logic** (AC: #2)
  - [ ] 4.1 Create `plugins/crew/mcp-proxy/src/daemon-paths.ts` exporting `resolveDaemonPaths(home?: string): { sockPath, pidPath, lockPath, crewDir }`. Default home: `process.env.HOME`.
  - [ ] 4.2 Create `plugins/crew/mcp-proxy/src/acquire-daemon.ts` exporting `acquireDaemon(opts): Promise<{ socket, daemonPid, spawned }>` per the AC2 implementation comment. The function takes injected `spawn`, `kill`, `connect`, `fs` ports so the AC2 vitest can mock them.
  - [ ] 4.3 Implement the hybrid logic per Q4: optimistic connect → on ENOENT/ECONNREFUSED, check pidfile + kill(0) → on stale, unlink and respawn → use `flock`-equivalent on `lockPath` (recommend `fs.openSync(lockPath, 'wx')` with try/finally cleanup; `proper-lockfile` is fine if already a workspace dep).
  - [ ] 4.4 Add the hung-daemon fifth code path (Q4 hybrid: kill(0) truthy but connect times out → SIGKILL, unlink, respawn). Use a 1s connect-probe timeout.

- [ ] **Task 5: Build the proxy's byte-forwarding glue** (AC: #1)
  - [ ] 5.1 Create `plugins/crew/mcp-proxy/src/index.ts` — the shim entry. Calls `acquireDaemon()`, then `process.stdin.pipe(socket); socket.pipe(process.stdout)`. Per Q3, the SDK's ReadBuffer on both ends handles framing — the shim is pure byte-forwarding.
  - [ ] 5.2 Wire `socket.on('error')` and `socket.on('close')` to emit clear error messages on stderr and exit with code 1 (so Claude Code sees a non-zero exit and surfaces "MCP server disconnected" cleanly).
  - [ ] 5.3 Wire `process.on('SIGTERM')` and `'SIGINT'` to close the socket and exit cleanly (code 0 for SIGTERM, 130 for SIGINT). Do NOT propagate the signal to the daemon — the daemon is detached on purpose.
  - [ ] 5.4 Wire `process.stdin.on('end')` to close socket + exit 0. This is the normal-shutdown path when Claude Code closes the stdio child (the cascade trigger — but now only kills the shim).

- [ ] **Task 6: Write the proxy spawn unit test** (AC: #1)
  - [ ] 6.1 Create `plugins/crew/mcp-server/src/__tests__/proxy-spawn.test.ts` — note this lives in mcp-server's tests dir (the workspace uses one vitest config for all plugin tests).
  - [ ] 6.2 Create `plugins/crew/mcp-server/tests/fixtures/echo-daemon.mjs` — tiny daemon that binds the supplied socket, echoes one frame, writes pid to env-supplied file.
  - [ ] 6.3 Test asserts: spawn called with `{ detached: true, stdio: 'ignore' }`, child.unref() called, initialize request reaches daemon, pid file written. Test uses in-memory fake stdio per AC1 implementation comment.

- [ ] **Task 7: Write the lockfile lifecycle unit test** (AC: #2)
  - [ ] 7.1 Create `plugins/crew/mcp-server/src/__tests__/proxy-lockfile.test.ts`.
  - [ ] 7.2 Four `describe` blocks (one per AC2 case) plus the fifth hung-daemon `it()`. Mocks per AC2 implementation comment.

- [ ] **Task 8: Write the integration test** (AC: #3)
  - [ ] 8.1 Create `plugins/crew/mcp-server/tests/proxy-daemon-survives-sigterm.integration.test.ts`.
  - [ ] 8.2 `describe.skipIf(process.platform !== 'darwin')`.
  - [ ] 8.3 Test body per AC3 implementation comment: real proxy + real daemon, real SIGTERM, real `kill(daemonPid, 0)` + `ps -o ppid=` assertion at ppid=1.
  - [ ] 8.4 Set `process.env.HOME = tmpdir` before spawn; cleanup with SIGKILL + rm -rf in afterAll.

- [ ] **Task 9: Write the daemon socket mode unit test** (AC: #6)
  - [ ] 9.1 Create `plugins/crew/mcp-server/src/__tests__/daemon-socket-mode.test.ts`.
  - [ ] 9.2 Test asserts ~/.crew/ at 0700, socket at 0600, verify hook wired (listenerCount >= 1).

- [ ] **Task 10: Update the plugin manifest** (AC: #4)
  - [ ] 10.1 Edit `plugins/crew/.claude-plugin/plugin.json` per the AC4 implementation comment diff. Validate JSON via `node -e "JSON.parse(...)"`.

- [ ] **Task 11: Wire proxy into build:watch and top-level scripts** (AC: #5)
  - [ ] 11.1 Update `plugins/crew/mcp-server/scripts/watch-and-normalise.mjs` (or wherever the workspace's build:watch lives) to also watch `plugins/crew/mcp-proxy/src/` and chain its normaliser per Story 5.28's pattern.
  - [ ] 11.2 Run `pnpm -F @crew/mcp-proxy build` once; verify `plugins/crew/mcp-proxy/bin/mcp-proxy.js` exists, has shebang, has mode 0755.
  - [ ] 11.3 Run `pnpm -F @crew/mcp-server build`; verify the daemon still compiles after the socket-transport refactor.
  - [ ] 11.4 Commit both `bin/` outputs (`mcp-proxy/bin/mcp-proxy.js` and `mcp-server/dist/index.js`) along with the source. Per the project rule "Plugin build output is tracked in git" — see `plugins/crew/docs/README-install.md` § Build artefacts.

- [ ] **Task 12: Verify acceptance** (AC: all)
  - [ ] 12.1 `pnpm -F @crew/mcp-server test` — all six new tests pass plus existing suite.
  - [ ] 12.2 `cat plugins/crew/.claude-plugin/plugin.json | jq '.mcpServers.crew.command'` — equals `"${CLAUDE_PLUGIN_ROOT}/mcp-proxy/bin/mcp-proxy.js"`.
  - [ ] 12.3 `head -1 plugins/crew/mcp-proxy/bin/mcp-proxy.js` — equals `#!/usr/bin/env node`.
  - [ ] 12.4 `stat -f "%Lp" plugins/crew/mcp-proxy/bin/mcp-proxy.js` (darwin) — has executable bit set.
  - [ ] 12.5 Smoke-test in a real Claude Code session: install the plugin via `--plugin-dir`, run any MCP tool (e.g., `/crew:status`), confirm the tool call succeeds. Then spawn a subagent Task, return from it, confirm the next MCP tool call still succeeds (cascade no longer kills the daemon).

---

## Implementation strategy

### Why bottom-up

The daemon's socket transport is independent of the proxy — it can be built and tested in isolation. The proxy's acquire-daemon logic depends on the daemon being able to start at a known socket path; building the daemon first means the proxy has a real target to connect to during dev. Wiring the manifest last is intentional: until all tests pass and the integration smoke is green, the production manifest stays on the working stdio path, so a half-built proxy doesn't break the dev's own `--plugin-dir` session.

### Why the proxy is a new package, not a script in mcp-server

Three reasons:
1. **Tooling separation.** The proxy has different dependencies (none, beyond Node built-ins) and a different build output (single shebang'd JS file at `bin/`, not a dist tree). Separating it cleanly avoids leaking `@modelcontextprotocol/sdk` into the proxy's transitive deps.
2. **Manifest cleanliness.** The manifest points at `mcp-proxy/bin/mcp-proxy.js` — a self-evident target. If the proxy lived inside `mcp-server/`, the manifest would point at `mcp-server/bin/proxy.js` which is confusable with the server.
3. **Future portability.** If a different MCP server in the future wants to reuse the proxy pattern (process-group escape on cascade-prone hosts), `@crew/mcp-proxy` can be lifted out as a standalone npm package. Embedded in `mcp-server`, it would need extraction.

### Why pure byte-forwarding, not framing-aware

Q3's evidence: the SDK's `serializeMessage` appends `'\n'`; `ReadBuffer.readMessage` splits on `'\n'`. Both endpoints (Claude Code's host transport and the crew daemon's socket transport) speak this format. The shim never needs to inspect frame boundaries — Node's `pipe()` machinery handles partial reads transparently, the ReadBuffer on the receiving end reassembles. This is ~5 lines of code. The defensive alternative (reuse ReadBuffer in the shim to demarcate frames before forwarding) is heavier and unnecessary unless a smoke surfaces a framing bug. Default to pipe; fall back if needed.

### Why filesystem-permission-only, not token

Q5's evidence: ssh-agent, gpg-agent, docker's default socket all rely on filesystem permissions alone. Same-user trust is the universal POSIX local-IPC model. A token stored in `~/.crew/` would be bypassable by anything running as the same user — the threat model collapses to the filesystem permissions anyway. Adding a token doubles the surface (generation, rotation, expiry) for zero security gain. The defence-in-depth peer-EUID check via `getsockopt(LOCAL_PEEREUID)` is wired as a no-op TODO so a follow-up story can land it without architectural change.

### Why hybrid daemon-liveness, not pure pidfile or pure socket-probe

Q4's edge-case matrix: pure pidfile fails the "hung daemon" case silently (kill(0) says alive, connect hangs). Pure socket-probe orphans the hung process on respawn (pidfile still points at the dead daemon). Only the hybrid recovers cleanly. Redis uses pidfile + EADDRINUSE-on-bind (the closest production-daemon precedent); D2's hybrid adds the connect-probe-timeout check that redis omits because Claude Code operators can't be expected to `redis-cli ping` the daemon and manually restart.

### Why darwin-only for AC3's integration test

Q5's project scoping: darwin is the reference platform for v1.1. The Q2 spike repro validated detachment on darwin; Linux is presumed to work (POSIX `setsid` is the load-bearing mechanism, and Linux honours it identically) but is not asserted here. Cross-platform support is a v1.2 follow-up; making AC3 darwin-only avoids gating v1.1 on Linux CI infrastructure we don't have.

### Why both Story 5.30's halt seam and Story 5.32's D2 stay

5.30 is a safety net for non-cascade MCP disconnects (idle reap, daemon crash, OS-level kill, network glitch). D2 only retires the cascade-specific cost. Removing the halt seam after D2 ships would leave non-cascade disconnects with no recovery surface. The seam is cheap (a typed error + a verbatim string + a SKILL.md entry); keep it.

---

## Locked files

- `plugins/crew/mcp-server/src/tools/**` — NOT touched. Tool semantics are unchanged; D2 is transport-layer.
- `plugins/crew/skills/start/SKILL.md` — NOT touched. Story 5.30's halt seam stays as written.
- `plugins/crew/skills/**/SKILL.md` (other skills) — NOT touched.
- `plugins/crew/permissions/**` — NOT touched. No new permission allowlist entries; the proxy is internal infrastructure.
- `plugins/crew/example/**` — NOT touched.
- `plugins/crew/catalogue/**` — NOT touched.
- `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` — NOT touched. Read-only reference for spike's Q1–Q5 verdicts.
- Top-level README, PRD non-functional-requirements, and other planning docs — NOT touched by this story. Documentation follow-up is a separate story once D2 is validated in steady state.

### Declared-locked-file changes (explicit exceptions)

- `plugins/crew/.claude-plugin/plugin.json` — AC4. Single-line change to `mcpServers.crew.command`, removal of `args` array.
- `plugins/crew/mcp-server/src/index.ts` — Task 3. Refactor from `StdioServerTransport` to `startSocketServer`. Lifecycle log, keepalive, signal handlers stay.
- `plugins/crew/mcp-server/src/lib/socket-server.ts` (new) — Task 2.
- `plugins/crew/mcp-server/src/lib/socket-transport.ts` (new) — Task 2.
- `plugins/crew/mcp-server/src/__tests__/proxy-spawn.test.ts` (new) — AC1, Task 6.
- `plugins/crew/mcp-server/src/__tests__/proxy-lockfile.test.ts` (new) — AC2, Task 7.
- `plugins/crew/mcp-server/src/__tests__/daemon-socket-mode.test.ts` (new) — AC6, Task 9.
- `plugins/crew/mcp-server/tests/proxy-daemon-survives-sigterm.integration.test.ts` (new) — AC3, Task 8.
- `plugins/crew/mcp-server/tests/fixtures/echo-daemon.mjs` (new) — Task 6.2.
- `plugins/crew/mcp-server/scripts/watch-and-normalise.mjs` — Task 11. Extend to watch the proxy's source dir per Story 5.28's chaining pattern.
- `plugins/crew/mcp-proxy/` (new sub-package) — Tasks 1, 4, 5. New `package.json`, `tsconfig.json`, `src/`, `scripts/normalise-dist.mjs`, `bin/mcp-proxy.js` (build output).
- `plugins/crew/pnpm-workspace.yaml` — Task 1.4. Add `mcp-proxy` if the glob doesn't already cover it.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-proxy/package.json` — sub-package manifest. name `@crew/mcp-proxy`.
- `plugins/crew/mcp-proxy/tsconfig.json` — extends `../tsconfig.base.json`.
- `plugins/crew/mcp-proxy/src/index.ts` — shim entry, byte-forwards stdio↔socket.
- `plugins/crew/mcp-proxy/src/acquire-daemon.ts` — pure function, hybrid liveness logic.
- `plugins/crew/mcp-proxy/src/daemon-paths.ts` — path resolver honouring HOME env.
- `plugins/crew/mcp-proxy/scripts/normalise-dist.mjs` — post-tsc step: prepend shebang, chmod 0755, rename.
- `plugins/crew/mcp-proxy/bin/mcp-proxy.js` — build output, committed (manifest target).
- `plugins/crew/mcp-server/src/lib/socket-server.ts` — daemon-side socket setup.
- `plugins/crew/mcp-server/src/lib/socket-transport.ts` — SDK-compatible socket transport.
- `plugins/crew/mcp-server/src/__tests__/proxy-spawn.test.ts` — AC1.
- `plugins/crew/mcp-server/src/__tests__/proxy-lockfile.test.ts` — AC2.
- `plugins/crew/mcp-server/src/__tests__/daemon-socket-mode.test.ts` — AC6.
- `plugins/crew/mcp-server/tests/proxy-daemon-survives-sigterm.integration.test.ts` — AC3.
- `plugins/crew/mcp-server/tests/fixtures/echo-daemon.mjs` — test fixture daemon.

### Files this story will modify

- `plugins/crew/.claude-plugin/plugin.json` — AC4. Point manifest at proxy.
- `plugins/crew/mcp-server/src/index.ts` — Task 3. Swap StdioServerTransport for startSocketServer. Remove stdin.end/close handlers (irrelevant once detached).
- `plugins/crew/mcp-server/scripts/watch-and-normalise.mjs` — Task 11. Extend to watch proxy src.
- `plugins/crew/mcp-server/dist/index.js` — rebuild output. Committed per the dist-tracked convention.
- `plugins/crew/pnpm-workspace.yaml` — Task 1.4. Add mcp-proxy if not already covered by glob.

### Files this story reads (read-only context)

- `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` — Q1–Q5 verdicts. The build's design contract.
- `plugins/crew/mcp-server/src/index.ts` (before edit) — reference for what lifecycle/signal/keepalive code must be preserved across the transport swap.
- `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js` — quoted in Q3; ReadBuffer/serializeMessage are the framing primitives the socket transport reuses.
- `node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js` — reference for the Transport contract that SocketServerTransport must implement.
- `plugins/crew/.claude-plugin/plugin.json` (before edit) — reference for what fields survive the AC4 swap.
- `plugins/crew/mcp-server/scripts/normalise-dist.mjs` — pattern reference for the proxy's normaliser script.
- `~/.crew/mcp-lifecycle.log` — observability surface that will validate D2 is working (cascade SIGTERMs should disappear from the log in steady state).
- `~/.claude/plans/linked-knitting-stardust.md` § "D2 — Detached proxy + parent-owned daemon" — the original design doc that the spike de-risked and this story implements.

### Spike findings to confirm at implementation time

Per the brief: "Any spike findings that turned out wrong when you tried to implement against them." The five spike verdicts are the design contract; the build must confirm or surface drift:

1. **Q1 — manifest-supports-shim: yes.** Confirm at Task 10 + Task 12.5: after the manifest edit, a real Claude Code session installs the plugin via `--plugin-dir` and the MCP tool list still appears. If the host rejects the proxy command for any reason (shebang issue, exec bit, expansion variable), Q1's verdict needs revisiting before continuing.
2. **Q2 — detached-survives-sigterm: yes.** Confirm at Task 8 (AC3 integration test). The repro at `/tmp/d2-detach-repro/` is the reference; AC3 reproduces it in vitest with the real proxy + real daemon. If the daemon doesn't survive the SIGTERM despite `detached: true + stdio: 'ignore'`, escalate immediately — the entire approach is dead.
3. **Q3 — framing-approach: line-delimited-json.** Confirm at Task 2.3: the SocketServerTransport must use `ReadBuffer` from `@modelcontextprotocol/sdk/dist/esm/shared/stdio.js` (or replicate its logic — newline-split, `\r$` strip). Mismatch here surfaces as silent JSON-parse errors on the daemon side.
4. **Q4 — daemon-liveness-pattern: hybrid.** Confirm at Task 4 + Task 7 (AC2). The fifth hung-daemon test case (kill(0) truthy + connect timeout → SIGKILL + respawn) is the defence the spike's edge-case matrix specifically named.
5. **Q5 — socket-auth: filesystem-permission-only.** Confirm at Task 2.2 + Task 9 (AC6). Mode 0700 on `~/.crew/`, mode 0600 on the socket. The verify-EUID hook is wired as a no-op; a real `getsockopt` call is deferred.

### Why no SKILL.md changes

D2 is transparent to the prose layer. The MCP API surface, tool schemas, error types, and skill interaction patterns are unchanged. The only operator-visible effect is "the `[mcp-cascade-halted]` line stops appearing for cascade reasons" — and that's an observation, not a behavioural change. Story 5.30's halt-seam SKILL.md entry stays exactly as written; it covers non-cascade disconnects which D2 does not address.

### Risk-tier rationale (medium)

Per memory `project_reviewer_toolchain_gaps` and Story 4.9 / 4.10b, medium-risk stories pause auto-merge until the human approves. This story is medium because:
- **Blast radius:** every MCP call from every Claude Code session against the crew plugin flows through the new proxy. If the proxy is broken, the plugin's MCP surface is completely unreachable in every session, immediately on manifest pickup.
- **Boot-path change:** the manifest swap means the next plugin reload of any session uses the new code; there's no canary or feature flag.
- **OS-level mechanics:** detachment, process groups, unix sockets, file permissions — all dependent on darwin syscall semantics. A subtle bug (e.g., the daemon binding the socket before chmod, leaving a 1ms window of 0666) is plausible.

The integration test (AC3) plus the smoke at Task 12.5 are the floor. The reviewer should flag any AC where the test is missing real moving parts (e.g., AC1's spawn assertion accepts a mock — that's correct for AC1 but the integration test in AC3 must use real subprocesses).

### Testing standards

- All `vitest:` ACs land under `plugins/crew/mcp-server/src/__tests__/` (unit) or `plugins/crew/mcp-server/tests/` (integration), matching the existing convention.
- The reviewer-side `runVitestCheck` per Story 5.27 is workspace-aware and will resolve the cwd correctly.
- AC3's integration test sets `vi.setConfig({ testTimeout: 15_000 })` at top of file — heavier than unit defaults but well under the harness ceiling.
- AC6 must not leak into the real `~/.crew/` — always set `process.env.HOME = tmpdir` and assert against `tmpdir/.crew/` paths.
- Per memory `feedback_default_to_deterministic_seams`: ACs use plain `artifact:` / `vitest:` markers, no backticks. The reviewer's classifier returns BLOCKED if any marker has backticks (memory `project_ac_marker_gap`).

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md § Story 5.32`] — this story's epic block.
- [Source: `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` § Verdict] — `proceed-with-d2` with rationale.
- [Source: `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` § Q1] — `manifest-supports-shim: yes`. Docs URL + Claude-Code-as-MCP example.
- [Source: `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` § Q2] — `detached-survives-sigterm: yes`. Repro source + observed terminal output (parent pid 48576, child pid 48578, ppid transition 48576→1).
- [Source: `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` § Q3] — `framing-approach: line-delimited-json`. SDK `ReadBuffer` source quoted; `serializeMessage` appends `\n`.
- [Source: `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` § Q4] — `daemon-liveness-pattern: hybrid`. Edge-case matrix + redis source reference (createPidFile + EADDRINUSE on bind).
- [Source: `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` § Q5] — `socket-auth: filesystem-permission-only`. ssh-agent / gpg-agent / docker precedent; LOCAL_PEEREUID API reference.
- [Source: `~/.claude/plans/linked-knitting-stardust.md` § "D2 — Detached proxy + parent-owned daemon"] — the original design doc.
- [Source: `_bmad-output/implementation-artifacts/5-30-mcp-cascade-halt-seam-and-lifecycle-diagnostics.md`] — Story 5.30, the halt seam that stays after D2 ships.
- [Source: `_bmad-output/implementation-artifacts/5-31-d2-feasibility-spike.md`] — Story 5.31, the spike that informed this build.
- [Source: `plugins/crew/.claude-plugin/plugin.json`] — current manifest; the AC4 diff target.
- [Source: `plugins/crew/mcp-server/src/index.ts`] — current daemon main; Task 3 refactor target.
- [Source: `plugins/crew/mcp-server/scripts/normalise-dist.mjs`] — pattern reference for the proxy normaliser (Task 1.3).
- [Source: project memory `project_mcp_cascade_sigterm`] — the RCA distilled.
- [Source: project memory `project_mcp_server_silent_disconnect`] — two-causes framing (idle-reap fixed; cascade fixed by this story).
- [Source: project memory `feedback_default_to_deterministic_seams`] — why ACs use plain `artifact:` / `vitest:` markers, not prose mandates.
- [Source: project memory `project_reviewer_toolchain_gaps`] — AC marker convention; medium-risk auto-merge pause.
- [Source: project memory `project_dev_loop_plugin_dir`] — dev loop is `--plugin-dir` + `build:watch`; Task 12.5's smoke uses this path.

---

## Previous story intelligence

### From Story 5.31 (sibling spike — the design contract)

- The spike's verdict block at the top of the notes file (`proceed-with-d2`) is the green light. Every implementation decision in this story traces to one of Q1–Q5's verdicts; the dev should re-read the spike notes file before each task and cite the corresponding Q in commit messages.
- The spike repro at `/tmp/d2-detach-repro/` still exists (per the brief). Running `bash /tmp/d2-detach-repro/run.sh` reproduces the Q2 evidence in 3 seconds. AC3's integration test is the vitest-form version of this same check.
- The spike scoped to darwin. AC3 honours that scope (`skipIf(process.platform !== 'darwin')`). Cross-platform follow-up is a separate story; do NOT widen scope inside this story.

### From Story 5.30 (sibling — halt seam, the safety net)

- Story 5.30 ships `McpDisconnectedError` and the verbatim `[mcp-cascade-halted]` halt line in `plugins/crew/skills/start/SKILL.md`. This story does NOT modify either; the halt seam stays as the safety net for non-cascade MCP disconnects.
- 5.30 also added lifecycle-log fields `ppid` and `pgid` to every event. After D2 ships, these fields confirm in the log that the daemon is in a different pgid than the host — the operational verification that detachment held. The dev can grep `~/.crew/mcp-lifecycle.log` post-deploy and look for daemon `pgid` ≠ host `pgid`.

### From Story 5.25 (always-on lifecycle logging)

- The lifecycle log is the evidence source that validated the cascade pattern (8/8 paired SIGTERMs). After D2 ships, the cascade pattern should disappear from the log in steady state. The dev should run `/crew:start` once after merge, return from a subagent Task, and grep the log: zero `signal: SIGTERM` events between subagent return and the next MCP call.
- The keepalive ping mechanism (server.ping every 5min) is unchanged by this story. It continues to run inside the daemon; the shim is transport-only.

### From Story 5.28 (build:watch chaining)

- This story's build adds a new sub-package (`mcp-proxy`) whose source needs to be watched. Task 11.1 extends `mcp-server/scripts/watch-and-normalise.mjs` to chain the proxy's build per the 5.28 pattern. Reference the 5.28 spec for the exact chaining convention.

### From Story 5.10 (transcript persistence — the invariant)

- The principle: critical state must be written to disk before any MCP call. D2 does not change this — the daemon could still crash or be killed by other means (OS, operator). The transcript-persistence invariant remains the floor.

### From the broader Epic 5 retro context

- The dogfood pause was lifted 2026-05-27 after L1 fixes (5.10/5.11/5.12). The next blocker on resuming `/crew:start` autonomous drain is the cascade — D2 is the fix. After this story merges, the next gate is the install-canary (Epic 7).

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
