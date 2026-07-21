#!/usr/bin/env bash
set -euo pipefail

for target in "$@"; do
  [[ -e "$target" ]] || continue
  if /usr/bin/xattr -p com.apple.quarantine "$target" >/dev/null 2>&1; then
    /usr/bin/printf '%s\n' "$target"
    exit 0
  fi
done

exit 1
