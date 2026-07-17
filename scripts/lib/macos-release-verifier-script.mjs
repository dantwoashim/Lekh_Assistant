import { createHash } from "node:crypto";

function shellLiteral(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function minisignKeyFingerprint(publicKey) {
  return createHash("sha256").update(publicKey).digest("hex");
}

export function buildMacOSReleaseVerifierScript({ publicKey, signatureVerifierPath, signatureVerifierSha256 }) {
  if (typeof publicKey !== "string" || publicKey.length === 0 || /[\r\n]/u.test(publicKey)) {
    throw new TypeError("publicKey must be one non-empty line");
  }
  if (
    typeof signatureVerifierPath !== "string" ||
    signatureVerifierPath.length === 0 ||
    signatureVerifierPath.startsWith("/") ||
    signatureVerifierPath.split("/").includes("..") ||
    /[\r\n]/u.test(signatureVerifierPath)
  ) {
    throw new TypeError("signatureVerifierPath must be one safe relative path");
  }
  if (typeof signatureVerifierSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(signatureVerifierSha256)) {
    throw new TypeError("signatureVerifierSha256 must be one lowercase SHA-256 digest");
  }
  const fingerprint = minisignKeyFingerprint(publicKey);
  return `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")" || exit 1
SOURCE_RELEASE_DIR="$PWD"
VERIFY_LOCAL_TMP_ROOT="\${TMPDIR:-/tmp}"
VERIFY_LOCAL_TMP_ROOT="\${VERIFY_LOCAL_TMP_ROOT%/}"
PINNED_MINISIGN_PUBLIC_KEY=${shellLiteral(publicKey)}
PINNED_MINISIGN_KEY_SHA256=${shellLiteral(fingerprint)}
MANIFEST="RELEASE-MANIFEST.json"
SIGNATURE="RELEASE-MANIFEST.json.minisig"
CHECKSUMS="SHA256SUMS.txt"
PUBLIC_KEY_FILE="lekh-release-manifest-minisign.pub"
SIGNATURE_VERIFIER=${shellLiteral(`./${signatureVerifierPath}`)}
PINNED_SIGNATURE_VERIFIER_SHA256=${shellLiteral(signatureVerifierSha256)}
VERIFY_SNAPSHOT_ROOT=""
VERIFY_TMP=""

cleanup() {
  if [[ -n "$VERIFY_TMP" && "$VERIFY_TMP" == "$VERIFY_LOCAL_TMP_ROOT"/lekh-release-verify.* ]]; then
    /bin/rm -rf -- "$VERIFY_TMP"
  fi
  if [[ -n "$VERIFY_SNAPSHOT_ROOT" && "$VERIFY_SNAPSHOT_ROOT" == "$VERIFY_LOCAL_TMP_ROOT"/lekh-release-snapshot.* ]]; then
    /bin/rm -rf -- "$VERIFY_SNAPSHOT_ROOT"
  fi
}
trap cleanup EXIT

if [[ "\${LEKH_RELEASE_VERIFY_STAGED:-0}" != "1" ]]; then
  echo "Creating a private metadata-clean release snapshot before verification..."
  umask 077
  VERIFY_SNAPSHOT_ROOT="$(/usr/bin/mktemp -d "$VERIFY_LOCAL_TMP_ROOT/lekh-release-snapshot.XXXXXX")" || {
    echo "Lekh release verification FAILED: could not create a private verification snapshot" >&2
    exit 1
  }
  staged_release="$VERIFY_SNAPSHOT_ROOT/Lekh Keyboard Test Installer"
  /usr/bin/ditto --norsrc --noextattr --noacl "$SOURCE_RELEASE_DIR" "$staged_release" || {
    echo "Lekh release verification FAILED: could not copy the private verification snapshot" >&2
    exit 1
  }
  if LEKH_RELEASE_VERIFY_STAGED=1 /bin/bash "$staged_release/Verify Lekh Release.command"; then
    exit 0
  else
    child_status="$?"
    exit "$child_status"
  fi
fi

fail() {
  printf 'Lekh release verification FAILED: %s\n' "$1" >&2
  exit 1
}

for required in "$MANIFEST" "$SIGNATURE" "$CHECKSUMS" "$PUBLIC_KEY_FILE"; do
  [[ -f "$required" && ! -L "$required" ]] || fail "missing or unsafe $required"
done

[[ -f "$SIGNATURE_VERIFIER" && -x "$SIGNATURE_VERIFIER" && ! -L "$SIGNATURE_VERIFIER" ]] || fail "missing or unsafe bundled signature verifier"
signature_verifier_hash="$(/usr/bin/shasum -a 256 "$SIGNATURE_VERIFIER" | /usr/bin/awk '{print $1}')"
[[ "$signature_verifier_hash" == "$PINNED_SIGNATURE_VERIFIER_SHA256" ]] || fail "bundled signature-verifier fingerprint mismatch"

embedded_key="$(/usr/bin/awk 'NF { value=$0 } END { print value }' "$PUBLIC_KEY_FILE")"
[[ "$embedded_key" == "$PINNED_MINISIGN_PUBLIC_KEY" ]] || fail "embedded release key does not match the verifier's pinned key"
embedded_fingerprint="$(printf '%s' "$embedded_key" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
[[ "$embedded_fingerprint" == "$PINNED_MINISIGN_KEY_SHA256" ]] || fail "embedded release-key fingerprint mismatch"

echo "1/4 Verifying the signed release manifest with pinned key $PINNED_MINISIGN_KEY_SHA256..."
"$SIGNATURE_VERIFIER" "$MANIFEST" "$SIGNATURE" "$PINNED_MINISIGN_PUBLIC_KEY" >/dev/null || fail "release-manifest signature is invalid"
[[ "$(/usr/bin/plutil -extract schemaVersion raw -o - "$MANIFEST" 2>/dev/null || true)" == "1" ]] || fail "unsupported release-manifest schema"
[[ "$(/usr/bin/plutil -extract hashAlgorithm raw -o - "$MANIFEST" 2>/dev/null || true)" == "SHA-256" ]] || fail "unsupported release hash algorithm"

manifest_count="$(/usr/bin/plutil -extract files raw -o - "$MANIFEST" 2>/dev/null || true)"
[[ "$manifest_count" =~ ^[1-9][0-9]*$ ]] || fail "signed manifest has no file inventory"
VERIFY_TMP="$(/usr/bin/mktemp -d "$VERIFY_LOCAL_TMP_ROOT/lekh-release-verify.XXXXXX")" || fail "could not create private verification directory"
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
