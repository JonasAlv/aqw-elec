import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as crypto from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';

// ============================================================================
// 1. Pepper Flash Plugin & Security Trust
// ============================================================================

const ELEC_ROOT = path.resolve(__dirname, '../..');
const candidatePlugins = [
  path.join(ELEC_ROOT, 'plugins/libpepflashplayer.so'),
  '/home/me/Music/clean-ts-client/aqw-elec/plugins/libpepflashplayer.so',
  '/home/me/Music/skua-rewrite/aqw-elec/plugins/libpepflashplayer.so'
];

let flashPluginPath = candidatePlugins.find((p) => fs.existsSync(p)) || candidatePlugins[0];
console.log('[Main] Registering Pepper Flash Plugin:', flashPluginPath);

try {
  const initTrust = require('nw-flash-trust');
  const trustManager = initTrust.initSync('aqw-elec');
  trustManager.add(ELEC_ROOT);
  trustManager.add(path.join(ELEC_ROOT, 'assets'));
  trustManager.add(path.join(ELEC_ROOT, 'dist'));
  trustManager.add(path.join(ELEC_ROOT, 'src'));
  console.log('[Main] nw-flash-trust authorized directory:', ELEC_ROOT);
} catch (e) {
  console.warn('[Main] Warning: Could not initialize nw-flash-trust:', e);
}

app.commandLine.appendSwitch('ppapi-flash-path', flashPluginPath);
app.commandLine.appendSwitch('ppapi-flash-version', '32.0.0.465');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('allow-file-access-from-files');
app.commandLine.appendSwitch('allow-file-access');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// ============================================================================
// 2. Constants & Global State
// ============================================================================

const HTTP_PORT         = 8080;
const FLASH_BRIDGE_PORT = 4242;
const API_TCP_PORT      = 4243;   // Raw TCP (existing — unchanged)
const API_WS_PORT       = 4244;   // WebSocket (same protocol, easier DX)
const POLICY = '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" to-ports="*" /></cross-domain-policy>\0';

let mainWindow: BrowserWindow | null = null;

// Multi-instance Flash tracking — one socket per webview/tab
const flashSockets: Map<number, net.Socket> = new Map();
const socketToInstance: Map<net.Socket, number> = new Map();

function getNextInstanceId(): number {
  let id = 0;
  while (flashSockets.has(id)) {
    id++;
  }
  return id;
}

// ============================================================================
// 3. Per-client routing: maps request ID → the socket that made the request
//    so responses go back only to the right caller, not broadcast to everyone.
// ============================================================================

interface ApiClient {
  id: number;              // unique client ID
  write: (data: string) => void;
  isAlive: boolean;
}

let nextClientId = 1;
const apiClients: Map<number, ApiClient> = new Map();

/** Register a new API client (TCP or WS) and return its assigned ID */
function registerClient(writeFn: (data: string) => void): ApiClient {
  const client: ApiClient = { id: nextClientId++, write: writeFn, isAlive: true };
  apiClients.set(client.id, client);
  return client;
}

function removeClient(clientId: number) {
  apiClients.delete(clientId);
  // Clean up any pending requests for this client
  for (const [reqId, pending] of pendingRequests) {
    if (pending.clientId === clientId) pendingRequests.delete(reqId);
  }
}

// Maps JSON-RPC request ID → { clientId, instanceId } that sent it
interface PendingRequest { clientId: number; instanceId: number; }
const pendingRequests: Map<string | number, PendingRequest> = new Map();

