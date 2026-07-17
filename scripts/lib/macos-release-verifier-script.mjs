import { createHash } from "node:crypto";

function shellLiteral(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function minisignKeyFingerprint(publicKey) {
  return createHash("sha256").update(publicKey).digest("hex");
}

export function buildMacOSReleaseVerifierScript({ publicKey }) {
  if (typeof publicKey !== "string" || publicKey.length === 0 || /[\r\n]/u.test(publicKey)) {
    throw new TypeError("publicKey must be one non-empty line");
  }
  const fingerprint = minisignKeyFingerprint(publicKey);
  return `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")" || exit 1
PINNED_MINISIGN_PUBLIC_KEY=${shellLiteral(publicKey)}
PINNED_MINISIGN_KEY_SHA256=${shellLiteral(fingerprint)}
MANIFEST="RELEASE-MANIFEST.json"
SIGNATURE="RELEASE-MANIFEST.json.minisig"
CHECKSUMS="SHA256SUMS.txt"
PUBLIC_KEY_FILE="lekh-release-manifest-minisign.pub"
VERIFY_TMP=""

cleanup() {
  if [[ -n "$VERIFY_TMP" && "$VERIFY_TMP" == "\${TMPDIR:-/tmp}"/lekh-release-verify.* ]]; then
    /bin/rm -rf -- "$VERIFY_TMP"
  fi
}
trap cleanup EXIT

fail() {
  printf 'Lekh release verification FAILED: %s\n' "$1" >&2
  exit 1
}

for required in "$MANIFEST" "$SIGNATURE" "$CHECKSUMS" "$PUBLIC_KEY_FILE"; do
  [[ -f "$required" && ! -L "$required" ]] || fail "missing or unsafe $required"
done

MINISIGN_BIN="$(command -v minisign || true)"
[[ -n "$MINISIGN_BIN" && -x "$MINISIGN_BIN" ]] || fail "minisign is required (brew install minisign)"

embedded_key="$(/usr/bin/awk 'NF { value=$0 } END { print value }' "$PUBLIC_KEY_FILE")"
[[ "$embedded_key" == "$PINNED_MINISIGN_PUBLIC_KEY" ]] || fail "embedded release key does not match the verifier's pinned key"
embedded_fingerprint="$(printf '%s' "$embedded_key" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
[[ "$embedded_fingerprint" == "$PINNED_MINISIGN_KEY_SHA256" ]] || fail "embedded release-key fingerprint mismatch"

echo "1/4 Verifying the signed release manifest with pinned key $PINNED_MINISIGN_KEY_SHA256..."
"$MINISIGN_BIN" -Vm "$MANIFEST" -x "$SIGNATURE" -P "$PINNED_MINISIGN_PUBLIC_KEY" >/dev/null || fail "release-manifest signature is invalid"
[[ "$(/usr/bin/plutil -extract schemaVersion raw -o - "$MANIFEST" 2>/dev/null || true)" == "1" ]] || fail "unsupported release-manifest schema"
[[ "$(/usr/bin/plutil -extract hashAlgorithm raw -o - "$MANIFEST" 2>/dev/null || true)" == "SHA-256" ]] || fail "unsupported release hash algorithm"

manifest_count="$(/usr/bin/plutil -extract files raw -o - "$MANIFEST" 2>/dev/null || true)"
[[ "$manifest_count" =~ ^[1-9][0-9]*$ ]] || fail "signed manifest has no file inventory"
VERIFY_TMP="$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/lekh-release-verify.XXXXXX")" || fail "could not create private verification directory"
expected_paths="$VERIFY_TMP/expected-paths.txt"
actual_paths="$VERIFY_TMP/actual-paths.txt"
expected_checksums="$VERIFY_TMP/expected-checksums.txt"
: > "$expected_paths"
: > "$expected_checksums"

echo "2/4 Verifying every file against the signed manifest..."
for ((index=0; index<manifest_count; index+=1)); do
  path="$(/usr/bin/plutil -extract "files.$index.path" raw -o - "$MANIFEST" 2>/dev/null || true)"
  bytes="$(/usr/bin/plutil -extract "files.$index.bytes" raw -o - "$MANIFEST" 2>/dev/null || true)"
  expected_hash="$(/usr/bin/plutil -extract "files.$index.sha256" raw -o - "$MANIFEST" 2>/dev/null || true)"
  [[ -n "$path" && "$path" != /* && "$path" != "." && "$path" != ".." && "$path" != ../* && "$path" != */../* && "$path" != */.. && "$path" != *$'\n'* ]] || fail "unsafe path in signed manifest"
  case "$path" in "$MANIFEST"|"$SIGNATURE"|"$CHECKSUMS") fail "signed payload inventory contains reserved metadata path $path" ;; esac
  [[ "$bytes" =~ ^[0-9]+$ && "$expected_hash" =~ ^[a-f0-9]{64}$ ]] || fail "invalid signed metadata for $path"
  target="./$path"
  [[ -f "$target" && ! -L "$target" ]] || fail "missing or unsafe signed file $path"
  actual_bytes="$(/usr/bin/stat -f '%z' "$target")"
  [[ "$actual_bytes" == "$bytes" ]] || fail "byte-size mismatch for $path"
  actual_hash="$(/usr/bin/shasum -a 256 "$target" | /usr/bin/awk '{print $1}')"
  [[ "$actual_hash" == "$expected_hash" ]] || fail "SHA-256 mismatch for $path"
  printf '%s\n' "$path" >> "$expected_paths"
  printf '%s  %s\n' "$expected_hash" "$path" >> "$expected_checksums"
done

echo "3/4 Enforcing the signed closed-world file inventory..."
unsafe_entry="$(/usr/bin/find . ! -type d ! -type f -print -quit)"
[[ -z "$unsafe_entry" ]] || fail "release contains a symlink or non-regular entry: $unsafe_entry"
/usr/bin/find . -type f -print | /usr/bin/sed 's#^\./##' | /usr/bin/awk '
  $0 == "RELEASE-MANIFEST.json" || $0 == "RELEASE-MANIFEST.json.minisig" || $0 == "SHA256SUMS.txt" { next }
  $0 == ".DS_Store" || $0 ~ /\\/.DS_Store$/ { next }
  { print }
' | LC_ALL=C /usr/bin/sort > "$actual_paths"
LC_ALL=C /usr/bin/sort -o "$expected_paths" "$expected_paths"
/usr/bin/cmp -s "$expected_paths" "$actual_paths" || fail "release has missing or unlisted files"

echo "4/4 Verifying the checksum sidecar is an exact copy of the signed inventory..."
/usr/bin/cmp -s "$expected_checksums" "$CHECKSUMS" || fail "SHA256SUMS.txt is not bound to the signed manifest"

echo "Lekh release verification passed."
if [[ "\${LEKH_RELEASE_VERIFY_NONINTERACTIVE:-0}" != "1" && -t 0 ]]; then
  read -r -p "Press Return to close this window..."
fi
`;
}
