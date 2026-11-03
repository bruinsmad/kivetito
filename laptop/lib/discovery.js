// Finds Kivetítő boards on the local network (UDP broadcast + optional manual IPs).
const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');

const UDP_PORT = 47801;
const DISCOVER = Buffer.from('KIVETITO_DISCOVER');
const EXPIRE_MS = 12000;

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const ip = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      out.add(ip.map((b, k) => (b | (~mask[k] & 255))).join('.'));
    }
  }
  return [...out];
}

class Discovery extends EventEmitter {
  constructor({ port = UDP_PORT, interval = 3000 } = {}) {
    super();
    this.port = port;
    this.interval = interval;
    this.boards = new Map(); // id -> {id, name, host, port, lastSeen}
    this.manualHosts = [];
    this.sock = null;
    this.timer = null;
  }

  start() {
    if (this.sock) return;
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('error', (e) => this.emit('log', 'udp error: ' + e.message));
    this.sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    this.sock.bind(0, () => {
      try { this.sock.setBroadcast(true); } catch {}
      this.probe();
      this.timer = setInterval(() => this.probe(), this.interval);
    });
  }

  stop() {
    clearInterval(this.timer);
    if (this.sock) try { this.sock.close(); } catch {}
    this.sock = null;
  }

  setManualHosts(hosts) { this.manualHosts = [...hosts]; this.probe(); }

  probe() {
    if (!this.sock) return;
    for (const addr of [...broadcastAddresses(), ...this.manualHosts]) {
      this.sock.send(DISCOVER, this.port, addr, () => {});
    }
    const now = Date.now();
    let changed = false;
    for (const [id, b] of this.boards) {
      if (now - b.lastSeen > EXPIRE_MS) { this.boards.delete(id); changed = true; }
    }
    if (changed) this.emit('change', this.list());
  }

  _onMessage(msg, rinfo) {
    const parts = msg.toString('utf8').split('\t');
    if (parts[0] !== 'KIVETITO' || parts.length < 4) return;
    const [, id, port, ...nameParts] = parts;
    const board = { id, name: nameParts.join(' ').trim() || rinfo.address, host: rinfo.address, port: Number(port), lastSeen: Date.now() };
    const prev = this.boards.get(id);
    this.boards.set(id, board);
    if (!prev || prev.name !== board.name || prev.host !== board.host) this.emit('change', this.list());
  }

  list() { return [...this.boards.values()].sort((a, b) => a.name.localeCompare(b.name, 'hu')); }
  get(id) { return this.boards.get(id); }
}

/** One-off unicast probe of a typed-in IP. Resolves to the board or null. */
function probeHost(host, timeoutMs = 2000, port = UDP_PORT) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const done = (v) => { clearTimeout(t); try { s.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done(null), timeoutMs);
    s.on('error', () => done(null));
    s.on('message', (msg, rinfo) => {
      const p = msg.toString('utf8').split('\t');
      if (p[0] === 'KIVETITO' && p.length >= 4) done({ id: p[1], port: Number(p[2]), name: p.slice(3).join(' '), host: rinfo.address });
    });
    s.send(DISCOVER, port, host, (e) => { if (e) done(null); });
  });
}

module.exports = { Discovery, probeHost, broadcastAddresses, UDP_PORT };
