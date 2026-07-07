#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STAGED_APP="${LEKH_MACOS_IMK_BUILD_DIR:-$HOME/Library/Caches/LekhKeyboardBuild/native/macos}/Lekh Keyboard.imkdevbundle"
RELEASE_APP="$ROOT/release/native/macos/Lekh Keyboard.imkdevbundle"
APP="$STAGED_APP"
if [[ ! -d "$APP" && -d "$RELEASE_APP" ]]; then
  APP="$RELEASE_APP"
fi
OLD_APP="$ROOT/release/native/macos/Lekh Keyboard Dev.imkdevbundle"
LEGACY_APP="$ROOT/release/native/macos/Lekh Keyboard.app"
DEST="$HOME/Library/Input Methods/Lekh Keyboard.app"
OLD_DEST="$HOME/Library/Input Methods/Lekh Keyboard Dev.app"
TMP_DEST="$HOME/Library/Input Methods/.Lekh Keyboard.app.installing.$$"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
cleanup() {
  rm -rf "$TMP_DEST"
}
trap cleanup EXIT

if [[ ! -d "$APP" ]]; then
  echo "Missing dev input method bundle: $STAGED_APP" >&2
  echo "Fallback path also missing: $RELEASE_APP" >&2
  echo "Run: npm run package:macos:imk:dev" >&2
  exit 1
fi

/usr/bin/pkill -x LekhInputMethodApp >/dev/null 2>&1 || true
mkdir -p "$HOME/Library/Input Methods"
if [[ -d "$OLD_DEST" ]]; then
  "$LSREGISTER" -u "$OLD_DEST" >/dev/null 2>&1 || true
fi
rm -rf "$TMP_DEST" "$OLD_DEST"
/usr/bin/ditto --norsrc --noextattr --noacl "$APP" "$TMP_DEST"
if [[ -d "$DEST" ]]; then
  /usr/bin/swift "$(dirname "$0")/atomic-install-swap.swift" "$TMP_DEST" "$DEST"
  "$LSREGISTER" -u "$TMP_DEST" >/dev/null 2>&1 || true
  rm -rf "$TMP_DEST"
else
  mv "$TMP_DEST" "$DEST"
fi
"$LSREGISTER" -u "$LEGACY_APP" >/dev/null 2>&1 || true
"$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
/bin/rm -rf "$LEGACY_APP" "$OLD_APP"
"$LSREGISTER" -f "$DEST" || true
swift "$(dirname "$0")/register-dev.swift" "$DEST"
echo "Installed Lekh Keyboard input method to: $DEST"
echo "Lekh Keyboard was registered and enabled, but not forced as the current keyboard."
echo "For controlled native testing only: swift native/macos-imk/skeleton/register-dev.swift \"$DEST\" --select"
