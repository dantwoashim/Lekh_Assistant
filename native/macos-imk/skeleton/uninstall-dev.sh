#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/release/native/macos/Lekh Keyboard.imkdevbundle"
OLD_APP="$ROOT/release/native/macos/Lekh Keyboard Dev.imkdevbundle"
LEGACY_APP="$ROOT/release/native/macos/Lekh Keyboard.app"
DEST="$HOME/Library/Input Methods/Lekh Keyboard.app"
OLD_DEST="$HOME/Library/Input Methods/Lekh Keyboard Dev.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$(dirname "$0")/restore-system-keyboard.sh"
/usr/bin/swift "$(dirname "$0")/purge-lekh-input-sources.swift" >/dev/null 2>&1 || true
/usr/bin/swift "$(dirname "$0")/register-dev.swift" "$OLD_DEST" --disable >/dev/null 2>&1 || true
/usr/bin/swift "$(dirname "$0")/register-dev.swift" "$DEST" --disable >/dev/null 2>&1 || true
if [[ -d "$DEST" ]]; then
  "$LSREGISTER" -u "$DEST" >/dev/null 2>&1 || true
fi
if [[ -d "$OLD_DEST" ]]; then
  "$LSREGISTER" -u "$OLD_DEST" >/dev/null 2>&1 || true
fi
"$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
"$LSREGISTER" -u "$OLD_APP" >/dev/null 2>&1 || true
"$LSREGISTER" -u "$LEGACY_APP" >/dev/null 2>&1 || true
/usr/bin/pkill -x LekhInputMethodApp >/dev/null 2>&1 || true
rm -rf "$DEST" "$OLD_DEST"
/usr/bin/swift "$(dirname "$0")/purge-lekh-input-sources.swift" >/dev/null 2>&1 || true
echo "Removed Lekh Keyboard input methods from: $DEST and $OLD_DEST"
