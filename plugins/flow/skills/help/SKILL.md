---
name: flow:help
description: Context-aware next-action advisor — tells you the single most useful thing to do right now, grounded in the live state of your project.
allowed_tools: [getHelpAdvice]
version: 0.1.0
---

# /flow:help

# What this skill does

Reads the live state of your project and tells you the **single best next action** to take right now — which command to run and why.

This is not a command reference. It does not list every available command. It reads what is actually happening in your project (whether a team is hired, what is in the backlog, what is currently building) and points you at the one thing that will move your project forward most effectively at this moment.

# Prerequisites

A target repo. The skill works on a fresh repo before any `.flow/config.yaml` exists — it falls back gracefully when the backlog is unreadable and focuses on the team-presence check.

# Steps

1. Identify the target repo root (the current Claude Code workspace root) as `targetRepoRoot`.
2. Call `getHelpAdvice({ targetRepoRoot })`.
3. Print the tool's text response **verbatim** — the tool already returns fully rendered, plain-language text. Do not paraphrase, summarise, or add commentary.

# Failure modes

- **No `.flow/state/` directory:** the backlog read returns zero items; the advisor still runs and may recommend `/flow:hire` (if no team) or `/flow:plan` (if no backlog). Not an error.
- **No team directory:** `getHelpAdvice` returns the `no-team` situation pointing to `/flow:hire`. Not an error.
- **Malformed backlog manifest:** `getHelpAdvice` propagates `MalformedExecutionManifestError` as a tool error — print the error message verbatim and stop.