/** Route a command from an API client → the correct Flash instance or handle host commands. */
function routeCommandToFlash(rawLine: string, senderClientId: number) {
  let instanceId = 0;
  let reqId: string | number | undefined;
  let parsedReq: any = null;
  try {
    parsedReq = JSON.parse(rawLine);
    instanceId = parsedReq.instanceId ?? 0;
    reqId = parsedReq.id;
  } catch (_) {}

  // ── Host-Level Commands (Electron native, non-invasive) ───────────────────
  if (parsedReq && parsedReq.type === 'CaptureScreenshot') {
    const client = apiClients.get(senderClientId);
    const outPath = parsedReq.path || '/tmp/aqw_screenshot.png';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.capturePage().then((image) => {
        fs.writeFileSync(outPath, image.toPNG());
        if (client && reqId != null) {
          client.write(JSON.stringify({ id: reqId, data: { success: true, path: outPath } }) + '\n');
        }
      }).catch((err) => {
        if (client && reqId != null) {
          client.write(JSON.stringify({ id: reqId, data: null, error: err.message }) + '\n');
        }
      });
    }
    return;
  }

  if (parsedReq && parsedReq.type === 'NewTab') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript('createTab(); true;').catch(() => {});
    }
    const client = apiClients.get(senderClientId);
    if (client && reqId != null) {
      client.write(JSON.stringify({ id: reqId, data: { success: true } }) + '\n');
    }
    return;
  }

  if (parsedReq && parsedReq.type === 'ToggleGrid') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript('toggleGrid(); true;').catch(() => {});
    }
    const client = apiClients.get(senderClientId);
    if (client && reqId != null) {
      client.write(JSON.stringify({ id: reqId, data: { success: true } }) + '\n');
    }
    return;
  }

  // ── Flash Commands ────────────────────────────────────────────────────────
  const targetSocket = flashSockets.get(instanceId);

  if (targetSocket && !targetSocket.destroyed) {
    if (reqId != null) pendingRequests.set(reqId, { clientId: senderClientId, instanceId });
    targetSocket.write(rawLine + '\n');
  } else {
    const client = apiClients.get(senderClientId);
    if (client && reqId != null) {
      client.write(JSON.stringify({ id: reqId, instanceId, data: null, error: `Instance ${instanceId} not connected` }) + '\n');
    }
  }
}

/** Dispatch a message FROM Flash → the correct API client(s), tagged with instanceId. */
function dispatchFromFlash(rawLine: string, fromSocket?: net.Socket) {
  // Attach instanceId to every response so external scripts know which account this is
  const instanceId = fromSocket ? (socketToInstance.get(fromSocket) ?? 0) : 0;
  let line = rawLine;
  let msgId: string | number | undefined;
  try {
    const msg = JSON.parse(rawLine);
    msg.instanceId = instanceId;
    msgId = msg.id;
    line = JSON.stringify(msg);
  } catch (_) {}

  if (msgId != null) {
    // Routed response — send back only to the requesting client
    const pending = pendingRequests.get(msgId);
    if (pending) {
      pendingRequests.delete(msgId);
      if (pending.instanceId === instanceId) {
        const client = apiClients.get(pending.clientId);
        if (client && client.isAlive) { client.write(line + '\n'); return; }
      }
    }
    return; // Client gone or mismatch — drop
  }

  // Event (no ID) — broadcast to all API clients
  for (const client of apiClients.values()) {
    if (client.isAlive) client.write(line + '\n');
  }
}

// ============================================================================
// 4. Dynamic HTTP Reverse-Proxy Server (Always pulls fresh from AE CDN)
// ============================================================================

