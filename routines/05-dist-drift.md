---
name: dist-drift
cron: "0 23 * * *"         # 09:00 Sydney daily (23:00 UTC prev day)
label: dist-drift
enabled: true
model: claude-sonnet-4-6
---

# dist/src drift guard

Catches the exact CI failure CLAUDE.md warns about: someone edits
`plugins/flow/mcp-server/src/` and forgets to rebuild and commit
`plugins/flow/mcp-server/dist/`. CI catches it too, but this routine
catches it overnight so it doesn't block a teammate's PR.

---

## Prompt

You are running as a scheduled remote agent against the
`jackmcintyre/crew` repository. The repo is already cloned. You have
read access, `git`, `pnpm`, `node`, and tools to read and write GitHub
(issues, labels). Use whichever GitHub-write mechanism is available in
your environment.

## Task

Build the MCP server and verify that the committed `dist/` matches the
build output exactly. Report if they drift.

## Steps

1. **Install dependencies.** From `plugins/flow/` (the pnpm workspace
   root — there is no workspace at the repo root), run
   `pnpm install --frozen-lockfile`. If install fails, **open an issue**
   noting the failure — don't try to recover.

2. **Capture the committed `dist/`.** Copy
   `plugins/flow/mcp-server/dist/` to `/tmp/dist-committed/` so you can
   diff against it after rebuilding.

3. **Build.** From `plugins/flow/`, run
   `pnpm --filter @flow/mcp-server build`. If the build fails, **open
   an issue** with the build output and stop here.

4. **Diff.** Compare the freshly built `plugins/flow/mcp-server/dist/`
   against `/tmp/dist-committed/`. Use `diff -r` for a recursive diff.
   Ignore timestamp-only or source-map-only differences if they are
   obviously not content changes (e.g., line numbers in `.js.map` files
   that match line-for-line otherwise).

5. **Decide whether to report.**
   - If the diff is empty (or only consists of stable, irrelevant
     differences as above), **exit silently — no issue**.
   - If there is real drift, proceed.

6. **Open the issue.** Create a GitHub issue with:
   - **Title:** `dist drift — YYYY-MM-DD`
   - **Label:** `dist-drift` (if the label doesn't exist, create it
     with colour `D93F0B` and description "Committed dist/ does not
     match a fresh build").
   - **Body:** see structure below.

## Issue body structure

```
## Drift detected

**Last commit touching `src/`:** <SHA — author — date — title>
**Last commit touching `dist/`:** <SHA — author — date — title>

## Files that differ

<For each file, one bullet: path — added/removed/modified — brief one-line description of the change (e.g., "function `foo` body changed", "new export `bar`").>

## Diff summary

```diff
<First 200 lines of diff. If the full diff is larger, truncate and note the line count.>
```

## To fix locally

```bash
cd plugins/flow
pnpm install --frozen-lockfile
pnpm --filter @flow/mcp-server build
cd ../..
git add plugins/flow/mcp-server/dist
git commit -m "chore: rebuild mcp-server dist"
```
```

## Important

- **No commits, no PRs.** Even though the fix is to commit a rebuilt
  `dist/`, this routine does *not* do that. A human reviews the
  surface area of the change and commits it themselves.
- **If `pnpm install` or the build fails,** that *is* a finding — open
  an issue noting the failure, with output. Don't exit silently in that
  case.
