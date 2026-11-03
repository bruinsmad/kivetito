// One TCP session to a board: handshake, then length-prefixed JPEG frames.
const net = require('net');
const { EventEmitter } = require('events');

const KEEPALIVE_MS = 2000;
const CONNECT_TIMEOUT_MS = 5000;
const MAX_BUFFERED = 1024 * 1024; // drop frames rather than build up latency

/**
 * Events: 'waiting' (board is asking the teacher), 'ready' (token), 'denied', 'timeout',
 *         'bye' (board stopped / another laptop took over), 'closed' (unexpected drop, err)
 */
class BoardConnection extends EventEmitter {
  constructor({ host, port, clientId, clientName, token }) {
    super();
    Object.assign(this, { host, port, clientId, clientName, token: token || '-' });
    this.state = 'idle';
    this.socket = null;
    this.lastSend = 0;
    this.lastFrame = null;
    this._ended = false;
  }

  connect() {
    this.state = 'connecting';
    const sock = net.connect({ host: this.host, port: this.port });
    this.socket = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 5000);
    const connectTimer = setTimeout(() => sock.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
    let waitTimer = null;
    let buf = '';

    sock.on('connect', () => {
      clearTimeout(connectTimer);
      const clean = (s) => String(s).replace(/[\t\r\n]/g, ' ').slice(0, 60);
      sock.write(`KIVETITO 1\t${clean(this.clientId)}\t${clean(this.token)}\t${clean(this.clientName)}\n`);
      this.state = 'hello';
      // If the board doesn't answer at once, it's showing the "allow this laptop?" dialog.
      waitTimer = setTimeout(() => { if (this.state === 'hello') this.emit('waiting'); }, 1200);
    });

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
      clearTimeout(connectTimer); clearTimeout(waitTimer); clearInterval(this._ka);
      const wasLive = this.state === 'live' || this.state === 'hello' || this.state === 'connecting';
      this.state = 'closed';
      if (!this._ended && wasLive) this.emit('closed', this._err || null);
    });
  }

  _onLine(line) {
    if (this.state === 'hello') {
      if (line.startsWith('OK\t')) {
        this.token = line.slice(3);
        this.state = 'live';
        this._ka = setInterval(() => {
          if (Date.now() - this.lastSend >= KEEPALIVE_MS) this._write(Buffer.alloc(4));
        }, 500);
        this.emit('ready', this.token);
      } else {
        this._ended = true;
        this.emit(line === 'DENIED' ? 'denied' : line === 'TIMEOUT' ? 'timeout' : 'closed', new Error(line));
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

  /** Resolves when the frame has been handed to the OS (natural backpressure). */
  sendFrame(jpeg) {
    if (this.state !== 'live') return Promise.resolve(false);
    if (this.socket.writableLength > MAX_BUFFERED) return Promise.resolve(false);
    // Identical image (static slide): don't resend, keepalive covers it.
    if (this.lastFrame && this.lastFrame.equals(jpeg)) return Promise.resolve(false);
    this.lastFrame = jpeg;
    const header = Buffer.alloc(4);
    header.writeUInt32BE(jpeg.length, 0);
    this.socket.cork();
    this.socket.write(header);
    const p = this._write(jpeg);
    this.socket.uncork();
    return p;
  }

  close() {
    this._ended = true;
    clearInterval(this._ka);
    if (this.socket) this.socket.destroy();
    this.state = 'closed';
  }
}

module.exports = { BoardConnection };
