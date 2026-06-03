---
name: docs-freshness
cron: "0 0 * * 1"          # 10:00 Sydney Monday (Monday 00:00 UTC)
label: docs-freshness
enabled: true
model: claude-sonnet-4-6
---

# Docs freshness scan

Walks CLAUDE.md, READMEs, install guides, and other top-level docs.
Flags references that have rotted: file paths that no longer exist,
commands or flags that don't match current code, and "TODO" / "not yet"
/ "coming soon" claims that are now false.

This routine exists because doc rot in CLAUDE.md actively misleads
Claude in every future session — silent, invisible, compounding.

---

## Prompt

You are running as a scheduled remote agent against the
`jackmcintyre/crew` repository. The repo is already cloned. You have
read access, `git`, and tools to read and write GitHub (issues, PRs,
labels). Use whichever GitHub-write mechanism is available in your
environment.

## Task

Identify stale claims in the project's top-level documentation. Report
only **specific, evidenced** staleness — not opinions about what the
docs *should* say.

## Steps

1. **Gather the docs to scan.** Read:
   - `CLAUDE.md` (top-level)
   - `README.md` (top-level)
   - Every `*.md` file under `plugins/flow/` (recursive), including
     `plugins/flow/docs/` and any subdirectories such as
     `plugins/flow/docs/spikes/`.
   - `routines/README.md` and every file under `routines/`.

   If a path above doesn't exist, just skip it. Skip `node_modules/`,
   `dist/`, and any `.claude/skills/bmad-*/` content.

2. **For each doc, extract claims that are checkable.** Specifically:
   - **Path references.** Any string that looks like a file or directory
     path (`plugins/flow/...`, `_bmad-output/...`, `docs/standards.md`,
     etc.). Check `git ls-files` or filesystem to confirm it exists.
   - **Command / flag references.** Any `command --flag` or
     `/skill-name` reference. For shell commands, sanity-check by
     reading the relevant source. For skills, check the file exists
     under `.claude/skills/` or in the plugin's skills directory.
   - **State claims.** Statements like "X is gitignored," "Y is tracked
     in git," "the plugin doesn't yet exist," "Z is committed." Verify
     against `.gitignore`, `git ls-files`, and the repo state.
   - **"Not yet" / "TODO" / "coming soon" / "will be" claims.** If the
     thing referenced now exists, the claim is stale.

3. **Check each claim.** Use file-existence checks, `grep`, and `git`
   commands. Be conservative: only flag something as stale if you have
   concrete evidence (the file isn't there, the flag isn't in the
   parser, the gitignore says otherwise). If you're unsure, don't flag.

4. **Decide whether to report.** If every claim checks out, **exit
   silently — no issue**. Otherwise, proceed.

5. **Open the issue.** Create a GitHub issue with:
   - **Title:** `Docs freshness — YYYY-MM-DD`
   - **Label:** `docs-freshness` (if the label doesn't exist, create
     it with colour `5319E7` and description "Stale claims in project
     documentation").
   - **Body:** see structure below.

## Issue body structure

```
## Stale claims found

### <docfile path>:<line number>

> <quoted claim from the doc>

**Issue:** <what's wrong, in one sentence>
**Evidence:** <the check you ran and its result — e.g., `git ls-files | grep X` returned nothing; or `.gitignore:9` says otherwise>
**Suggested fix:** <one-line suggestion, or "remove the claim" / "update the path">

<Repeat for each stale claim. Group by file.>
```

## Important

- **Specific over comprehensive.** Better to flag 3 confirmed stale
  claims than 15 maybe-stale ones. Confidence matters.
- **No style edits.** If a path is correct and a command works, don't
  flag it because the prose is awkward. This is a *correctness* check,
  not a copy-edit.
- **Skip auto-generated or installed files.** Don't audit
  `.claude/skills/bmad-*` content, `node_modules`, `dist/` outputs.
- **Read-only on the codebase.** No commits, no PRs, no branch changes.
  Issue creation is the only write.
