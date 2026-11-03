// Kivetítő relay – a laptop és a tábla is kifelé kapcsolódik ide (WebSocket), a relay összeköti őket.
// Futtatás a Mac minin: `npm install && node server.js` (alapból 127.0.0.1:8787, Caddy / Cloudflare Tunnel mögött).
//
// Tábla  → WS /ws/board?id&secret&name    állandó vezérlőkapcsolat; kap: "CODE\t<6 jegy>", "SESSION\t<sid>"
// Laptop → WS /ws/connect?board=<id>      a relay szól a táblának ("SESSION\t<sid>")
// Tábla  → WS /ws/accept?sid&id&secret    ezután a két WebSocket bájtjait változatlanul továbbítjuk
// Laptop → GET /api/boards?ids=a,b        online táblák: a kért azonosítók + az azonos nyilvános IP-ről érkezők
// Laptop → GET /api/lookup?code=123456    párosító kód → tábla
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'relay-data.json');
const MAX_PAYLOAD = 16 * 1024 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
const PENDING_TIMEOUT_MS = 15000;
const PENDING_BUFFER_MAX = 2 * 1024 * 1024;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ persistent store
let store = { boards: {} }; // id -> { secretHash, code, name }
try { store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); store.boards ||= {}; } catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function newCode() {
  const used = new Set(Object.values(store.boards).map((b) => b.code));
  let c;
  do { c = String(crypto.randomInt(100000, 1000000)); } while (used.has(c));
  return c;
}

// ------------------------------------------------------------------ live state
const boards = new Map();  // id -> { ws, name, ip, code }
const pending = new Map(); // sid -> { boardId, laptop, buf: [], bytes, timer, board }
const lookupHits = new Map();

function clientIp(req) {
  const ra = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ra === '127.0.0.1' || ra === '::1') { // behind Caddy / cloudflared: trust their headers
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return ra;
}

const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
const cleanName = (s) => String(s || '').replace(/[\t\r\n]/g, ' ').trim().slice(0, 60) || 'Tábla';

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ------------------------------------------------------------------ HTTP API
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`Kivetítő relay OK – ${boards.size} tábla online\n`);
  }
  if (url.pathname === '/api/boards') {
    const ip = clientIp(req);
    const ids = new Set((url.searchParams.get('ids') || '').split(',').filter(validId).slice(0, 200));
    const list = [];
    for (const [id, b] of boards) if (ids.has(id) || b.ip === ip) list.push({ id, name: b.name });
    return json(res, 200, list);
  }
  if (url.pathname === '/api/lookup') {
    const ip = clientIp(req);
    const now = Date.now();
    const h = lookupHits.get(ip) || { n: 0, reset: now + 10 * 60 * 1000 };
    if (now > h.reset) { h.n = 0; h.reset = now + 10 * 60 * 1000; }
    if (++h.n > 30) { lookupHits.set(ip, h); return json(res, 429, { error: 'too many attempts' }); }
    lookupHits.set(ip, h);
    const code = (url.searchParams.get('code') || '').replace(/\D/g, '');
    for (const [id, b] of boards) if (b.code === code) return json(res, 200, { id, name: b.name });
    return json(res, 404, { error: 'not found' });
  }
  json(res, 404, { error: 'not found' });
});

// ------------------------------------------------------------------ WebSockets
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (!['/ws/board', '/ws/connect', '/ws/accept'].includes(url.pathname)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    const p = url.searchParams;
    if (url.pathname === '/ws/board') onBoard(ws, req, p);
    else if (url.pathname === '/ws/connect') onLaptop(ws, req, p);
    else onAccept(ws, p);
  });
});

function checkBoard(id, secret) {
  if (!validId(id) || typeof secret !== 'string' || secret.length < 16 || secret.length > 128) return false;
  const rec = store.boards[id];
  return !rec || rec.secretHash === sha(secret);
}

function onBoard(ws, req, p) {
  const id = p.get('id'), secret = p.get('secret'), name = cleanName(p.get('name'));
  if (!checkBoard(id, secret)) return ws.close(4403, 'bad credentials');
  let rec = store.boards[id];
  if (!rec) { rec = store.boards[id] = { secretHash: sha(secret), code: newCode() }; }
  if (rec.name !== name) rec.name = name;
  save();

  const prev = boards.get(id);
  if (prev && prev.ws !== ws) prev.ws.close(4000, 'replaced');
  const entry = { ws, name, ip: clientIp(req), code: rec.code };
  boards.set(id, entry);
  ws.send('CODE\t' + rec.code);
  log('board online', id.slice(0, 8), JSON.stringify(name), entry.ip);

  ws.on('close', () => {
    if (boards.get(id) === entry) { boards.delete(id); log('board offline', id.slice(0, 8)); }
  });
}

function onLaptop(ws, req, p) {
  const id = p.get('board');
  const b = validId(id) && boards.get(id);
  if (!b) return ws.close(4404, 'board offline');
  const sid = crypto.randomBytes(16).toString('hex');
  const s = { boardId: id, laptop: ws, buf: [], bytes: 0, board: null };
  s.timer = setTimeout(() => { pending.delete(sid); ws.close(4408, 'board did not answer'); }, PENDING_TIMEOUT_MS);
  pending.set(sid, s);

  ws.on('message', (data, isBinary) => {
    if (s.board) return forward(ws, s.board, data, isBinary);
    s.buf.push([data, isBinary]);
    s.bytes += data.length;
    if (s.bytes > PENDING_BUFFER_MAX) ws.close(1009, 'too much data before board joined');
  });
  ws.on('close', () => {
    clearTimeout(s.timer);
    pending.delete(sid);
    if (s.board) s.board.close(1000);
  });
  b.ws.send('SESSION\t' + sid);
  log('session request', sid.slice(0, 8), '→', id.slice(0, 8), 'from', clientIp(req));
}

function onAccept(ws, p) {
  const sid = p.get('sid'), id = p.get('id'), secret = p.get('secret');
  const s = pending.get(sid);
  if (!s || s.boardId !== id || !store.boards[id] || store.boards[id].secretHash !== sha(secret)) {
    return ws.close(4404, 'no such session');
  }
  pending.delete(sid);
  clearTimeout(s.timer);
  s.board = ws;
  for (const [data, isBinary] of s.buf) ws.send(data, { binary: isBinary });
  s.buf = [];
  ws.on('message', (data, isBinary) => forward(ws, s.laptop, data, isBinary));
  ws.on('close', () => s.laptop.close(1000));
  log('session start', sid.slice(0, 8));
}

/** Forward one message; pause the sender's socket while the receiver is backed up. */
function forward(src, dst, data, isBinary) {
  if (dst.readyState !== WebSocket.OPEN) return;
  dst.send(data, { binary: isBinary });
  if (dst.bufferedAmount > HIGH_WATER && !src._kvPaused && src._socket) {
    src._kvPaused = true;
    src._socket.pause();
    const t = setInterval(() => {
      if (dst.bufferedAmount < LOW_WATER || dst.readyState !== WebSocket.OPEN) {
        clearInterval(t);
        src._kvPaused = false;
        if (src._socket) src._socket.resume();
      }
    }, 50);
  }
}

// Keep Cloudflare / NAT from dropping idle connections, and reap dead ones.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000).unref();

server.listen(PORT, HOST, () => log(`Kivetítő relay: http://${HOST}:${PORT}`));

module.exports = { server };
