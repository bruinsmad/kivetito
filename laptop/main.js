// Kivetítő – laptop oldal. Tálca/menüsor ikon, egy kattintással kivetíti a képernyőt a táblára.
const {
  app, Tray, Menu, BrowserWindow, desktopCapturer, session, screen, ipcMain,
  Notification, globalShortcut, nativeImage, systemPreferences, dialog, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Discovery, probeHost } = require('./lib/discovery');
const { BoardConnection, dialTcp } = require('./lib/connection');
const { RelayDirectory, lookupCode, dialRelay, httpBase } = require('./lib/relay');

const APP_NAME = 'Kivetítő';
const SHORTCUT = 'CommandOrControl+Shift+K';
const isMac = process.platform === 'darwin';
const DEFAULT_RELAY = 'wss://kivetito.bruinsma.lol';
// Over the internet: cap the stream so a school uplink can keep up.
const RELAY_CAP = { fps: 8, maxWidth: 1600, quality: 0.65 };
const PRESETS = {
  low: { label: 'Alacsony (gyenge Wi-Fi)', fps: 8, maxWidth: 1280, quality: 0.6 },
  normal: { label: 'Normál (diák, dokumentum)', fps: 12, maxWidth: 1920, quality: 0.7 },
  high: { label: 'Magas (videó, animáció)', fps: 20, maxWidth: 1920, quality: 0.75 },
};

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('lol.bruinsma.kivetito');

// ------------------------------------------------------------------ config
const configPath = () => path.join(app.getPath('userData'), 'config.json');
let config = {};
function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { config = {}; }
  config.clientId ||= crypto.randomUUID();
  config.tokens ||= {};          // boardId -> token
  config.manualHosts ||= [];     // typed-in IPs
  config.knownBoards ||= {};     // boardId -> {name, host, port} (last seen)
  config.preset ||= 'normal';
  config.relayUrl ||= DEFAULT_RELAY;
  if (config.relayEnabled === undefined) config.relayEnabled = true;
  saveConfig();
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}
const clientName = () => os.hostname().replace(/\.local$/i, '');

// ------------------------------------------------------------------ state
let tray = null;
let captureWin = null;
const discovery = new Discovery();
const relayDir = new RelayDirectory({
  getUrl: () => config.relayUrl,
  getIds: () => Object.keys(config.knownBoards),
  isEnabled: () => !!config.relayEnabled,
});
const share = {
  boardId: null,     // which board we want to share to (null = not sharing)
  conn: null,
  transport: null,   // 'lan' | 'relay'
  status: 'idle',    // idle | connecting | waiting | live | reconnecting
  reconnectUntil: 0,
  reconnectTimer: null,
};

/** Everything we know about a board: name, LAN address (if any), whether the relay sees it. */
function boardInfo(id) {
  const lan = discovery.get(id);
  const relay = config.relayEnabled ? relayDir.get(id) : null;
  const known = config.knownBoards[id];
  if (!lan && !relay && !known) return null;
  return {
    id,
    name: lan?.name || relay?.name || known?.name || 'Tábla',
    host: lan?.host || known?.host || null,
    port: lan?.port || known?.port || 47800,
    lanSeen: !!lan,
    relayOnline: !!relay,
  };
}

function allBoards() {
  const ids = new Set([...discovery.list().map((b) => b.id), ...relayDir.list().map((b) => b.id)]);
  if (share.boardId) ids.add(share.boardId);
  return [...ids].map(boardInfo).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'hu'));
}

/** Transports to try, best first. */
function transportsFor(b) {
  const out = [];
  if (b.host) out.push('lan');           // seen on LAN, or a remembered / typed-in IP
  if (config.relayEnabled && config.relayUrl) out.push('relay');
  return out;
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: APP_NAME, body, silent: true }).show();
}

// ------------------------------------------------------------------ sharing
async function startShare(boardId) {
  stopShare({ quiet: true });
  const b = boardInfo(boardId);
  if (!b) { notify('A tábla most nem érhető el.'); return; }
  if (!(await ensureScreenPermission())) return;
  share.boardId = boardId;
  config.lastBoard = boardId;
  saveConfig();
  connect();
}

