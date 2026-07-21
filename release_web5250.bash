#!/bin/bash
# Copyright 2026 by moshix. All rights reserved.
#
# Rebuild all web5250 binaries and publish them as a GitHub Release.
#
# Usage:   ./release_web5250.bash [version]
#          VERSION=1.3 ./release_web5250.bash
#
# Requirements:
#   - gh (GitHub CLI), authenticated:  https://cli.github.com  then  gh auth login
#   - this directory is a git clone of a GitHub repo (the release is created there;
#     override the target repo with  GH_REPO=owner/name  if you are not inside one)
set -euo pipefail

VERSION="${1:-${VERSION:-1.3}}"
TAG="v${VERSION}"

# ── preconditions ────────────────────────────────────────────────────────
command -v gh >/dev/null 2>&1 || {
    echo "error: gh (GitHub CLI) not found — install from https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || {
    echo "error: not logged in to GitHub — run 'gh auth login'" >&2; exit 1; }

# gh needs to know which repo to release into: either GH_REPO=owner/name, or a
# clone whose 'origin' points at GitHub.
REPO_ARGS=()
if [ -n "${GH_REPO:-}" ]; then
    REPO_ARGS=(--repo "$GH_REPO")
elif ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "error: not inside a git repo and GH_REPO is unset." >&2
    echo "       run inside a GitHub clone, or set GH_REPO=owner/name." >&2
    exit 1
fi

# ── 1. rebuild all binaries into bin/ ────────────────────────────────────
echo "==> Rebuilding binaries (version ${VERSION})..."
VERSION="$VERSION" ./build_web5250.bash

# collect the cross-compiled artifacts (the versioned files; not the bare binary)
shopt -s nullglob
ASSETS=(bin/web5250-"${VERSION}"-*)
if [ ${#ASSETS[@]} -eq 0 ]; then
    echo "error: no binaries found matching bin/web5250-${VERSION}-*" >&2; exit 1
fi
echo "==> Release assets:"
printf '      %s\n' "${ASSETS[@]}"

# ── 2. create or update the GitHub Release, uploading every binary ───────
NOTES="web5250 ${VERSION} — a browser-based 5250 (AS/400 / IBM i) terminal.

Pure-Go, self-contained binaries (no runtime dependencies). Download the one for
your OS/arch, then:

    ./web5250 -listen :8050 -host your-as400 -port 23

then open http://localhost:8050/web5250 in a browser."

if gh release view "$TAG" "${REPO_ARGS[@]}" >/dev/null 2>&1; then
    echo "==> Release ${TAG} already exists — uploading/replacing its assets..."
    gh release upload "$TAG" "${ASSETS[@]}" --clobber "${REPO_ARGS[@]}"
else
    echo "==> Creating release ${TAG}..."
    gh release create "$TAG" "${ASSETS[@]}" \
        --title "web5250 ${VERSION}" \
        --notes "$NOTES" \
        "${REPO_ARGS[@]}"
fi

URL="$(gh release view "$TAG" "${REPO_ARGS[@]}" --json url -q .url 2>/dev/null || true)"
echo "==> Done. ${URL:-release $TAG published}"
