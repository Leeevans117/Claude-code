#!/usr/bin/env bash
# Pulls the latest version of this repo and makes sure Premiere's CEP
# extensions folder points straight at it via a symlink - so after the
# first run of this script, updating is just "git pull" + restart
# Premiere, with no copying step at all.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/pip-toolkit"

if git -C "$SRC_DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "Pulling latest changes..."
  git -C "$SRC_DIR" pull
  echo "Now at commit: $(git -C "$SRC_DIR" rev-parse --short HEAD) - $(git -C "$SRC_DIR" log -1 --format=%s)"
else
  echo "WARNING: this folder isn't inside a git clone, so there's nothing to pull - using whatever is currently in this folder as-is. Nothing new was fetched."
fi

# Make sure the installed extension is a symlink to this folder, not a copy.
if [ -L "$DEST_DIR" ] && [ "$(readlink "$DEST_DIR")" = "$SRC_DIR" ]; then
  echo "Extensions folder already points here - nothing to relink."
else
  echo "Relinking extensions folder to this checkout..."
  rm -rf "$DEST_DIR"
  mkdir -p "$(dirname "$DEST_DIR")"
  ln -s "$SRC_DIR" "$DEST_DIR"
fi

echo "Clearing any quarantine flag on the source files..."
xattr -dr com.apple.quarantine "$SRC_DIR" 2>/dev/null || true

echo "Quitting Premiere Pro (reopen it manually after)..."
osascript -e 'tell application "Adobe Premiere Pro 2026" to quit' 2>/dev/null || true
sleep 2
pkill -f "Adobe Premiere Pro" 2>/dev/null || true

echo ""
echo "Done. Reopen Premiere Pro."
