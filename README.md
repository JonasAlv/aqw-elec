# aqw-elec

> A clean, stateless, multi-instance **AdventureQuest Worlds** desktop client built with **Electron 11.5.0 + Pepper Flash + TypeScript**.

Designed to be both a **blazing-fast, modern client for normal gameplay** and a **stateless host for custom API prototypes and multi-account automation**.

---

## Key Highlights

* ⚔ **Pure Vanilla Gameplay Out-of-the-box**: Plays the official, untouched AdventureQuest Worlds client via the official Artix Entertainment `Loader3.swf`.
* 🌐 **Always-Fresh CDN Streaming**: Uses a built-in transparent reverse-proxy (`http://127.0.0.1:8080`) that streams fresh game files directly from Artix Entertainment's live CDN on every launch. No stale disk caches, no manual game update downloads.
* 📑 **Multi-Account Tab System**: Run multiple accounts simultaneously inside a single window. Background tabs never freeze or disconnect.
* ⊞ **Live Grid View**: Tile all your active accounts in a synchronized 2×2, 3×2, or 3×3 grid with a single click or hotkey.
* 🔌 **Optional Developer API Bridge**: If a custom `bridge.swf` is placed in `assets/`, the client automatically lights up **WebSocket (`ws://127.0.0.1:4244`)** and **TCP (`127.0.0.1:4243`)** ports for external automation scripts.

---

## Architecture: How It Works

```
                                  Launch ./run.sh
                                         │
                   ┌─────────────────────▼─────────────────────┐
                   │               aqw-elec                    │
                   │   Electron 11.5.0 + Pepper Flash Engine   │
                   └─────────────────────┬─────────────────────┘
                                         │
                 Does assets/bridge.swf exist in client?
                                 /      \
                                /        \
                             YES          NO
                             /              \
               [ API Mode (Dev) ]        [ Vanilla Mode (Normal) ]
             Loads bridge.swf            Streams official Loader3.swf
             Exposes ports 4243/4244     directly from Artix CDN
             Ready for custom APIs       100% clean, authentic play
```

### 1. Dynamic CDN Reverse-Proxy (Port 8080)
Instead of bundling proprietary AQW game files or storing out-of-date `.swf` files locally:
1. `aqw-elec` launches an internal Node.js HTTP proxy on `127.0.0.1:8080`.
2. When the Flash game requests maps, monsters, items, or interface SWFs, the proxy forwards the request directly to `https://game.aq.com/game/...` with clean spoofed headers.
3. Every new release, weekly event, class rework, or server hotfix is reflected immediately on launch.

### 2. Multi-Account Sandboxing (Tabs & Grid)
* Each tab runs in an isolated Chromium `<webview>` with its own Pepper Flash plugin instance.
* Background tabs are kept alive with `visibility: hidden` rather than being unmounted. Your characters continue farming, resting, and staying connected in the background.
* Tab IDs and slot numbers are dynamic:
  * Closing all tabs resets the count back to `Client 1`.
  * Closing an individual tab automatically recycles that slot for the next tab.

---

## Playing Normally (Vanilla Gameplay)

If you are just using `aqw-elec` to play the game:

1. Clone or download the repository.
2. Run:
   ```bash
   ./run.sh
   ```
3. The client opens directly to the AQWorlds login screen.
4. Use the tab bar at the top or keyboard shortcuts to manage your accounts.

### Keyboard Shortcuts

| Shortcut | Action | Description |
|---|---|---|
| <kbd>Ctrl</kbd> + <kbd>T</kbd> | **New Tab** | Opens a new AQW client session |
| <kbd>Ctrl</kbd> + <kbd>W</kbd> | **Close Tab** | Closes the active client session |
| <kbd>Ctrl</kbd> + <kbd>G</kbd> | **Toggle Grid** | Switches between single Tab View and multi-account Grid View |
| <kbd>Ctrl</kbd> + <kbd>1</kbd>–<kbd>9</kbd> | **Switch Tab** | Instantly switches to client 1 through 9 |

---

## Developer / API Prototyping Mode

`aqw-elec` was architected to serve as a **stateless, headless/GUI driver** for experimental game APIs (TypeScript, Python, Rust, Go, etc.).

### Enabling API Mode
Simply compile or place your `bridge.swf` into `assets/bridge.swf`. On launch, the client automatically detects it and enables:

1. **WebSocket Server (`ws://127.0.0.1:4244`)**:
   Modern, zero-dependency JSON-RPC protocol. Supports browser clients, Node.js, Bun, Python `websockets`, Rust, etc.
2. **TCP Socket Server (`127.0.0.1:4243`)**:
   Newline-delimited JSON stream for raw socket connections.

### Multi-Instance Targeting
All API commands can be addressed to a specific open tab using `instanceId`:
```json
// Tab 1 (Client 1)
{ "instanceId": 0, "id": 1, "type": "GetState" }

// Tab 2 (Client 2)
{ "instanceId": 1, "id": 2, "type": "JoinMap", "map": "battleon" }
```

### Host-Level Commands (Non-Invasive)
The client provides built-in host actions that execute directly in Chromium without stealing window focus or touching OS keystrokes:
* **Silent In-Memory Screenshot**:
  ```json
  { "type": "CaptureScreenshot", "path": "/path/to/save.png" }
  ```
* **Remote Tab Management**:
  ```json
  { "type": "NewTab" }
  { "type": "ToggleGrid" }
  ```

---

## Prerequisites & Installation

### Requirements
* **Node.js**: v18+ (tested with v22 / v26)
* **Linux (X11 / Wayland via XWayland)**
* Pepper Flash Plugin: Included in `plugins/libpepflashplayer.so` (version 32.0.0.465)

### Setup
```bash
git clone https://github.com/<your-username>/aqw-elec.git
cd aqw-elec
npm install
./run.sh
```

---

## License & Disclaimer
This project is an independent open-source client utility. AdventureQuest Worlds and all related assets, game SWFs, and characters are trademarks and copyright of **Artix Entertainment, LLC**. This repository does not distribute proprietary game binaries; all game assets are streamed directly from Artix Entertainment's public content servers.
