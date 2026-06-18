---
name: flow:review-inbox
description: "Review the stored maintainer-feedback inbox — list each filed item and get a ready-to-file GitHub issue link for any you choose to act on."
allowed_tools: [reviewMaintainerInbox]
version: 0.1.0
---

# /flow:review-inbox

# What this skill does

This is the **after-the-fact review surface** for feedback the team filed into the maintainer inbox while you were away. When the team runs unattended, any role that hits a structural limitation of the tool calls `recordMaintainerFeedback`, which accumulates items under `.flow/maintainer-inbox/`. This skill lets you look over those stored items on demand and convert any one you choose into a pre-filled GitHub issue you open and submit yourself — nothing is ever filed automatically.

Each listed item includes:
- **What the problem is** — the structural limitation the team hit.
- **Which tool area it concerns** — the specific part of the tool.
- **What triggered it** — which role or story surfaced it.
- **A suggested direction** (when the team recorded one) — how to fix or improve.
- **A ready-to-file GitHub issue link** — a plain web URL that opens GitHub's new-issue form with title and body already filled from the item's details. You review and submit yourself; nothing is created automatically.

When the inbox is empty, you are told plainly that there is nothing waiting — no broken or blank link is produced.

# Prerequisites

A target repo with `.flow/config.yaml` resolved. An empty inbox renders cleanly as a "nothing waiting" message — it is not an error. `gh` authentication is not required to use this skill; it is only used to resolve the repo owner/name for the pre-filled links. If `gh` is unavailable, items are still listed without links.

# Steps

1. Identify the target repo root (the current Claude Code workspace root) as `targetRepoRoot`.
2. Call the `reviewMaintainerInbox` MCP tool with `{ targetRepoRoot }`.
3. If the result has `emptyInbox: true`, print verbatim:
   ```
   Maintainer inbox is empty — no feedback items are waiting.
   ```
   and exit.
4. Otherwise, for each item in `result.items`, print a block in this format (substituting values):
   ```
   [<index>] Tool area: <tool_area>
   Problem: <problem>
   Trigger: <trigger>
   Suggested direction: <suggested_direction>   ← omit this line if absent
   Issue link: <issueUrl>                        ← omit this line if absent (gh unavailable)
   ```
5. After listing all items, print:
   ```
   To file one of these issues, open its link in your browser, review the pre-filled title and body, and submit. Nothing is created automatically.
   ```

Never write to a manifest file, never edit `.flow/state/**`, and never run a `gh` command directly. Your job is to call the read tool and present its output.

# Failure modes

- **Inbox is empty:** the tool returns `emptyInbox: true`; print the empty-state message from Step 3 and exit.
- **`gh` unavailable or not authenticated:** items are still listed from the inbox, but without issue links. The operator can resolve the repo identity manually if needed.
- **Malformed inbox files:** the tool skips them and reports them in `malformedCount`. If `malformedCount > 0`, note this to the operator: `Note: <malformedCount> inbox file(s) could not be parsed and were skipped.`
- **No `.flow/config.yaml`:** the underlying workspace resolution surfaces the resolver's typed error verbatim — resolve the target repo (run `/flow:dashboard` to check) and retry.
