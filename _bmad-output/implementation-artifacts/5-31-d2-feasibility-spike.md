# Story 5.31: Path D2 feasibility spike — detached proxy + parent-owned MCP daemon

story_shape: spike

Status: ready-for-dev

<!--
Authored 2026-05-28 as the v1.1 reliability candidate identified by the MCP-cascade RCA
(`~/.claude/plans/linked-knitting-stardust.md` § Recommendation, step 4).
Time-boxed half-day research spike. No production code modified. Output is a notes file
with concrete evidence answering five blocking questions; the spike's exit is either
"all five answered with green evidence" or "one hard blocker, escalate".
-->

## Story

As a **plugin engineer planning v1.1 reliability work**,
I want **a half-day spike that confirms or invalidates Path D2 — a detached proxy script that re-execs the real MCP server in its own process group so the server survives the SIGTERM cascade that Story 5.30 only halts cleanly against**,
So that **the next reliability investment is grounded in concrete evidence (manifest support confirmed, OS-level detachment validated, framing/lockfile/auth patterns decided) rather than design speculation, and we either commit to building D2 as v1.1's headline story or pivot to Path B (HTTP daemon) without losing a week to a dead end**.

### What this story is, in one paragraph

Story 5.30 (sibling) ships Path A: accept the cascade, halt cleanly, document. Path A is a UX patch — every story interrupted by the cascade costs one Claude Code restart. The RCA memo names Path D2 as the right v1.1 investment: 2–3 days of engineering for the same outcome as Path B (HTTP daemon, 4–7 days) without B's first-install ergonomic regression. This story is **not** the build. It is the half-day spike that investigates the five questions which, if any answer is hostile, would invalidate the entire D2 approach before the build is scheduled. The spike's only deliverable is a notes file at `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` with concrete evidence per question.

### Why this story is the right shape (research spike, not build)

The five questions span three failure surfaces:
1. **Will the plugin host even route to a shim?** (Q1) — if no, D2 is dead and we go straight to Path B or stay on Path A.
2. **Will the OS-level detachment actually work?** (Q2) — if no, D2 is dead regardless of host behaviour; the cascade reaches the daemon.
3. **Are the three implementation patterns (framing, daemon-liveness, auth) decisions we can defend?** (Q3–Q5) — these are "engineering risk" questions, not "go/no-go" questions, but answering them up front collapses the build estimate's uncertainty band.

Each of Q1 and Q2 has a binary outcome that can kill the approach. Investigating them in production code first would mean writing throwaway D2 plumbing inside `plugins/crew/` — wasted effort if Q1 says "no". The spike investigates in isolation (one-line bash shim, 30-line Node repro outside the repo) so the answer costs hours, not days.

### Why the notes-file-only output

The spike's value is **the answers**, not artefacts. A notes file is grep-able by the next engineer picking up D2; it lives next to the implementation specs where reviewers expect to find context. The five `artifact:` ACs (one per question, plus one for the file's existence and verdict) give the reviewer a deterministic check: open the file, find the labelled section per AC, verify the evidence is concrete (URL with quoted excerpt, runnable snippet with observed output, or quoted source-file fragment). No vitest seam — there is no production code to test.

### What this story does NOT

- (a) Modify `plugins/crew/.claude-plugin/plugin.json`. The manifest is read-only for the spike; Q1 is investigated by either docs lookup or an out-of-repo test plugin.
- (b) Modify `plugins/crew/mcp-server/src/index.ts` or any other production source. The current stdio transport setup is reference material for Q3 (framing); the spike reads it, does not change it.
- (c) Build `mcp-proxy.js`, the unix-socket bridge, the daemon lifecycle script, or any of the D2 implementation surface. The spike confirms feasibility; the v1.1 story builds.
- (d) File the upstream Anthropic bug. That action belongs alongside Story 5.30 (Path A) and is tracked separately; it is out of scope here even though both stories ground in the same RCA.
- (e) Update README, PRD `non-functional-requirements.md`, or any user-facing docs. Documentation follows the build, not the spike.
- (f) Investigate Path B (HTTP daemon) as a fallback. If any spike question answers hostile to D2, the notes file records the verdict as `pivot-to-path-b` or `blocked-escalate-to-jack` — it does **not** start the Path B investigation. That is a follow-up.
- (g) Investigate non-darwin platforms. The project's reference platform is darwin (memory `feedback_dependency_versions` and the broader project posture). Q5 explicitly scopes to darwin; Linux/Windows are out of scope for the spike, in scope for the build if Linux/Windows operators surface in v1.1.
- (h) Build a "stale daemon detector" prototype. Q4 decides the pattern; the build implements it.

