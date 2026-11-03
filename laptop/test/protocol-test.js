// Self-contained protocol test: a mock board (same wire format as the Android app) + the real laptop code.
const net = require('net');
const dgram = require('dgram');
const assert = require('assert');
const { Discovery, probeHost } = require('../lib/discovery');
const { BoardConnection } = require('../lib/connection');

const TCP = 47900, UDP = 47901;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (em, ...evs) => new Promise((r) => evs.forEach((e) => em.once(e, (...a) => r([e, ...a]))));

function mockBoard({ approve = true } = {}) {
  const tokens = {}; const frames = []; let active = null;
  const udp = dgram.createSocket('udp4');
  udp.on('message', (m, r) => { if (m.toString() === 'KIVETITO_DISCOVER') udp.send(`KIVETITO\tb1\t${TCP}\tTeszt tábla`, r.port, r.address); });
  udp.bind(UDP);
  const srv = net.createServer((s) => {
    let buf = Buffer.alloc(0), hello = false;
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!hello) {
        const nl = buf.indexOf(10); if (nl < 0) return;
        const [v, id, tok] = buf.slice(0, nl).toString().split('\t'); buf = buf.slice(nl + 1); hello = true;
        assert.strictEqual(v, 'KIVETITO 1');
        const ok = tokens[id] === tok;
        setTimeout(() => {
          if (!ok && !approve) return s.end('DENIED\n');
          if (!ok) tokens[id] = 'tok-' + id;
          if (active) { active.write('BYE\n'); active.destroy(); }
          active = s; s.write(`OK\t${tokens[id]}\n`);
        }, ok ? 0 : 1500);
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0); if (buf.length < 4 + len) break;
        if (len) frames.push(buf.slice(4, 4 + len)); buf = buf.slice(4 + len);
      }
    });
    s.on('error', () => {});
  }).listen(TCP);
  return { frames, close: () => { udp.close(); srv.close(); }, stop: () => { active.write('BYE\n'); active.destroy(); } };
}

(async () => {
  const board = mockBoard();
  const d = new Discovery({ port: UDP, interval: 300 }); d.setManualHosts(['127.0.0.1']); d.start();
  await sleep(800);
  assert.ok(d.list().some((b) => b.id === 'b1'), 'discovery'); d.stop();
  assert.strictEqual((await probeHost('127.0.0.1', 1000, UDP)).name, 'Teszt tábla');

  const mk = (id, token) => new BoardConnection({ host: '127.0.0.1', port: TCP, clientId: id, clientName: id, token });
  let a = mk('A'); let waited = false; a.on('waiting', () => (waited = true)); a.connect();
  const [ev, tok] = await once(a, 'ready', 'denied', 'closed');
  assert.strictEqual(ev, 'ready'); assert.ok(waited, 'waiting event before approval');
  const jpg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  assert.strictEqual(await a.sendFrame(jpg), true);
  assert.strictEqual(await a.sendFrame(Buffer.from(jpg)), false, 'identical frame skipped');
  await sleep(200); assert.strictEqual(board.frames.length, 1);
  a.close();

  a = mk('A', tok); a.connect(); assert.strictEqual((await once(a, 'ready', 'closed'))[0], 'ready');
  const aEnd = once(a, 'bye', 'closed');
  const b = mk('B'); b.connect(); assert.strictEqual((await once(b, 'ready'))[0], 'ready');
  assert.strictEqual((await aEnd)[0], 'bye', 'takeover sends BYE');
  const bEnd = once(b, 'bye', 'closed'); board.stop();
  assert.strictEqual((await bEnd)[0], 'bye', 'board stop sends BYE');
  board.close();
  console.log('protocol test OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
