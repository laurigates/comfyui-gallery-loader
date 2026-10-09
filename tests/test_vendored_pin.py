"""The vendored-module pin: scripts/vendored.sh and the CI job that runs it.

The vendored copies used to be diffed against the canonical repo's ``main``,
so the check failed on *time*, not content: any PR opened after a canonical
merge went red whatever it changed (laurigates/comfyui-gallery-loader#92).
They are now diffed against a pinned canonical commit (``scripts/vendored-pin``)
that only moves in this repo's own commits.

These tests run the shipped script against a fake canonical repo served by a
``curl`` stub on PATH, so they exercise the real fetch/diff/bump logic without
the network. The property the change exists for is pinned in both directions:
canonical ``main`` moving does NOT fail the check, and a local edit to a
vendored copy DOES.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "vendored.sh"
PIN_FILE = REPO / "scripts" / "vendored-pin"

OLD_SHA = "a" * 40
NEW_SHA = "b" * 40

CURL_STUB = r"""#!/usr/bin/env bash
# Serves a fake canonical repo laid out as $FAKE_CANONICAL/<ref>/<file>, and
# $FAKE_CANONICAL/refs/<name> for the commits API. Logs every URL it is asked.
out=""; url=""
while [ $# -gt 0 ]; do
    case "$1" in
        -o) out="$2"; shift 2 ;;
        -H) shift 2 ;;
        http*) url="$1"; shift ;;
        *) shift ;;
    esac
done
echo "$url" >> "$CURL_LOG"
case "$url" in
    https://api.github.com/repos/*/commits/*) src="$FAKE_CANONICAL/refs/${url##*/commits/}" ;;
    https://raw.githubusercontent.com/*)
        rest="${url#https://raw.githubusercontent.com/}"
        rest="${rest#*/*/}"            # drop <owner>/<repo>/
        src="$FAKE_CANONICAL/$rest" ;;
    *) exit 22 ;;
