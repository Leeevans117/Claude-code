#!/usr/bin/env bash
# Installs (symlinks) this extension into Premiere Pro's CEP extensions
# folder on macOS, and enables unsigned-extension debug mode so an
# unsigned personal panel like this one is allowed to load.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/pip-toolkit"

mkdir -p "$HOME/Library/Application Support/Adobe/CEP/extensions"

if [ -e "$DEST_DIR" ] || [ -L "$DEST_DIR" ]; then
  echo "Removing existing install at: $DEST_DIR"
  rm -rf "$DEST_DIR"
fi

ln -s "$SRC_DIR" "$DEST_DIR"
echo "Symlinked $SRC_DIR -> $DEST_DIR"

# Files downloaded via a browser (e.g. a GitHub ZIP) get a macOS quarantine
# flag that makes Premiere silently skip the extension with no error
# anywhere. Clear it defensively - harmless if it isn't set.
xattr -dr com.apple.quarantine "$SRC_DIR" 2>/dev/null || true

for ver in 9 10 11 12 13; do
  defaults write "com.adobe.CSXS.$ver" PlayerDebugMode 1 2>/dev/null || true
done
echo "Enabled PlayerDebugMode for CSXS 9-13."

echo ""
echo "Done. Restart Premiere Pro, then open:"
echo "  Window > Extensions > PiP Toolkit"
