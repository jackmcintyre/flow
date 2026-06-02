"""Tests for default_base resolution and worktree-first spec-path fallback.

Covers AC5 sub-cases (5c)–(5j) from Story 1.12:
  (5c) resolve_default_base returns 'dev' when config says default_base: dev
  (5d) default-base subcommand prints the resolved base; SKILL.md has --base flag
  (5e) _resolve_spec_path finds worktree-only spec via worktree_ready event
  (5f) Green-field (no config) defaults to 'main'
  (5g) Malformed config falls back to 'main' with a stderr warning
  (5h) Post-cleanup fallback: missing worktree path falls through to convention
  (5i) SKILL.md has exactly one gh pr create block and it includes --base substitution
  (5j) cmd_cleanup honours resolve_default_base (regression guard for d3e1c81 revert)
"""
import json
import subprocess
import sys
import textwrap
import uuid
from pathlib import Path

import pytest

# Allow importing ship.py directly without installing the package.
sys.path.insert(0, str(Path(__file__).parent))
import ship  # noqa: E402


# ------------------------------------------------------------------ helpers


def write_config(root: Path, content: str) -> None:
    config_dir = root / ".claude" / "skills" / "ship-story"
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / "config.yaml").write_text(content)


def write_run_log(root: Path, story_key: str, events: list[dict]) -> None:
    """Write JSONL events to the run log for *story_key* under *root*."""
    runs_dir = root / ".claude" / "skills" / "ship-story" / ".runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    log_path = runs_dir / f"{story_key}.jsonl"
    with log_path.open("w") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")


# ------------------------------------------------------------------ AC5(c) resolve_default_base


class TestResolveDefaultBase:
    def test_returns_dev_when_config_set(self, tmp_path, monkeypatch):
        """(5c) Pure-function test: config says dev → returns dev."""
        write_config(tmp_path, "default_base: dev\n")
        monkeypatch.setattr(ship, "REPO", tmp_path)
        assert ship.resolve_default_base() == "dev"

    def test_returns_main_when_no_config(self, tmp_path, monkeypatch):
        """(5f) Green-field: no config file → main."""
        monkeypatch.setattr(ship, "REPO", tmp_path)
        assert ship.resolve_default_base() == "main"

    def test_returns_main_when_key_missing(self, tmp_path, monkeypatch):
        """Missing default_base key → main."""
        write_config(tmp_path, "other_key: something\n")
        monkeypatch.setattr(ship, "REPO", tmp_path)
        assert ship.resolve_default_base() == "main"

    def test_non_string_value_falls_back_with_warning(self, tmp_path, monkeypatch, capsys):
        """(5g) Non-string value (e.g. int) → main with stderr warning."""
        write_config(tmp_path, "default_base: 42\n")
        monkeypatch.setattr(ship, "REPO", tmp_path)
        result = ship.resolve_default_base()
        assert result == "main"
        captured = capsys.readouterr()
        assert "malformed config" in captured.err
        assert "falling back to main" in captured.err

    def test_empty_string_value_falls_back(self, tmp_path, monkeypatch, capsys):
        """(5g) Empty string value → main with stderr warning."""
        write_config(tmp_path, 'default_base: ""\n')
        monkeypatch.setattr(ship, "REPO", tmp_path)
        result = ship.resolve_default_base()
        assert result == "main"

    def test_non_mapping_yaml_falls_back_with_warning(self, tmp_path, monkeypatch, capsys):
        """(5g) Non-mapping YAML (e.g. bare list) → main with stderr warning."""
        write_config(tmp_path, "- item1\n- item2\n")
        monkeypatch.setattr(ship, "REPO", tmp_path)
        result = ship.resolve_default_base()
        assert result == "main"
        captured = capsys.readouterr()
        assert "malformed config" in captured.err

    def test_empty_file_falls_back(self, tmp_path, monkeypatch):
        """(5g) Empty config file → main (safe_load returns None → not a dict)."""
        write_config(tmp_path, "")
        monkeypatch.setattr(ship, "REPO", tmp_path)
        assert ship.resolve_default_base() == "main"

    def test_malformed_yaml_falls_back_with_warning(self, tmp_path, monkeypatch, capsys):
        """(5g) Unparseable YAML → main with stderr warning."""
        write_config(tmp_path, "default_base: [\nunterminated")
        monkeypatch.setattr(ship, "REPO", tmp_path)
        result = ship.resolve_default_base()
        assert result == "main"
        captured = capsys.readouterr()
        assert "malformed config" in captured.err


