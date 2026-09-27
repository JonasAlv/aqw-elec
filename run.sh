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

# Electron's postinstall is blocked by npm's install-scripts policy AND
# extract-zip (used by install.js) silently fails on Node 26+.
# Workaround: find the cached zip (~/.cache/electron) and extract with system unzip.
if [ ! -f "node_modules/electron/dist/electron" ]; then
  echo "[aqw-elec] Electron binary missing — extracting from cache with unzip..."
  ELECTRON_VER=$(node -e "process.stdout.write(require('./node_modules/electron/package.json').version)")
  ELECTRON_ZIP="$HOME/.cache/electron/electron-v${ELECTRON_VER}-linux-x64.zip"

  # If not cached yet, trigger the download via install.js (it downloads even if extract fails)
  if [ ! -f "$ELECTRON_ZIP" ]; then
    echo "[aqw-elec] Downloading Electron v${ELECTRON_VER}..."
    node node_modules/electron/install.js 2>/dev/null || true
    # Also check the hashed subdirectory format used by newer @electron/get
    ELECTRON_ZIP_ALT=$(find "$HOME/.cache/electron" -name "electron-v${ELECTRON_VER}-linux-x64.zip" 2>/dev/null | head -1)
    [ -n "$ELECTRON_ZIP_ALT" ] && ELECTRON_ZIP="$ELECTRON_ZIP_ALT"
  fi

  if [ ! -f "$ELECTRON_ZIP" ]; then
    echo "[aqw-elec] ERROR: Could not find Electron zip at $ELECTRON_ZIP"
    exit 1
  fi

  rm -rf node_modules/electron/dist
  mkdir -p node_modules/electron/dist
  unzip -oq "$ELECTRON_ZIP" -d node_modules/electron/dist
  printf "electron" > node_modules/electron/path.txt
  chmod +x node_modules/electron/dist/electron
  echo "[aqw-elec] Electron v${ELECTRON_VER} ready."
fi

# Compile TypeScript
echo "[aqw-elec] Compiling TypeScript..."
./node_modules/.bin/tsc

# Launch Electron 11.5.0 with Pepper Flash & clean X11 environment
export ELECTRON_RUN_AS_NODE=""
export GDK_BACKEND="x11"

exec ./node_modules/.bin/electron . "$@" 2>&1 | grep -a -v -E "Fontconfig (error|warning)"
