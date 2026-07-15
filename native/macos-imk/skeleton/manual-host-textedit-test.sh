#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$HOME/Library/Input Methods/Lekh Keyboard.app"
EXPECTED_CONNECTION_NAME="com.lekh.inputmethod.LekhKeyboard_Connection"
RESTORE="$ROOT/native/macos-imk/skeleton/restore-system-keyboard.sh"
REGISTER="$ROOT/native/macos-imk/skeleton/register-dev.swift"
LOG_DIR="$HOME/Library/Logs/LekhKeyboard"
LOG="$LOG_DIR/manual-host-textedit-oslog.log"
TESTFILE="/tmp/lekh-manual-host-textedit-test.txt"
DURATION="${1:-45}"
LOG_PID=""

if ! [[ "$DURATION" =~ ^[0-9]+$ ]] || [[ "$DURATION" -lt 5 ]]; then
  echo "Usage: $0 [seconds >= 5]" >&2
  exit 64
fi

if [[ ! -d "$APP" ]]; then
  echo "Missing installed Lekh Keyboard input method bundle: $APP" >&2
  echo "Run: npm run package:macos:imk:dev && native/macos-imk/skeleton/install-dev.sh" >&2
  exit 1
fi

CONNECTION_NAME="$(/usr/bin/plutil -extract InputMethodConnectionName raw -o - "$APP/Contents/Info.plist" 2>/dev/null || true)"
if [[ "$CONNECTION_NAME" != "$EXPECTED_CONNECTION_NAME" ]]; then
  echo "Installed IMK connection is invalid: expected $EXPECTED_CONNECTION_NAME, observed ${CONNECTION_NAME:-missing}." >&2
  exit 1
fi

cleanup() {
  "$RESTORE" >/dev/null 2>&1 || true
  if [[ -n "$LOG_PID" ]]; then
    /bin/kill "$LOG_PID" >/dev/null 2>&1 || true
  fi
  /bin/launchctl unsetenv LEKH_IMK_DEBUG_LOG >/dev/null 2>&1 || true
  /bin/launchctl unsetenv LEKH_IMK_DIAGNOSTICS >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

mkdir -p "$LOG_DIR"
/usr/bin/swift "$(dirname "$RESTORE")/restore-system-keyboard.swift" --snapshot >/dev/null 2>&1 || true
"$RESTORE"
rm -f "$LOG"
printf "" > "$TESTFILE"
REAL_TESTFILE="$(cd "$(dirname "$TESTFILE")" && pwd -P)/$(basename "$TESTFILE")"

/bin/launchctl setenv LEKH_IMK_DIAGNOSTICS 1
/usr/bin/log stream --style compact --predicate 'subsystem == "com.lekh.inputmethod.keyboard"' > "$LOG" 2>&1 &
LOG_PID="$!"
/usr/bin/open -a TextEdit "$TESTFILE"
sleep 1
/usr/bin/osascript \
  -e 'tell application "TextEdit" to activate' \
  -e "tell application \"TextEdit\" to if (path of front document) is not \"$REAL_TESTFILE\" then error \"Front TextEdit document is not the Lekh manual test file.\""

# Input methods must be started by TIS/imklaunchagent, never opened as normal
# applications. Selection is intentionally prompt-free and does not mutate
# registration or approval state.
/usr/bin/swift "$REGISTER" "$APP" --select-only
/usr/bin/osascript -e 'tell application "TextEdit" to activate'

echo "Lekh Keyboard is selected for $DURATION seconds."
echo "In the TextEdit window, physically type: swasthya then Space"
echo "Expected committed text: स्वास्थ्य "
echo "ABC will be restored automatically when the timer ends."
sleep "$DURATION"

"$RESTORE"
/bin/launchctl unsetenv LEKH_IMK_DEBUG_LOG
/bin/launchctl unsetenv LEKH_IMK_DIAGNOSTICS
if [[ -n "$LOG_PID" ]]; then
  /bin/kill "$LOG_PID" >/dev/null 2>&1 || true
  LOG_PID=""
fi
trap - EXIT INT TERM

ACTUAL="$(/usr/bin/osascript \
  -e "tell application \"TextEdit\" to if (path of front document) is \"$REAL_TESTFILE\" then get text of front document" \
  2>/dev/null || true)"

echo
echo "TextEdit test file: $TESTFILE"
echo "Observed TextEdit text:"
printf '%s\n' "$ACTUAL"
echo
echo "Recent IMK diagnostic log:"
if [[ -f "$LOG" ]]; then
  /usr/bin/tail -n 160 "$LOG"
else
  echo "No IMK diagnostic log was captured."
fi
