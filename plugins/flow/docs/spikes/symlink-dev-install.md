# Spike: symlink-based dev install for the flow plugin

**Date:** 2026-05-20
**Status:** no-go (symlink not needed — Claude Code already runs from the live source tree)
**Recommendation:** Drop the symlink idea; the real bottleneck is MCP process restart, not install copying. Add `"build:watch": "tsc -p tsconfig.json --watch"` to `mcp-server/package.json` and document the two-step dev loop: build-watch in a terminal + `/reload-plugins` after each rebuild.

## TL;DR

- **Claude Code does not copy the plugin into a cache for local-directory marketplaces.** The MCP server process runs directly from `plugins/flow/mcp-server/dist/index.js` in the live source tree. Confirmed via `ps` output and `getPluginRoot()` resolution via `import.meta.url`.
- **The cache at `~/.claude/plugins/cache/crew/crew/0.1.0/` is a snapshot taken at install time**, used for version metadata only. It does not affect what code runs.
- **Skills (SKILL.md files) are loaded by Claude Code at `/reload-plugins` time** from the source tree's `installPath` neighbourhood; editing a SKILL.md and reloading is instant, no rebuild required.
- **The only barrier to sub-second feedback is the MCP server module cache.** After `pnpm build`, `/reload-plugins` restarts the node process and picks up new `dist/`. Round-trip is seconds, not minutes.
- **The painful uninstall+reinstall flow documented in `worktree-smoke.md` remains correct for worktree branch testing** — it is not made obsolete by this finding. The issue there is that Claude Code's idempotent install sees the cached metadata (same version) and skips re-copying, not that the live path is wrong.

## Question this spike answers

Can the flow plugin be installed into Claude Code as a symlink to its source worktree, enabling a sub-second edit→test loop?

## Findings

### Q1: Does Claude Code support symlink installs?

**Moot — it already behaves like a live symlink for local marketplaces.**

**Evidence:**

1. `~/.claude/plugins/known_marketplaces.json` registers the crew marketplace as:
   ```json
   "crew": {
     "source": { "source": "directory", "path": "/Users/jackmcintyre/projects/crew" },
     "installLocation": "/Users/jackmcintyre/projects/crew"
   }
   ```

2. `plugins/flow/.claude-plugin/marketplace.json` maps the plugin to `"source": "./plugins/flow"`.

3. `plugin.json` declares:
   ```json
   "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js"]
   ```
   For a directory-sourced marketplace, `CLAUDE_PLUGIN_ROOT` resolves to `<installLocation>/<source>` = `/Users/jackmcintyre/projects/crew/plugins/flow`.

4. `ps` output at spike time confirms the live process:
   ```
   node /Users/jackmcintyre/projects/crew/plugins/flow/mcp-server/dist/index.js
   ```
   — the source tree, not the cache copy.

5. `getPluginRoot()` in `mcp-server/src/lib/plugin-root.ts` uses `import.meta.url` (three levels up from the running file) to resolve the plugin root at runtime. No env var, no process.cwd(). The path is always `plugins/flow/` relative to wherever the node process lives.

6. Inode comparison confirms the cache copy and source are separate files (different inodes). The cache at `~/.claude/plugins/cache/crew/crew/0.1.0/mcp-server/dist/index.js` is a point-in-time snapshot; the running process ignores it entirely.

**Verdict: a symlink is unnecessary. The system is already live-linked by construction.**

### Q2: What does the dev loop look like?

**Two-step loop for MCP server changes (TypeScript src/):**

1. In a shell, run a watch build:
   ```sh
   pnpm --dir plugins/flow/mcp-server build -- --watch
   # or equivalently:
   cd plugins/flow/mcp-server && npx tsc -p tsconfig.json --watch
   ```
   `tsc --watch` is a built-in TypeScript flag; no new dependency needed. It incrementally recompiles changed files into `dist/` in 1–3 seconds.

2. In the Claude Code TUI, after each rebuild:
   ```
   /reload-plugins
   ```
   This kills and respawns the node process, picks up the new `dist/index.js`, and rebinds MCP tools. No session restart. No uninstall/reinstall.

**Proposed `package.json` delta** (not applied — for operator to add):
```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "build:watch": "tsc -p tsconfig.json --watch",
  "test": "vitest run"
}
```

**Caching layers and invalidation:**

