package lol.bruinsma.kivetito.core;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Keeps the board registered at the relay and turns relayed sessions into {@link BoardServer.Conn}s.
 * Pure Java: the WebSocket implementation is injected (OkHttp on Android, java.net.http in tests).
 */
public final class RelayClient {

    // ---- injected WebSocket abstraction ----
    public interface Ws {
        void sendBinary(byte[] b, int off, int len);
        void close();
    }

    public interface WsListener {
        /** {@code self} is the same socket the factory returned, ready to use. */
        void onOpen(Ws self);
        void onText(String text);
        void onBinary(byte[] data);
        /** Called exactly once: on close or on failure (also when the connection never opened). */
        void onClosed(String reason);
    }

    public interface WsFactory {
        Ws connect(String url, WsListener listener);
    }

    public interface Listener {
        void onRelayStatus(boolean online, String code);
        void onLog(String msg);
    }

    private final BoardServer server;
    private final WsFactory factory;
    private final Listener listener;
    private final String boardId, secret;
    private volatile String baseUrl;
    private volatile String name;

    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "kv-relay");
        t.setDaemon(true);
        return t;
    });
    private volatile boolean running;
    private volatile int generation;
    private volatile Ws control;
    private volatile String code;
    private int backoffMs = 2000;

    public RelayClient(String baseUrl, String boardId, String secret, String name,
                       BoardServer server, WsFactory factory, Listener listener) {
        this.baseUrl = trim(baseUrl);
        this.boardId = boardId;
        this.secret = secret;
        this.name = name;
        this.server = server;
        this.factory = factory;
        this.listener = listener;
    }

    public void start() {
        running = true;
        exec.execute(this::connectControl);
    }

    public void stop() {
        running = false;
        generation++;
        Ws c = control;
        if (c != null) c.close();
        exec.shutdownNow();
    }

    /** Relay URL or board name changed: re-register now. */
    public void update(String newBaseUrl, String newName) {
        baseUrl = trim(newBaseUrl);
        name = newName;
        exec.execute(() -> {
            generation++;
            Ws old = control;
            control = null;
            if (old != null) old.close();
            backoffMs = 2000;
            connectControl();
        });
    }

    public String getCode() { return code; }

    // ------------------------------------------------------------------ control connection

    private void connectControl() {
        if (!running) return;
        String base = baseUrl;
        if (base.isEmpty()) { listener.onRelayStatus(false, null); return; }
        final int gen = ++generation;
        String url = base + "/ws/board?id=" + enc(boardId) + "&secret=" + enc(secret) + "&name=" + enc(name);
        try {
            factory.connect(url, new WsListener() {
                @Override public void onOpen(Ws self) {
                    if (gen != generation) { self.close(); return; }
                    control = self;
                    exec.execute(() -> backoffMs = 2000);
                    listener.onLog("relay connected");
                }

                @Override public void onText(String text) {
                    if (gen != generation) return;
                    String[] p = text.split("\t", 2);
                    if (p.length < 2) return;
                    if (p[0].equals("CODE")) {
                        code = p[1];
                        listener.onRelayStatus(true, code);
                    } else if (p[0].equals("SESSION")) {
                        openSession(p[1]);
                    }
                }

                @Override public void onBinary(byte[] data) {}

                @Override public void onClosed(String reason) {
                    if (gen != generation) return;
                    control = null;
                    listener.onRelayStatus(false, null);
                    listener.onLog("relay closed: " + reason);
                    scheduleReconnect();
                }
            });
        } catch (Exception e) {
            listener.onLog("relay connect failed: " + e);
            scheduleReconnect();
        }
    }

    private void scheduleReconnect() {
        if (!running) return;
        try {
            exec.schedule(this::connectControl, backoffMs, TimeUnit.MILLISECONDS);
            backoffMs = Math.min(backoffMs * 2, 30_000);
        } catch (Exception ignored) { /* executor shut down */ }
    }

    // ------------------------------------------------------------------ sessions

    private void openSession(String sid) {
        final RelayConn conn = new RelayConn();
        final AtomicBoolean started = new AtomicBoolean(false);
        String url = baseUrl + "/ws/accept?sid=" + enc(sid) + "&id=" + enc(boardId) + "&secret=" + enc(secret);
        try {
            factory.connect(url, new WsListener() {
                @Override public void onOpen(Ws self) {
                    conn.ws = self;
                    if (started.compareAndSet(false, true)) {
                        Thread t = new Thread(() -> server.handleConn(conn), "kv-relay-session");
                        t.setDaemon(true);
                        t.start();
                    }
                }
                @Override public void onText(String text) {}
                @Override public void onBinary(byte[] data) { conn.in.feed(data); }
                @Override public void onClosed(String reason) { conn.in.finish(); }
            });
        } catch (Exception e) {
            listener.onLog("relay session failed: " + e);
        }
    }

    static final class RelayConn implements BoardServer.Conn {
        final ChunkInputStream in = new ChunkInputStream(8 * 1024 * 1024);
        volatile Ws ws;
        private final OutputStream out = new OutputStream() {
            @Override public void write(int b) throws IOException { write(new byte[]{(byte) b}, 0, 1); }
            @Override public void write(byte[] b, int off, int len) throws IOException {
                Ws w = ws;
                if (w == null) throw new IOException("relay not open");
                w.sendBinary(b, off, len);
            }
        };

        @Override public InputStream in() { return in; }
        @Override public OutputStream out() { return out; }
        @Override public void setReadTimeout(int ms) { in.setTimeout(ms); }
        @Override public void close() {
            in.close();
            Ws w = ws;
            if (w != null) w.close();
        }
    }

    // ------------------------------------------------------------------ helpers

    private static String trim(String s) {
        s = s == null ? "" : s.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s == null ? "" : s, "UTF-8"); }
        catch (UnsupportedEncodingException e) { throw new RuntimeException(e); }
    }
}