# ------------------------------------------------------------------ AC5(c) cmd_worktree integration


class TestCmdWorktreeUsesDefaultBase:
    """Integration test: cmd_worktree's git calls honour default_base."""

    def test_dev_config_uses_origin_dev(self, tmp_path, monkeypatch):
        """(5c) With default_base: dev, git calls reference origin/dev."""
        write_config(tmp_path, "default_base: dev\n")
        monkeypatch.setattr(ship, "REPO", tmp_path)

        recorded: list[list] = []

        def fake_check_call(cmd, **kwargs):
            recorded.append(list(cmd))

        monkeypatch.setattr(ship.subprocess, "check_call", fake_check_call)

        # Stub the worktree-exists check to pretend the branch and dir don't exist.
        def fake_run(cmd, **kwargs):
            class _R:
                returncode = 1
                stdout = ""
                stderr = ""
            return _R()

        monkeypatch.setattr(ship.subprocess, "run", fake_run)

        # Stub worktrees_dir.mkdir and worktree.exists — use a real subdir.
        story_key = "9-99-test-story"
        wt_dir = tmp_path / ".worktrees"
        wt_dir.mkdir(parents=True, exist_ok=True)

        class _FakeArgs:
            story_key = "9-99-test-story"

        ship.cmd_worktree(_FakeArgs())

        cmds = [" ".join(c) for c in recorded]
        assert any("git fetch origin dev" in c for c in cmds), \
            f"Expected 'git fetch origin dev' in calls; got: {cmds}"
        assert any("origin/dev" in c for c in cmds), \
            f"Expected 'origin/dev' in worktree-add call; got: {cmds}"

    def test_no_config_uses_origin_main(self, tmp_path, monkeypatch):
        """(5f) With no config, git calls reference origin/main."""
        monkeypatch.setattr(ship, "REPO", tmp_path)

        recorded: list[list] = []

        def fake_check_call(cmd, **kwargs):
            recorded.append(list(cmd))

        monkeypatch.setattr(ship.subprocess, "check_call", fake_check_call)

        def fake_run(cmd, **kwargs):
            class _R:
                returncode = 1
                stdout = ""
                stderr = ""
            return _R()

        monkeypatch.setattr(ship.subprocess, "run", fake_run)

        wt_dir = tmp_path / ".worktrees"
        wt_dir.mkdir(parents=True, exist_ok=True)

        class _FakeArgs:
            story_key = "9-99-test-story"

        ship.cmd_worktree(_FakeArgs())

        cmds = [" ".join(c) for c in recorded]
        assert any("git fetch origin main" in c for c in cmds), \
            f"Expected 'git fetch origin main' in calls; got: {cmds}"
        assert any("origin/main" in c for c in cmds), \
            f"Expected 'origin/main' in worktree-add call; got: {cmds}"


# ------------------------------------------------------------------ AC5(d) default-base subcommand CLI


