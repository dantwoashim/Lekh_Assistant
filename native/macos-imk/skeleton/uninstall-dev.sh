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

lekh_pid_is_running() {
  local pid="$1"
  local command_name
  command_name="$(/bin/ps -p "$pid" -o comm= 2>/dev/null | /usr/bin/tr -d '[:space:]')"
  command_name="${command_name##*/}"
  [[ "$command_name" == "LekhInputMethodApp" ]]
}

remaining_lekh_pids() {
  local pid
  for pid in "$@"; do
    if lekh_pid_is_running "$pid"; then
      printf '%s ' "$pid"
    fi
  done
}

stop_lekh_input_method_for_removal() {
  local pids
  local remaining
  local attempt=0
  pids="$(/usr/bin/pgrep -x LekhInputMethodApp 2>/dev/null || true)"
  [[ -n "$pids" ]] || return 0

  /bin/kill -TERM $pids >/dev/null 2>&1 || true
  while (( attempt < 30 )); do
    remaining="$(remaining_lekh_pids $pids)"
    [[ -z "$remaining" ]] && return 0
    /bin/sleep 0.1
    attempt=$((attempt + 1))
  done

  echo "Lekh Keyboard did not exit after SIGTERM; forcing only the remaining process(es): $remaining" >&2
  /bin/kill -KILL $remaining >/dev/null 2>&1 || true
  attempt=0
  while (( attempt < 20 )); do
    remaining="$(remaining_lekh_pids $remaining)"
    [[ -z "$remaining" ]] && return 0
    /bin/sleep 0.1
    attempt=$((attempt + 1))
  done
  echo "Could not stop Lekh Keyboard process(es) before bundle removal: $remaining" >&2
  return 1
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