function connect(order = null, idx = 0) {
  const b = boardInfo(share.boardId);
  if (!b) return scheduleReconnect();
  order ||= transportsFor(b);
  if (idx >= order.length) return scheduleReconnect();
  const transport = order[idx];
  if (share.status !== 'reconnecting') share.status = 'connecting';
  updateTray();

  const conn = new BoardConnection({
    dial: transport === 'lan' ? () => dialTcp(b.host, b.port) : () => dialRelay(config.relayUrl, b.id),
    clientId: config.clientId, clientName: clientName(),
    token: config.tokens[share.boardId],
  });
  share.conn = conn;
  share.transport = transport;

  conn.on('waiting', () => {
    share.status = 'waiting'; updateTray();
    notify(`Engedélyezd a laptopot a táblán („${b.name}”).`);
  });
  conn.on('ready', (token) => {
    config.tokens[share.boardId] = token;
    const prev = config.knownBoards[share.boardId] || {};
    config.knownBoards[share.boardId] = {
      name: b.name,
      host: transport === 'lan' ? b.host : prev.host || null,
      port: b.port,
    };
    saveConfig();
    share.status = 'live';
    share.reconnectUntil = 0;
    updateTray();
    startCapture();
  });
  conn.on('denied', () => { stopShare({ quiet: true }); notify('A táblán elutasították a kapcsolatot.'); });
  conn.on('timeout', () => { stopShare({ quiet: true }); notify('Senki nem fogadta el a táblán. Próbáld újra.'); });
  conn.on('bye', () => { stopShare({ quiet: true }); notify('A kivetítés véget ért (a táblán leállították vagy más laptop vette át).'); });
  conn.on('closed', (_err, wasReady) => {
    if (share.conn !== conn) return;
    stopCapture();
    // Couldn't even get through this way (e.g. school network blocks LAN) → try the next transport now.
    if (!wasReady && idx + 1 < order.length) return connect(order, idx + 1);
    scheduleReconnect();
  });
  conn.connect();
}

/** Wi-Fi hiccup or board restart: keep trying for a minute. */
function scheduleReconnect() {
  if (!share.boardId) return;
  if (!share.reconnectUntil) share.reconnectUntil = Date.now() + 60_000;
  if (Date.now() > share.reconnectUntil) {
    const name = boardInfo(share.boardId)?.name || 'tábla';
    stopShare({ quiet: true });
    notify(`Megszakadt a kapcsolat: ${name}.`);
    return;
  }
  share.status = 'reconnecting';
  updateTray();
  clearTimeout(share.reconnectTimer);
  share.reconnectTimer = setTimeout(() => { discovery.probe(); relayDir.poll(); setTimeout(() => connect(), 500); }, 1500);
}

function stopShare({ quiet = false } = {}) {
  const wasSharing = !!share.boardId;
  clearTimeout(share.reconnectTimer);
  stopCapture();
  if (share.conn) share.conn.close();
  Object.assign(share, { boardId: null, conn: null, transport: null, status: 'idle', reconnectUntil: 0 });
  updateTray();
  if (wasSharing && !quiet) notify('Kivetítés leállítva.');
}

function toggleLast() {
  if (share.boardId) return stopShare();
  if (config.lastBoard && boardInfo(config.lastBoard)) return startShare(config.lastBoard);
  const boards = allBoards();
  if (boards.length === 1) return startShare(boards[0].id);
  notify(boards.length ? 'Válaszd ki a táblát a Kivetítő menüjében.' : 'Nem található tábla.');
  if (!isMac) tray.popUpContextMenu();
}

// ------------------------------------------------------------------ capture
function createCaptureWindow() {
  captureWin = new BrowserWindow({
    show: false,
    width: 200, height: 200,
    webPreferences: {
      preload: path.join(__dirname, 'capture', 'preload.js'),
      backgroundThrottling: false, // keep capturing while hidden
      contextIsolation: true,
      sandbox: true,
    },
  });
  captureWin.loadFile(path.join(__dirname, 'capture', 'capture.html'));
}

function captureSettings() {
  const p = PRESETS[config.preset] || PRESETS.normal;
  const s = { fps: p.fps, maxWidth: p.maxWidth, quality: p.quality };
  if (share.transport === 'relay') {
    s.fps = Math.min(s.fps, RELAY_CAP.fps);
    s.maxWidth = Math.min(s.maxWidth, RELAY_CAP.maxWidth);
    s.quality = Math.min(s.quality, RELAY_CAP.quality);
  }
  return s;
}

function startCapture() {
  captureWin.webContents.send('kv:start', captureSettings());
}
function stopCapture() { if (captureWin) captureWin.webContents.send('kv:stop'); }

ipcMain.handle('kv:frame', async (_e, jpeg) => {
  const conn = share.conn;
  if (!conn || share.status !== 'live') return false;
  return conn.sendFrame(Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength));
});

