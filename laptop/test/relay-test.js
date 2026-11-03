// Relay end-to-end: real relay server + mock board (same relay protocol as the Android app) + real laptop code.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { WebSocket } = require('ws');
const { RelayDirectory, lookupCode, dialRelay } = require('../lib/relay');
const { BoardConnection } = require('../lib/connection');

const PORT = 47950;
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (em, ...evs) => new Promise((r) => evs.forEach((e) => em.once(e, (...a) => r([e, ...a]))));

function mockBoard(id, secret) {
  const state = { code: null, frames: 0, tokens: {}, sessions: [] };
  const ctl = new WebSocket(`${URL}/ws/board?id=${id}&secret=${secret}&name=Teszt%20t%C3%A1bla`);
  ctl.on('message', (m) => {
    const [kind, arg] = m.toString().split('\t');
    if (kind === 'CODE') state.code = arg;
    if (kind !== 'SESSION') return;
    const s = new WebSocket(`${URL}/ws/accept?sid=${arg}&id=${id}&secret=${secret}`);
    state.sessions.push(s);
    let buf = Buffer.alloc(0), hello = false;
    s.on('message', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!hello) {
        const nl = buf.indexOf(10); if (nl < 0) return;
        const [, cid, tok] = buf.subarray(0, nl).toString().split('\t'); buf = buf.subarray(nl + 1); hello = true;
        state.tokens[cid] ||= 'tok-' + cid;
        setTimeout(() => s.send(Buffer.from(`OK\t${state.tokens[cid]}\n`)), tok === state.tokens[cid] ? 0 : 1600);
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0); if (buf.length < 4 + len) break;
        if (len) state.frames++; buf = buf.subarray(4 + len);
      }
    });
  });
  state.stop = () => { const s = state.sessions.at(-1); s.send(Buffer.from('BYE\n')); s.close(); };
  state.close = () => ctl.close();
  return state;
}

(async () => {
  const relay = spawn(process.execPath, [path.join(__dirname, '../../relay/server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE: path.join(os.tmpdir(), `kv-relay-${process.pid}.json`) },
    stdio: 'ignore',
  });
  try {
    await sleep(800);
    const board = mockBoard('board-test-0001', 'secret-secret-secret');
    await sleep(500);
    assert.match(board.code, /^\d{6}$/, 'board gets a pairing code');

    const dir = new RelayDirectory({ getUrl: () => URL, getIds: () => [], isEnabled: () => true });
    await dir.poll();
    assert.ok(dir.get('board-test-0001'), 'same-IP board listed');
    assert.strictEqual((await lookupCode(URL, board.code)).id, 'board-test-0001', 'code lookup');
    assert.strictEqual(await lookupCode(URL, '000000'), null);

    // a second board can't hijack the ID without the secret
    const evil = new WebSocket(`${URL}/ws/board?id=board-test-0001&secret=wrong-wrong-wrong-wrong`);
    const [, code] = await once(evil, 'close');
    assert.strictEqual(code, 4403, 'wrong secret rejected');

    const mk = (token) => new BoardConnection({ dial: () => dialRelay(URL, 'board-test-0001'), clientId: 'L1', clientName: 'Laptop', token });
    let c = mk(); let waited = false; c.on('waiting', () => (waited = true)); c.connect();
    const [ev, tok] = await once(c, 'ready', 'closed'); assert.strictEqual(ev, 'ready'); assert.ok(waited);
    for (let i = 0; i < 20; i++) await c.sendFrame(Buffer.from([0xff, 0xd8, i, 0xff, 0xd9]));
    await sleep(300); assert.strictEqual(board.frames, 20, 'frames through relay');
    c.close(); await sleep(200);

    c = mk(tok); c.connect(); assert.strictEqual((await once(c, 'ready', 'closed'))[0], 'ready', 'token reconnect');
    const end = once(c, 'bye', 'closed'); board.stop(); assert.strictEqual((await end)[0], 'bye', 'board stop');

    board.close(); await sleep(300);
    const off = new BoardConnection({ dial: () => dialRelay(URL, 'board-test-0001'), clientId: 'L1', clientName: 'Laptop' });
    off.connect(); const [e2, , wasReady] = await once(off, 'ready', 'closed');
    assert.strictEqual(e2, 'closed'); assert.strictEqual(wasReady, false, 'offline board → closed, not ready');
    console.log('relay test OK');
  } finally {
    relay.kill();
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