class TestDefaultBaseSubcommand:
    """(5d) default-base subcommand prints the resolved base to stdout."""

    def _run(self, config_root: Path | None = None) -> subprocess.CompletedProcess:
        env: dict = {"FLOW_SHIP_SKIP_CWD_CHECK": "1"}
        if config_root is not None:
            # Set PYTHONPATH so the child process picks up the right ship.py
            # and point it at a tmp dir that has the right config.
            import os
            env.update(os.environ)
            env["FLOW_SHIP_SKIP_CWD_CHECK"] = "1"
        return subprocess.run(
            [sys.executable, str(Path(__file__).parent / "ship.py"), "default-base"],
            capture_output=True,
            text=True,
            cwd=str(config_root) if config_root else None,
            env=env,
        )

    def test_prints_dev_when_config_has_dev(self, tmp_path):
        """Subprocess prints 'dev' when config.yaml says default_base: dev."""
        # Config in the canonical REPO location (4 parents up from scripts/).
        # For the subprocess, we need REPO to resolve to tmp_path. The
        # _canonical_repo logic goes 4 parents up from __file__. We replicate
        # the structure: tmp_path/.claude/skills/ship-story/scripts/ship.py
        scripts_dir = tmp_path / ".claude" / "skills" / "ship-story" / "scripts"
        scripts_dir.mkdir(parents=True, exist_ok=True)

        # Symlink or copy ship.py — use the real file.
        real_ship = Path(__file__).parent / "ship.py"
        child_ship = scripts_dir / "ship.py"
        child_ship.write_text(real_ship.read_text())

        # Write config at the correct relative location.
        write_config(tmp_path, "default_base: dev\n")

        import os
        rc = subprocess.run(
            [sys.executable, str(child_ship), "default-base"],
            capture_output=True,
            text=True,
            env={**os.environ, "FLOW_SHIP_SKIP_CWD_CHECK": "1"},
        )
        assert rc.returncode == 0, f"stderr: {rc.stderr}"
        assert rc.stdout.strip() == "dev"

    def test_prints_main_when_no_config(self, tmp_path):
        """Subprocess prints 'main' when no config file exists."""
        scripts_dir = tmp_path / ".claude" / "skills" / "ship-story" / "scripts"
        scripts_dir.mkdir(parents=True, exist_ok=True)

        real_ship = Path(__file__).parent / "ship.py"
        child_ship = scripts_dir / "ship.py"
        child_ship.write_text(real_ship.read_text())

        import os
        rc = subprocess.run(
            [sys.executable, str(child_ship), "default-base"],
            capture_output=True,
            text=True,
            env={**os.environ, "FLOW_SHIP_SKIP_CWD_CHECK": "1"},
        )
        assert rc.returncode == 0, f"stderr: {rc.stderr}"
        assert rc.stdout.strip() == "main"

    def test_skill_md_contains_base_substitution(self):
        """(5d, 5i) SKILL.md Step 9 gh pr create block includes --base substitution."""
        skill_md = Path(__file__).parents[1] / "SKILL.md"
        assert skill_md.exists(), f"SKILL.md not found at {skill_md}"
        content = skill_md.read_text()
        # base is resolved via ship.py default-base, then consumed as --base "$base"
        # (resolution must NOT be inline inside the worktree subshell — see Step 9 note).
        assert 'base="$(python3 .claude/skills/ship-story/scripts/ship.py default-base)"' in content, \
            "SKILL.md Step 9 must resolve the base via ship.py default-base"
        assert '--base "$base"' in content, \
            "SKILL.md Step 9 gh pr create block must consume the resolved base"


# ------------------------------------------------------------------ AC5(e) worktree-first spec resolution


class TestResolveSpecPathWorktreeFirst:
    """(5e) _resolve_spec_path finds a worktree-only spec via worktree_ready event."""

    def test_finds_worktree_only_spec(self, tmp_path, monkeypatch, request):
        """(5e) Exercise the REAL _resolve_spec_path worktree-first branch end-to-end."""
        # Unique story key per test to avoid /tmp collisions.
        uid = uuid.uuid4().hex[:8]
        story_key = f"1-99-wt-{uid}"
        spec_rel = f"_bmad-output/implementation-artifacts/{story_key}.md"

        # Set up worktree directory with the spec inside it (only in worktree,
        # not in the main repo — exercises the worktree-first branch).
        worktree_dir = tmp_path / "wt"
        spec_in_wt = worktree_dir / spec_rel
        spec_in_wt.parent.mkdir(parents=True, exist_ok=True)
        spec_in_wt.write_text("# Story spec\nstory_shape: substrate\n")

        # Write run log with worktree_ready event under tmp_path (steered by
        # monkeypatching _DEFAULT_RUNS_DIR so runs_dir() reads from here).
        write_run_log(tmp_path, story_key, [
            {"event": "worktree_ready", "ts": "2026-01-01T00:00:00Z", "data": {"path": str(worktree_dir)}},
        ])

        # Write resolve JSON to the real /tmp/ path that _resolve_spec_path hardcodes.
        resolve_json_path = Path(f"/tmp/ship-{story_key}.resolve.json")
        resolve_json_path.write_text(json.dumps({"spec_path": spec_rel}))
        request.addfinalizer(lambda: resolve_json_path.unlink(missing_ok=True))

        # Steer REPO and the run-log dir to tmp_path; do NOT stub _resolve_spec_path.
        monkeypatch.setattr(ship, "REPO", tmp_path)
        monkeypatch.setattr(ship, "_DEFAULT_RUNS_DIR", tmp_path / ".claude/skills/ship-story/.runs")

        result = ship._resolve_spec_path(story_key, None)
        assert result == spec_in_wt
        assert result.exists()

    def test_falls_through_when_worktree_gone(self, tmp_path, monkeypatch, request):
        """(5h) Post-cleanup: worktree_ready event exists but path is gone → fall through."""
        uid = uuid.uuid4().hex[:8]
        story_key = f"1-99-cl-{uid}"
        spec_rel = f"_bmad-output/implementation-artifacts/{story_key}.md"

        # Run log points at a non-existent worktree (simulates post-cleanup state).
        write_run_log(tmp_path, story_key, [
            {"event": "worktree_ready", "ts": "2026-01-01T00:00:00Z", "data": {"path": str(tmp_path / "gone_worktree")}},
        ])

        # Write resolve JSON to the real /tmp/ path.
        resolve_json_path = Path(f"/tmp/ship-{story_key}.resolve.json")
        resolve_json_path.write_text(json.dumps({"spec_path": spec_rel}))
        request.addfinalizer(lambda: resolve_json_path.unlink(missing_ok=True))

        # Create spec at the main-repo fallback path (worktree is gone, this should win).
        main_spec = tmp_path / spec_rel
        main_spec.parent.mkdir(parents=True, exist_ok=True)
        main_spec.write_text("# Fallback spec\n")

        # Steer REPO and the run-log dir to tmp_path; do NOT stub _resolve_spec_path.
        monkeypatch.setattr(ship, "REPO", tmp_path)
        monkeypatch.setattr(ship, "_DEFAULT_RUNS_DIR", tmp_path / ".claude/skills/ship-story/.runs")

        result = ship._resolve_spec_path(story_key, None)
        # Worktree path doesn't exist → falls through to REPO / spec_rel.
        assert result == main_spec


