# Pre-dogfood hygiene checklist

Run this checklist before promoting `dev → main` ahead of a dogfood resumption attempt. It exists because the 2026-05-25 rollback was preceded by latent state drift that nobody noticed until things broke under load.

## Invariants verified at promotion time

Run each command from the repo root. Every line should return the empty / "no match" state shown.

```bash
# 1. Working tree clean on dev (or current trunk)
git status --short
#   expected: no output
```

```bash
# 2. No stale ship-story worktrees
git worktree list | grep -v "^$(pwd)\s"
#   expected: no output (only the main repo worktree should be listed)
```

```bash
# 3. No leftover story branches local
git branch | grep "story/" || echo "ok"
#   expected: ok
```

```bash
# 4. No leftover story branches remote
git branch -r | grep "story/" || echo "ok"
#   expected: ok
```

```bash
# 5. No stale stashes
git stash list
#   expected: no output (drop or land any leftover stashes before promotion)
```

```bash
# 6. Runtime state directory empty
find .flow/state -mindepth 1 2>/dev/null || echo "ok"
#   expected: ok (or .flow/state does not exist — also fine)
```

```bash
# 7. Pending ship-story cleanups drained
python3 .claude/skills/ship-story/scripts/ship.py pending-cleanup
#   expected: {"pending": []}
```

## Promotion procedure

After all seven invariants pass:

```bash
# Fast-forward dev → main locally
git checkout main
git pull --ff-only origin main
git merge --ff-only dev
git push origin main

# Tag the promotion commit
git tag pre-dogfood-resumption-N  # bump N per attempt
git push origin pre-dogfood-resumption-N

# Switch back to dev for ongoing work
git checkout dev
```

`--ff-only` on both `pull` and `merge` is load-bearing — it refuses to create a merge commit, ensuring `main` is exactly the dev tip. Per memory `feedback_never_commit_to_local_main`, this is the only way `main` should ever change locally.

## Branch protection re-enable

`main` is protected by **repository ruleset 16642015**, not classic branch protection. The classic-protection endpoint (`gh api repos/{owner}/{repo}/branches/main/protection`) returns 404 on this repo; querying the wrong API is a recurring confusion point per memory `project_main_protection_via_ruleset`. Always use the ruleset endpoint.

The promotion procedure above (Phase E) requires a one-shot relax of the ruleset's `pull_request` rule for the direct push, then re-enable. Pattern:

```bash
# 1. Snapshot the current ruleset (always do this first — gives you the body to PUT back).
gh api repos/{owner}/{repo}/rulesets/16642015 > /tmp/ruleset-16642015.json

# 2. To relax for the promotion push: edit the snapshot, remove or temporarily
#    weaken the `pull_request` rule entry, then PUT it back:
gh api -X PUT repos/{owner}/{repo}/rulesets/16642015 \
  --input /tmp/ruleset-16642015-relaxed.json

# 3. Do the ff-only `dev → main` promotion (Phase E steps).

# 4. Re-enable by PUTting the original snapshot back:
gh api -X PUT repos/{owner}/{repo}/rulesets/16642015 \
  --input /tmp/ruleset-16642015.json
```

Or toggle via the GitHub web UI: **Settings → Rules → Rulesets → ruleset 16642015 → edit `pull_request` rule → save, push, restore, save**.

### Load-bearing rules

Two ruleset entries must persist across every promotion:

- **`non_fast_forward`** — blocks force pushes. This is what stopped the 2026-05-25 rollback from going further wrong (memory `project_branch_protection_load_bearing`). Never disable without immediate re-enable.
- **`pull_request`** — enforces PR-mediated merges as the normal path. Relax for the documented `dev → main` ff-promotion only; re-enable immediately after.

Other ruleset entries (status-check requirements, etc.) are conventional and can be toggled per project policy without the same blast radius.

## When this checklist should run

- Before every dogfood attempt (the obvious case).
- After any incident that touches branch state or git history (force-push, history rewrite, mass branch cleanup).
- On a cadence (e.g. weekly) if dogfood is paused for an extended period.

