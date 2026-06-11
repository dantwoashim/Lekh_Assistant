#!/usr/bin/env bash
set -euo pipefail

swift "$(dirname "$0")/restore-system-keyboard.swift"
