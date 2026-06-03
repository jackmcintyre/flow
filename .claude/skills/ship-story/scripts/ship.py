#!/usr/bin/env python3
"""ship-story plumbing.

Deterministic helpers so the SKILL.md orchestrator only handles judgment work.
Every subcommand exits non-zero on failure with a human-readable message on stderr
and emits structured JSON on stdout when it has a result the orchestrator needs to parse.

Subcommands:
  preflight                       sanity-check the environment before a run
  resolve [story_id]              pick story, extract ACs, return JSON, persist
                                  it to /tmp/ship-<key>.resolve.json
  worktree <story_key>            create worktree + branch off the configured
                                  default_base (default: main). Reads
                                  <repo>/.claude/skills/ship-story/config.yaml.
  set-status <key> <status>       atomic mutation of sprint-status.yaml
  verify-ac-table <results.json>  hard gate: fail if any AC row not green
  pre-pr-gate <story_key>         pre-PR smoke gate for user-surface ACs;
                                  exits 42 (USER_SURFACE_UNVERIFIED) if any
                                  user-surface AC lacks valid verification
                                  evidence in the run log.
  pr-body <story_key> <results.json> <review_passes>   emit markdown PR body
  record <story_key> <event>      append JSONL event to run log (resumability)
  record-verification <story_key> --type ... --data ...
                                  schema-validated wrapper over `record` for
                                  automated_e2e_verified / user_surface_verified
                                  events.
  state <story_key> [--get STEP]  read run state for resume
  cleanup <story_key>             post-merge: status→done, remove worktree,
                                  delete branch, sync default_base, tidy /tmp
  pending-cleanup                 list stories with pr_opened but no cleaned
  reviewer-issues <story_key>     render reviewer-flagged issues (from
                                  review_pass events' data.issues) as a
                                  markdown bullet list for Step 11 summary
  review-budget <spec_path>       return the review-pass budget for a story
                                  based on story_shape tag (substrate=3,
                                  user-surface=5)
  default-base                    print the resolved default_base to stdout
                                  (for shell substitution in gh pr create)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.stderr.write(
        "ERROR: PyYAML required. Install: python3 -m pip install --user pyyaml\n"
    )
    sys.exit(2)

# scripts/ship.py → ship-story/scripts/ship.py → ship-story/ → skills/ → .claude/ → repo
_RAW_REPO = Path(__file__).resolve().parents[4]


def _canonical_repo(p: Path) -> Path:
    # Worktrees check out their branch under <repo>/.worktrees/<key>/ and
    # therefore carry a copy of this script at the same relative path. When
    # ship.py is invoked via a relative path from inside a worktree,
    # Path(__file__).resolve() points at the worktree's copy, and run-log
    # writes land in <worktree>/.claude/skills/ship-story/.runs/ instead of
    # the canonical .runs/ — breaking pending-cleanup, the pre-PR gate, and
    # any other reader of the run log. Walk up to the ancestor above
    # .worktrees so REPO is invocation-path-agnostic. See PR #94 retro.
    parts = p.parts
    if ".worktrees" in parts:
        idx = parts.index(".worktrees")
        return Path(*parts[:idx])
    return p


REPO = _canonical_repo(_RAW_REPO)
STATUS_FILE = REPO / "_bmad-output/implementation-artifacts/sprint-status.yaml"
EPICS_DIR = REPO / "_bmad-output/planning-artifacts/epics"
# Tests override the runs dir via CREW_SHIP_RUNS_DIR. Resolved at call time
# (not module load) so the env var is robust to import order and to tests
# that set it after import.
_DEFAULT_RUNS_DIR = REPO / ".claude/skills/ship-story/.runs"


def runs_dir() -> Path:
    return Path(os.environ.get("CREW_SHIP_RUNS_DIR", str(_DEFAULT_RUNS_DIR)))


# ---------------------------------------------------------------- config helpers


def resolve_default_base() -> str:
    """Return the configured default_base trunk name.

    Reads <repo>/.claude/skills/ship-story/config.yaml.  Falls back to
    ``"main"`` when (i) the config file doesn't exist, (ii) the file isn't a
    YAML mapping, (iii) the mapping lacks a ``default_base`` key, or (iv)
    the value is not a non-empty string.  In the malformed-value case a
    one-line warning is written to stderr so the operator can diagnose.

    This function is intentionally pure (no side effects) and deterministic
    by REPO; each caller re-reads the config so there is no stale-cache risk.
    """
    config_path = REPO / ".claude" / "skills" / "ship-story" / "config.yaml"
    if not config_path.exists():
        return "main"
    try:
        raw = yaml.safe_load(config_path.read_text())
    except yaml.YAMLError:
        sys.stderr.write(
            f"ship.py: malformed config at {config_path}; falling back to main\n"
        )
        return "main"
    if not isinstance(raw, dict):
        sys.stderr.write(
            f"ship.py: malformed config at {config_path}; falling back to main\n"
        )
        return "main"
    base = raw.get("default_base")
    if not isinstance(base, str) or not base.strip():
        if "default_base" in raw:
            sys.stderr.write(
                f"ship.py: malformed config at {config_path}; falling back to main\n"
            )
        return "main"
    return base


def _cwd_sanity_check() -> None:
    """Refuse to run if cwd is inside a `.worktrees/` checkout.

    `_canonical_repo` already strips `.worktrees/<key>` from REPO so writes
    land in the right place, but the orchestrator's Bash cwd persisting
    inside a worktree means subsequent shell commands (gh, git push, manual
    file edits) target the wrong tree. Hard-fail here forces the operator
    to `cd` back to the main repo before proceeding. (Epic 3 retro,
    2026-05-21 — bit Stories 3.4 and 3.6.)

    Tests can opt out via CREW_SHIP_SKIP_CWD_CHECK=1.
    """
    if os.environ.get("CREW_SHIP_SKIP_CWD_CHECK") == "1":
        return
    cwd = Path.cwd().resolve()
    if ".worktrees" in cwd.parts:
        sys.stderr.write(
            f"ship.py: cwd is inside .worktrees/ ({cwd}). "
            f"Run from the main repo root ({REPO}) instead. "
            f"See Epic 3 retro for context.\n"
        )
        sys.exit(2)

# Exit code mnemonic for the pre-PR user-surface gate.
EXIT_USER_SURFACE_UNVERIFIED = 42

# Review-pass budget by story shape (Epic 2 retro: user-surface stories need
# more review cycles because LLM-driven output is non-deterministic and
# stub-vs-real gaps are harder to catch statically).
REVIEW_PASS_BUDGET: dict[str, int] = {
    "substrate": 3,
    "user-surface": 5,
}
_DEFAULT_STORY_SHAPE = "substrate"

_STORY_SHAPE_RE = re.compile(r"^story_shape:\s*(substrate|user-surface)\s*$", re.MULTILINE)

# AC tag extraction regex for the user-surface gate.
USER_SURFACE_AC_RE = re.compile(
    r"^\*\*AC(\d+)\s*\(user-surface\)\s*:\*\*", re.MULTILINE
)

# Verification event types known to the schema validator.
_VERIFICATION_EVENT_TYPES = {"automated_e2e_verified", "user_surface_verified"}


class MalformedVerificationEvent(ValueError):
    """Raised when an *_verified event payload fails its expected shape."""


# ---------------------------------------------------------------- helpers


def read_story_shape(spec_path: Path) -> str:
    """Return 'substrate' or 'user-surface' from a spec's story_shape tag.

    The tag must appear as a standalone line immediately after the title:
      story_shape: user-surface

    Defaults to 'substrate' if missing or spec does not exist.
    """
    if not spec_path.exists():
        return _DEFAULT_STORY_SHAPE
    m = _STORY_SHAPE_RE.search(spec_path.read_text())
    return m.group(1) if m else _DEFAULT_STORY_SHAPE


def review_pass_budget(spec_path: Path) -> int:
    """Return the max review passes for the story at spec_path."""
    shape = read_story_shape(spec_path)
    return REVIEW_PASS_BUDGET.get(shape, REVIEW_PASS_BUDGET[_DEFAULT_STORY_SHAPE])


def die(msg: str, code: int = 1) -> None:
    sys.stderr.write(f"ERROR: {msg}\n")
    sys.exit(code)


def load_status() -> dict:
    if not STATUS_FILE.exists():
        die(f"sprint-status.yaml not found at {STATUS_FILE}")
    return yaml.safe_load(STATUS_FILE.read_text())


def _set_status_value(target: Path, key: str, old: str, new: str) -> None:
    """Flip ``<key>: <old>`` to ``<key>: <new>`` in a sprint-status YAML file
    and bump ``last_updated``, preserving every comment and all formatting.

    PyYAML's load/dump round-trip silently strips inline ``# ...`` comments, and
    sprint-status.yaml carries load-bearing rationale comments (rescope/sequence
    notes). So rather than re-serialise the parsed document, rewrite only the
    single status line (and the last_updated scalar) via anchored regex
    substitutions on the raw text. Atomic: tmp file then rename.
    """
    raw = target.read_text()

    status_pat = re.compile(
        r"^(?P<pre>[ \t]*" + re.escape(key) + r":[ \t]+)"
        + re.escape(old)
        + r"(?P<post>[ \t]*(?:#.*)?)$",
        re.MULTILINE,
    )
    raw, n = status_pat.subn(lambda m: m.group("pre") + new + m.group("post"), raw)
    if n != 1:
        die(f"set-status: expected exactly one '{key}: {old}' line, found {n}")

    today = dt.date.today().isoformat()
    raw, _ = re.subn(
        r"^last_updated:[ \t]*.*$", f"last_updated: '{today}'", raw,
        count=1, flags=re.MULTILINE,
    )

    tmp = target.with_suffix(".yaml.tmp")
    tmp.write_text(raw)
    tmp.replace(target)


def story_keys(dev_status: dict) -> list[str]:
    return [
        k for k in dev_status
        if not k.startswith("epic-") and "retrospective" not in k
    ]


def run_log(story_key: str) -> Path:
    rd = runs_dir()
    rd.mkdir(parents=True, exist_ok=True)
    return rd / f"{story_key}.jsonl"


# ---------------------------------------------------------------- preflight


def cmd_preflight(_args) -> None:
    issues: list[str] = []

    if not STATUS_FILE.exists():
        issues.append(f"sprint-status.yaml missing: {STATUS_FILE}")
    if not EPICS_DIR.exists():
        issues.append(f"epics dir missing: {EPICS_DIR}")

    rc = subprocess.run(
        ["git", "status", "--porcelain"], cwd=REPO, capture_output=True, text=True
    )
    if rc.returncode != 0:
        issues.append("git status failed — is this a repo?")
    elif rc.stdout.strip():
        issues.append("working tree is dirty — commit or stash before shipping")

    rc = subprocess.run(["gh", "auth", "status"], capture_output=True)
    if rc.returncode != 0:
        issues.append("gh CLI not authenticated — run `gh auth login`")

    if issues:
        for i in issues:
            sys.stderr.write(f"- {i}\n")
        die(f"{len(issues)} preflight issue(s)")
    print(json.dumps({"preflight": "ok"}))


# ---------------------------------------------------------------- resolve


_AC_HEADING_RE = re.compile(
    r"\*{0,2}Acceptance Criteria[\s:\*]*\n+", re.IGNORECASE
)


def extract_acs(story_body: str) -> list[str]:
    """Pull AC blocks out of a story section.

    Stories in this repo use Given/When/Then paragraph blocks separated by blank
    lines, sometimes with explicit `**ACN:**` labels. We split on blank lines and
    flatten each block to a single line for table-friendly rendering.
    """
    m = _AC_HEADING_RE.search(story_body)
    if not m:
        return []
    tail = story_body[m.end():]
    blocks = re.split(r"\n\s*\n", tail.strip())
    acs: list[str] = []
    for block in blocks:
        flat = " ".join(line.strip() for line in block.splitlines() if line.strip())
        if not flat:
            continue
        # Stop at any heading line that slipped through (defence-in-depth)
        if flat.startswith("#"):
            break
        acs.append(flat)
    return acs


def pick_story(dev_status: dict, story_id: str | None) -> str:
    if story_id:
        for key in story_keys(dev_status):
            if key == story_id or key.startswith(story_id + "-"):
                return key
        die(f"No story matching '{story_id}'")

    in_progress_epics = {
        k.split("-")[1]
        for k, v in dev_status.items()
        if re.fullmatch(r"epic-\d+", k) and v == "in-progress"
    }

    candidates = [k for k in story_keys(dev_status) if dev_status[k] == "backlog"]
    if not candidates:
        die("no backlog stories remaining")

    if in_progress_epics:
        for key in candidates:
            if key.split("-", 1)[0] in in_progress_epics:
                return key
    return candidates[0]


def cmd_resolve(args) -> None:
    status = load_status()
    dev = status["development_status"]
    story_key = pick_story(dev, args.story_id)

    parts = story_key.split("-")
    epic_num, story_num = parts[0], parts[1]
    story_short = f"{epic_num}.{story_num}"

    epic_files = list(EPICS_DIR.glob(f"epic-{epic_num}-*.md"))
    if not epic_files:
        die(f"no epic file for epic {epic_num}")
    epic_file = epic_files[0]

    text = epic_file.read_text()
    # Sharded epics use `## Story X.Y:`; the original monolithic epics.md used `###`.
    pattern = re.compile(
        rf"^#{{2,3}} Story {re.escape(story_short)}:\s*(.+?)$(.*?)(?=^#{{2,3}} Story |\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(text)
    if not m:
        die(f"story '{story_short}' not found in {epic_file.name}")
    title = m.group(1).strip()
    body = m.group(2)
    acs = extract_acs(body)

    if not acs:
        die(
            f"no acceptance criteria found for story {story_short} in {epic_file.name}"
        )

    payload = {
        "story_key": story_key,
        "story_short": story_short,
        "epic_num": epic_num,
        "title": title,
        "current_status": dev[story_key],
        "epic_file": str(epic_file.relative_to(REPO)),
        "acceptance_criteria": acs,
        "spec_path": f"_bmad-output/implementation-artifacts/{story_key}.md",
    }
    resolve_json_path = Path(f"/tmp/ship-{story_key}.resolve.json")
    resolve_json_path.write_text(json.dumps(payload, indent=2))
    payload["resolve_json_path"] = str(resolve_json_path)
    print(json.dumps(payload, indent=2))


# ---------------------------------------------------------------- worktree


def _plugin_dir_hint(checkout_root: Path) -> dict:
    """Tell the operator how to load this checkout's plugin into Claude Code.

    Story 1.11 shipped a `pnpm dev:install` script that symlinks the worktree's
    `plugins/flow/` into `~/.claude/plugins/cache/`. In practice that symlink
    fights Claude Code's plugin healer — the healer expects a directory-copy
    install, sees the symlink as corruption, and wipes the cache entry on
    startup. Epic 3 retro (2026-05-21) replaced the symlink approach with
    Anthropic's blessed dev workflow: `claude --plugin-dir <path>`, which
    loads the plugin for the session and survives restarts.
    """
    plugin_path = checkout_root / "plugins" / "flow"
    return {
        "invocation": f"claude --plugin-dir {plugin_path}",
        "plugin_dir": str(plugin_path),
    }


def cmd_worktree(args) -> None:
    """Create a story worktree forked from the configured default_base.

    The trunk branch is resolved from <repo>/.claude/skills/ship-story/config.yaml
    (``default_base`` key).  Falls back to ``origin/main`` for green-field repos
    with no config file.
    """
    base = resolve_default_base()
    worktrees_dir = REPO / ".worktrees"
    worktrees_dir.mkdir(parents=True, exist_ok=True)
    worktree = worktrees_dir / args.story_key
    branch = f"story/{args.story_key}"

    if worktree.exists():
        die(f"worktree path already exists: {worktree}")

    rc = subprocess.run(
        ["git", "rev-parse", "--verify", branch],
        cwd=REPO, capture_output=True,
    )
    if rc.returncode == 0:
        die(f"branch '{branch}' already exists — clean up before retry")

    subprocess.check_call(["git", "fetch", "origin", base], cwd=REPO)
    subprocess.check_call(
        ["git", "worktree", "add", str(worktree), "-b", branch, f"origin/{base}"],
        cwd=REPO,
    )
    plugin_dir = _plugin_dir_hint(worktree)
    print(json.dumps({"worktree": str(worktree), "branch": branch, "base": base, "plugin_dir": plugin_dir}))


# ---------------------------------------------------------------- status


_ALLOWED_STATUSES = {
    "backlog", "ready-for-dev", "in-progress", "review", "done",
    "optional",  # retrospectives
    "in-progress",  # epics
}


def cmd_set_status(args) -> None:
    if args.new_status not in _ALLOWED_STATUSES:
        die(f"illegal status '{args.new_status}'")
    target = STATUS_FILE
    if getattr(args, "worktree", None):
        wt = Path(args.worktree)
        if not wt.exists():
            die(f"worktree path does not exist: {wt}")
        target = wt / "_bmad-output/implementation-artifacts/sprint-status.yaml"
        if not target.exists():
            die(f"sprint-status.yaml not found in worktree: {target}")
    data = yaml.safe_load(target.read_text())
    if args.key not in data["development_status"]:
        die(f"unknown key '{args.key}'")
    old = data["development_status"][args.key]
    if old == args.new_status:
        print(json.dumps({
            "key": args.key, "from": old, "to": args.new_status,
            "noop": True, "target": str(target),
        }))
        return
    _set_status_value(target, args.key, old, args.new_status)
    print(json.dumps({
        "key": args.key, "from": old, "to": args.new_status,
        "target": str(target),
    }))


# ---------------------------------------------------------------- AC gate


def cmd_verify_ac_table(args) -> None:
    """Hard gate. results.json: [{ac, test, result, evidence}, ...]"""
    data = json.loads(Path(args.results).read_text())
    if not isinstance(data, list) or not data:
        die("AC results must be a non-empty list")

    failed = [
        r for r in data
        if str(r.get("result", "")).strip().lower() not in {"pass", "green", "ok"}
    ]
    if failed:
        sys.stderr.write(f"FAIL: {len(failed)}/{len(data)} ACs not green\n")
        for r in failed:
            sys.stderr.write(f"  - {r.get('ac')!r}: {r.get('result')}\n")
        sys.exit(1)
    print(json.dumps({"passed": len(data)}))


# ---------------------------------------------------------------- PR body


def cmd_pr_body(args) -> None:
    info = json.loads(Path(args.resolve_json).read_text())
    results = json.loads(Path(args.results).read_text())

    # Resolve budget for the story shape so the PR body reflects the correct cap.
    spec_path = REPO / info.get("spec_path", f"_bmad-output/implementation-artifacts/{info['story_key']}.md")
    budget = review_pass_budget(spec_path)
    story_shape = read_story_shape(spec_path)

    rows = "\n".join(
        f"| {r.get('ac','').strip()} | {r.get('test','').strip()} | {r.get('result','').strip()} | {r.get('evidence','').strip()} |"
        for r in results
    )

    body = f"""## Summary
