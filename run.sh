#!/usr/bin/env bash
set -e
cd "$HOME/pika-profiler"
export PATH="$HOME/.local/node-v22.23.3-linux-x64/bin:$PATH"
exec npm start
