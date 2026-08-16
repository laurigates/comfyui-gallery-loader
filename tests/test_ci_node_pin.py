"""CI must pin the Node the JS suites run under, from one source of truth.

WHY THIS IS A TEST AND NOT A COMMENT.

`bun run test` and `bun run test:e2e` do not run under bun. Both shell out to a
Node bin (`vitest`, `playwright`) whose shebang is `env node`, so the runtime is
the runner image's Node — a version nothing in this repo declared.

That is load-bearing rather than cosmetic, because the runtime decides which
`Storage` implementation the jsdom suite exercises. Measured locally, no flags,
with `setupFiles` removed from vitest.config.js so the shim could not mask it:

    node        'localStorage' in globalThis    tests/js/gallery-loader.test.js
    22.21.1     False                           6 passed  (jsdom's own Storage)
    24.19.0     False                           6 passed  (jsdom's own Storage)
    25.0.0      True                            6 failed
    26.5.0      True                            6 failed

    TypeError: Cannot read properties of undefined (reading 'clear')

So the built-in accessor is unflagged from **v25**, not from v22.4 (v22.4 is
where the *flag* landed — issue #75 conflated the two). Where the accessor
exists it evaluates to `undefined` without `--localstorage-file`, and vitest
copies jsdom's window globals onto `globalThis` only where the name is ABSENT,
so jsdom's real Storage never lands and `tests/js/setup-jsdom.js` installs its
in-memory shim instead. Below v25 there is no accessor, jsdom's Storage lands,
and the shim's guard is false.

Both paths are green today. The problem is that they are DIFFERENT paths, and
without a pin CI silently picks one while every developer picks the other — so
a shim-only regression cannot be caught by CI, and a jsdom-Storage-only one
cannot be caught locally. The pin is what makes the two sides agree.

This test exists because the pin lives in a workflow file that nothing else
reads: a new Node-running job added later, or a hand-edit dropping the step,
restores the divergence with no other signal.

Ported from comfyui-image-browser (8e5dc13), which hit the same divergence.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
CI = REPO / ".github" / "workflows" / "ci.yml"
NODE_VERSION_FILE = REPO / ".node-version"

# The measured boundary above. Anything below this puts CI on jsdom's Storage
# while developers are on the shim. 25 itself reached end-of-life 2026-06-01,
# which is why the repo pins 26 rather than the bare minimum.
MIN_NODE_MAJOR = 25

# Commands that reach a Node bin rather than running under bun.
NODE_DRIVEN_COMMANDS = ("bun run test", "bun run test:e2e")


def _jobs() -> dict:
    return yaml.safe_load(CI.read_text(encoding="utf-8"))["jobs"]


def _runs_node_suite(job: dict) -> bool:
    for step in job.get("steps") or []:
        run = (step.get("run") or "").strip()
        if any(line.strip() in NODE_DRIVEN_COMMANDS for line in run.splitlines()):
            return True
    return False


def _setup_node_step(job: dict) -> dict | None:
    for step in job.get("steps") or []:
        if str(step.get("uses") or "").startswith("actions/setup-node@"):
            return step
    return None


def test_the_node_version_file_exists_and_names_a_version_with_the_builtin_accessor():
    assert NODE_VERSION_FILE.is_file(), ".node-version is missing"
    raw = NODE_VERSION_FILE.read_text(encoding="utf-8").strip().lstrip("v")
    assert raw, ".node-version is empty"
    major = int(raw.split(".")[0])
    assert major >= MIN_NODE_MAJOR, (
        f".node-version pins Node {raw}, below v{MIN_NODE_MAJOR}. Node only "
        "exposes the built-in localStorage accessor unflagged from v25, so a "
        "lower pin puts CI on jsdom's Storage while developers run the "
        "tests/js/setup-jsdom.js shim — the divergence the pin exists to close."
    )


def test_the_workflow_actually_contains_node_driven_suites():
    # The paired positive. Without it, the per-job assertion below is
    # "every job in an empty set is pinned", which is true of a workflow that
    # runs no JS at all and of one whose job names were renamed out from under
    # this test.
    names = sorted(n for n, j in _jobs().items() if _runs_node_suite(j))
    assert names == ["test-e2e", "test-js"], (
        f"expected the vitest and playwright jobs to be found by their run "
        f"commands, got {names}. Either a job was renamed/removed or "
        f"NODE_DRIVEN_COMMANDS no longer matches how the suites are invoked — "
        f"in which case the pin assertion below is silently checking nothing."
    )


@pytest.mark.parametrize("job_name", ["test-js", "test-e2e"])
def test_each_node_driven_job_pins_node_from_the_shared_file(job_name: str):
    job = _jobs()[job_name]
    assert _runs_node_suite(job), f"{job_name} no longer runs a Node-driven suite"
    step = _setup_node_step(job)
    assert step is not None, (
        f"{job_name} runs a Node bin but has no actions/setup-node step, so it "
        f"runs on whatever Node the runner image ships."
    )
    # One source of truth: the file, not a literal repeated per job. A version
    # written inline here and again in .node-version is two numbers that drift.
    assert (step.get("with") or {}).get("node-version-file") == ".node-version", (
        f"{job_name} sets up Node without reading .node-version "
        f"(with: {step.get('with')!r}). Use node-version-file so the workflow "
        f"and local tooling cannot disagree."
    )
    assert "node-version" not in (step.get("with") or {}), (
        f"{job_name} pins an inline node-version alongside node-version-file; "
        f"setup-node prefers the inline one, which reintroduces the drift."
    )
