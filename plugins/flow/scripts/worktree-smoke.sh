#!/bin/sh
# plugins/flow/scripts/worktree-smoke.sh — print the worktree-smoke install
# recipe for pasting into Claude Code. Story 2.8 AC1, AC3, AC4.
#
# Usage: run from inside a worktree checkout (under .worktrees/<branch>/).
# The script prints three slash-command lines to stdout; paste them into the
# Claude Code TUI in order. It does NOT execute them.
#
# Exit codes:
#   0 — printed the recipe successfully (you are inside a worktree)
#   2 — refusing to run: not inside a worktree (run from .worktrees/<branch>/)
#   3 — preflight failure: missing dependency (git) or not inside a git repo

set -e

# Preflight: git must be on PATH.
if ! command -v git >/dev/null 2>&1; then
  printf 'worktree-smoke: missing dependency: git\n' >&2
  exit 3
fi

# Locate the repo root.
root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  printf 'worktree-smoke: not inside a git repository\n' >&2
  exit 3
}

# Detect whether this checkout is a worktree.
# `git rev-parse --git-dir` returns ".git" inside the main checkout, but
# something like /path/to/main/.git/worktrees/<branch> inside a worktree.
gitdir=$(git rev-parse --git-dir 2>/dev/null)
case "$gitdir" in
  *.git/worktrees/*) ;;
  *)
    printf 'worktree-smoke: refusing to run outside a worktree — cd into .worktrees/<branch>/ first\n' >&2
    exit 2
    ;;
esac

branch=$(git rev-parse --abbrev-ref HEAD)
plugin_root="$root/plugins/flow"
version=$(node -e "console.log(require('$plugin_root/.claude-plugin/plugin.json').version)" 2>/dev/null || printf 'unknown')

printf '# Paste these into Claude Code to load worktree branch %s:\n' "$branch"
printf '/plugin uninstall flow@flow\n'
printf '/plugin install flow@flow\n'
printf '/reload-plugins\n'
printf '# After /reload-plugins, /flow:status should report version %s from %s\n' "$version" "$plugin_root"

exit 0
