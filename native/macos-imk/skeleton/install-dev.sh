#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/release/native/macos/Lekh Keyboard.imkdevbundle"
OLD_APP="$ROOT/release/native/macos/Lekh Keyboard Dev.imkdevbundle"
LEGACY_APP="$ROOT/release/native/macos/Lekh Keyboard.app"
DEST="$HOME/Library/Input Methods/Lekh Keyboard.app"
OLD_DEST="$HOME/Library/Input Methods/Lekh Keyboard Dev.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [[ ! -d "$APP" ]]; then
  echo "Missing dev input method bundle: $APP" >&2
  echo "Run: npm run package:macos:imk:dev" >&2
  exit 1
fi

/usr/bin/swift "$(dirname "$0")/register-dev.swift" "$OLD_DEST" --disable >/dev/null 2>&1 || true
/usr/bin/swift "$(dirname "$0")/register-dev.swift" "$DEST" --disable >/dev/null 2>&1 || true
/usr/bin/pkill -x LekhInputMethodApp >/dev/null 2>&1 || true
mkdir -p "$HOME/Library/Input Methods"
if [[ -d "$OLD_DEST" ]]; then
  "$LSREGISTER" -u "$OLD_DEST" >/dev/null 2>&1 || true
fi
if [[ -d "$DEST" ]]; then
  "$LSREGISTER" -u "$DEST" >/dev/null 2>&1 || true
fi
rm -rf "$DEST" "$OLD_DEST"
/usr/bin/ditto --norsrc --noextattr --noacl "$APP" "$DEST"
"$LSREGISTER" -u "$LEGACY_APP" >/dev/null 2>&1 || true
"$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
/bin/rm -rf "$LEGACY_APP" "$OLD_APP"
"$LSREGISTER" -f "$DEST" || true
swift "$(dirname "$0")/register-dev.swift" "$DEST"
echo "Installed Lekh Keyboard input method to: $DEST"
echo "Lekh Keyboard was registered and enabled, but not forced as the current keyboard."
echo "For controlled native testing only: swift native/macos-imk/skeleton/register-dev.swift \"$DEST\" --select"