const httpServer = http.createServer((req, res) => {
  const cleanUrl = (req.url || '/').split('?')[0];

  if (cleanUrl === '/' || cleanUrl === '/index.html') {
    const indexPath = path.join(ELEC_ROOT, 'src/renderer/index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
      });
      res.end(fs.readFileSync(indexPath));
      return;
    }
  }

  if (cleanUrl === '/bridge.swf' || cleanUrl.endsWith('/bridge.swf')) {
    const bridgePath = path.join(ELEC_ROOT, 'assets/bridge.swf');
    if (fs.existsSync(bridgePath)) {
      res.writeHead(200, {
        'Content-Type': 'application/x-shockwave-flash',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
      });
      res.end(fs.readFileSync(bridgePath));
      return;
    } else {
      // No bridge.swf found in assets/ — transparently fallback to official Artix Entertainment Loader3.swf!
      console.log('[HTTP Proxy] No bridge.swf found in assets/ -> Fallback to official AE Loader3.swf (Vanilla Mode)');
      res.writeHead(302, { 'Location': '/gamefiles/Loader3.swf?ver=a' });
      res.end();
      return;
    }
  }

  // The /game prefix is only correct for actual game assets.
  // Pages like /boklore/badges/ load root-level assets (/css/, /img/, /shared/, etc.)
  // that live at https://game.aq.com/<path> (no /game prefix).
  // Detect these and forward without the /game prefix.
  const ROOT_LEVEL_PREFIXES = ['/css/', '/img/', '/shared/', '/js/', '/fonts/', '/lore/', '/boklore/', '/help/', '/pages/', '/character', '/about', '/gamedesignnotes/'];
  const isRootLevelPath = ROOT_LEVEL_PREFIXES.some(prefix => (req.url || '/').startsWith(prefix));
  const targetUrl = isRootLevelPath
    ? 'https://game.aq.com' + req.url
    : 'https://game.aq.com/game' + req.url;

  if (isRootLevelPath) {
    console.log(`[HTTP Proxy] Root-level path: ${req.url} → ${targetUrl}`);
  }

  const reqHeaders: any = {
    ...req.headers,
    host: 'game.aq.com',
    referer: 'https://game.aq.com/game/',
    origin: 'https://game.aq.com'
  };
  delete reqHeaders['accept-encoding'];

  const proxyReq = https.request(
    targetUrl,
    { method: req.method, headers: reqHeaders, rejectUnauthorized: false },
    (proxyRes) => {
      const resHeaders = {
        ...proxyRes.headers,
        'access-control-allow-origin': '*',
        'cache-control': 'no-store, no-cache, must-revalidate, max-age=0'
      };
      delete resHeaders['content-encoding'];
      res.writeHead(proxyRes.statusCode || 200, resHeaders);
      proxyRes.pipe(res, { end: true });
    }
  );

  proxyReq.on('error', (err) => {
    console.error(`[Proxy ERROR] Failed fetching ${req.url}:`, err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Proxy Error: ' + err.message);
  });

  req.pipe(proxyReq, { end: true });
});

httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[HTTP Proxy] Dynamic CDN proxy listening on http://127.0.0.1:${HTTP_PORT}`);
});

// ============================================================================
// 5. Flash TCP Bridge Server (Port 4242) — Flash AS3 connects here
// ============================================================================

const flashServer = net.createServer((socket) => {
  socket.setNoDelay(true);
  let buffer = '';
  let instanceId = -1; // Assigned when Flash sends 'connected'

  socket.on('data', (chunk) => {
    const raw = chunk.toString();
    if (raw.includes('<policy-file-request/>')) {
      socket.write(POLICY);
      return;
    }

    buffer += raw;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === 'connected') {
          // If Flash sends a clientId like "tab-1", use that directly as instanceId (1 - 1 = 0)
          let assignedId = -1;
          if (msg.clientId && typeof msg.clientId === 'string' && msg.clientId.startsWith('tab-')) {
            const parsed = parseInt(msg.clientId.replace('tab-', ''), 10);
            if (!isNaN(parsed) && parsed >= 1) {
              assignedId = parsed - 1;
            }
          }
          if (assignedId === -1 || flashSockets.has(assignedId)) {
            assignedId = getNextInstanceId();
          }

          instanceId = assignedId;
          flashSockets.set(instanceId, socket);
          socketToInstance.set(socket, instanceId);
          console.log(`[Flash Bridge] Instance #${instanceId} connected (clientId: ${msg.clientId})`);
          // Tell Flash its assigned instanceId (optional, for debugging)
          socket.write(JSON.stringify({ type: 'instance_assigned', instanceId }) + '\n');
          // Broadcast to API clients
          dispatchFromFlash(JSON.stringify({ type: 'instance_connected', instanceId, clientId: msg.clientId }), socket);
          continue;
        } else if (msg.type === 'game_found') {
          console.log(`[Flash Bridge] Instance #${instanceId} game root found!`);
        } else if (msg.type === 'bridge_log') {
          console.log(`[Flash #${instanceId}] ${msg.msg}`);
          continue; // Don't forward logs to API clients
        }
      } catch (_) {}

      dispatchFromFlash(trimmed, socket);
    }
  });

  socket.on('close', () => {
    if (instanceId >= 0) {
      flashSockets.delete(instanceId);
      socketToInstance.delete(socket);
      console.log(`[Flash Bridge] Instance #${instanceId} disconnected`);
      dispatchFromFlash(JSON.stringify({ type: 'instance_disconnected', instanceId }));
    }
  });

  socket.on('error', (err) => {
    console.warn(`[Flash Bridge] Instance #${instanceId} error:`, err.message);
  });
});

