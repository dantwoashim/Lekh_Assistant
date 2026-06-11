#!/usr/bin/env bash
set -euo pipefail

DEST="$HOME/Library/Input Methods/Lekh Keyboard.app"
"$(dirname "$0")/restore-system-keyboard.sh"
rm -rf "$DEST"
echo "Removed Lekh Keyboard dev input method from: $DEST"
