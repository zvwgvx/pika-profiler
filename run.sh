#!/usr/bin/env bash
set -euo pipefail

cd "$HOME/pika-profiler"

# Fall back to the local Node.js install when node is not on PATH
if ! command -v node >/dev/null 2>&1; then
  export PATH="$HOME/.local/node-v22.23.3-linux-x64/bin:$PATH"
fi

exec npm start
