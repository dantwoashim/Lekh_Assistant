#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/release/native/macos/Lekh Keyboard.imkdevbundle"
OLD_APP="$ROOT/release/native/macos/Lekh Keyboard Dev.imkdevbundle"
LEGACY_APP="$ROOT/release/native/macos/Lekh Keyboard.app"
DEST="$HOME/Library/Input Methods/Lekh Keyboard.app"
OLD_DEST="$HOME/Library/Input Methods/Lekh Keyboard Dev.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
LEGACY_BACKUP_ROOT="$HOME/Library/Application Support/Lekh Keyboard/InstallBackups"
ARCHIVE_BACKUP_ROOT="$HOME/Library/Application Support/Lekh Keyboard/InstallBackups.noindex"
RUNTIME_HEALTH="$HOME/Library/Application Support/Lekh Keyboard/runtime-health.v1.json"
TERMINATE_EXACT="$(dirname "$0")/terminate-exact-processes.swift"

stop_lekh_input_method_for_removal() {
  /usr/bin/swift "$TERMINATE_EXACT" --terminate-all-exact-path \
    "$DEST/Contents/MacOS/LekhInputMethodApp" >/dev/null
  /usr/bin/swift "$TERMINATE_EXACT" --terminate-all-exact-path \
    "$OLD_DEST/Contents/MacOS/LekhInputMethodApp" >/dev/null
}

unregister_stale_lekh_bundles() {
  /usr/bin/find "$LEGACY_BACKUP_ROOT" -maxdepth 1 -type d -name 'Lekh Keyboard.app.backup.*' -print0 2>/dev/null |
    while IFS= read -r -d '' backup; do
      "$LSREGISTER" -u "$backup" >/dev/null 2>&1 || true
    done
}
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
unregister_stale_lekh_bundles
stop_lekh_input_method_for_removal
rm -rf "$DEST" "$OLD_DEST"
/bin/rm -rf "$LEGACY_BACKUP_ROOT" "$ARCHIVE_BACKUP_ROOT"
/bin/rm -f "$RUNTIME_HEALTH"
/usr/bin/swift "$(dirname "$0")/purge-lekh-input-sources.swift" >/dev/null 2>&1 || true
echo "Removed Lekh Keyboard input methods from: $DEST and $OLD_DEST"
