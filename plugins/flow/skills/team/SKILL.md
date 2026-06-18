---
name: flow:team
description: Print a one-shot snapshot of your hired team — roles, domains, recent knowledge entries, fire counts.
allowed_tools: [Read]
user_invocable: false
---

# /flow:team

# What this skill does

Calls the `getTeamSnapshot` MCP tool and prints a deterministic text snapshot of every hired role under `{target-repo}/team/`. For each role the snapshot shows: the role id, its domain (from the persona frontmatter), how many times it has been invoked (`fire count` from `.flow/telemetry/*.jsonl`), and the most recent knowledge entries (default: last 3, in reverse file order so the most recently appended entry appears first).

There is **no LLM in the loop** — the snapshot is computed via pure file reads and JSONL aggregation. The response is instant regardless of team size, and running `/flow:team` does not consume any tokens beyond the skill invocation itself (NFR28).

If your team is not yet hired, run `/flow:hire` to go through the full hiring conversation with the hiring-manager agent, or `/flow:skip-hiring` to instantly materialise the default five-role roster without a conversation.

# Prerequisites

A target repo with at least one hired role under `{target-repo}/team/{role}/PERSONA.md` (created by `/flow:hire` or `/flow:skip-hiring`). `.flow/config.yaml` is NOT required — the adapter is not consulted by this skill.

# Steps

1. Identify the target repo root (the current Claude Code workspace root) as `targetRepoRoot`. Do NOT call `getStatus` — adapter resolution is not needed.
2. Call the `getTeamSnapshot` MCP tool with `{ targetRepoRoot, knowledgeLimit: 3 }`.
3. Print the tool's text response verbatim. It is already the fully rendered snapshot produced by `renderTeamSnapshot`. No post-processing, no reformatting, no explanation prefix.

# Failure modes

- **No `team/` directory:** the snapshot renders the empty-state block — `flow team — 0 role(s)` followed by a cross-reference to `/flow:hire` and `/flow:skip-hiring`. This is not an error; run one of those skills to create the team.
- **A single persona file is malformed:** the per-role stanza prints `  error: {message}` and the snapshot continues for the remaining roles. The persona file is plain Markdown (NFR25); open `{target-repo}/team/{role}/PERSONA.md` directly and fix the malformation. `git revert {persona-path}` is the bail-out if you're unsure what changed.
- **Telemetry contains malformed lines:** the snapshot renders normally and a final annotation line surfaces the malformed-line count, e.g. `(2 malformed telemetry line(s) skipped across 1 file(s))`. Inspect `{target-repo}/.flow/telemetry/{YYYY-MM}.jsonl` directly — the malformed lines are typically the most recent (a writer crash mid-line); `tail -n 50` usually locates them.
- **`getTeamSnapshot` throws on a non-malformation error:** propagated by the MCP transport as a tool error. This is a programming bug; surface the error verbatim.