ipcMain.on('kv:capture-error', (_e, msg) => {
  if (!share.boardId) return;
  stopShare({ quiet: true });
  if (isMac) {
    dialog.showMessageBox({
      type: 'warning', message: 'Nem sikerült rögzíteni a képernyőt.',
      detail: 'Engedélyezd a Kivetítőnek a Képernyőfelvételt: Rendszerbeállítások → Adatvédelem és biztonság → Képernyő- és rendszerhangfelvétel, majd indítsd újra az alkalmazást.\n\n' + msg,
      buttons: ['Beállítások megnyitása', 'OK'],
    }).then((r) => { if (r.response === 0) openMacScreenSettings(); });
  } else {
    notify('Nem sikerült rögzíteni a képernyőt: ' + msg);
  }
});

function openMacScreenSettings() {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
}

async function ensureScreenPermission() {
  if (!isMac) return true;
  const st = systemPreferences.getMediaAccessStatus('screen');
  if (st === 'granted') return true;
  // Triggers the macOS prompt the first time.
  try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch {}
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return true;
  const r = await dialog.showMessageBox({
    type: 'info', message: 'A Kivetítőnek engedély kell a képernyő rögzítéséhez.',
    detail: 'Rendszerbeállítások → Adatvédelem és biztonság → Képernyő- és rendszerhangfelvétel: kapcsold be a Kivetítőt, majd indítsd újra az alkalmazást. Ezt csak egyszer kell megtenni.',
    buttons: ['Beállítások megnyitása', 'Mégse'],
  });
  if (r.response === 0) openMacScreenSettings();
  return false;
}

// ------------------------------------------------------------------ add board by IP
function promptForIp() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 380, height: 170, resizable: false, minimizable: false, maximizable: false,
      title: 'Tábla hozzáadása', alwaysOnTop: true, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'capture', 'preload.js'), contextIsolation: true, sandbox: true },
    });
    let done = false;
    const finish = (v) => { if (done) return; done = true; ipcMain.removeListener('kv:prompt', onSubmit); if (!win.isDestroyed()) win.close(); resolve(v); };
    const onSubmit = (e, v) => { if (e.sender === win.webContents) finish(v); };
    ipcMain.on('kv:prompt', onSubmit);
    win.on('closed', () => finish(null));
    win.loadFile(path.join(__dirname, 'capture', 'prompt.html'));
  });
}

/** Accepts the board's IP (same network) or its 6-digit code (via the relay). */
async function addBoard() {
  const input = await promptForIp();
  if (!input) return;
  const digits = input.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    if (!config.relayEnabled) config.relayEnabled = true;
    const b = await lookupCode(config.relayUrl, digits);
    if (!b) {
      dialog.showMessageBox({ type: 'warning', message: `Nincs online tábla ezzel a kóddal: ${digits}`,
        detail: 'Ellenőrizd a kódot a táblán (a Kivetítő képernyőjén látszik), és hogy a tábla kapcsolódik-e az internethez.' });
      return;
    }
    config.knownBoards[b.id] = { name: b.name, host: config.knownBoards[b.id]?.host || null, port: 47800 };
    saveConfig();
    await relayDir.poll();
    return startShare(b.id);
  }
  const b = await probeHost(input);
  if (!b) {
    dialog.showMessageBox({ type: 'warning', message: `Nem válaszol tábla ezen a címen: ${input}`,
      detail: 'Valószínűleg külön hálózaton vagytok. Írd be inkább a táblán látható 6 jegyű kódot – az interneten át is működik.' });
    return;
  }
  if (!config.manualHosts.includes(input)) config.manualHosts.push(input);
  config.knownBoards[b.id] = { name: b.name, host: b.host, port: b.port };
  saveConfig();
  discovery.setManualHosts(config.manualHosts);
  startShare(b.id);
}

// ------------------------------------------------------------------ tray
const icon = (name) => {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', name));
  return img;
};

function statusLabel() {
  const name = share.boardId ? (boardInfo(share.boardId)?.name || 'tábla') : '';
  switch (share.status) {
    case 'connecting': return `Kapcsolódás: ${name}…`;
    case 'waiting': return `Engedélyezd a táblán: ${name}`;
    case 'live': return `● Kivetítés: ${name}${share.transport === 'relay' ? ' (interneten át)' : ''}`;
    case 'reconnecting': return `Újrakapcsolódás: ${name}…`;
    default: return 'Nincs kivetítés';
  }
}

