#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/release/native/macos/Lekh Keyboard.app"
DEST="$HOME/Library/Input Methods/Lekh Keyboard.app"

if [[ ! -d "$APP" ]]; then
  echo "Missing dev input method bundle: $APP" >&2
  echo "Run: npm run package:macos:imk:dev" >&2
  exit 1
fi

"$(dirname "$0")/restore-system-keyboard.sh"
mkdir -p "$HOME/Library/Input Methods"
rm -rf "$DEST"
/usr/bin/ditto "$APP" "$DEST"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" || true
"$(dirname "$0")/restore-system-keyboard.sh"
open -gj "$DEST"
sleep 0.5
swift "$(dirname "$0")/register-dev.swift" "$DEST"
"$(dirname "$0")/restore-system-keyboard.sh"
echo "Installed Lekh Keyboard dev input method to: $DEST"
echo "Started the Lekh Keyboard IMK server app in the background."
echo "Lekh Keyboard was registered but not selected. Do not select it for daily typing until host-app smoke tests pass."
echo "For controlled native testing only: swift native/macos-imk/skeleton/register-dev.swift \"$DEST\" --select"
