"""Regression tests for comment-preserving sprint-status writes.

PyYAML's load/dump round-trip silently strips inline ``# ...`` comments, and
sprint-status.yaml carries load-bearing rationale comments (rescope/sequence
notes). The Story 6.5b ship surfaced this: a ``done`` flip wiped ~21 comments.
``_set_status_value`` rewrites only the single status line + last_updated via
anchored regex on raw text, so every other byte survives.
"""
import sys
from pathlib import Path

import pytest

# Allow importing ship.py directly without installing the package.
sys.path.insert(0, str(Path(__file__).parent))
import ship  # noqa: E402


SAMPLE = """\
generated: 2026-05-19
last_updated: '2026-05-30'
project: crew
development_status:
  epic-6: in-progress
  6-5b-regenerate-standards: ready-for-dev
  6-6-promotion-threshold: ready-for-dev  # waits on 6.5b merge
  5-1-some-cancelled-story: cancelled  # /crew:start retired (#210); see SCP
"""


def test_preserves_all_comments_and_changes_only_target(tmp_path):
    """The flip changes exactly the target status token + last_updated; every
    comment and all other bytes are preserved verbatim."""
    f = tmp_path / "sprint-status.yaml"
    f.write_text(SAMPLE)

    ship._set_status_value(f, "6-5b-regenerate-standards", "ready-for-dev", "done")
    out = f.read_text()

    assert "  6-5b-regenerate-standards: done\n" in out
    # comments on OTHER lines survive verbatim
    assert "  6-6-promotion-threshold: ready-for-dev  # waits on 6.5b merge\n" in out
    assert "  5-1-some-cancelled-story: cancelled  # /crew:start retired (#210); see SCP\n" in out

    today = ship.dt.date.today().isoformat()
    expected = SAMPLE.replace(
        "  6-5b-regenerate-standards: ready-for-dev\n",
        "  6-5b-regenerate-standards: done\n",
    ).replace(
        "last_updated: '2026-05-30'\n",
        f"last_updated: '{today}'\n",
    )
    assert out == expected, "only the target status token and last_updated should change"


def test_preserves_inline_comment_on_the_flipped_line(tmp_path):
    """Flipping a key that itself carries a trailing comment keeps the comment."""
    f = tmp_path / "sprint-status.yaml"
    f.write_text(SAMPLE)

    ship._set_status_value(f, "6-6-promotion-threshold", "ready-for-dev", "done")
    out = f.read_text()

    assert "  6-6-promotion-threshold: done  # waits on 6.5b merge\n" in out


def test_raises_when_no_matching_line(tmp_path):
    """Fail closed if the key/old-status pair is not found exactly once."""
    f = tmp_path / "sprint-status.yaml"
    f.write_text(SAMPLE)

    with pytest.raises(SystemExit):
        ship._set_status_value(f, "nonexistent-key", "ready-for-dev", "done")


def test_cmd_set_status_end_to_end_preserves_comments(tmp_path, monkeypatch):
    """The full cmd_set_status path (validate via parse, write via line edit)
    leaves the canonical comments intact."""
    f = tmp_path / "sprint-status.yaml"
    f.write_text(SAMPLE)
    monkeypatch.setattr(ship, "STATUS_FILE", f)

    class _Args:
        key = "6-5b-regenerate-standards"
        new_status = "done"
        worktree = None

    ship.cmd_set_status(_Args())
    out = f.read_text()

    assert "  6-5b-regenerate-standards: done\n" in out
    assert "# /crew:start retired (#210); see SCP" in out