Ships story {info['story_short']} — {info['title']}.

## Story
[{info['story_key']}]({info['spec_path']}) (from {info['epic_file']})

## Acceptance Criteria Verification

| AC | Test(s) | Result | Evidence |
|----|---------|--------|----------|
{rows}

## Reviewer
Approved by `bmad-code-review` (pass {args.review_passes} of {budget}, story_shape: {story_shape})

🤖 Shipped via `/ship-story`
"""
    print(body)


# ---------------------------------------------------------------- run state


def cmd_record(args) -> None:
    payload = {
        "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
        "event": args.event,
    }
    if args.data:
        try:
            payload["data"] = json.loads(args.data)
        except json.JSONDecodeError:
            payload["data"] = args.data
    with run_log(args.story_key).open("a") as f:
        f.write(json.dumps(payload) + "\n")
    print(json.dumps({"recorded": args.event}))


def cmd_state(args) -> None:
    log = run_log(args.story_key)
    if not log.exists():
        print(json.dumps({"events": []}))
        return
    events = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    if args.get:
        match = [e for e in events if e.get("event") == args.get]
        print(json.dumps(match[-1] if match else None))
    else:
        print(json.dumps({"events": events, "last": events[-1] if events else None}))


# ---------------------------------------------------------------- cleanup


# Halt codes (mirrored in SKILL.md):
#   10 NOT_MERGED
#   11 MAIN_NOT_FAST_FORWARD
#   12 WORKTREE_DIRTY


def _find_pr_number(story_key: str) -> int:
    """Try the run log first (data.number), then data.url, then gh pr list."""
    log = run_log(story_key)
    if log.exists():
        for line in reversed(log.read_text().splitlines()):
            if not line.strip():
                continue
            e = json.loads(line)
            if e.get("event") != "pr_opened":
                continue
            d = e.get("data") or {}
            if isinstance(d.get("number"), int):
                return d["number"]
            url = d.get("url", "")
            m = re.search(r"/pull/(\d+)", url)
            if m:
                return int(m.group(1))
            break
    rc = subprocess.run(
        ["gh", "pr", "list", "--head", f"story/{story_key}",
         "--state", "all", "--json", "number", "--limit", "1"],
        cwd=REPO, capture_output=True, text=True,
    )
    if rc.returncode == 0:
        arr = json.loads(rc.stdout or "[]")
        if arr:
            return int(arr[0]["number"])
    die(f"could not locate PR number for story/{story_key}")


def cmd_cleanup(args) -> None:
    key = args.story_key
    base = resolve_default_base()
    pr_number = _find_pr_number(key)

    rc = subprocess.run(
        ["gh", "pr", "view", str(pr_number), "--json", "state,mergedAt,headRefName"],
        cwd=REPO, capture_output=True, text=True,
    )
    if rc.returncode != 0:
        die(f"gh pr view #{pr_number} failed: {rc.stderr.strip()}")
    info = json.loads(rc.stdout)
    if info.get("state") != "MERGED":
        die(
            f"PR #{pr_number} is not merged (state: {info.get('state')}). "
            f"Cleanup refuses to run on unmerged PRs.",
            code=10,
        )

    worktree = REPO / ".worktrees" / key
    branch = f"story/{key}"
    summary: dict = {"pr": pr_number, "mergedAt": info.get("mergedAt")}

    # 1. sync local base branch FIRST (only if currently on the base branch;
    # otherwise just fetch). Under the post-2026-05-24 flow the merged PR
    # carries the `status: done` flip already, so syncing first avoids the
    # redundant local write that would otherwise collide with the incoming
    # ff-merge (the failure mode that surfaced cleaning up PR #122).
    subprocess.check_call(
        ["git", "fetch", "origin", base], cwd=REPO,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    cur = subprocess.check_output(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=REPO, text=True,
    ).strip()
    if cur == base:
        rc = subprocess.run(
            ["git", "merge", "--ff-only", f"origin/{base}"],
            cwd=REPO, capture_output=True, text=True,
        )
        if rc.returncode != 0:
            die(
                f"local {base} is not fast-forwardable from origin/{base} "
                f"(diverged?): {rc.stderr.strip()}",
                code=11,
            )
        summary["main_synced"] = True
    else:
        summary["main_synced"] = f"skipped (HEAD={cur})"

    # 2. status → done (idempotent: under the post-2026-05-24 flow the
    # ff-merge in step 1 already brought the flip in via Step 8's
    # bookkeeping commit, so this is normally a no-op verification. The
    # write branch remains as a safety net for legacy stories shipped
    # before the bookkeeping commit existed, or for stories whose
    # bookkeeping commit was somehow omitted.)
    data = load_status()
    dev = data.get("development_status") or {}
    if key in dev and dev[key] != "done":
        _set_status_value(STATUS_FILE, key, dev[key], "done")
        summary["status"] = "done (written)"
    elif key in dev:
        summary["status"] = "done (already)"
    else:
        summary["status"] = "absent"

    # 3. remove worktree (fails closed if dirty)
    if worktree.exists():
        rc = subprocess.run(
            ["git", "worktree", "remove", str(worktree)],
            cwd=REPO, capture_output=True, text=True,
        )
        if rc.returncode != 0:
            die(
                f"worktree at {worktree} is dirty or in use; resolve manually "
                f"or re-run with --force: {rc.stderr.strip()}",
                code=12,
            )
        summary["worktree_removed"] = str(worktree)
    else:
        summary["worktree_removed"] = "absent"

    # 4. delete local branch (best-effort — fine if already gone)
    rc = subprocess.run(
        ["git", "branch", "-D", branch],
        cwd=REPO, capture_output=True, text=True,
    )
    summary["branch_deleted_local"] = branch if rc.returncode == 0 else f"absent ({branch})"

    # 5. delete remote branch (best-effort — fine if GitHub already cleaned it up)
    rc = subprocess.run(
        ["git", "push", "origin", "--delete", branch],
        cwd=REPO, capture_output=True, text=True,
    )
    if rc.returncode == 0:
        summary["branch_deleted_remote"] = branch
    elif "remote ref does not exist" in (rc.stderr or "").lower():
        summary["branch_deleted_remote"] = f"absent ({branch})"
    else:
        summary["branch_deleted_remote"] = f"failed: {rc.stderr.strip()}"

    # 6. tidy /tmp artefacts
    removed = []
    for suffix in (".resolve.json", ".acs.json", ".body.md", ".retro.md"):
        f = Path(f"/tmp/ship-{key}{suffix}")
        if f.exists():
            f.unlink()
            removed.append(f.name)
    summary["tmp_removed"] = removed

    # 6b. tell the operator how to point Claude Code back at main now that the
    # worktree is gone. See `_plugin_dir_hint` for the rationale on why we no
    # longer auto-mutate `~/.claude/plugins/cache/` (Epic 3 retro, 2026-05-21).
    summary["plugin_dir"] = _plugin_dir_hint(REPO)

    # 7. record event (run log persists — audit trail outlives the worktree)
    log = run_log(key)
    event = {
        "event": "cleaned",
        "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
        "data": {"pr": pr_number, "mergedAt": info.get("mergedAt")},
    }
    with log.open("a") as f:
        f.write(json.dumps(event) + "\n")

    print(json.dumps(summary, indent=2))


def cmd_reconcile(args) -> None:
    """Scan sprint-status for stories in `review`; for each whose PR is merged,
    invoke cleanup. Handles drift from stories merged before ship-story existed
    (no run log) and from manual merges that skipped the cleanup step.
    """
    data = load_status()
    dev = data.get("development_status") or {}
    review_keys = [
        k for k, v in dev.items()
        if v == "review"
        and not k.startswith("epic-")
        and "retrospective" not in k
    ]

    if not review_keys:
        print(json.dumps({"reconciled": [], "skipped": [], "note": "no stories in review"}))
        return

    reconciled: list[dict] = []
    skipped: list[dict] = []
    for key in review_keys:
        # Look up PR via gh fallback path (works even with no run log)
        rc = subprocess.run(
            ["gh", "pr", "list", "--head", f"story/{key}",
             "--state", "all", "--json", "number,state,mergedAt", "--limit", "1"],
            cwd=REPO, capture_output=True, text=True,
        )
        if rc.returncode != 0:
            skipped.append({"key": key, "reason": f"gh failed: {rc.stderr.strip()}"})
            continue
        arr = json.loads(rc.stdout or "[]")
        if not arr:
            skipped.append({"key": key, "reason": "no PR found for branch"})
            continue
        if arr[0].get("state") != "MERGED":
            skipped.append({"key": key, "reason": f"PR #{arr[0]['number']} state={arr[0].get('state')}"})
            continue

        # Invoke our own cleanup as a subprocess so behaviour is identical
        rc = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "cleanup", key],
            cwd=REPO, capture_output=True, text=True,
        )
        if rc.returncode != 0:
            skipped.append({"key": key, "reason": f"cleanup failed: {rc.stderr.strip()}"})
            continue
        try:
            summary = json.loads(rc.stdout)
        except json.JSONDecodeError:
            summary = {"raw": rc.stdout.strip()}
        reconciled.append({"key": key, "summary": summary})

    print(json.dumps({"reconciled": reconciled, "skipped": skipped}, indent=2))


def cmd_reviewer_issues(args) -> None:
    """Emit reviewer-flagged issues recorded across all review passes.

    Reads `review_pass` events from the run log and collects each pass's
    `data.issues` array (orchestrator records this when the reviewer flagged
    items but still approved). Output is a markdown bullet list suitable for
    pasting into the Step 11 summary, or empty string if no issues recorded.
    """
    log = run_log(args.story_key)
    if not log.exists():
        print("")
        return
    flagged: list[dict] = []
    for line in log.read_text().splitlines():
        if not line.strip():
            continue
        e = json.loads(line)
        if e.get("event") != "review_pass":
            continue
        d = e.get("data") or {}
        for issue in d.get("issues") or []:
            row = dict(issue) if isinstance(issue, dict) else {"text": str(issue)}
            row["pass"] = d.get("pass")
            flagged.append(row)
    if not flagged:
        print("")
        return
    lines = []
    for f in flagged:
        sev = f.get("severity", "").strip()
        loc = f.get("location", "").strip()
        desc = f.get("description") or f.get("text") or ""
        prefix = f"[{sev}] " if sev else ""
        loc_part = f" `{loc}` —" if loc else ""
        lines.append(f"- {prefix}{loc_part} {desc}".strip())
    print("\n".join(lines))


def cmd_review_budget(args) -> None:
    """Return the review-pass budget for a story based on its story_shape tag."""
    spec_path = Path(args.spec_path)
    shape = read_story_shape(spec_path)
    budget = REVIEW_PASS_BUDGET.get(shape, REVIEW_PASS_BUDGET[_DEFAULT_STORY_SHAPE])
    print(json.dumps({"spec_path": str(spec_path), "story_shape": shape, "budget": budget}))


def cmd_default_base(_args) -> None:
    """Print the resolved default_base to stdout (for shell substitution)."""
    print(resolve_default_base())


def cmd_pending_cleanup(args) -> None:
    """Stories whose last recorded run event is `pr_opened` (shipped, not yet cleaned)."""
    rd = runs_dir()
    rd.mkdir(parents=True, exist_ok=True)
    pending = []
    for log in sorted(rd.glob("*.jsonl")):
        events = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
        if not events:
            continue
        names = [e["event"] for e in events if "event" in e]
        if "pr_opened" in names and "cleaned" not in names:
            pr_event = next(e for e in reversed(events) if e.get("event") == "pr_opened")
            pending.append({
                "story_key": log.stem,
                "pr_url": (pr_event.get("data") or {}).get("url"),
            })
    print(json.dumps({"pending": pending}, indent=2))


# ---------------------------------------------------------------- pre-pr-gate (user-surface)


def _parse_user_surface_acs(spec_text: str) -> set[int]:
    """Return the set of AC indexes tagged `(user-surface)` in a story spec."""
    return {int(m.group(1)) for m in USER_SURFACE_AC_RE.finditer(spec_text)}


def _validate_verification_event(event: dict) -> None:
    """Raise `MalformedVerificationEvent` if the event payload is malformed.

    Validates only the two `*_verified` event types this gate cares about.
    Other event types pass through (this validator is called by the gate
    only for matching types).
    """
    if not isinstance(event, dict):
        raise MalformedVerificationEvent("event must be a JSON object")
    etype = event.get("type")
    if etype not in _VERIFICATION_EVENT_TYPES:
        raise MalformedVerificationEvent(
            f"unknown verification event type: {etype!r}"
        )
    data = event.get("data")
    if not isinstance(data, dict):
        raise MalformedVerificationEvent("event.data must be a JSON object")

    ac_refs = data.get("ac_refs")
    if not isinstance(ac_refs, list) or not ac_refs:
        raise MalformedVerificationEvent(
            "data.ac_refs must be a non-empty array of positive integers"
        )
    for n in ac_refs:
        if not isinstance(n, int) or isinstance(n, bool) or n <= 0:
            raise MalformedVerificationEvent(
                "data.ac_refs entries must be positive integers"
            )

    if etype == "automated_e2e_verified":
        test_path = data.get("test_path")
        test_command = data.get("test_command")
        if not isinstance(test_path, str) or not test_path.strip():
            raise MalformedVerificationEvent(
                "data.test_path must be a non-empty string"
            )
        if not isinstance(test_command, str) or not test_command.strip():
            raise MalformedVerificationEvent(
                "data.test_command must be a non-empty string"
            )
        return

    # user_surface_verified
    operator = data.get("operator")
    if not isinstance(operator, str) or not operator.strip():
        raise MalformedVerificationEvent(
            "data.operator must be a non-empty string"
        )
    obs = data.get("observations")
    if not isinstance(obs, list) or not obs:
        raise MalformedVerificationEvent(
            "data.observations must be a non-empty array"
        )
    observed_refs: set[int] = set()
    for i, o in enumerate(obs):
        if not isinstance(o, dict):
            raise MalformedVerificationEvent(
                f"data.observations[{i}] must be a JSON object"
            )
        ac_ref = o.get("ac_ref")
        if (
            not isinstance(ac_ref, int)
            or isinstance(ac_ref, bool)
            or ac_ref <= 0
        ):
            raise MalformedVerificationEvent(
                f"data.observations[{i}].ac_ref must be a positive integer"
            )
        pasted = o.get("pasted_output")
        if not isinstance(pasted, str) or not pasted.strip():
            raise MalformedVerificationEvent(
                f"data.observations[{i}].pasted_output must be a non-empty string"
            )
        if ac_ref not in ac_refs:
            raise MalformedVerificationEvent(
                f"data.observations[{i}].ac_ref={ac_ref} not present in data.ac_refs"
            )
        observed_refs.add(ac_ref)
    if observed_refs != set(ac_refs):
        missing = sorted(set(ac_refs) - observed_refs)
        raise MalformedVerificationEvent(
            f"data.observations does not cover ac_refs (missing: {missing})"
        )


def _load_verification_events(story_key: str) -> dict:
    """Read the run log and return verification-event diagnostics.

    Returns a dict with:
      - `valid_events`: list of well-formed verification events.
      - `malformed`: list of (event_dict, error_message) for malformed events.
    Non-verification events are ignored. Missing log → empty diagnostics.
    """
    log = run_log(story_key)
    out: dict = {"valid_events": [], "malformed": []}
    if not log.exists():
        return out
    for line in log.read_text().splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        etype = event.get("type")
        if etype not in _VERIFICATION_EVENT_TYPES:
            continue
        try:
            _validate_verification_event(event)
        except MalformedVerificationEvent as exc:
            out["malformed"].append((event, str(exc)))
            continue
        out["valid_events"].append(event)
    return out


def _latest_event_data(story_key: str, event_type: str) -> dict | None:
    """Return the ``data`` field of the latest event with the given type.

    Reads the run-log JSONL for *story_key*, scans all lines, and returns
    the ``data`` dict of the last line whose ``event`` field matches
    *event_type*.  Returns ``None`` if the log file is absent, contains no
    matching events, or if any line fails JSON parsing (malformed lines are
    silently skipped — they don't abort the scan).
    """
    log = run_log(story_key)
    if not log.exists():
        return None
    latest: dict | None = None
    for line in log.read_text().splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("event") == event_type:
            latest = event.get("data") or {}
    return latest


def _resolve_spec_path(story_key: str, override: str | None) -> Path:
    """Resolve the spec path for a story, in priority order.

    Resolution order (first existing path wins):
    1. ``override`` — the ``--spec-path`` flag (test hook / explicit override).
    2. Worktree-first — if a ``worktree_ready`` event exists in the run log
       AND the resulting ``<worktree_path>/<spec_rel>`` path exists, return
       that path.  Handles the mid-ship window where the spec only lives
       inside the worktree (not yet merged to the main repo).
    3. Resolve-payload-first — ``spec_path`` from the persisted
       ``/tmp/ship-<story_key>.resolve.json`` joined with REPO.
    4. Convention fallback — ``REPO/_bmad-output/implementation-artifacts/<story_key>.md``.
    """
    if override:
        return Path(override)

    # Determine spec_rel from resolve payload (needed for branches 2 and 3).
    resolve_json = Path(f"/tmp/ship-{story_key}.resolve.json")
    spec_rel: str | None = None
    if resolve_json.exists():
        try:
            info = json.loads(resolve_json.read_text())
        except json.JSONDecodeError:
            info = {}
        spec_rel = info.get("spec_path")

    # Worktree-first branch: check if we have a live worktree with the spec.
    worktree_data = _latest_event_data(story_key, "worktree_ready")
    if worktree_data is not None:
        wt_path_str = worktree_data.get("path")
        if wt_path_str and spec_rel:
            candidate = Path(wt_path_str) / spec_rel
            if candidate.exists():
                return candidate

    # Resolve-payload path.
    if spec_rel:
        return REPO / spec_rel

    # Convention fallback.
    return REPO / f"_bmad-output/implementation-artifacts/{story_key}.md"


def cmd_pre_pr_gate(args) -> None:
    spec_path = _resolve_spec_path(args.story_key, args.spec_path)
    if not spec_path.exists():
        die(f"story spec not found: {spec_path}")
    spec_text = spec_path.read_text()
    user_surface = _parse_user_surface_acs(spec_text)

    if not user_surface:
        print(
            json.dumps(
                {
                    "gate": "pre-pr",
                    "status": "skipped",
                    "reason": "no user-surface ACs",
                }
            )
        )
        return

    diag = _load_verification_events(args.story_key)
    # Coverage union from VALID events only.
    automated_cov: set[int] = set()
    operator_cov: set[int] = set()
    for ev in diag["valid_events"]:
        etype = ev.get("type")
        refs = set(ev["data"]["ac_refs"])
        if etype == "automated_e2e_verified":
            automated_cov |= refs
        elif etype == "user_surface_verified":
            operator_cov |= refs

    union_cov = automated_cov | operator_cov
    missing = sorted(user_surface - union_cov)

    if missing:
        # Surface any malformed-event diagnostics first so the operator sees
        # why an apparently-present event didn't count.
        for _ev, err in diag["malformed"]:
            sys.stderr.write(f"MalformedVerificationEvent: {err}\n")
        sys.stderr.write(
            "Missing user-surface verification for "
            + ", ".join(f"AC{n}" for n in missing)
            + ". Provide either an automated_e2e_verified event covering "
            + "these ACs, or a user_surface_verified event with pasted "
            + "Claude Code output for each.\n"
        )
        sys.exit(EXIT_USER_SURFACE_UNVERIFIED)

    # Determine route label for the orchestrator.
    if automated_cov >= user_surface:
        route = "automated"
    elif operator_cov >= user_surface:
        route = "operator"
    else:
        route = "mixed"
    print(
        json.dumps(
            {
                "gate": "pre-pr",
                "status": "passed",
                "route": route,
                "ac_refs": sorted(user_surface),
            }
        )
    )


def cmd_record_verification(args) -> None:
    """Schema-validated wrapper around `record` for verification events."""
    if args.type not in _VERIFICATION_EVENT_TYPES:
        die(
            f"--type must be one of {sorted(_VERIFICATION_EVENT_TYPES)}",
            code=2,
        )
    try:
        data = json.loads(args.data)
    except json.JSONDecodeError as exc:
        sys.stderr.write(
            f"MalformedVerificationEvent: --data must be valid JSON ({exc})\n"
        )
        sys.exit(2)
    candidate = {"type": args.type, "data": data}
    try:
        _validate_verification_event(candidate)
    except MalformedVerificationEvent as exc:
        sys.stderr.write(f"MalformedVerificationEvent: {exc}\n")
        sys.exit(2)

    payload = {
        "type": args.type,
        "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
        "story_key": args.story_key,
        "data": data,
    }
    with run_log(args.story_key).open("a") as f:
        f.write(json.dumps(payload) + "\n")
    print(json.dumps({"recorded": args.type, "ac_refs": data["ac_refs"]}))


# ---------------------------------------------------------------- entry


def main() -> None:
    _cwd_sanity_check()
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("preflight").set_defaults(func=cmd_preflight)

    r = sub.add_parser("resolve")
    r.add_argument("story_id", nargs="?")
    r.set_defaults(func=cmd_resolve)

    w = sub.add_parser("worktree")
    w.add_argument("story_key")
    w.set_defaults(func=cmd_worktree)

    s = sub.add_parser("set-status")
    s.add_argument("key")
    s.add_argument("new_status")
    s.add_argument(
        "--worktree",
        help=(
            "path to worktree; when given, mutates the worktree's "
            "sprint-status.yaml instead of the main repo's (so the flip "
            "ships in the story PR rather than landing on main)"
        ),
    )
    s.set_defaults(func=cmd_set_status)

    v = sub.add_parser("verify-ac-table")
    v.add_argument("results")
    v.set_defaults(func=cmd_verify_ac_table)

    pr = sub.add_parser("pr-body")
    pr.add_argument("resolve_json", help="JSON file from `resolve` step")
    pr.add_argument("results", help="AC verification results JSON")
    pr.add_argument("review_passes", type=int)
    pr.set_defaults(func=cmd_pr_body)

    rec = sub.add_parser("record")
    rec.add_argument("story_key")
    rec.add_argument("event")
    rec.add_argument("--data", default=None)
    rec.set_defaults(func=cmd_record)

    st = sub.add_parser("state")
    st.add_argument("story_key")
    st.add_argument("--get", default=None, help="return latest event of this name")
    st.set_defaults(func=cmd_state)

    cl = sub.add_parser("cleanup")
    cl.add_argument("story_key")
    cl.set_defaults(func=cmd_cleanup)

    sub.add_parser("pending-cleanup").set_defaults(func=cmd_pending_cleanup)
    sub.add_parser("reconcile").set_defaults(func=cmd_reconcile)

    ri = sub.add_parser("reviewer-issues")
    ri.add_argument("story_key")
    ri.set_defaults(func=cmd_reviewer_issues)

    pg = sub.add_parser("pre-pr-gate")
    pg.add_argument("story_key")
    pg.add_argument(
        "--spec-path",
        default=None,
        help="override spec path (test hook); defaults to the resolve.json path",
    )
    pg.set_defaults(func=cmd_pre_pr_gate)

    rv = sub.add_parser("record-verification")
    rv.add_argument("story_key")
    rv.add_argument(
        "--type",
        required=True,
        choices=sorted(_VERIFICATION_EVENT_TYPES),
    )
    rv.add_argument("--data", required=True, help="JSON-encoded event data")
    rv.set_defaults(func=cmd_record_verification)

    rb = sub.add_parser("review-budget")
    rb.add_argument("spec_path", help="path to the story spec file")
    rb.set_defaults(func=cmd_review_budget)

    sub.add_parser("default-base").set_defaults(func=cmd_default_base)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