function updateTray() {
  if (!tray) return;
  const live = share.status === 'live';
  tray.setImage(live ? icon('tray-live.png') : icon(isMac ? 'trayTemplate.png' : 'tray.png'));
  tray.setToolTip(`${APP_NAME} – ${statusLabel()}`);

  const boards = allBoards();

  const displays = screen.getAllDisplays();
  const template = [
    { label: statusLabel(), enabled: false },
    ...(share.boardId ? [{ label: 'Kivetítés leállítása', accelerator: SHORTCUT, click: () => stopShare() }] : []),
    { type: 'separator' },
    { label: 'Táblák:', enabled: false },
    ...(boards.length
      ? boards.map((b) => ({
          label: b.name + (!b.lanSeen && b.relayOnline ? '  ☁' : '') + (config.tokens[b.id] ? '' : '  (első alkalommal engedélyezni kell)'),
          type: 'checkbox',
          checked: share.boardId === b.id,
          accelerator: share.boardId !== b.id && config.lastBoard === b.id ? SHORTCUT : undefined,
          click: () => (share.boardId === b.id ? stopShare() : startShare(b.id)),
        }))
      : [{ label: '   keresés…', enabled: false }]),
    { label: 'Tábla hozzáadása (kód vagy IP-cím)…', click: addBoard },
    { type: 'separator' },
    {
      label: 'Beállítások',
      submenu: [
        ...(displays.length > 1 ? [
          { label: 'Kivetített kijelző', enabled: false },
          ...displays.map((d, i) => ({
            label: `${i + 1}. kijelző (${d.size.width}×${d.size.height})${d.id === screen.getPrimaryDisplay().id ? ' – fő' : ''}`,
            type: 'radio',
            checked: String(config.displayId ?? screen.getPrimaryDisplay().id) === String(d.id),
            click: () => { config.displayId = d.id; saveConfig(); if (share.status === 'live') { stopCapture(); setTimeout(startCapture, 300); } },
          })),
          { type: 'separator' },
        ] : []),
        { label: 'Képminőség', enabled: false },
        ...Object.entries(PRESETS).map(([k, p]) => ({
          label: p.label, type: 'radio', checked: config.preset === k,
          click: () => {
            config.preset = k; saveConfig();
            captureWin.webContents.send('kv:settings', captureSettings());
          },
        })),
        { type: 'separator' },
        {
          label: `Relay használata (${httpBase(config.relayUrl).replace(/^https?:\/\//, '')})${config.relayEnabled ? (relayDir.online ? ' – elérhető' : ' – nem érhető el') : ''}`,
          type: 'checkbox', checked: !!config.relayEnabled,
          click: (item) => { config.relayEnabled = item.checked; saveConfig(); relayDir.poll(); updateTray(); },
        },
        {
          label: 'Indítás bejelentkezéskor', type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }),
        },
        {
          label: 'Mentett táblák és párosítások törlése',
          click: () => {
            stopShare({ quiet: true });
            Object.assign(config, { tokens: {}, manualHosts: [], knownBoards: {}, lastBoard: null });
            saveConfig(); discovery.setManualHosts([]); updateTray();
          },
        },
      ],
    },
    { label: `Gyorsbillentyű: ${isMac ? '⌘⇧K' : 'Ctrl+Shift+K'} (be/ki)`, enabled: false },
    { type: 'separator' },
    { label: 'Kilépés', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------ app lifecycle
app.whenReady().then(() => {
  loadConfig();
  if (isMac && app.dock) app.dock.hide();

  // No picker: always hand over the chosen screen.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const want = String(config.displayId ?? screen.getPrimaryDisplay().id);
      const src = sources.find((s) => s.display_id === want) || sources[0];
      callback(src ? { video: src } : {});
    } catch (e) {
      callback({});
    }
  }, { useSystemPicker: false });

  createCaptureWindow();

  tray = new Tray(icon(isMac ? 'trayTemplate.png' : 'tray.png'));
  if (!isMac) tray.on('click', () => tray.popUpContextMenu());
  updateTray();

  discovery.on('change', updateTray);
  discovery.setManualHosts(config.manualHosts);
  discovery.start();
  relayDir.on('change', updateTray);
  relayDir.start();

  globalShortcut.register(SHORTCUT, toggleLast);
  screen.on('display-added', updateTray);
  screen.on('display-removed', updateTray);

  if (!config.firstRunDone) {
    config.firstRunDone = true; saveConfig();
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    notify(`A Kivetítő a ${isMac ? 'menüsorban' : 'tálcán'} fut. Kattints az ikonra, és válaszd ki a táblát.`);
  }
});

app.on('second-instance', () => { if (!isMac) tray?.popUpContextMenu(); });
app.on('window-all-closed', (e) => e.preventDefault()); // tray app: stay alive
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopShare({ quiet: true }); discovery.stop(); relayDir.stop(); });