### Deferred work

- **Building D2.** If the spike returns `proceed-with-d2`, the v1.1 build story will be authored from the spike's notes file, scoped to: (i) `mcp-proxy.js` stdio shim with detached re-exec, (ii) per-user unix socket at `~/.crew/mcp-daemon.sock`, (iii) chosen framing per Q3 verdict, (iv) chosen daemon-liveness pattern per Q4, (v) chosen socket-auth approach per Q5. Estimated 2–3 days per the RCA memo.
- **Path B investigation.** Only triggered if the spike returns `pivot-to-path-b`. Larger surface (launchd/systemd, port discovery, HTTP transport swap, install/uninstall flow).
- **Linux / Windows platform validation.** Out of scope for the spike (darwin only). If v1.1 ships D2 and operators on other platforms surface, follow-up spike covers the platform-specific deltas.
- **Upstream Anthropic bug filing.** Tracked alongside Story 5.30; both stories ground in the same RCA.

---

## Acceptance Criteria

> ACs are reproduced from this story's epic block (`epic-5 § Story 5.31`) with per-AC implementation detail added below each one. AC markers (`artifact:`) use plain unbacked-tick form per memory `project_reviewer_toolchain_gaps` (entry 1). Each AC references a section of the same notes file — the spike author writes one section per AC under the headings called out in the implementation comments below. The file's existence and the verdict line satisfy AC1; the per-question sections satisfy AC2–AC6.

**AC1 (spike notes file exists with all five answers):**
A notes file at `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` exists and answers all five investigation questions below, each with concrete evidence (a URL with quoted excerpt, a runnable repro snippet with observed output, or a quoted fragment of an existing source file). The notes file's top section names the spike's verdict in one of three forms: `proceed-with-d2`, `pivot-to-path-b`, or `blocked-escalate-to-jack` with the named blocker.
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

<!--
Implementation: the notes file's structure is the spike author's choice but the reviewer
must be able to locate each AC's answer by section heading. Suggested skeleton:

  # Path D2 feasibility spike notes

  ## Verdict
  <one of: proceed-with-d2 | pivot-to-path-b | blocked-escalate-to-jack>
  <one-paragraph rationale>

  ## Q1: Manifest support for stdio shim (AC2)
  verdict: manifest-supports-shim: <yes | no | unclear-with-caveats>
  evidence: <URL+quote | repro+output | source-quote>

  ## Q2: detached:true survives SIGTERM cascade on darwin (AC3)
  verdict: detached-survives-sigterm: <yes | no | partial-with-caveats>
  evidence: <repro source + observed terminal output>

  ## Q3: JSON-RPC framing for the shim bridge (AC4)
  verdict: framing-approach: <named approach>
  evidence: <SDK reference | source quote | rationale>

  ## Q4: Lockfile + stale-daemon detection (AC5)
  verdict: daemon-liveness-pattern: <pidfile-with-kill-zero | socket-connect-probe | hybrid>
  evidence: <reference + edge-case analysis>

  ## Q5: Auth / multi-user safety on darwin (AC6)
  verdict: socket-auth: <filesystem-permission-only | token-handshake | other>
  evidence: <reference + threat model>

The file's parent dir (`_bmad-output/implementation-artifacts/spikes/`) does not yet
exist — `mkdir -p` it as part of the first write.
-->

