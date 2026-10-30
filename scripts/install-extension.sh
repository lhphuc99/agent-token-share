#!/usr/bin/env bash
# Builds a fresh .vsix (via `bun run package`) and installs it into the local VS Code.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v code >/dev/null 2>&1; then
  echo "error: 'code' CLI not found on PATH." >&2
  echo "In VS Code: Cmd+Shift+P -> \"Shell Command: Install 'code' command in PATH\", then re-run this script." >&2
  exit 1
fi

bun run package

vsix="$(ls -t ./*.vsix | head -n1)"
echo "Installing $vsix ..."
code --install-extension "$vsix" --force

echo "Done. Run \"Developer: Reload Window\" in VS Code (Cmd+Shift+P) to activate the update."