flashServer.listen(FLASH_BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`[Flash Bridge] Listening on 127.0.0.1:${FLASH_BRIDGE_PORT}`);
});

// ============================================================================
// 6. External API — Raw TCP Server (Port 4243) — backward compatible
// ============================================================================

function handleApiSocketData(socket: net.Socket, client: ApiClient, chunk: Buffer, bufRef: { buf: string }) {
  bufRef.buf += chunk.toString();
  const lines = bufRef.buf.split('\n');
  bufRef.buf = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) routeCommandToFlash(trimmed, client.id);
  }
}

const apiTcpServer = net.createServer((socket) => {
  socket.setNoDelay(true);
  const writeFn = (data: string) => { if (!socket.destroyed) socket.write(data); };
  const client = registerClient(writeFn);
  const bufRef = { buf: '' };

  console.log(`[API TCP] Client #${client.id} connected`);

  socket.on('data', (chunk) => handleApiSocketData(socket, client, chunk, bufRef));

  socket.on('close', () => {
    client.isAlive = false;
    removeClient(client.id);
    console.log(`[API TCP] Client #${client.id} disconnected`);
  });

  socket.on('error', (err) => {
    console.warn(`[API TCP] Client #${client.id} error:`, err.message);
    client.isAlive = false;
    removeClient(client.id);
  });
});

apiTcpServer.listen(API_TCP_PORT, '127.0.0.1', () => {
  console.log(`[API TCP] External API bridge listening on 127.0.0.1:${API_TCP_PORT}`);
});

// ============================================================================
// 7. External API — WebSocket Server (Port 4244) — NEW: easier DX for scripts
//    Same exact protocol as TCP (newline-delimited JSON or raw JSON), over WS.
//    Use: new WebSocket("ws://localhost:4244")
// ============================================================================

const wsServer = new WebSocketServer({ port: API_WS_PORT, host: '127.0.0.1' });

wsServer.on('connection', (ws: WebSocket) => {
  const writeFn = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  };
  const client = registerClient(writeFn);
  console.log(`[API WS] Client #${client.id} connected`);

  ws.on('message', (message: Buffer | string) => {
    const raw = message.toString();
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) routeCommandToFlash(trimmed, client.id);
    }
  });

  ws.on('close', () => {
    client.isAlive = false;
    console.log(`[API WS] Client #${client.id} disconnected`);
    removeClient(client.id);
  });

  ws.on('error', (err) => {
    console.warn(`[API WS] Client #${client.id} error:`, err.message);
    client.isAlive = false;
    removeClient(client.id);
  });
});

console.log(`[API WS]  WebSocket API bridge listening on ws://127.0.0.1:${API_WS_PORT}`);

// ============================================================================
// 8. Electron Application Window (Zero Menus, Pure Game Display)
// ============================================================================

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 960,
    height: 588,           // 550px game + 38px unified titlebar
    frame: false,          // Frameless custom titlebar (merges tabs & window controls)
    resizable: true,
    useContentSize: true,
    title: 'aqw-elec',
    backgroundColor: '#0d0d0d',
    autoHideMenuBar: true,
    webPreferences: {
      plugins: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
      contextIsolation: false,
      nodeIntegration: true,  // Shell renderer needs it for webview & window control
      webviewTag: true        // Enable <webview> elements
    }
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-is-maximized', true);
    }
  });

  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-is-maximized', false);
    }
  });

  // Load the shell (tab manager) instead of the game directly.
  // Each tab in the shell creates its own <webview> which loads the game.
  const shellPath = path.join(ELEC_ROOT, 'src/renderer/shell.html');
  mainWindow.loadFile(shellPath);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Native Window Controls IPC Handlers ─────────────────────────────────────
ipcMain.on('window-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  try { httpServer.close(); } catch (_) {}
  try { flashServer.close(); } catch (_) {}
  try { apiTcpServer.close(); } catch (_) {}
  try { wsServer.close(); } catch (_) {}
  if (process.platform !== 'darwin') app.quit();
});
