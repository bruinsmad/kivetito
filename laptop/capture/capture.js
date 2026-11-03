// Runs in a hidden window: grabs the screen and hands JPEG frames to the main process.
let stream = null, running = false;
let settings = { fps: 10, maxWidth: 1920, quality: 0.7 };

const canvas = new OffscreenCanvas(1, 1);
const ctx = canvas.getContext('2d', { alpha: false });

async function encode(frame) {
  const w = frame.displayWidth, h = frame.displayHeight;
  const scale = Math.min(1, settings.maxWidth / w);
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  ctx.drawImage(frame, 0, 0, cw, ch);
  frame.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: settings.quality });
  return new Uint8Array(await blob.arrayBuffer());
}

async function loop(track) {
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  let last = 0, busy = false;
  while (running) {
    const { value: frame, done } = await reader.read();
    if (done) break;
    const now = performance.now();
    if (busy || now - last < 1000 / settings.fps) { frame.close(); continue; }
    last = now; busy = true;
    encode(frame)
      .then((jpeg) => running && window.kv.sendFrame(jpeg)) // resolves when written to the socket
      .catch((e) => console.error(e))
      .finally(() => { busy = false; });
  }
  try { reader.releaseLock(); } catch {}
}

async function start(s) {
  stop();
  settings = { ...settings, ...s };
  try {
    // The main process answers this without any picker (setDisplayMediaRequestHandler).
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  } catch (e) {
    window.kv.captureError(String(e && e.message || e));
    return;
  }
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => { stop(); window.kv.captureError('ended'); });
  running = true;
  loop(track);
}

function stop() {
  running = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

window.kv.onStart(start);
window.kv.onStop(stop);
window.kv.onSettings((s) => { settings = { ...settings, ...s }; });
