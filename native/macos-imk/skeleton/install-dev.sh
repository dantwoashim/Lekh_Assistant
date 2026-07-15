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
LEGACY_BACKUP_ROOT="$HOME/Library/Application Support/Lekh Keyboard/InstallBackups"
ARCHIVE_BACKUP_ROOT="$HOME/Library/Application Support/Lekh Keyboard/InstallBackups.noindex"
RUNTIME_HEALTH="$HOME/Library/Application Support/Lekh Keyboard/runtime-health.v1.json"
cleanup() {
  rm -rf "$TMP_DEST"
}
trap cleanup EXIT

verify_bundle() {
  local bundle="$1"
  local executable="$bundle/Contents/MacOS/LekhInputMethodApp"
  local plist="$bundle/Contents/Info.plist"
  local required_resources=(
    "runtime-suggestions.lkb"
    "runtime-suggestions.json"
    "lekh-engine-contract.v1.json"
    "lekh-token-candidates.v1.json"
    "lekh-token-completions.v1.json"
    "lekh-token-completions.v1.manifest.json"
    "en.lproj/Localizable.strings"
    "ne.lproj/Localizable.strings"
  )
  local resource

  [[ -f "$plist" ]] || { echo "Bundle preflight failed: missing Info.plist in $bundle" >&2; return 1; }
  [[ -x "$executable" ]] || { echo "Bundle preflight failed: missing executable in $bundle" >&2; return 1; }
  /usr/bin/plutil -lint "$plist" >/dev/null || return 1
  [[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$plist" 2>/dev/null)" == "com.lekh.inputmethod.LekhKeyboard" ]] || {
    echo "Bundle preflight failed: unexpected CFBundleIdentifier in $bundle" >&2
    return 1
  }
  [[ "$(/usr/bin/plutil -extract InputMethodConnectionName raw -o - "$plist" 2>/dev/null)" == "com.lekh.inputmethod.LekhKeyboard_Connection" ]] || {
    echo "Bundle preflight failed: unexpected InputMethodConnectionName in $bundle" >&2
    return 1
  }
  for resource in "${required_resources[@]}"; do
    [[ -s "$bundle/Contents/Resources/$resource" ]] || {
      echo "Bundle preflight failed: missing or empty resource $resource in $bundle" >&2
      return 1
    }
  done
  /usr/bin/codesign --verify --deep --strict "$bundle" >/dev/null 2>&1 || {
    echo "Bundle preflight failed: code signature/resource seal is invalid in $bundle" >&2
    return 1
  }
}

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

stop_lekh_input_method_for_replacement() {
  local pids
  local remaining
  local attempt=0
  pids="$(/usr/bin/pgrep -x LekhInputMethodApp 2>/dev/null || true)"
  [[ -n "$pids" ]] || return 0

  # SIGTERM gives AppKit one bounded opportunity to unwind the IMK server.
  # SIGKILL is reserved for a process that would otherwise keep the bundle in
  # use while this explicit install operation replaces it.
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
  echo "Could not stop Lekh Keyboard process(es) before bundle replacement: $remaining" >&2
  return 1
}

archive_stale_lekh_bundles() {
  /bin/mkdir -p "$ARCHIVE_BACKUP_ROOT"
  /usr/bin/touch "$ARCHIVE_BACKUP_ROOT/.metadata_never_index"
  /usr/bin/find "$LEGACY_BACKUP_ROOT" -maxdepth 1 -type d -name 'Lekh Keyboard.app.backup.*' -print0 2>/dev/null |
    while IFS= read -r -d '' backup; do
      "$LSREGISTER" -u "$backup" >/dev/null 2>&1 || true
      backup_name="$(/usr/bin/basename "$backup")"
      archive="$ARCHIVE_BACKUP_ROOT/$backup_name.zip"
      if [[ -e "$archive" ]]; then
        archive="$ARCHIVE_BACKUP_ROOT/$backup_name.$$.zip"
      fi
      archive_tmp="$archive.installing"
      /bin/rm -f "$archive_tmp"
      if /usr/bin/ditto -c -k --norsrc --noextattr --keepParent "$backup" "$archive_tmp" >/dev/null 2>&1; then
        /bin/mv "$archive_tmp" "$archive"
        /bin/rm -rf "$backup"
      else
        /bin/rm -f "$archive_tmp"
      fi
    done
}

if [[ ! -d "$APP" ]]; then
  echo "Missing dev input method bundle: $STAGED_APP" >&2
  echo "Fallback path also missing: $RELEASE_APP" >&2
  echo "Run: npm run package:macos:imk:dev" >&2
  exit 1
fi

# Copy and verify a coherent snapshot before disabling or stopping the working
# input method. If packaging is concurrently publishing a new artifact, a
# mixed copy fails its resource seal here while the installed keyboard remains
# untouched and ABC remains available.
mkdir -p "$HOME/Library/Input Methods"
rm -rf "$TMP_DEST"
verify_bundle "$APP"
/usr/bin/ditto --norsrc --noextattr --noacl "$APP" "$TMP_DEST"
verify_bundle "$TMP_DEST"

/usr/bin/swift "$(dirname "$0")/restore-system-keyboard.swift" --snapshot >/dev/null 2>&1 || true
"$(dirname "$0")/restore-system-keyboard.sh" >/dev/null 2>&1 || true
/usr/bin/swift "$(dirname "$0")/register-dev.swift" "$DEST" --disable >/dev/null 2>&1 || true
/usr/bin/swift "$(dirname "$0")/purge-lekh-input-sources.swift" >/dev/null 2>&1 || true
stop_lekh_input_method_for_replacement
archive_stale_lekh_bundles
if [[ -d "$OLD_DEST" ]]; then
  "$LSREGISTER" -u "$OLD_DEST" >/dev/null 2>&1 || true
fi
rm -rf "$OLD_DEST"
if [[ -d "$DEST" ]]; then
  /usr/bin/swift "$(dirname "$0")/atomic-install-swap.swift" "$TMP_DEST" "$DEST"
  if ! verify_bundle "$DEST"; then
    echo "Installed-bundle verification failed; restoring the prior input method." >&2
    /usr/bin/swift "$(dirname "$0")/atomic-install-swap.swift" "$TMP_DEST" "$DEST" || true
    exit 1
  fi
  "$LSREGISTER" -u "$TMP_DEST" >/dev/null 2>&1 || true
  rm -rf "$TMP_DEST"
else
  mv "$TMP_DEST" "$DEST"
  if ! verify_bundle "$DEST"; then
    echo "Installed-bundle verification failed; removing the invalid first install while ABC remains available." >&2
    rm -rf "$DEST"
    exit 1
  fi
fi
"$LSREGISTER" -u "$LEGACY_APP" >/dev/null 2>&1 || true
"$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
/bin/rm -rf "$LEGACY_APP" "$OLD_APP"
archive_stale_lekh_bundles
"$LSREGISTER" -f "$DEST" || true
/usr/bin/swift "$(dirname "$0")/register-dev.swift" "$DEST"
/bin/rm -f "$RUNTIME_HEALTH"
echo "Installed Lekh Keyboard input method to: $DEST"
echo "Lekh Keyboard was registered and enabled, but not forced as the current keyboard."
echo "For controlled native testing only: swift native/macos-imk/skeleton/register-dev.swift \"$DEST\" --select-only"
