#!/usr/bin/env bash
set -euo pipefail

# TUI Pixel Agents — build and run script
# Renders Claude Code agents as animated pixel art characters in your terminal.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing root dependencies..."
  npm install
fi

if [ ! -d "tui/node_modules" ]; then
  echo "Installing TUI dependencies..."
  cd tui && npm install && cd ..
fi

# Build the TUI
echo "Building TUI..."
cd tui && npm run build && cd ..

# Run, passing all arguments through
echo "Starting TUI Pixel Agents..."
exec node tui/dist/index.js "$@"
