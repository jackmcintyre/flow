# Dev-install mechanism decision record

**Date:** 2026-05-21
**Story:** 1.11 — Dev-install loop: make plugin changes visible without a daemon restart
**Status:** decided — hybrid symlink chosen

## Chosen mechanism: hybrid symlink (option 1d)

Replace the install cache directory (`~/.claude/plugins/cache/flow/flow/<version>/`)
with a symlink pointing at the active worktree's `plugins/flow/` directory. On first
run the existing cache directory (a regular directory) is removed and replaced with the
symlink. On subsequent runs the existing symlink is left in place (no-op). A "now
restart Claude Code" instruction is printed on success.

**Concrete steps the script performs:**

1. Preflight: verify `git rev-parse --show-toplevel` succeeds; verify
   `<root>/plugins/flow/.claude-plugin/plugin.json` exists; read `version`.
2. Build check: if `<root>/plugins/flow/mcp-server/dist/index.js` is missing, exit
   non-zero naming the build command — do not auto-build (keeps the script fast and
   predictable on no-op re-runs).
3. Cache resolution: compute `target=$HOME/.claude/plugins/cache/flow/flow/$version`.
   If `$target` is already a symlink to the source, print the success line and exit 0
   (idempotency path). If `$target` is a regular directory, remove it. Create parent
   dirs if absent.
4. Create symlink: `ln -s <root>/plugins/flow $target`.
5. Sentinel verify: read `$target/.claude-plugin/plugin.json`, confirm version matches.
6. Print success line and a "restart Claude Code" instruction.

## Ruled-out alternatives

### (b) Copy-based rsync

`rsync -a --delete` source → cache would match what `/plugin install` does internally.
**Ruled out** because: the symlink approach is zero-overhead on no-op re-runs (the
idempotency check is a single `readlink` comparison, not an rsync scan), and skill
changes are reflected immediately without a second rsync pass.

### (c) Repoint `known_marketplaces.json`

Would require writing to a Claude Code registry file. **Eliminated by the behavioural
contract** ("MUST NOT modify Claude Code registries").

### (a) Symlink without build-check or daemon guidance

Simpler, but leaves the operator wondering why their TypeScript changes aren't visible
when `dist/` is stale. The hybrid adds the build-check preflight and the
"restart Claude Code" instruction, which covers the cases the pure symlink misses.

## Task 1.2: Daemon re-scan trigger research

**Finding:** No programmatic invalidation API is available for Claude Code's plugin
daemon skill-index cache from outside the daemon. The empirical experiments documented
in spike 8739bbf (PR #85) test plan Steps 3 and 4 confirm that `/reload-plugins`
restarts the MCP server node process and re-reads skill SKILL.md files — but the
skill _index_ (the list of skills that appears in the slash-command picker) is not
guaranteed to be refreshed by `/reload-plugins` alone across sessions.

**`pkill -USR1` / `pkill -HUP` probes:** Neither signal causes the daemon to re-scan
in the tested Claude Code 2.1.x version. The daemon ignores both.

**Sentinel-file probe:** touching a file under the cache directory did not trigger a
re-scan.

**Conclusion:** A full Claude Code restart is the only reliable way to pick up new
skills in the slash-command picker when the skill index has changed. The script prints
"next: restart Claude Code" as its final instruction. This is the same operator
contract as the production install path.

## Task 1.4: `--kill-daemon` flag

A targeted `pkill -f plugins/flow/mcp-server/dist/index.js` successfully kills the
MCP server subprocess. Claude Code respawns it on the next tool call or `/reload-plugins`.
This does NOT cause the skill index to re-scan; a full restart is still required for
new skills to appear in the picker. The `--kill-daemon` flag is included in the script
as a convenience to speed up MCP server restart, **gated behind the flag and off by
default**. It is documented in the script's help text.