# ------------------------------------------------------------------ AC5(i) SKILL.md structural anchor


class TestSkillMdStructure:
    """(5i) SKILL.md has exactly one gh pr create invocation with --base substitution."""

    def test_gh_pr_create_has_base_flag(self):
        skill_md = Path(__file__).parents[1] / "SKILL.md"
        content = skill_md.read_text()
        assert 'base="$(python3 .claude/skills/ship-story/scripts/ship.py default-base)"' in content
        assert '--base "$base"' in content

    def test_gh_pr_create_appears_in_step_9(self):
        skill_md = Path(__file__).parents[1] / "SKILL.md"
        content = skill_md.read_text()
        # Find Step 9 section and confirm gh pr create is inside it.
        step9_start = content.find("### Step 9")
        step10_start = content.find("### Step 10")
        assert step9_start != -1
        assert step10_start != -1
        step9_section = content[step9_start:step10_start]
        assert "gh pr create" in step9_section, "gh pr create not found in Step 9"
        assert '--base "$base"' in step9_section
        # The fix: base is resolved in the main-repo cwd, BEFORE cd-ing into the
        # worktree subshell (ship.py refuses to run from inside .worktrees/).
        base_line = step9_section.find('base="$(python3 .claude/skills/ship-story/scripts/ship.py default-base)"')
        subshell = step9_section.find("(cd <worktree_path> && gh pr create")
        assert base_line != -1 and subshell != -1 and base_line < subshell, \
            "default-base must be resolved before the worktree subshell"


# ------------------------------------------------------------------ AC5(j) cmd_cleanup regression guard


