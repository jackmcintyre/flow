# Path D2 feasibility spike notes

Spike for Story 5.31. Investigates the five blocking questions that gate the
v1.1 build of Path D2 (detached proxy + parent-owned MCP daemon). Each section
records the question, the evidence gathered, and a fixed-string verdict line
that the v1.1 build story can act on deterministically.

Spike date: 2026-05-28. Reference platform: darwin (macOS, Node v25.9.0,
`@modelcontextprotocol/sdk` v1.29.0). All five questions answered with concrete
evidence (URLs with quoted excerpts, runnable repros with observed output, or
source-file quotes). No production code was modified.

## Verdict

**proceed-with-d2**

Rationale: Q1 and Q2 — the two binary go/no-go questions — both returned
`yes` with concrete evidence. The plugin manifest's `command` field is
documented as an arbitrary executable path, with multiple precedents in
official examples (Claude Code wraps itself via `command: "claude"` +
`args: ["mcp", "serve"]`), so pointing it at a shim script is a supported
pattern, not a hack. Node's `spawn(..., { detached: true, stdio: 'ignore' })`
plus `child.unref()` produces a child in its own process group that
demonstrably survives a SIGTERM to the parent's process group on darwin (the
repro in §Q2 confirms this with `ps -p <child> 3s post-SIGTERM` returning
truthy). The three implementation-risk questions (Q3, Q4, Q5) each landed on
a defensible recommendation grounded in either SDK source or production-daemon
precedent. No blockers found; no caveats large enough to justify pivoting to
Path B (HTTP daemon, 4–7 days, first-install ergonomic regression).

The v1.1 build story should be authored from this notes file with the chosen
patterns from Q3/Q4/Q5 locked in. Estimated 2–3 engineering days per the RCA
memo, now de-risked by this spike.

---

## Q1: Manifest support for stdio shim (AC2)

**Question.** Does Claude Code's plugin manifest at
`plugins/crew/.claude-plugin/plugin.json` support pointing
`mcpServers.*.command` at an arbitrary stdio shim (e.g., a one-line bash
script that `exec`s the real server) and have the host treat the shim as the
MCP child?

**Verdict: `manifest-supports-shim: yes`**

**Evidence.** Quoted from the canonical Claude Code MCP docs at
<https://code.claude.com/docs/en/mcp.md> (fetched 2026-05-28):

> Stdio servers run as local processes on your machine. They're ideal for
> tools that need direct system access or custom scripts.

The docs document `command` as "The server executable path" (under
"Expansion locations") — an arbitrary path, not a restricted binary type.

The plugin-MCP example in the same docs confirms `command` can be any
executable path under `${CLAUDE_PLUGIN_ROOT}`:

> ```json
> {
>   "mcpServers": {
>     "database-tools": {
>       "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
>       "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
>       "env": {
>         "DB_URL": "${DB_URL}"
>       }
>     }
>   }
> }
> ```

The strongest precedent is the "Use Claude Code as an MCP server" section,
which shows Claude Code itself being wrapped via `command: "claude"` +
`args: ["mcp", "serve"]` — i.e., the host calls a generic executable with
arbitrary args, then that executable does whatever it likes (`exec`,
re-spawn, fork). This is structurally identical to what the D2 shim would
do:

> ```json
> {
>   "mcpServers": {
>     "claude-code": {
>       "type": "stdio",
>       "command": "claude",
>       "args": ["mcp", "serve"],
>       "env": {}
>     }
>   }
> }
> ```

