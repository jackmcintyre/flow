#!/usr/bin/env bash
# Flow plugin PreToolUse hook for the `Skill` tool.
# Story native:01KV4610DTPJJR5E5JJN7P235D.
#
# Records a single skill.invoke telemetry event via the captureSkillInvoke CLI
# seam. FAIL-SOFT BY CONTRACT: this hook must NEVER block a skill call, so it
# swallows every error and always exits 0. A telemetry hiccup is invisible to
# the operator's work.
#
# Claude Code pipes the PreToolUse payload (JSON) to this hook on stdin and
# exposes the plugin root as CLAUDE_PLUGIN_ROOT.

PAYLOAD="$(cat 2>/dev/null)"
CLI="${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/cli.js"

if [ -n "$PAYLOAD" ] && [ -f "$CLI" ]; then
  node "$CLI" captureSkillInvoke --json "$PAYLOAD" >/dev/null 2>&1 || true
fi

exit 0
