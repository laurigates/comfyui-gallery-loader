"""CI must lint with ONE pinned ruff version, shared with pre-commit and uv.lock.

WHY THIS IS A TEST AND NOT A COMMENT.

CI used to run bare ``uvx ruff check .``, which resolves the newest ruff on every
run. Ruff 0.17.4 added a SIM102 case that flagged untouched code, and every open
PR went red for a reason outside its diff. A lint result has to change only with
a deliberate version bump.

Three places name a ruff version: the dev dependency in ``pyproject.toml``
(resolved into ``uv.lock``), the ``ruff-pre-commit`` rev, and whatever CI runs.
This test makes the dev dependency the single source: it must be an exact pin,
the lock must resolve to it, the pre-commit rev must match it, and every CI ruff
step must run it through ``uv run --locked``. Renovate groups the pyproject pin
and the pre-commit rev (``renovate.json``) so one PR moves both; a hand-edit of
either alone fails here.
"""

from __future__ import annotations

import re
from pathlib import Path

import tomllib
import yaml

REPO = Path(__file__).resolve().parents[1]
CI = REPO / ".github" / "workflows" / "ci.yml"
PYPROJECT = REPO / "pyproject.toml"
LOCK = REPO / "uv.lock"
PRE_COMMIT = REPO / ".pre-commit-config.yaml"
RUFF_PRE_COMMIT_REPO = "https://github.com/astral-sh/ruff-pre-commit"


def _pinned_version() -> str:
    dev = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["dependency-groups"]["dev"]
    specs = [d for d in dev if re.match(r"ruff\b", d)]
    assert len(specs) == 1, f"expected one ruff entry in the dev group, found {specs!r}"
    m = re.fullmatch(r"ruff==(\d+\.\d+\.\d+)", specs[0].replace(" ", ""))
    assert m, (
        f"the dev group declares {specs[0]!r}; it must be an exact pin (ruff==X.Y.Z) "
        "so the lint result changes only with a deliberate bump."
    )
    return m.group(1)


def _ci_ruff_commands() -> list[str]:
    jobs = yaml.safe_load(CI.read_text(encoding="utf-8"))["jobs"]
    return [
        line.strip()
        for job in jobs.values()
        for step in job.get("steps") or []
        for line in (step.get("run") or "").splitlines()
        if re.search(r"\bruff\b", line)
    ]


def test_uv_lock_resolves_ruff_to_the_pinned_version():
    lock = tomllib.loads(LOCK.read_text(encoding="utf-8"))
    locked = [p["version"] for p in lock["package"] if p["name"] == "ruff"]
    assert locked == [_pinned_version()], (
        f"uv.lock resolves ruff to {locked!r} but pyproject pins {_pinned_version()}. "
        "Run `uv lock`."
    )


def test_pre_commit_ruff_rev_matches_the_pinned_version():
    repos = yaml.safe_load(PRE_COMMIT.read_text(encoding="utf-8"))["repos"]
    revs = [r["rev"] for r in repos if r.get("repo") == RUFF_PRE_COMMIT_REPO]
    assert revs == [f"v{_pinned_version()}"], (
        f"ruff-pre-commit is at {revs!r} but pyproject pins ruff {_pinned_version()}; "
        "the hook and CI would disagree on what passes."
    )


def test_every_ci_ruff_step_runs_the_locked_version():
    cmds = _ci_ruff_commands()
    assert cmds, "no ruff step found in ci.yml; the assertions below would check nothing"
    unpinned = [c for c in cmds if not c.startswith("uv run --locked")]
    assert not unpinned, (
        f"these CI steps do not run the locked ruff: {unpinned!r}. Use "
        "`uv run --locked --only-group dev ruff ...`; bare `uvx ruff` resolves "
        "the newest release on every run."
    )