class TestCmdCleanupHonoursDefaultBase:
    """(5j) cmd_cleanup uses resolve_default_base — regression guard for d3e1c81 revert."""

    def _make_run_log(self, tmp_path: Path, story_key: str, pr_number: int = 42) -> None:
        """Write a minimal run log with pr_opened event."""
        write_run_log(tmp_path, story_key, [
            {"event": "pr_opened", "ts": "2026-01-01T00:00:00Z", "data": {"number": pr_number, "url": f"https://github.com/foo/bar/pull/{pr_number}"}},
        ])

    def test_dev_config_uses_origin_dev(self, tmp_path, monkeypatch):
        """With default_base: dev, cleanup's git fetch/merge reference origin/dev."""
        write_config(tmp_path, "default_base: dev\n")
        monkeypatch.setattr(ship, "REPO", tmp_path)
        monkeypatch.setattr(ship, "_DEFAULT_RUNS_DIR", tmp_path / ".claude/skills/ship-story/.runs")

        story_key = "9-99-cleanup-dev"
        self._make_run_log(tmp_path, story_key, pr_number=55)

        recorded_check_call: list[list] = []
        recorded_run: list[list] = []

        def fake_check_call(cmd, **kwargs):
            recorded_check_call.append(list(cmd))

        def fake_check_output(cmd, **kwargs):
            # rev-parse HEAD → return 'dev' so the ff-merge branch is taken.
            return "dev"

        class _MergedPR:
            returncode = 0
            stdout = json.dumps({"state": "MERGED", "mergedAt": "2026-01-01T00:00:00Z", "headRefName": "story/9-99-cleanup-dev"})
            stderr = ""

        class _NullRC:
            returncode = 0
            stdout = "[]"
            stderr = ""

        def fake_run(cmd, **kwargs):
            recorded_run.append(list(cmd))
            if "gh" in cmd and "pr" in cmd and "view" in cmd:
                return _MergedPR()
            # git worktree remove, branch -D, push --delete → success
            return _NullRC()

        monkeypatch.setattr(ship.subprocess, "check_call", fake_check_call)
        monkeypatch.setattr(ship.subprocess, "check_output", fake_check_output)
        monkeypatch.setattr(ship.subprocess, "run", fake_run)

        # Stub STATUS_FILE so load_status doesn't fail.
        import io
        status_data = {
            "last_updated": "2026-01-01",
            "development_status": {story_key: "review"},
        }
        status_file = tmp_path / "_bmad-output" / "implementation-artifacts" / "sprint-status.yaml"
        status_file.parent.mkdir(parents=True, exist_ok=True)
        import yaml as _yaml
        status_file.write_text(_yaml.safe_dump(status_data))
        monkeypatch.setattr(ship, "STATUS_FILE", status_file)

        class _FakeArgs:
            story_key = "9-99-cleanup-dev"

        ship.cmd_cleanup(_FakeArgs())

        all_cmds = [" ".join(c) for c in recorded_check_call]
        assert any("git fetch origin dev" in c for c in all_cmds), \
            f"Expected 'git fetch origin dev'; got: {all_cmds}"
        all_run_cmds = [" ".join(c) for c in recorded_run]
        assert any("git merge --ff-only origin/dev" in c for c in all_run_cmds), \
            f"Expected 'git merge --ff-only origin/dev'; got: {all_run_cmds}"

    def test_no_config_uses_origin_main(self, tmp_path, monkeypatch):
        """With no config, cleanup's git fetch/merge reference origin/main."""
        monkeypatch.setattr(ship, "REPO", tmp_path)
        monkeypatch.setattr(ship, "_DEFAULT_RUNS_DIR", tmp_path / ".claude/skills/ship-story/.runs")

        story_key = "9-99-cleanup-main"
        self._make_run_log(tmp_path, story_key, pr_number=56)

        recorded_check_call: list[list] = []
        recorded_run: list[list] = []

        def fake_check_call(cmd, **kwargs):
            recorded_check_call.append(list(cmd))

        def fake_check_output(cmd, **kwargs):
            return "main"

        class _MergedPR:
            returncode = 0
            stdout = json.dumps({"state": "MERGED", "mergedAt": "2026-01-01T00:00:00Z", "headRefName": "story/9-99-cleanup-main"})
            stderr = ""

        class _NullRC:
            returncode = 0
            stdout = "[]"
            stderr = ""

        def fake_run(cmd, **kwargs):
            recorded_run.append(list(cmd))
            if "gh" in cmd and "pr" in cmd and "view" in cmd:
                return _MergedPR()
            return _NullRC()

        monkeypatch.setattr(ship.subprocess, "check_call", fake_check_call)
        monkeypatch.setattr(ship.subprocess, "check_output", fake_check_output)
        monkeypatch.setattr(ship.subprocess, "run", fake_run)

        status_data = {
            "last_updated": "2026-01-01",
            "development_status": {story_key: "review"},
        }
        status_file = tmp_path / "_bmad-output" / "implementation-artifacts" / "sprint-status.yaml"
        status_file.parent.mkdir(parents=True, exist_ok=True)
        import yaml as _yaml
        status_file.write_text(_yaml.safe_dump(status_data))
        monkeypatch.setattr(ship, "STATUS_FILE", status_file)

        class _FakeArgs:
            story_key = "9-99-cleanup-main"

        ship.cmd_cleanup(_FakeArgs())

        all_cmds = [" ".join(c) for c in recorded_check_call]
        assert any("git fetch origin main" in c for c in all_cmds), \
            f"Expected 'git fetch origin main'; got: {all_cmds}"
        all_run_cmds = [" ".join(c) for c in recorded_run]
        assert any("git merge --ff-only origin/main" in c for c in all_run_cmds), \
            f"Expected 'git merge --ff-only origin/main'; got: {all_run_cmds}"
