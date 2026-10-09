#!/usr/bin/env bash
# Check, restore and re-pin the modules this repo vendors verbatim from their
# canonical home.
#
# The vendored copies are compared against the canonical file AT A PINNED
# COMMIT (scripts/vendored-pin), not against canonical main. Comparing against
# a moving main made the check fail on time rather than content: any PR opened
# after a canonical merge went red whatever it changed, and a canonical change
# could not land without first reasoning about which downstream PRs it would
# break (laurigates/comfyui-gallery-loader#92). The pin moves only in this
# repo's own commits, so a canonical merge cannot change a PR's status here.
# The scheduled "Vendored sync" workflow notices canonical drift instead, and
# opens the bump PR. Fetching by commit SHA also sidesteps the ~5 minute
# raw.githubusercontent.com cache, which only ever serves a stale `main`.
#
# Usage:
#   scripts/vendored.sh check [file...]  diff vendored copies against the pin (exit 1 on drift)
#   scripts/vendored.sh sync  [file...]  restore vendored copies from the pin
#   scripts/vendored.sh bump  [ref]      pin <ref> (default: main) and re-fetch every file
#   scripts/vendored.sh files            list the vendored files
#
# Exit codes: 0 ok, 1 drift (check only), 2 usage/config error or fetch failure.
set -euo pipefail

CANONICAL_REPO="laurigates/comfyui-image-browser"
VENDORED_FILES=(image_meta.py)
PIN_FILE="scripts/vendored-pin"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

WORK=$(mktemp -d)
[ -n "$WORK" ] && [ -d "$WORK" ] || { echo "vendored.sh: mktemp -d failed" >&2; exit 2; }
trap 'rm -rf "$WORK"' EXIT

die() {
    echo "vendored.sh: $*" >&2
    exit 2
}

is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

pinned_ref() {
    [ -f "$PIN_FILE" ] || die "$PIN_FILE is missing"
    local ref
    ref=$(tr -d '[:space:]' <"$PIN_FILE")
    is_sha "$ref" || die "$PIN_FILE must hold a full 40-character commit SHA, found '${ref}'"
    printf '%s' "$ref"
}

# Set FILES to the requested file arguments (default: all), refusing anything
# that is not vendored. Runs in the calling shell, not in a $(...) subshell,
# so the refusal exits the script instead of yielding an empty list.
select_files() {
    FILES=()
    if [ "$#" -eq 0 ]; then
        FILES=("${VENDORED_FILES[@]}")
        return
    fi
    local f v ok
    for f in "$@"; do
        ok=""
        for v in "${VENDORED_FILES[@]}"; do [ "$f" = "$v" ] && ok=1; done
        [ -n "$ok" ] || die "'$f' is not vendored here (vendored: ${VENDORED_FILES[*]})"
        FILES+=("$f")
    done
}

fetch() { # fetch <sha> <file> <dest>
    curl -fsSL "https://raw.githubusercontent.com/${CANONICAL_REPO}/$1/$2" -o "$3" ||
        die "could not fetch $2 at ${CANONICAL_REPO}@$1"
}

resolve_ref() { # resolve_ref <branch|tag|sha> -> full commit SHA
    if is_sha "$1"; then
        printf '%s' "$1"
        return
    fi
    local auth=() sha
    [ -n "${GH_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${GH_TOKEN}")
    sha=$(curl -fsSL ${auth[@]+"${auth[@]}"} -H "Accept: application/vnd.github.sha" \
        "https://api.github.com/repos/${CANONICAL_REPO}/commits/$1") ||
        die "could not resolve '$1' in ${CANONICAL_REPO}"
    sha=$(printf '%s' "$sha" | tr -d '[:space:]')
    is_sha "$sha" || die "resolving '$1' in ${CANONICAL_REPO} returned '${sha}', not a commit SHA"
    printf '%s' "$sha"
}

cmd_check() {
    local ref tmp f drift=0
    ref=$(pinned_ref)
    select_files "$@"
    tmp="$WORK"
    for f in "${FILES[@]}"; do
        fetch "$ref" "$f" "$tmp/$f"
        if diff -u --label "${CANONICAL_REPO}@${ref:0:12}/$f" --label "$f" "$tmp/$f" "$f"; then
            echo "$f matches ${CANONICAL_REPO}@${ref:0:12}"
        else
            drift=1
            echo "DRIFT: $f differs from ${CANONICAL_REPO}@${ref:0:12}." \
                "Vendored copies are not edited here: land the change in ${CANONICAL_REPO}" \
                "first, then take it with 'just bump-vendored'."
        fi
    done
    return "$drift"
}

cmd_sync() {
    local ref tmp f
    ref=$(pinned_ref)
    select_files "$@"
    tmp="$WORK"
    for f in "${FILES[@]}"; do fetch "$ref" "$f" "$tmp/$f"; done
    for f in "${FILES[@]}"; do
        mv "$tmp/$f" "$f"
        echo "$f restored from ${CANONICAL_REPO}@${ref:0:12}"
    done
}

cmd_bump() {
    [ "$#" -le 1 ] || die "bump takes at most one ref"
    local old new tmp f
    old=$(pinned_ref)
    new=$(resolve_ref "${1:-main}")
    tmp="$WORK"
    # Fetch everything before touching anything, so a failed fetch leaves the
    # pin and every vendored copy exactly as they were.
    for f in "${VENDORED_FILES[@]}"; do fetch "$new" "$f" "$tmp/$f"; done
    for f in "${VENDORED_FILES[@]}"; do mv "$tmp/$f" "$f"; done
    printf '%s\n' "$new" >"$PIN_FILE"
    echo "pinned ${CANONICAL_REPO}@${new:0:12} (was ${old:0:12})"
}

case "${1:-}" in
check)
    shift
    cmd_check "$@"
    ;;
sync)
    shift
    cmd_sync "$@"
    ;;
bump)
    shift
    cmd_bump "$@"
    ;;
files) printf '%s\n' "${VENDORED_FILES[@]}" ;;
*) die "usage: scripts/vendored.sh {check|sync} [file...] | bump [ref] | files" ;;
esac