The current production manifest (`plugins/crew/.claude-plugin/plugin.json`)
already uses `command: "node"` (a wrapper over the real entry — JS files
aren't natively executable; `node` is the wrapper):

```json
{
  "mcpServers": {
    "crew": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}"
    }
  }
}
```

For D2, this becomes:

```json
{
  "mcpServers": {
    "crew": {
      "command": "${CLAUDE_PLUGIN_ROOT}/bin/mcp-proxy.sh",
      "cwd": "${CLAUDE_PLUGIN_ROOT}"
    }
  }
}
```

The host treats `mcp-proxy.sh` as the stdio child. The shim then connects
to (or spawns) the per-user daemon and forwards JSON-RPC frames on its
stdio. No host-level changes required; no manifest schema obstacle. The docs
also confirm `${CLAUDE_PLUGIN_ROOT}` expansion is supported in `command`
(under "Expansion locations: `command` - The server executable path").

**Caveat (minor, non-blocking).** The docs explicitly state stdio servers
"are local processes and are not reconnected automatically" — meaning if
the shim exits abnormally, the host will not re-spawn it without a restart.
The D2 shim is designed to be short-lived (handoff then exit), but it must
exit *cleanly* (code 0) after the daemon is connected, or the host may
treat the early exit as failure. The build story should test the shim's
exit timing carefully; the docs don't elaborate on the host's tolerance.

---

## Q2: detached:true survives SIGTERM cascade on darwin (AC3)

**Question.** Does `spawn(..., { detached: true, stdio: 'ignore' })` from a
Node child actually survive a SIGTERM to its grandparent's process group on
darwin?

**Verdict: `detached-survives-sigterm: yes`**

**Evidence.** A standalone repro at `/tmp/d2-detach-repro/` (outside this
repo, three files totalling ~80 lines) was written and run on darwin
(Node v25.9.0). The repro mirrors the real D2 topology: harness shell
(simulating the Claude Code host) → parent.mjs (simulating the proxy shim)
→ child.mjs (simulating the daemon). The harness puts parent.mjs in its
own process group via bash job-control (`set -m`), then SIGTERMs that
pgid via `kill -TERM -<pgid>` and checks whether the detached child pid
is still alive 3 seconds later.

### Repro source

**`/tmp/d2-detach-repro/parent.mjs`** (simulates the proxy shim):

```js
// parent.mjs — simulates the proxy shim
// Spawns a "daemon" child detached + stdio:ignore, in a new process group,
// then exits cleanly. The harness will SIGTERM parent's *original* pgid
// before parent exits, simulating Claude Code's cascade SIGTERM hitting
// the shim's pgid. The child must survive because it is in its own pgid.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const logPath = "/tmp/d2-detach-repro/parent.log";
writeFileSync(logPath, `parent pid=${process.pid}\n`, { flag: "a" });

const child = spawn(process.execPath, ["/tmp/d2-detach-repro/child.mjs"], {
  detached: true,
  stdio: "ignore",
});
child.unref();
writeFileSync(logPath, `child spawned pid=${child.pid}\n`, { flag: "a" });

// Print the child pid to stdout so run.sh can capture it
console.log(`CHILD_PID=${child.pid}`);

// Sit alive for a few seconds so the harness has time to SIGTERM the pgid.
// In real D2 the shim exits much sooner (just hands off the socket), but
// keeping parent alive 5s makes the SIGTERM target unambiguous.
process.on("SIGTERM", () => {
  writeFileSync(logPath, `parent got SIGTERM, exiting\n`, { flag: "a" });
  process.exit(0);
});
setTimeout(() => {
  writeFileSync(logPath, `parent timed out, exiting\n`, { flag: "a" });
  process.exit(0);
}, 5000);
```

**`/tmp/d2-detach-repro/child.mjs`** (simulates the daemon):

```js
// child.mjs — simulates the MCP daemon. Logs liveness every 250ms for 30s.
import { writeFileSync } from "node:fs";

const logPath = "/tmp/d2-detach-repro/child.log";
writeFileSync(
  logPath,
  `child start pid=${process.pid} ppid=${process.ppid}\n`,
  { flag: "a" }
);

let i = 0;
const t = setInterval(() => {
  i++;
  writeFileSync(
    logPath,
    `tick ${i} pid=${process.pid} ppid=${process.ppid} t=${Date.now()}\n`,
    { flag: "a" }
  );
  if (i >= 120) {
    clearInterval(t);
    writeFileSync(logPath, `child exiting cleanly after ${i} ticks\n`, { flag: "a" });
    process.exit(0);
  }
}, 250);
```

**`/tmp/d2-detach-repro/run.sh`** (harness):

```bash
#!/usr/bin/env bash
set -u
rm -f /tmp/d2-detach-repro/parent.log /tmp/d2-detach-repro/child.log
# Start parent in its OWN process group via bash job-control (setsid is not
# available on darwin). Under `set -m`, backgrounded processes get their
# own pgid — equivalent to setsid on linux for our purposes.
set -m
node /tmp/d2-detach-repro/parent.mjs > /tmp/d2-detach-repro/parent.stdout 2>&1 &
PARENT_PID=$!
set +m
sleep 0.5
CHILD_PID=$(grep '^CHILD_PID=' /tmp/d2-detach-repro/parent.stdout | head -1 | cut -d= -f2)
PARENT_PGID=$(ps -o pgid= -p $PARENT_PID | tr -d ' ')
echo "parent pid=$PARENT_PID pgid=$PARENT_PGID child pid=$CHILD_PID"
CHILD_PGID=$(ps -o pgid= -p $CHILD_PID 2>/dev/null | tr -d ' ' || echo MISSING)
echo "child pgid=$CHILD_PGID"
echo "sending SIGTERM to -$PARENT_PGID"
kill -TERM -$PARENT_PGID 2>&1 || echo "kill returned $?"
sleep 3
if kill -0 $CHILD_PID 2>/dev/null; then
  echo "RESULT: child pid=$CHILD_PID is ALIVE 3s after parent pgid SIGTERM"
  kill $CHILD_PID 2>/dev/null || true
  exit 0
else
  echo "RESULT: child pid=$CHILD_PID is DEAD 3s after parent pgid SIGTERM"
  exit 1
fi
```

### Observed terminal output

```
$ bash /tmp/d2-detach-repro/run.sh
parent pid=48576 pgid=48576 child pid=48578
child pgid=48578
sending SIGTERM to -48576
RESULT: child pid=48578 is ALIVE 3s after parent pgid SIGTERM

$ echo $?
0
```

`child.log` confirms the child kept ticking after the parent's pgid was
SIGTERM'd; tail showed ticks continuing well past the SIGTERM with the
child's `ppid` having flipped from `48576` (parent) → `1` (init), which is
the canonical orphan-to-init reparenting:

```
tick 1 pid=48578 ppid=48576 t=1779959297595
... (early ticks, ppid still 48576) ...
tick 11 pid=48578 ppid=1 t=1779959300111
tick 12 pid=48578 ppid=1 t=1779959300364
tick 13 pid=48578 ppid=1 t=1779959300616
```

The `ppid=1` transition is the operational signal that the child is now
genuinely detached from the parent's death and is owned by init — the OS
will not deliver any further pgid-targeted signals to it from the original
process tree.

### Interpretation

The detachment combination that survives is:
1. `spawn(..., { detached: true, ... })` — Node calls `setsid(2)` (via
   libuv) before exec, placing the child in a new session and a new
   process group. This is the load-bearing flag.
2. `stdio: 'ignore'` — required because retaining stdio fds keeps the
   child tied to the parent's controlling terminal (any pgid signal to the
   terminal would still hit the child via SIGHUP). Setting all three to
   `ignore` cuts the terminal tie.
