// Relay through the user's own server (bruinsma.lol): used when the school network blocks direct traffic.
const { EventEmitter } = require('events');
const { WebSocket, createWebSocketStream } = require('ws');

const POLL_MS = 5000;

const httpBase = (wsUrl) => String(wsUrl || '').trim().replace(/\/+$/, '').replace(/^ws(s?):/i, 'http$1:');
const wsBase = (wsUrl) => String(wsUrl || '').trim().replace(/\/+$/, '').replace(/^http(s?):/i, 'ws$1:');

/** Polls the relay for boards that are online (known IDs + boards behind the same public IP). */
class RelayDirectory extends EventEmitter {
  constructor({ getUrl, getIds, isEnabled }) {
    super();
    Object.assign(this, { getUrl, getIds, isEnabled });
    this.boards = new Map(); // id -> {id, name}
    this.online = false;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async poll() {
    if (!this.isEnabled() || !this.getUrl()) return this._set([], false);
    try {
      const ids = this.getIds().join(',');
      const res = await fetch(`${httpBase(this.getUrl())}/api/boards?ids=${encodeURIComponent(ids)}`,
        { signal: AbortSignal.timeout(4000), cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const list = await res.json();
      this._set(Array.isArray(list) ? list : [], true);
    } catch (e) {
      this._set([], false);
    }
  }

  _set(list, online) {
    const next = new Map(list.filter((b) => b && b.id).map((b) => [b.id, { id: b.id, name: String(b.name || 'Tábla') }]));
    const same = online === this.online && next.size === this.boards.size &&
      [...next].every(([id, b]) => this.boards.get(id)?.name === b.name);
    this.boards = next;
    this.online = online;
    if (!same) this.emit('change');
  }

  list() { return [...this.boards.values()]; }
  get(id) { return this.boards.get(id) || null; }
}

/** Pairing code shown on the board → {id, name} or null. */
async function lookupCode(relayUrl, code) {
  try {
    const res = await fetch(`${httpBase(relayUrl)}/api/lookup?code=${encodeURIComponent(code)}`,
      { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Opens a relayed byte stream to the board. Resolves to a Duplex once the WebSocket is open. */
function dialRelay(relayUrl, boardId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase(relayUrl)}/ws/connect?board=${encodeURIComponent(boardId)}`, {
      perMessageDeflate: false,
      handshakeTimeout: timeoutMs,
    });
    ws.once('open', () => {
      const stream = createWebSocketStream(ws);
      stream.on('error', () => {});
      // The ws duplex only ends its readable side on a remote close; make sure 'close' fires.
      ws.once('close', () => { if (!stream.destroyed) stream.destroy(); });
      resolve(stream);
    });
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error('relay HTTP ' + res.statusCode)));
  });
}

module.exports = { RelayDirectory, lookupCode, dialRelay, httpBase, wsBase };
