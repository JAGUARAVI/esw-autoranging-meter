#!/usr/bin/env bash
#
# push-both.sh — commit and push ESWCap to BOTH destinations with one command.
#
#   1. Personal repo:  the local repo's `origin`
#      (https://github.com/JAGUARAVI/esw-autoranging-meter)
#   2. Classroom repo: ESW-M26/esw-m26-51_praise_claude
#      mirrored into the subfolder `Code/capacitance`
#
# Usage:
#   ./push-both.sh                       # default commit message
#   ./push-both.sh "feat: my message"    # custom commit message
#
# Overridable via environment:
#   ESWCAP_CLASSROOM_REPO   (default https://github.com/ESW-M26/esw-m26-51_praise_claude.git)
#   ESWCAP_CLASSROOM_SUBDIR (default Code/capacitance)
#   ESWCAP_CLASSROOM_BRANCH (default main)
#   ESWCAP_CLASSROOM_CACHE  (default ~/.cache/eswcap-classroom)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MSG="${1:-sync: push from local ESWCap}"

CLASSROOM_REPO="${ESWCAP_CLASSROOM_REPO:-https://github.com/ESW-M26/esw-m26-51_praise_claude.git}"
CLASSROOM_SUBDIR="${ESWCAP_CLASSROOM_SUBDIR:-Code/capacitance}"
CLASSROOM_BRANCH="${ESWCAP_CLASSROOM_BRANCH:-main}"
CACHE="${ESWCAP_CLASSROOM_CACHE:-$HOME/.cache/eswcap-classroom}"

# Files/dirs never mirrored to the classroom copy (build caches, local IDE state).
RSYNC_EXCLUDES=(
  --exclude='.git'
  --exclude='.pio'
  --exclude='.venv'
  --exclude='__pycache__'
  --exclude='.vscode/c_cpp_properties.json'
  --exclude='.vscode/launch.json'
  --exclude='.vscode/ipch'
)

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# Make sure git has working GitHub credentials (uses the gh CLI login).
if command -v gh >/dev/null 2>&1; then
  gh auth setup-git >/dev/null 2>&1 || true
fi

say "1/2  Personal repo — commit & push"
cd "$REPO_ROOT"
PERSONAL_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "$MSG"
else
  echo "No local changes to commit."
fi
git push origin "$PERSONAL_BRANCH"

say "2/2  Classroom repo — mirror into $CLASSROOM_SUBDIR & push"
if [ -d "$CACHE/.git" ]; then
  git -C "$CACHE" fetch origin
  git -C "$CACHE" checkout "$CLASSROOM_BRANCH"
  git -C "$CACHE" reset --hard "origin/$CLASSROOM_BRANCH"
else
  mkdir -p "$(dirname "$CACHE")"
  git clone --branch "$CLASSROOM_BRANCH" "$CLASSROOM_REPO" "$CACHE"
fi

DEST="$CACHE/$CLASSROOM_SUBDIR"
mkdir -p "$DEST"
rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$REPO_ROOT/" "$DEST/"

cd "$CACHE"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "$MSG"
  git push origin "$CLASSROOM_BRANCH"
else
  echo "Classroom copy already up to date."
fi

say "Done — pushed to both repositories."