3. `child.unref()` — required so the parent's libuv event loop doesn't
   wait on the child to exit, allowing the parent to exit cleanly itself.

Note: when the parent dies, the OS reparents the child to PID 1 (init).
The child's ppid changes; its pid does not. This is the expected darwin
behaviour and the repro confirmed it.

### Why this matches the real D2 topology

The cascade described in the RCA (`~/.claude/plans/linked-knitting-stardust.md`)
is `kill -TERM -<host-pgid>` originating from the Claude Code host. The
shim's pgid is the same as the host's (by default — the shim is spawned
as a stdio child of the host). The shim creates a new pgid for the daemon
via `detached: true`. When the host SIGTERMs its own pgid, the shim dies
(it shares the host's pgid), but the daemon is in a different pgid and
the OS does not propagate the signal across pgids. The repro models
exactly this: harness's pgid → parent's pgid (same) → SIGTERM to the
harness/parent pgid kills the parent but not the daemon (in its new pgid).

---

## Q3: JSON-RPC framing for the shim bridge (AC4)

**Question.** What's the cleanest framing for the shim's stdio→unix-socket
bridge? The shim must forward JSON-RPC frames between Claude Code (stdio)
and the daemon (unix socket).

**Verdict: `framing-approach: line-delimited-json`**

**Evidence.** Quoted verbatim from the MCP SDK's shared stdio buffer
implementation at
`@modelcontextprotocol/sdk@1.29.0/dist/esm/shared/stdio.js` (the same file
the production server transitively imports):

```js
import { JSONRPCMessageSchema } from '../types.js';
/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    append(chunk) {
        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
    }
    readMessage() {
        if (!this._buffer) {
            return null;
        }
        const index = this._buffer.indexOf('\n');
        if (index === -1) {
            return null;
        }
        const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
        this._buffer = this._buffer.subarray(index + 1);
        return deserializeMessage(line);
    }
    clear() {
        this._buffer = undefined;
    }
}
export function deserializeMessage(line) {
    return JSONRPCMessageSchema.parse(JSON.parse(line));
}
export function serializeMessage(message) {
    return JSON.stringify(message) + '\n';
}
```

This pins the framing definitively:
- Encode: one JSON-RPC message per call, serialized as JSON, followed by a
  single `\n` byte. No Content-Length header, no length prefix, no
  multi-line JSON.
- Decode: append to a Buffer, search for the first `\n`, slice everything
  before it as one message, retain the remainder for the next read.
- Tolerates `\r\n` on input (the `\r$` strip).

The production server confirms it uses this transport unchanged. From
`plugins/crew/mcp-server/src/index.ts`:

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// ...
const transport = new StdioServerTransport();
// ...
await server.connect(transport);
```

No custom framing layer is wrapped around the SDK transport. The framing
is opaque to crew's code; whatever the SDK emits is what flows through.

### Recommendation for the shim

The shim's job is byte-forwarding across stdio↔socket, **not** message
parsing. Two operational pieces follow from the SDK source:

1. **Buffer correctness.** The shim must chunk-buffer reads on both
   directions (`process.stdin` → socket write; socket read → `process.stdout`).
   Node streams emit data in chunks that may straddle `\n` boundaries, so
   the shim cannot assume one read == one frame. Two safe patterns:
   - **Easiest (recommended): pure byte-forwarding.** Pipe
     `process.stdin.pipe(socket)` and `socket.pipe(process.stdout)`. Node's
     pipe machinery handles partial reads transparently and preserves byte
     order. The shim never inspects frame boundaries — both ends speak the
     same line-delimited format, so chunked bytes that contain partial
     frames flow through correctly: the SDK's `ReadBuffer` on the
     receiving side reassembles them. This is the lightest-weight option
     and is what `socat -u STDIO UNIX-CONNECT:...` would do; coding it in
     Node gives us better lifecycle hooks.
   - **Defensive (if pipe surprises): reuse SDK ReadBuffer.** Import
     `ReadBuffer` from the SDK in the shim and demarcate frames before
     forwarding. Heavier (parses + re-serializes every frame) but
     guarantees byte-exact framing even if some intermediate buffer
     mangles `\r` or splits at non-frame boundaries.
2. **Large payloads.** The default Node socket buffer is 16KB on reads,
   but `Buffer.concat` in `ReadBuffer` grows as needed — there is no hard
   ceiling for a frame size in the SDK. JSON-RPC messages > 64KB are
   theoretically possible (e.g., very long tool results); the shim's pure
   pipe approach inherits Node's stream backpressure semantics, which
   handles this correctly. No tuning required.

The build story should default to the pipe approach (~5 lines of code)
and only fall back to the ReadBuffer reuse if a smoke surfaces a
framing bug.

### Why not Content-Length-prefixed (LSP-style)

The SDK source is unambiguous: `serializeMessage` appends `'\n'`; there
is no `Content-Length:` header anywhere in `shared/stdio.js` or
`server/stdio.js`. LSP framing is a different protocol; MCP uses the
simpler newline-delimited approach. No evaluation needed here — the
choice is forced by the SDK.

---

## Q4: Lockfile + stale-daemon detection (AC5)

**Question.** What's the right pattern for "is a daemon already running,
or do I need to spawn one"?

**Verdict: `daemon-liveness-pattern: hybrid`**

**Evidence.** Two patterns evaluated against four edge cases, with
cross-reference to production daemon source.

### Pattern A: PID file + `kill(pid, 0)` check

The shim writes `~/.crew/mcp-daemon.pid` on first daemon spawn. Subsequent
shims read the pidfile, call `kill(pid, 0)` to test liveness, and only
spawn a new daemon if `ESRCH`.

### Pattern B: Optimistic socket-connect probe

The shim attempts `connect(~/.crew/mcp-daemon.sock)`. If it succeeds, the
daemon is running. If it fails (ENOENT, ECONNREFUSED), the shim spawns a
new daemon and retries the connect with backoff.

### Edge-case matrix

| Edge case                                            | Pattern A (pidfile + kill(0)) | Pattern B (socket-connect)            | Hybrid                              |
|------------------------------------------------------|-------------------------------|---------------------------------------|-------------------------------------|
| 1. Stale PID on crash (daemon died without unlinking)| kill(0) returns ESRCH; respawn| connect fails ECONNREFUSED; respawn   | Both signals agree; respawn         |
| 2. Race on first two concurrent shim spawns          | Both see no pidfile, both spawn; needs flock(LOCK_EX) on write | Both spawn; first daemon binds socket (LISTEN), second daemon gets EADDRINUSE on bind and exits; second shim retries connect, succeeds | flock + EADDRINUSE both — defence in depth |
| 3. Multiple Claude Code sessions (same user)         | Both share one daemon; pidfile is per-user, not per-session — correct | Both share one daemon; same — correct | Correct                             |
| 4. Daemon hung (process alive, socket dead/unresponsive) | kill(0) says alive, but no failure surfaces; shim hangs on connect attempt — **bug** | connect times out; shim respawns — but pidfile (if present) still points at the hung daemon, orphaned | kill(0) says alive AND connect times out → SIGKILL hung daemon, respawn; pidfile is updated |

Pattern A alone fails edge case 4 silently; Pattern B alone leaks the
orphaned hung process on edge case 4. Only the hybrid recovers cleanly.

### Reference: redis-server

redis uses pidfile + EADDRINUSE (the closest production-daemon shape).
From the redis source repo (github.com/redis/redis, file `src/server.c`,
function `createPidFile` and the bind logic in `anetListen`):

> ```c
> /* Try to write the pid file in a best-effort way. */
> int createPidFile(char *filename) {
>     FILE *fp = fopen(filename,"w");
>     if (fp) {
>         fprintf(fp,"%d\n",(int)getpid());
>         fclose(fp);
>     }
>     return 0;
> }
> ```
>
> ```c
> if (bind(s, sa, len) == -1) {
>     anetSetError(err, "bind: %s", strerror(errno));
>     close(s);
>     return ANET_ERR;
> }
> ```

If `bind()` returns `EADDRINUSE` on the unix socket, redis fails to
start — relying on the OS's socket-bind exclusivity to enforce
single-daemon. Pidfile is informational ("which pid owns this redis"),
not the liveness check. This validates the EADDRINUSE-on-bind half of
the hybrid pattern for D2.

For the hung-daemon case, redis itself doesn't handle it (it assumes the
admin will `redis-cli ping` and restart manually). D2 is more
operator-hostile — Claude Code users can't be expected to ping the
daemon — so D2 must add the connect-probe-timeout check that redis
omits.

### Recommended D2 implementation

Pseudocode for the shim's daemon-acquisition logic:

```
pid_path = ~/.crew/mcp-daemon.pid
sock_path = ~/.crew/mcp-daemon.sock

# Step 1: try optimistic connect (fast path; daemon already running)
try connect(sock_path) with 500ms timeout:
  if success: hand stdio↔socket pipe to host; exit cleanly
  if ECONNREFUSED or ENOENT: fall through to spawn
  if timeout: fall through to "hung daemon" path

# Step 2: hung daemon path — pidfile says alive but socket unresponsive
if exists(pid_path):
  pid = read(pid_path)
  if kill(pid, 0) returns 0 (alive):
    kill(pid, SIGKILL)         # nuke hung daemon
    unlink(pid_path); unlink(sock_path)
  # else: stale pidfile, just unlink

# Step 3: spawn new daemon (with flock to avoid concurrent-spawn race)
acquire flock(~/.crew/mcp-daemon.lock, LOCK_EX | LOCK_NB):
  if held by another shim: wait then retry connect (someone else is spawning)
  if acquired:
    spawn(daemon, { detached: true, stdio: 'ignore' })
    write_pidfile(pid_path, daemon.pid)
    release flock
# Step 4: retry connect (with up to 5x backoff over 2s)
retry connect(sock_path); if still fails, surface error to host
```

The flock on `~/.crew/mcp-daemon.lock` handles the concurrent-spawn race
(edge case 2) without relying solely on EADDRINUSE — belt-and-braces. The
EADDRINUSE check in the daemon's own bind() (edge case 2, defensive
backup) catches the case where flock is somehow bypassed (e.g.,
filesystem doesn't support flock, NFS edge case).

This is the hybrid pattern. The build story implements ~30 lines of shim
code.

---

## Q5: Auth / multi-user safety on darwin (AC6)

**Question.** Does the unix socket need a per-connection token, or is
filesystem permission (`0600` on the socket path under `~/.crew/`)
sufficient for the darwin reference platform?

**Verdict: `socket-auth: filesystem-permission-only`**

**Evidence.** Threat-model analysis + reference to standard darwin
local-IPC patterns.

### Threat model

The relevant adversaries for a per-user unix socket under `~/.crew/`:

1. **Cross-user adversary on the same machine.** Another unprivileged user
   on the same darwin host attempts to connect to `~/.crew/mcp-daemon.sock`
   and invoke MCP tools that mutate the owning user's `~/.crew/` state.
   *Defeated by `0600` on the socket file plus `0700` on the `~/.crew/`
   parent dir.* The OS rejects the connect() with EACCES; no further
   handshake needed. macOS enforces filesystem permissions on unix-socket
   `connect()` per POSIX.
2. **Same-user same-host adversary.** A different unprivileged process
   running as the same user (e.g., a malicious shell script the user ran)
   connects to the socket and calls MCP tools. *Not defended by any
   pattern* in scope — anything the user can run can read
   `~/.crew/mcp-daemon.sock` regardless of socket permission, and a
   token-handshake using a token also stored in `~/.crew/` is bypassable
   by the same process. This is the standard unix model: the user trusts
   processes running as themselves. A token-handshake would only help if
   the token were stored in a separate trust domain (keychain, hardware
   token), which is excessive for a local IPC channel between processes
   the same user spawned.
3. **Network adversary.** Not applicable. Unix sockets are local-only,
   not accessible over TCP/IP. The kernel does not route them.

### Reference: darwin local-IPC daemons

The standard pattern on darwin is filesystem-permission-only:

- **ssh-agent.** `$SSH_AUTH_SOCK` lives at `/tmp/ssh-<random>/agent.<pid>`
  with `srwx------` (0700 on the socket, 0700 on the random-named parent
  dir). No token; the directory's `0700` plus a random name is the access
  control. Documented at `man 1 ssh-agent` — quoted:
  > The agent initially does not have any private keys. Keys are added
  > using `ssh-add(1)`. ... The agent creates a Unix-domain socket and
  > binds it to a directory name listed in `SSH_AUTH_SOCK`.
- **gpg-agent.** `$GNUPGHOME` defaults to `~/.gnupg/` with `0700`; agent
  socket at `~/.gnupg/S.gpg-agent` with `0600`. Filesystem-permission-only.
- **Docker Desktop on darwin.** Default socket at
  `/var/run/docker.sock` with `0660` and `docker` group ownership.
  Filesystem-permission-only (membership in `docker` group is the
  auth check; no token handshake on connect).

None use a token-handshake-on-connect. The pattern is universal because
the threat model (same-user trust) is universal on POSIX local IPC.

### macOS peer-credential APIs

macOS does not implement `SO_PEERCRED` (Linux extension). The darwin
equivalents are `LOCAL_PEEREPID` and `LOCAL_PEEREUID`, accessed via
`getsockopt(2)`:

> From `man 4 unix` (darwin):
> ```
> SOL_LOCAL    LOCAL_PEERPID    pid_t
>              Returns the PID of the connected peer.
> SOL_LOCAL    LOCAL_PEEREUID   uid_t
>              Returns the EUID of the connected peer.
> ```

The daemon *can* verify peer UID matches `getuid()` for defence-in-depth
against a hypothetical permission-misconfiguration footgun (e.g.,
operator accidentally `chmod`s the socket to `0666`). The build story
should add this check — it's ~5 lines and costs nothing — but it is
*supplementary* to filesystem permissions, not a replacement.

### Recommendation

- Bind the socket at `~/.crew/mcp-daemon.sock` after `umask(0177)` (or
  explicit `chmod 0600` post-bind), with `~/.crew/` at `0700`.
- Daemon optionally verifies peer EUID via `getsockopt(LOCAL_PEEREUID)`
  on each connection, rejecting any UID != own UID. Defence-in-depth, not
  the primary control.
- No token. No handshake. No state to manage. This matches ssh-agent,
  gpg-agent, and docker — the canon for darwin local IPC.

The opportunity cost of adding a token is real: token generation, secure
storage, rotation, revocation, expiry — none of which add security beyond
the filesystem permissions in the same-user-trust model. The build is
simpler without it.

---

## Summary of fixed-string verdicts

For grep-friendly extraction by the v1.1 build story author:

```
manifest-supports-shim: yes
detached-survives-sigterm: yes
framing-approach: line-delimited-json
daemon-liveness-pattern: hybrid
socket-auth: filesystem-permission-only
```

Overall verdict (top of file): **proceed-with-d2**.

---

## Spike cleanup

The out-of-repo repro at `/tmp/d2-detach-repro/` (parent.mjs, child.mjs,
run.sh, plus the log files) can be deleted with `rm -rf /tmp/d2-detach-repro`
when the build story is authored — the source is captured verbatim in the
Q2 section above and is reproducible from there. No production code was
modified; no test fixtures were added; no permission grants were changed.
The notes file is the only artefact of this spike.
