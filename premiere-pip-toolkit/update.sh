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

# IMPORTANT, and easy to get wrong: Premiere's CEP/ExtendScript engine for
# this panel stays loaded in memory for the life of the Premiere PROCESS,
# not for the life of the panel window. Closing and reopening the panel
# (Window > Extensions > PiP Toolkit) does NOT reload host/hostscript.jsx -
# it reuses the already-running engine and its already-defined functions,
# so edits on disk (even a completed git pull) silently have zero effect
# until Premiere itself is fully quit and relaunched as a new process. This
# has bitten this project before (see git log: update.sh's git-detection was
# once broken the same way - "looked updated" but was testing an old
# commit). So this script does not just ask Premiere to quit and hope: it
# confirms the process is actually gone before saying it's safe to reopen.
echo "Quitting Premiere Pro (a FULL app quit + relaunch is required - closing/reopening just the panel does not reload the updated script)..."
osascript -e 'tell application "Adobe Premiere Pro 2026" to quit' 2>/dev/null || true

QUIT_TIMEOUT_SEC=20
waited=0
while pgrep -f "Adobe Premiere Pro" > /dev/null 2>&1 && [ "$waited" -lt "$QUIT_TIMEOUT_SEC" ]; do
  sleep 1
  waited=$((waited + 1))
done

if pgrep -f "Adobe Premiere Pro" > /dev/null 2>&1; then
  echo "Still running after ${QUIT_TIMEOUT_SEC}s (likely stuck on an unsaved-changes dialog) - force-quitting..."
  pkill -f "Adobe Premiere Pro" 2>/dev/null || true
  sleep 2
fi

if pgrep -f "Adobe Premiere Pro" > /dev/null 2>&1; then
  echo ""
  echo "WARNING: Premiere Pro is STILL running and could not be confirmed quit."
  echo "Do not treat this update as applied yet - reopening the panel now would"
  echo "keep running the OLD script from before this update. Quit Premiere Pro"
  echo "manually (Cmd+Q), confirm no 'Adobe Premiere Pro' process remains"
  echo "(Activity Monitor, or: pgrep -f 'Adobe Premiere Pro'), then relaunch it."
  exit 1
fi

echo ""
echo "Confirmed Premiere Pro fully quit. Now relaunch it (a fresh process load is"
echo "what actually picks up the update - reopening just the panel is not enough)."
