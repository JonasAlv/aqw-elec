#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Compile TypeScript
./node_modules/.bin/tsc

# Launch Electron 11.5.0 with Pepper Flash & clean X11 environment
export ELECTRON_RUN_AS_NODE=""
export GDK_BACKEND="x11"

exec ./node_modules/.bin/electron . "$@" 2>&1 | grep -a -v -E "Fontconfig (error|warning)"
