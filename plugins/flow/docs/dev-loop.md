# flow plugin — developer loop guide

> **This guide is for engineers iterating on the plugin itself.** If you are
> installing the plugin as an end-user, follow [`README-install.md`](./README-install.md).

## Two install paths

| Path | Command | Use when |
|------|---------|----------|
| **Production** | `/plugin install flow@flow` (inside Claude Code) | End-user installing from main — see `README-install.md` |
| **Dev (worktree)** | `claude --plugin-dir <worktree>/plugins/flow` (shell) | Engineer iterating on a worktree branch — this guide |

## The blessed dev workflow

Launch Claude Code with the `--plugin-dir` flag pointing at the worktree's
plugin tree:

```bash
claude --plugin-dir /Users/<you>/projects/crew/.worktrees/<story-key>/plugins/flow
```

This is Anthropic's documented developer workflow (`Load a plugin from a
directory or .zip for this session only`). It:

- Bypasses the marketplace cache entirely — no `/plugin install`, no
  `~/.claude/plugins/cache/` manipulation.
- Survives Claude Code restarts (provided you re-launch with the same flag).
- Cannot collide with a production install on `main`: the `--plugin-dir`
  plugin loads alongside, and the worktree version wins for the session.

When `ship.py worktree <story-key>` creates a worktree, its output includes
the exact `claude --plugin-dir …` invocation to use. Copy it from the
`plugin_dir.invocation` field.

## Daily dev loop (current branch, no worktree switch)

If you are editing on the **current branch** (not switching branches), the
watch-build + `/reload-plugins` loop is the fastest path:

1. Start the watch compiler in a terminal:
   ```sh
   pnpm --dir plugins/flow/mcp-server build:watch
   ```
   `tsc --watch` incrementally recompiles into `dist/` in 1–3 seconds.
2. After each rebuild, in the Claude Code TUI: `/reload-plugins`

**Skill-only changes (SKILL.md files):** no rebuild needed — just `/reload-plugins`.

## Deprecated: `pnpm --dir plugins/flow dev:install`

Story 1.11 shipped `pnpm --dir plugins/flow dev:install`, a script that
symlinks the worktree's `plugins/flow/` into
`~/.claude/plugins/cache/flow/flow/<version>/`. The script still works for
the current session, but Claude Code's plugin healer treats the symlink as
corruption and wipes the cache entry on the next startup. After Epic 3 retro
(2026-05-21), `ship.py` no longer calls this script during worktree creation
or cleanup; the canonical dev workflow is `claude --plugin-dir <path>` above.

The script is retained for backward compatibility but prints a deprecation
warning on each run. Anything that asks for `pnpm dev:install` in older docs
or runbooks should be updated to the `--plugin-dir` invocation.

See [`spikes/dev-install-decision.md`](spikes/dev-install-decision.md) for
the historical research; see GitHub issues
[anthropics/claude-code#17361](https://github.com/anthropics/claude-code/issues/17361)
and [#23819](https://github.com/anthropics/claude-code/issues/23819) for the
plugin-healer behaviour that motivated the deprecation.

## Verifying the dev plugin is loaded

After launching Claude Code with `--plugin-dir`:

```
> /flow:status
```

Should print the plugin version from your worktree's
`plugins/flow/.claude-plugin/plugin.json`, not the main-branch version.