| Layer | What caches | Invalidated by |
|---|---|---|
| Node module cache | Compiled JS loaded into memory at process start | `/reload-plugins` (process restart) |
| Skill content (SKILL.md) | Claude Code reads at `/reload-plugins` time | `/reload-plugins` — no rebuild needed |
| Catalogue / persona files | Read from disk on each MCP tool call | Nothing to invalidate; live reads always |
| `~/.claude/plugins/cache/` | Point-in-time install snapshot | Irrelevant to running code; only consulted for version metadata |
| Claude prompt cache | Prompt tokens in the session | New session or cache miss after TTL |

**Estimated edit→test latency:**

- Skill-only change: edit SKILL.md → `/reload-plugins` → ~2 seconds
- MCP server change: edit src/ → tsc recompiles (~2–4 s) → `/reload-plugins` → ~2 seconds
- Total MCP loop: **~5–8 seconds**, not the 30–60 seconds of the current uninstall+reinstall ritual

### Q3: Alternatives (not applicable)

Q1 resolved as already-live — no fallback needed. For completeness:

- **Scripted reinstall helper (`worktree-smoke.sh` variant):** Already exists. Useful only for worktree branch testing where the idempotency trap fires (same version, different branch). Not applicable to the day-to-day dev loop.
- **`node --watch`:** The MCP server could run under `node --watch dist/index.js` for automatic process restart on file change. This would eliminate the `/reload-plugins` step but requires Claude Code to not manage the process lifetime itself. Claude Code spawns the node process from `plugin.json`; replacing that with a watch wrapper is unsupported and fragile.

## Recommendation

**Nothing to change in how the plugin installs.** The live-source behaviour is already in place.

Two concrete next steps, small enough to do in a single story:

1. **Add `"build:watch"` to `mcp-server/package.json`** — one-line change, gives contributors `pnpm build:watch` instead of having to know the `tsc --watch` flag.
2. **Update `worktree-smoke.md`** with a new section clarifying the day-to-day dev loop (watch + reload) vs. the worktree branch-testing loop (uninstall + install + reload). The two are currently conflated, which is why contributors reach for the nuclear option by default.

Both fit in the existing docs-maintenance track; no new story required unless you want to gate on a CI check.

## Open questions / risks

- **`/reload-plugins` restart guarantee (unverified):** This spike assumes `/reload-plugins` fully kills and respawns the node process. If it only reconnects the MCP transport without killing the process, stale module cache persists. **Operator validation needed** — see test plan.
- **Skill loading path (partially verified):** Skills appear to be read by Claude Code from the source tree at reload time, but this was not directly confirmed with a sentinel test. The inode difference between cache and source means one of them is authoritative; the assumption is source.
- **CLAUDE_PLUGIN_ROOT resolution for non-directory marketplaces:** The live-source behaviour confirmed here is specific to `"source": "directory"` marketplaces. GitHub-cloned marketplaces may behave differently (cache is authoritative). Not a concern for dev workflow but matters for published installs.
- **`tsc --watch` and committed `dist/`:** Running watch in a dev session will produce uncommitted `dist/` changes. The CI `git diff --exit-code mcp-server/dist` check will catch drift on PRs. Contributors must remember to commit the final `dist/` before opening a PR.

## Test plan for the operator

Run these steps in a live Claude Code session with the crew repo open, to validate spike conclusions:

**Test 1 — Confirm live-source MCP path**
1. Run `ps aux | grep crew` in a terminal. Note the full path of the node process. Confirm it points to `plugins/flow/mcp-server/dist/index.js` inside the repo, not `~/.claude/plugins/cache/`.
2. Expected: path matches `/Users/<you>/projects/crew/plugins/flow/mcp-server/dist/index.js`.

**Test 2 — MCP change picked up without reinstall**
1. In a terminal: `cd plugins/flow/mcp-server && npx tsc -p tsconfig.json` (one-shot build).
2. In Claude Code TUI: `/reload-plugins`.
3. Run `/flow:status`. Confirm it works. No uninstall/reinstall needed.
4. Expected: plugin responds normally.

**Test 3 — `/reload-plugins` actually restarts the node process**
1. Note the PID of the node process from `ps aux | grep crew`.
2. In Claude Code TUI: `/reload-plugins`.
3. Run `ps aux | grep crew` again. Check if the PID changed.
4. Expected: new PID = process was killed and respawned (module cache cleared). Same PID = only transport reconnected (stale module cache risk — need a session restart for MCP src changes).

**Test 4 — Skill-only change (no rebuild)**
1. Add `SPIKE-SENTINEL-SL` to the first line of `plugins/flow/skills/status/SKILL.md`.
2. In Claude Code TUI: `/reload-plugins`.
3. Run `/flow:status` and check `/help crew:status`.
4. Expected: sentinel visible, no rebuild step needed.
5. Revert the sentinel edit.
