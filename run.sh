#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Auto-install dependencies on first run (or after a fresh clone)
if [ ! -d "node_modules" ] || [ ! -f "node_modules/.bin/tsc" ]; then
  echo "[aqw-elec] node_modules missing or incomplete — installing dependencies..."
  npm install --legacy-peer-deps

  # Workaround: npm's resolver is broken on Node 26+ for some packages.
  # If ws failed to install via npm, fall back to npm pack + manual extraction.
  if [ ! -d "node_modules/ws" ]; then
    echo "[aqw-elec] Applying ws tarball workaround..."
    npm pack ws
    mkdir -p node_modules/ws
    tar -xzf ws-*.tgz -C node_modules/ws --strip-components=1
    rm -f ws-*.tgz
  fi

  if [ ! -d "node_modules/@types/ws" ]; then
    echo "[aqw-elec] Applying @types/ws tarball workaround..."
    npm pack @types/ws
    mkdir -p node_modules/@types/ws
    tar -xzf types-ws-*.tgz -C node_modules/@types/ws --strip-components=1
    rm -f types-ws-*.tgz
  fi

  echo "[aqw-elec] Dependencies ready."
fi

# npm blocks Electron's postinstall script by default on newer versions,
# which means the actual Electron binary never gets downloaded.
# Detect this and run the install script manually.
if [ ! -f "node_modules/electron/dist/electron" ]; then
  echo "[aqw-elec] Electron binary missing — running postinstall manually..."
  node node_modules/electron/install.js
fi

# Compile TypeScript
echo "[aqw-elec] Compiling TypeScript..."
./node_modules/.bin/tsc

# Launch Electron 11.5.0 with Pepper Flash & clean X11 environment
export ELECTRON_RUN_AS_NODE=""
export GDK_BACKEND="x11"

exec ./node_modules/.bin/electron . "$@" 2>&1 | grep -a -v -E "Fontconfig (error|warning)"
