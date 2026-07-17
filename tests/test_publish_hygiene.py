"""Registry-tarball hygiene guard.

The Comfy Registry security scan flags a node version on ANY finding —
even info severity — and a Flagged version is not served to installers
(see Comfy-Org/registry-backend#180, Comfy-Org/ComfyUI-Manager#2927).
Every shipped file is scan surface.

comfy-cli builds node.zip as: git-tracked files - .comfyignore matches,
with [tool.comfy] includes force-kept (see comfy_cli/file_utils.py
zip_files). These tests recreate that file set and pin it:

1. every top-level path in the tarball is a known runtime path — adding
   a new dev-only directory (scripts/, tooling/, ...) fails this test
   until .comfyignore excludes it. That is the regression that shipped
   scripts/corpus_probe.py in comfyui-sampler-info 0.1.16 and got the
   version flagged (info_python_network_operations);
2. shipped Python contains no scanner-tripwire patterns (network, env,
   subprocess, dynamic exec) unless explicitly allowlisted as intended
   functionality;
3. web/dist stays force-included via [tool.comfy] includes.

This file is kept byte-identical across the comfyui-* pack repos —
sync changes to all of them (and to the comfyui-node-scaffold skill).
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pathspec

REPO = Path(__file__).resolve().parents[1]

# Top-level entries that are allowed to ship (directories end with "/").
# Any top-level *.py is runtime node code and is also allowed.
EXPECTED_RUNTIME = {
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "pyproject.toml",
    "icon.png",
    "banner.png",
    "web/",
}
PY_TOPLEVEL = re.compile(r"^[a-z0-9_]+\.py$")

# Patterns the registry scanner reacts to in shipped Python.
TRIPWIRES = {
    "network": re.compile(
        r"urllib|urlopen|http\.client"
        r"|\brequests\.(get|post|put|delete|head|patch|request|Session)\b"
        r"|\bsocket\.\w"
    ),
    "environment": re.compile(r"os\.environ"),
    "subprocess": re.compile(r"\bsubprocess\b|os\.system\("),
    "dynamic-exec": re.compile(r"\beval\(|\bexec\(|__import__|pickle\.loads"),
}

# filename -> tripwire categories that are intended, reviewed functionality.
# comfyui-touch-manager IS a node manager: registry lookups (network),
# feature-gate env vars, git/pip subprocess — scanner-visible by design,
# tracked for appeal in Comfy-Org/registry-backend#180.
ALLOWED_TRIPWIRES: dict[str, set[str]] = {
    "touch_manager.py": {"network", "environment", "subprocess"},
}


def _tracked_files() -> list[str]:
    out = subprocess.check_output(["git", "ls-files"], cwd=REPO, text=True)
    return [line for line in out.splitlines() if line]


def _includes() -> list[str]:
    text = (REPO / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r"^includes\s*=\s*\[(.*?)\]", text, re.M | re.S)
    return re.findall(r'"([^"]+)"', match.group(1)) if match else []


def _ignore_spec() -> pathspec.PathSpec | None:
    # Mirrors comfy-cli's _load_comfyignore_spec.
    path = REPO / ".comfyignore"
    if not path.exists():
        return None
    patterns = [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    return pathspec.PathSpec.from_lines("gitwildmatch", patterns) if patterns else None


def _force_included(rel_path: str, include_prefixes: list[str]) -> bool:
    return any(
        rel_path == prefix or rel_path.startswith(prefix + "/") for prefix in include_prefixes
    )


def shipped_files() -> list[str]:
    """The file set comfy-cli would pack into node.zip."""
    spec = _ignore_spec()
    prefixes = [i.strip("/") for i in _includes()]

    def keep(path: str) -> bool:
        if _force_included(path, prefixes):
            return True
        return not (spec and spec.match_file(path))

    return [f for f in _tracked_files() if keep(f)]


def test_web_dist_is_force_included():
    assert "web/dist" in _includes(), (
        "[tool.comfy] includes must force-ship web/dist — without it a "
        "checkout-wiped build publishes an empty frontend"
    )


def test_only_expected_runtime_paths_ship():
    unexpected = []
    for f in shipped_files():
        top = f.split("/", 1)[0]
        if "/" in f:
            if top + "/" not in EXPECTED_RUNTIME:
                unexpected.append(f)
        elif f not in EXPECTED_RUNTIME and not PY_TOPLEVEL.match(f):
            unexpected.append(f)
    assert not unexpected, (
        "Files would ship in the registry tarball that are not classified "
        "as runtime content — either add them to .comfyignore (dev-only) "
        f"or to EXPECTED_RUNTIME in this test (runtime): {sorted(unexpected)}"
    )


def test_no_unexpected_tripwires_in_shipped_python():
    findings = []
    for f in shipped_files():
        if not f.endswith(".py"):
            continue
        text = (REPO / f).read_text(encoding="utf-8", errors="replace")
        allowed = ALLOWED_TRIPWIRES.get(Path(f).name, set())
        for category, rx in TRIPWIRES.items():
            if category in allowed:
                continue
            match = rx.search(text)
            if match:
                findings.append(f"{f}: {category} ({match.group(0)!r})")
    assert not findings, (
        "Shipped Python matches registry-scanner tripwire patterns. Move "
        "dev tooling out of the tarball via .comfyignore, or — if this is "
        "intended runtime functionality — add an ALLOWED_TRIPWIRES entry "
        f"with a justification comment: {findings}"
    )