**AC2 (manifest support — Q1):**
The notes file answers: does Claude Code's plugin manifest at `plugins/crew/.claude-plugin/plugin.json` support pointing `mcpServers.*.command` at an arbitrary stdio shim (e.g., a one-line bash script that `exec`s the real server) and have the host treat the shim as the MCP child? Evidence: either (a) a quoted excerpt from Claude Code's MCP docs (https://code.claude.com/docs/en/mcp.md) confirming the manifest treats `command` as an arbitrary executable path, OR (b) a runnable repro outside this repo (a tiny test plugin with a shell shim) showing MCP tools list correctly through the shim. The notes record the verdict as `manifest-supports-shim: yes | no | unclear-with-caveats`.
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

<!--
Implementation: cheapest path is the docs lookup via Context7 or a direct WebFetch of
the docs URL. The docs likely describe `mcpServers.<name>.command` as a command string
that gets exec'd — if so, quote the exact passage. If the docs are ambiguous, build the
out-of-repo repro: create a temp plugin dir, write a `plugin.json` whose
`mcpServers.test.command` points at a one-line bash script that `exec`s the real crew
MCP server binary, install the temp plugin into a clean Claude Code session, run
`/mcp` (or equivalent) and confirm the tools list. If the shim works, verdict is yes.

The current production manifest (`plugins/crew/.claude-plugin/plugin.json`) is the
reference for what a working manifest looks like; quote the relevant `mcpServers` block
if it clarifies the contract.
-->

**AC3 (OS-level detachment — Q2):**
The notes file answers: does `spawn(..., { detached: true, stdio: 'ignore' })` from a Node child actually survive a SIGTERM to its grandparent's process group on darwin? Evidence: a 20–40 line standalone Node repro outside this repo (not in `plugins/crew/`) that (a) spawns a "real server" child with `detached: true` + `stdio: 'ignore'`, (b) sends `SIGTERM` to the parent's process group via `process.kill(-pgid, 'SIGTERM')`, and (c) observes the detached child's pid is still alive 2s later (`process.kill(pid, 0)` returns truthy). The notes include the repro source verbatim and the observed terminal output. Records verdict as `detached-survives-sigterm: yes | no | partial-with-caveats`.
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

<!--
Implementation: this is the critical question. The repro must mirror the real topology:
grandparent (simulating the Claude Code host) -> parent (simulating the proxy shim) ->
child (simulating the daemon). The grandparent SIGTERMs its process group, which kills
the parent (shim). The child should survive because it was spawned detached + new pgid.

Suggested shape (write to `/tmp/d2-detach-repro/` outside the repo):
  - parent.mjs: spawns child with { detached: true, stdio: 'ignore' }; logs child pid;
    sets up SIGTERM handler that logs "parent exiting"; child.unref(); after 100ms,
    parent exits cleanly (mimicking the shim's normal lifecycle on host SIGTERM).
  - child.mjs: writes its pid + ppid + pgid to /tmp/d2-detach-repro/child.log every
    250ms; runs for 30s.
  - run.sh: starts parent.mjs, captures parent pid, waits 500ms, kills parent's pgid
    (`kill -TERM -<pgid>`), waits 3s, checks if child pid is alive (`ps -p <pid>`).

If `ps -p <pid>` returns the child after 3s, verdict is yes. If the child dies with the
parent, the cascade reaches detached children too and D2 is dead — escalate to Jack
with `blocked-escalate-to-jack: detachment-does-not-survive-pgid-sigterm`.

Note: on darwin, `process.getpgrp()` exists and `kill -TERM -<pgid>` works as on Linux.
The repro is portable but the spike scopes to darwin (project reference platform).
-->

**AC4 (JSON-RPC framing — Q3):**
The notes file answers: what's the cleanest framing for the shim's stdio→unix-socket bridge? The shim must forward JSON-RPC frames between Claude Code (stdio) and the daemon (unix socket). The notes identify any framing gotchas (chunked frames across socket reads, large payloads >64KB exceeding default buffer sizes, partial reads requiring buffering, line-delimited vs Content-Length framing) and recommend one framing approach with rationale. Evidence: either (a) a quoted reference to the MCP SDK's transport framing (`@modelcontextprotocol/sdk` source or docs via Context7), OR (b) a quoted note from the spike's investigation of the existing `plugins/crew/mcp-server/src/index.ts` stdio transport setup. Records verdict as `framing-approach: <named approach>` (e.g., `line-delimited-json`, `content-length-prefixed`).
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

<!--
Implementation: the MCP SDK's stdio transport is the canonical reference for what the
shim must speak on its stdio side; whatever the SDK emits, the shim forwards. The
clearest path is to query Context7 for the @modelcontextprotocol/sdk docs on stdio
transport framing and quote the relevant passage. Failing that, read the SDK source
in the project's node_modules (or the GitHub repo) and quote the encode/decode loop.

The current production server (`plugins/crew/mcp-server/src/index.ts`) sets up the
stdio transport via the SDK; quote the relevant lines to show the framing is opaque to
our code (the SDK owns it). The shim's job is byte-forwarding — it doesn't need to
parse JSON-RPC, just chunk-buffer correctly across socket read boundaries.

Recommended framing is whatever the SDK uses end-to-end; the spike's job is to confirm
it's line-delimited (one JSON-RPC frame per newline) vs Content-Length-prefixed
(LSP-style headers). Either is straightforward but the buffering code differs.
-->

**AC5 (lockfile + stale-daemon detection — Q4):**
The notes file answers: what's the right pattern for "is a daemon already running, or do I need to spawn one"? The notes evaluate at minimum two patterns — (a) PID file + `kill(pid, 0)` check, and (b) optimistic socket-connect probe — and recommend one with rationale covering: stale-PID handling on crash, race condition on first two concurrent shim spawns, cross-session correctness when multiple Claude Code instances run. Evidence: either a quoted reference from a well-known daemon's source (sshd, pgsql, redis), or a short pseudocode sketch validated against the four edge cases above. Records verdict as `daemon-liveness-pattern: <pidfile-with-kill-zero | socket-connect-probe | hybrid>`.
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

<!--
Implementation: this is a design decision, not a feasibility check. The notes evaluate
both patterns against the four named edge cases:

  1. Stale PID on crash: pidfile contains a pid that no longer maps to a live daemon
     because the daemon crashed without unlinking the pidfile. kill(pid, 0) returns
     ESRCH — shim spawns a fresh daemon. Socket-connect-probe fails to connect — shim
     spawns a fresh daemon. Both handle this; pidfile needs the kill(0) check, socket
     pattern is inherently self-cleaning.

  2. Race on first concurrent shim spawns: two Claude Code sessions start at the same
     instant; both shims check for a running daemon, both find none, both spawn one.
     Now two daemons compete for the socket. Pidfile pattern needs flock(LOCK_EX) on
     write to prevent. Socket-connect-probe needs the daemon to bind the socket
     exclusively (EADDRINUSE on second daemon's bind — second daemon exits, second
     shim retries connect, succeeds).

  3. Cross-session correctness with multiple Claude Code instances: the daemon is
     per-user, not per-session — both sessions share one daemon, which is exactly the
     desired behaviour. Both patterns handle this naturally.

  4. Daemon hung (process alive, socket dead): pidfile + kill(0) says alive but the
     shim's connect attempt fails. Hybrid: kill(0) AND connect-probe; if pid alive
     but socket dead, SIGKILL the hung daemon and respawn.

Likely recommendation is hybrid (kill(0) + connect-probe + EADDRINUSE-on-bind race
handling), but the spike author makes the call from the evaluation.

Reference daemons: redis-server uses pidfile + EADDRINUSE; postgres uses pidfile +
shared-memory key; sshd uses pidfile + per-host-key socket. None are pure socket-
connect-probe; the hybrid pattern is the production norm.
-->

**AC6 (auth / multi-user safety — Q5):**
The notes file answers: does the unix socket need a per-connection token, or is filesystem permission (`0600` on the socket path under `~/.crew/`) sufficient for the darwin reference platform? The notes identify the threat model (other unprivileged processes on the same machine; not a network adversary — unix sockets are local-only), evaluate filesystem-permission-only vs token-handshake-on-connect, and recommend one with rationale. Evidence: either a quoted reference from unix-socket auth best-practices (e.g., man 2 socket section on `SO_PEERCRED` / macOS equivalents) or a quoted note on equivalent patterns in adjacent local-IPC daemons. Records verdict as `socket-auth: <filesystem-permission-only | token-handshake | other>`.
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

<!--
Implementation: threat model is "another unprivileged user on the same machine, or
another unprivileged process running as the same user, connects to the socket and
calls MCP tools that mutate ~/.crew/ state". Filesystem permission 0600 on the socket
path under ~/.crew/ defeats the cross-user case (only the owning user can connect).
Same-user same-process case is not defended by either pattern — anyone running as the
user can call any tool the user has access to (this is the standard unix model).

For darwin specifically, macOS does not have SO_PEERCRED; the equivalent is
LOCAL_PEEREPID + LOCAL_PEEREUID via getsockopt. The spike notes whether the daemon
needs to verify peer uid programmatically (defence in depth against socket-permission
misconfigurations) or whether 0600 + the OS enforcing it is the operative guarantee.

Likely recommendation is filesystem-permission-only (0600 + parent dir 0700 on
~/.crew/) — same model as ssh-agent, gpg-agent, docker daemon's default socket. The
spike confirms this matches darwin conventions and notes any caveat (e.g., if the
socket path is in /tmp instead of ~/.crew/, the threat model changes).
-->

---

## Tasks / Subtasks

Implementation order is research-then-write. The spike author can answer Q1, Q3, Q4, Q5 in any order from docs/sources; Q2 needs the out-of-repo Node repro and is the highest-risk question (it's the one that kills D2 if hostile). Suggested order: Q2 first (kill the approach early if it fails), then Q1 (kill the approach early if the manifest doesn't route to a shim), then Q3/Q4/Q5 in parallel.

- [ ] **Task 1: Create the spikes directory and notes file skeleton** (AC: #1)
  - [ ] 1.1 `mkdir -p _bmad-output/implementation-artifacts/spikes/`
  - [ ] 1.2 Create `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` with the section skeleton (Verdict + Q1–Q5 sections per the AC1 implementation comment). Leave each section's verdict as `<pending>` until that question is answered.

- [ ] **Task 2: Investigate Q2 — OS-level detachment** (AC: #3)
  - [ ] 2.1 Create a temp directory outside this repo (e.g., `/tmp/d2-detach-repro/`). Write `parent.mjs`, `child.mjs`, and `run.sh` per the AC3 implementation comment.
  - [ ] 2.2 Run `bash /tmp/d2-detach-repro/run.sh`. Capture the terminal output. Confirm whether the child pid is alive 3s after the parent's pgid was SIGTERM'd.
  - [ ] 2.3 Write the Q2 section of the notes file: include `parent.mjs` and `child.mjs` source verbatim, the observed `ps -p <pid>` output, and the verdict line `detached-survives-sigterm: <yes|no|partial-with-caveats>`. If the verdict is `no`, escalate to Jack immediately — D2 is dead.

- [ ] **Task 3: Investigate Q1 — manifest support for shim** (AC: #2)
  - [ ] 3.1 Try the docs path first: query Context7 for `mcp manifest command field` or WebFetch https://code.claude.com/docs/en/mcp.md and locate the section on `mcpServers.<name>.command`. Quote the relevant passage.
  - [ ] 3.2 If the docs are ambiguous, build the out-of-repo repro: create a temp plugin dir (e.g., `/tmp/d2-shim-test/`), write a `plugin.json` whose `mcpServers.test.command` points at a one-line bash script that `exec`s the real crew MCP server binary, install the temp plugin via `/plugin install /tmp/d2-shim-test/` in a clean Claude Code session, run the MCP tools list, confirm the shim works.
  - [ ] 3.3 Write the Q1 section of the notes file with the evidence and the verdict line `manifest-supports-shim: <yes|no|unclear-with-caveats>`. If the verdict is `no`, escalate to Jack — D2 is dead.

- [ ] **Task 4: Investigate Q3 — JSON-RPC framing** (AC: #4)
  - [ ] 4.1 Query Context7 for `@modelcontextprotocol/sdk stdio transport framing`. Locate the encode/decode loop in the SDK. Quote the relevant passage.
  - [ ] 4.2 Read `plugins/crew/mcp-server/src/index.ts` to confirm the production server uses the SDK's stdio transport unchanged (no custom framing). Quote the relevant lines.
  - [ ] 4.3 Write the Q3 section of the notes file with the SDK reference, source quote, and the verdict line `framing-approach: <named-approach>`. Note any buffering gotchas the shim must handle.

- [ ] **Task 5: Investigate Q4 — lockfile + stale-daemon detection** (AC: #5)
  - [ ] 5.1 Evaluate the two patterns (PID file + kill(0); socket-connect-probe) against the four edge cases in the AC5 implementation comment. Sketch pseudocode for each.
  - [ ] 5.2 Cross-reference with one well-known daemon's source (redis-server is closest in shape — pidfile + EADDRINUSE). Quote the relevant lines or docs.
  - [ ] 5.3 Write the Q4 section of the notes file with the evaluation, the reference, and the verdict line `daemon-liveness-pattern: <pidfile-with-kill-zero|socket-connect-probe|hybrid>`.

- [ ] **Task 6: Investigate Q5 — auth / multi-user safety** (AC: #6)
  - [ ] 6.1 Identify the threat model in the notes (per AC6 implementation comment).
  - [ ] 6.2 Evaluate filesystem-permission-only (0600 on socket + 0700 on `~/.crew/`) vs token-handshake-on-connect. Reference darwin's peer-credential APIs if relevant (LOCAL_PEEREPID / LOCAL_PEEREUID via getsockopt).
  - [ ] 6.3 Cross-reference with one adjacent local-IPC daemon's default (ssh-agent, gpg-agent, docker daemon — quoted from docs or source).
  - [ ] 6.4 Write the Q5 section of the notes file with the threat model, evaluation, reference, and verdict line `socket-auth: <filesystem-permission-only|token-handshake|other>`.

- [ ] **Task 7: Write the verdict section** (AC: #1)
  - [ ] 7.1 Once Q1–Q5 are answered, fill the notes file's top `## Verdict` section. The verdict is `proceed-with-d2` iff Q1 and Q2 are both `yes` AND Q3/Q4/Q5 each have a defensible recommendation. The verdict is `pivot-to-path-b` iff Q1 or Q2 is `no` AND the spike's judgement is that Path B is the right next investigation. The verdict is `blocked-escalate-to-jack: <named-blocker>` iff Q1 or Q2 is `no` AND the next step requires Jack's call (e.g., scope expansion, deferral, accepting Path A as permanent).
  - [ ] 7.2 Add a one-paragraph rationale under the verdict line explaining why the verdict follows from the Q1–Q5 answers.

- [ ] **Task 8: Verify the notes file passes AC checks** (AC: all)
  - [ ] 8.1 `grep -E "manifest-supports-shim:|detached-survives-sigterm:|framing-approach:|daemon-liveness-pattern:|socket-auth:" _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` — confirm five verdict lines are present.
  - [ ] 8.2 `grep -E "^## Verdict$" _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` — confirm the top verdict section exists.
  - [ ] 8.3 Manually scan each Q section to confirm it has concrete evidence (URL+quote, runnable snippet+output, or source-file quote) — not assertion alone.

---

## Implementation strategy

### Why a spike, not a build

The RCA memo's recommendation lists D2 as a "v1.1 candidate" precisely because three of the five questions (Q1, Q2, Q3) are unknown today and any of them being hostile invalidates the build. Spending 2–3 engineering days on D2 before answering Q1 ("does the manifest even route to a shim?") is the worst-case waste. A half-day spike that answers Q1+Q2 first, then refines Q3/Q4/Q5, collapses the build estimate's uncertainty from "2–7 days depending on what we find" to "2–3 days with named decisions". The spike is the cheapest way to buy that certainty.

### Why notes-file-only, no production code

The spike's deliverable is **decisions and evidence**, not artefacts. Writing throwaway D2 plumbing inside `plugins/crew/` would mean either (a) commenting it out for the merge, which is sloppy, or (b) leaving it active, which contaminates the production surface before the build is approved. Out-of-repo repros (Q2's `/tmp/d2-detach-repro/`, Q1's `/tmp/d2-shim-test/`) keep the production tree untouched and the evidence reproducible by quoting source + output verbatim in the notes file.

### Why the verdict is one of three exact strings

The next engineer picking up D2 will scan the notes file's top section first; making the verdict a fixed enum (`proceed-with-d2` | `pivot-to-path-b` | `blocked-escalate-to-jack`) means the orchestrating planner can act on the verdict deterministically. Free-form prose verdicts invite re-interpretation. The verdict is the spike's primary output.

### Why Q2 (detachment) goes first

Q2 is the question most likely to kill D2 and is the cheapest to answer (a 40-line Node script and a 3-second test). If Q2 returns `no` (detached children die with the parent's pgid SIGTERM), no other answer matters — D2 is dead. Front-loading Q2 minimises wasted spike time. Q1 (manifest support) is the second cheapest and the second most likely killer.

### Why Q3 references the SDK, not custom framing

The MCP SDK owns the wire format on both sides — Claude Code's stdio side and the crew server's stdio side both speak whatever the SDK encodes. The shim's job is byte-forwarding across stdio↔socket. The framing question is therefore "what does the SDK emit", not "what should the shim choose". The answer is forced by the SDK; the spike just confirms what it is and notes the buffering gotcha (the shim must read full frames, not arbitrary chunks).

### Why Q4 considers a hybrid

Pure pidfile is racy under concurrent shim spawns; pure socket-connect-probe doesn't detect a daemon hung on a dead socket. Production daemons (redis, postgres) use both: pidfile for fast-path "is anything supposed to be there" + socket-bind EADDRINUSE for race correctness on spawn. The spike's recommendation is likely hybrid, but the author makes the call from evaluation, not assumption.

### Why Q5 is darwin-scoped

The project's reference platform is darwin. macOS's local-IPC threat model and peer-credential APIs differ from Linux's in detail (no `SO_PEERCRED`; `LOCAL_PEEREPID`/`LOCAL_PEEREUID` instead). Scoping the spike to darwin keeps the answer concrete; the v1.1 build will revisit if Linux/Windows operators surface.

---

## Locked files

- `plugins/crew/.claude-plugin/plugin.json` — NOT touched. Read-only reference for Q1.
- `plugins/crew/mcp-server/src/**` — NOT touched. Read-only reference for Q3 (current stdio transport setup at `src/index.ts`).
- `plugins/crew/mcp-server/dist/**` — NOT touched. No build artefacts change because no source changes.
- `plugins/crew/skills/start/SKILL.md` — NOT touched. Story 5.30 modifies it; this spike does not.
- `plugins/crew/permissions/**` — NOT touched. No allowlist changes.
- Any other production source under `plugins/crew/` — NOT touched. The spike's deliverable is a notes file under `_bmad-output/implementation-artifacts/spikes/`.

### Declared-locked-file changes (explicit exceptions)

- `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` (new file) — Task 1 creates it; Tasks 2–7 fill it. This is the spike's only deliverable.
- `_bmad-output/implementation-artifacts/spikes/` (new directory) — created by Task 1.1.

---

## Dev Notes

### Files this story will create

- `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` (Task 1.2) — the spike's only deliverable. Sectioned per AC1's implementation comment. Verdict + Q1–Q5 sections, each with concrete evidence.
- `_bmad-output/implementation-artifacts/spikes/` (Task 1.1) — new directory for spike notes; future spikes land here too.

### Files this story will NOT modify

- `plugins/crew/.claude-plugin/plugin.json` — Path D2 build territory; the spike is read-only against it.
- `plugins/crew/mcp-server/src/**` — same.
- `plugins/crew/skills/start/SKILL.md` — Story 5.30's surface.
- README, PRD `non-functional-requirements.md`, or any other doc — follows the build, not the spike.

### Files this story reads (read-only context)

- `plugins/crew/.claude-plugin/plugin.json` — for Q1 evidence (current `mcpServers` block shape).
- `plugins/crew/mcp-server/src/index.ts` — for Q3 evidence (current stdio transport setup; confirms shim's framing job).
- `~/.crew/mcp-lifecycle.log` — for cascade-pattern context (already cited in Story 5.30's spec; the spike does not re-investigate the RCA, only references it).
- `~/.claude/plans/linked-knitting-stardust.md` — the RCA memo. Section "D2. Detached proxy + parent-owned daemon" is the spike's design starting point.
- Claude Code MCP docs at https://code.knaude.com/docs/en/mcp.md — for Q1 evidence (correct URL is https://code.claude.com/docs/en/mcp.md; the typo'd URL exists in the source brief but the spike author should use the canonical one).

### Spec citations and evidence (read-only context)

- 8/8 paired SIGTERMs in `~/.crew/mcp-lifecycle.log` across 4 distinct incidents (RCA memo at `~/.claude/plans/linked-knitting-stardust.md`) — the failure mode D2 fixes.
- Story 5.30's halt seam ships first; D2 is the structural fix that retires Story 5.30's restart-per-cascade UX cost. The two stories coexist: 5.30 is the v1 patch, this spike informs the v1.1 fix.
- Path A (Story 5.30) costs every cascade-interrupted story one Claude Code restart. D2 costs zero restarts but 2–3 days of build time, gated on this spike returning `proceed-with-d2`.

### Why no testing standards section

No production code; no tests. The notes file is the deliverable; AC verification is a manual scan (Task 8) plus the reviewer's read-through.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md § Story 5.31`] — this story's epic block.
- [Source: `~/.claude/plans/linked-knitting-stardust.md` § Recommendation, step 4 + § D2] — the RCA memo identifying D2 as the v1.1 candidate.
- [Source: `_bmad-output/implementation-artifacts/5-30-mcp-cascade-halt-seam-and-lifecycle-diagnostics.md`] — Story 5.30 (Path A), the sibling story this spike supersedes structurally in v1.1.
- [Source: `plugins/crew/.claude-plugin/plugin.json`] — current MCP server registration; Q1 reference.
- [Source: `plugins/crew/mcp-server/src/index.ts`] — current stdio transport setup; Q3 reference.
- [Source: https://code.claude.com/docs/en/mcp.md] — Claude Code MCP docs; Q1 primary evidence path.
- [Source: project memory `project_mcp_cascade_sigterm`] — the RCA distilled.
- [Source: project memory `project_mcp_server_silent_disconnect`] — two-causes framing (idle-reap fixed; cascade pending).
- [Source: project memory `feedback_dependency_versions`] — darwin as reference platform; pin via pnpm.
- [Source: project memory `project_reviewer_toolchain_gaps`] — AC marker convention (plain `artifact:` / `vitest:`, no backticks).
- [Source: project memory `feedback_default_to_deterministic_seams`] — why the verdict is an enum, not free-form prose.

---

## Previous story intelligence

### From Story 5.30 (sibling: Path A halt seam)

- Story 5.30 ships the operator-facing patch (verbatim halt line + recovery instructions + lifecycle log diagnostic fields). This spike (5.31) investigates whether the structural fix (D2) is buildable. The two stories ship in the same window: 5.30 first (operator gets unblocked), then this spike (engineering decides whether D2 ships as v1.1).
- Story 5.30's lifecycle-log additions (`ppid`/`pgid`/optional `sessionUlid`) are pre-work for D2: if D2 ever ships, the lifecycle log will tell us whether the detached proxy stayed in its own process group (i.e., whether the OS-level detachment held in production).
- The halt seam's verbatim string `[mcp-cascade-halted] ...` is the operator's signal that the cascade fired. If D2 ships and works, this string should never appear in chat output for cascade reasons (it may still appear for other MCP-disconnect causes — the typed error covers both).

### From Story 5.25 (always-on lifecycle logging)

- The lifecycle logger is the evidence source for the RCA. Without 5.25, we would not have the 8/8 paired-SIGTERM pattern that named the cascade as a process-group signal. If D2 ships, the logger continues to provide observability into the daemon's lifecycle — but the cascade pattern itself should disappear from the log.

### From Story 5.20 (orphan-recovery — reviewer-only respawn)

- Story 5.20's orphan-recovery branch is what makes Story 5.30's halt seam survivable for the operator (restart → reattach → reviewer-only spawn drives the rework). If D2 ships, the orphan branch is still load-bearing for non-cascade failures (operator quits Claude Code mid-cycle, crash, etc.), but the cascade-restart case becomes unnecessary.

### From Story 5.10 (transcript persistence)

- The principle: critical state must be written to disk before any MCP call. D2 does not change this invariant — the daemon could still crash or be killed by other means; the transcript-persistence invariant remains the floor.

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
