// One session to a board: handshake, then length-prefixed JPEG frames.
// The byte stream is either a direct TCP socket or a relayed WebSocket (see lib/relay.js).
const net = require('net');
const { EventEmitter } = require('events');

const KEEPALIVE_MS = 2000;
const CONNECT_TIMEOUT_MS = 5000;
const MAX_BUFFERED = 1024 * 1024; // drop frames rather than build up latency

/** Direct TCP dialer. */
function dialTcp(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once('connect', () => {
      s.removeListener('error', reject);
      s.setNoDelay(true);
      s.setKeepAlive(true, 5000);
      resolve(s);
    });
    s.once('error', reject);
  });
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error('connect timeout')), ms); }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Events: 'waiting' (board is asking the teacher), 'ready' (token), 'denied', 'timeout',
 *         'bye' (board stopped / another laptop took over), 'closed' (err, wasReady)
 */
class BoardConnection extends EventEmitter {
  /** dial: () => Promise<Duplex>. Or pass {host, port} for direct TCP. */
  constructor({ dial, host, port, clientId, clientName, token }) {
    super();
    this.dial = dial || (() => dialTcp(host, port));
    Object.assign(this, { clientId, clientName, token: token || '-' });
    this.state = 'idle';
    this.socket = null;
    this.lastSend = 0;
    this.lastFrame = null;
    this.everReady = false;
    this._ended = false;
  }

  async connect() {
    this.state = 'connecting';
    let sock;
    try {
      sock = await withTimeout(this.dial(), CONNECT_TIMEOUT_MS);
    } catch (e) {
      this.state = 'closed';
      if (!this._ended) this.emit('closed', e, false);
      return;
    }
    if (this._ended) { sock.destroy(); return; }
    this.socket = sock;

    const clean = (s) => String(s).replace(/[\t\r\n]/g, ' ').slice(0, 60);
    sock.write(`KIVETITO 1\t${clean(this.clientId)}\t${clean(this.token)}\t${clean(this.clientName)}\n`);
    this.state = 'hello';
    // If the board doesn't answer at once, it's showing the "allow this laptop?" dialog.
    const waitTimer = setTimeout(() => { if (this.state === 'hello') this.emit('waiting'); }, 1500);

    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        this._onLine(line);
      }
    });
    sock.on('error', (e) => { this._err = e; });
    sock.on('close', () => {
      clearTimeout(waitTimer);
      clearInterval(this._ka);
      this.state = 'closed';
      if (!this._ended) this.emit('closed', this._err || null, this.everReady);
    });
  }

  _onLine(line) {
    if (this.state === 'hello') {
      if (line.startsWith('OK\t')) {
        this.token = line.slice(3);
        this.state = 'live';
        this.everReady = true;
        this._ka = setInterval(() => {
          if (Date.now() - this.lastSend >= KEEPALIVE_MS) this._write(Buffer.alloc(4));
        }, 500);
        this.emit('ready', this.token);
      } else {
        this._ended = true;
        this.emit(line === 'DENIED' ? 'denied' : line === 'TIMEOUT' ? 'timeout' : 'closed', new Error(line), false);
        this.socket.destroy();
      }
    } else if (line === 'BYE') {
      this._ended = true;
      this.emit('bye');
      this.socket.destroy();
    }
  }

  _write(buf) {
    this.lastSend = Date.now();
    return new Promise((resolve) => this.socket.write(buf, () => resolve(true)));
  }

  /** Resolves when the frame has been handed off (natural backpressure). */
  sendFrame(jpeg) {
    if (this.state !== 'live') return Promise.resolve(false);
    if (this.socket.writableLength > MAX_BUFFERED) return Promise.resolve(false);
    // Identical image (static slide): don't resend, keepalive covers it.
    if (this.lastFrame && this.lastFrame.equals(jpeg)) return Promise.resolve(false);
    this.lastFrame = jpeg;
    const frame = Buffer.allocUnsafe(4 + jpeg.length);
    frame.writeUInt32BE(jpeg.length, 0);
    jpeg.copy(frame, 4);
    return this._write(frame); // one write = one WebSocket message on the relay path
  }

  close() {
    this._ended = true;
    clearInterval(this._ka);
    if (this.socket) this.socket.destroy();
    this.state = 'closed';
  }
}

module.exports = { BoardConnection, dialTcp };