esac
[ -f "$src" ] || exit 22
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
"""


def _vendored_files() -> list[str]:
    out = subprocess.run(
        ["bash", str(SCRIPT), "files"], capture_output=True, text=True, check=True
    )
    return out.stdout.split()


@pytest.fixture
def sandbox(tmp_path: Path):
    """A copy of this repo's vendoring surface plus a fake canonical repo.

    The canonical repo holds OLD_SHA (identical to the vendored copies) and
    NEW_SHA (every file changed), with ``main`` pointing at NEW_SHA — i.e. the
    canonical repo has moved since this repo last synced.
    """
    files = _vendored_files()
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    shutil.copy2(SCRIPT, repo / "scripts" / "vendored.sh")
    (repo / "scripts" / "vendored-pin").write_text(OLD_SHA + "\n")

    canonical = tmp_path / "canonical"
    for sha, suffix in ((OLD_SHA, ""), (NEW_SHA, "# moved upstream\n")):
        (canonical / sha).mkdir(parents=True)
        for name in files:
            body = f"# {name} at canonical\n{suffix}"
            (canonical / sha / name).write_text(body)
    (canonical / "refs").mkdir()
    (canonical / "refs" / "main").write_text(NEW_SHA)
    # raw.githubusercontent.com also answers for a branch name, so `main` is
    # served too -- that is what the pre-pin check diffed against.
    shutil.copytree(canonical / NEW_SHA, canonical / "main")
    for name in files:
        shutil.copy2(canonical / OLD_SHA / name, repo / name)

    bindir = tmp_path / "bin"
    bindir.mkdir()
    curl = bindir / "curl"
    curl.write_text(CURL_STUB)
    curl.chmod(curl.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "curl.log"
    log.write_text("")

    env = {
        **os.environ,
        "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}",
        "FAKE_CANONICAL": str(canonical),
        "CURL_LOG": str(log),
    }
    env.pop("GH_TOKEN", None)

    def run(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(repo / "scripts" / "vendored.sh"), *args],
            capture_output=True,
            text=True,
            env=env,
        )

    return {
        "repo": repo,
        "files": files,
        "run": run,
        "log": log,
        "canonical": canonical,
    }


def test_the_curl_stub_is_what_answers(sandbox):
    """Guard: without this, a broken stub would let the real network answer."""
    sandbox["run"]("check")
    assert sandbox["log"].read_text().strip(), "the curl stub was never called"


def test_check_passes_against_the_pin_even_after_canonical_main_moved(sandbox):
    result = sandbox["run"]("check")
    assert result.returncode == 0, result.stdout + result.stderr
    urls = sandbox["log"].read_text().split()
    assert urls and all(f"/{OLD_SHA}/" in u for u in urls), urls
    assert not any("/main/" in u for u in urls), urls


def test_check_fails_on_a_local_edit_and_names_the_file(sandbox):
    name = sandbox["files"][0]
    path = sandbox["repo"] / name
    path.write_text(path.read_text() + "# edited in place\n")
    result = sandbox["run"]("check")
    assert result.returncode == 1, result.stdout + result.stderr
    assert name in result.stdout + result.stderr


def test_check_can_be_scoped_to_one_file(sandbox):
    edited, untouched = sandbox["files"][0], sandbox["files"][-1]
    path = sandbox["repo"] / edited
    path.write_text("# edited\n")
    if edited != untouched:
        assert sandbox["run"]("check", untouched).returncode == 0
    assert sandbox["run"]("check", edited).returncode == 1


def test_check_refuses_a_file_that_is_not_vendored(sandbox):
    result = sandbox["run"]("check", "image_browser.py")
    assert result.returncode == 2, result.stdout + result.stderr
    assert "not vendored" in result.stderr
    # Refused before any fetch: a 404 from canonical would also exit 2, and
    # would say nothing about whether the file list is enforced.
    assert sandbox["log"].read_text() == ""


def test_a_malformed_pin_is_refused_not_fetched(sandbox):
    (sandbox["repo"] / "scripts" / "vendored-pin").write_text("main\n")
    result = sandbox["run"]("check")
    assert result.returncode == 2, result.stdout + result.stderr
    assert sandbox["log"].read_text() == ""


def test_sync_restores_a_vendored_copy_from_the_pin(sandbox):
    name = sandbox["files"][0]
    path = sandbox["repo"] / name
    path.write_text("# clobbered\n")
    assert sandbox["run"]("sync", name).returncode == 0
    assert path.read_text() == (sandbox["canonical"] / OLD_SHA / name).read_text()


def test_bump_moves_the_pin_to_main_and_refetches_every_file(sandbox):
    result = sandbox["run"]("bump")
    assert result.returncode == 0, result.stdout + result.stderr
    pin = (sandbox["repo"] / "scripts" / "vendored-pin").read_text().strip()
    assert pin == NEW_SHA
    for name in sandbox["files"]:
        assert (sandbox["repo"] / name).read_text() == (
            sandbox["canonical"] / NEW_SHA / name
        ).read_text()
    assert sandbox["run"]("check").returncode == 0


def test_bump_is_all_or_nothing_when_a_file_cannot_be_fetched(sandbox):
    missing = sandbox["files"][-1]
    (sandbox["canonical"] / NEW_SHA / missing).unlink()
    result = sandbox["run"]("bump")
    assert result.returncode != 0
    pin = (sandbox["repo"] / "scripts" / "vendored-pin").read_text().strip()
    assert pin == OLD_SHA
    for name in sandbox["files"]:
        assert (sandbox["repo"] / name).read_text() == (
            sandbox["canonical"] / OLD_SHA / name
        ).read_text()


def test_the_committed_pin_is_a_full_commit_sha():
    assert re.fullmatch(r"[0-9a-f]{40}", PIN_FILE.read_text().strip())


def test_the_ci_drift_job_checks_against_the_pin_not_main():
    ci = (REPO / ".github" / "workflows" / "ci.yml").read_text()
    job = ci[ci.index("vendored-drift:") :]
    job = job[: job.index("\n  security:")]
    assert "scripts/vendored.sh check" in job
    assert "/main/" not in job


def test_every_vendored_file_has_a_check_recipe():
    """The rule docs drive sweeps from `grep '^check-.*-drift:' justfile`."""
    justfile = (REPO / "justfile").read_text()
    for name in _vendored_files():
        assert f"scripts/vendored.sh check {name}" in justfile, name
