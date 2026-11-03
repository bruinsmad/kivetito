package lol.bruinsma.kivetito.core;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Pure-Java receiver core (no Android imports, so it can be tested on a desktop JVM).
 *
 * Discovery (UDP 47801): laptop broadcasts "KIVETITO_DISCOVER";
 *   board replies "KIVETITO\t<boardId>\t<tcpPort>\t<boardName>".
 * Session (TCP 47800):
 *   laptop → "KIVETITO 1\t<clientId>\t<token or ->\t<clientName>\n"
 *   board  → "OK\t<token>\n" | "DENIED\n" | "TIMEOUT\n"
 *   then laptop → repeated [int32 big-endian length][JPEG bytes]; length 0 = keepalive.
 * A newly authorised sender takes over from the previous one.
 */
public final class BoardServer {
    public static final int TCP_PORT = 47800;
    public static final int UDP_PORT = 47801;
    public static final String DISCOVER = "KIVETITO_DISCOVER";
    private static final int MAX_FRAME = 20 * 1024 * 1024;
    private static final int READ_TIMEOUT_MS = 12_000; // sender keepalive is every 2 s
    private static final int APPROVAL_TIMEOUT_S = 60;

    public interface Auth {
        boolean isTrusted(String clientId, String token);
        String issueToken(String clientId, String clientName);
    }

    /** Answer exactly once via {@link Approval#answer}. */
    public interface Approval { void answer(boolean allowed); }

    public interface Listener {
        void onApprovalRequest(String clientName, Approval approval);
        void onSessionStart(String clientName);
        /** Called on the reader thread; decode here, don't block for long. */
        void onFrame(byte[] jpeg, int length);
        void onSessionEnd();
        void onLog(String msg);
    }

    private final String boardId;
    private volatile String boardName;
    private final Auth auth;
    private final Listener listener;
    private final int tcpPort, udpPort;

    private final AtomicBoolean running = new AtomicBoolean(false);
    private ServerSocket server;
    private DatagramSocket udp;
    private final Object sessionLock = new Object();
    private Socket active; // guarded by sessionLock

    public BoardServer(String boardId, String boardName, Auth auth, Listener listener) {
        this(boardId, boardName, auth, listener, TCP_PORT, UDP_PORT);
    }

    public BoardServer(String boardId, String boardName, Auth auth, Listener listener, int tcpPort, int udpPort) {
        this.boardId = boardId;
        this.boardName = clean(boardName);
        this.auth = auth;
        this.listener = listener;
        this.tcpPort = tcpPort;
        this.udpPort = udpPort;
    }

    public void setBoardName(String name) { this.boardName = clean(name); }
    public String getBoardName() { return boardName; }

    public void start() throws IOException {
        if (!running.compareAndSet(false, true)) return;
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(tcpPort));
        udp = new DatagramSocket(null);
        udp.setReuseAddress(true);
        udp.setBroadcast(true);
        udp.bind(new InetSocketAddress(udpPort));
        thread("kv-accept", this::acceptLoop);
        thread("kv-discovery", this::discoveryLoop);
        listener.onLog("listening tcp " + tcpPort + " udp " + udpPort);
    }

    public void stop() {
        running.set(false);
        closeQuietly(server);
        if (udp != null) udp.close();
        synchronized (sessionLock) { closeQuietly(active); active = null; }
    }

    /** Ends the current session (e.g. teacher taps "stop" on the board). */
    public void disconnectActive() {
        synchronized (sessionLock) { sayByeAndClose(active); }
    }

    /** Tells the laptop to stop (so it doesn't auto-reconnect), then closes. */
    private static void sayByeAndClose(Socket s) {
        if (s == null) return;
        try { write(s.getOutputStream(), "BYE\n"); } catch (IOException ignored) {}
        closeQuietly(s);
    }

    // ---------- discovery ----------
    private void discoveryLoop() {
        byte[] buf = new byte[256];
        while (running.get()) {
            try {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                udp.receive(p);
                String msg = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8).trim();
                if (!msg.equals(DISCOVER)) continue;
                byte[] reply = ("KIVETITO\t" + boardId + "\t" + tcpPort + "\t" + boardName).getBytes(StandardCharsets.UTF_8);
                udp.send(new DatagramPacket(reply, reply.length, p.getSocketAddress()));
            } catch (IOException e) {
                if (running.get()) listener.onLog("udp: " + e.getMessage());
            }
        }
    }

    // ---------- sessions ----------
    private void acceptLoop() {
        while (running.get()) {
            try {
                Socket s = server.accept();
                thread("kv-session", () -> handle(s));
            } catch (IOException e) {
                if (running.get()) listener.onLog("accept: " + e.getMessage());
            }
        }
    }

    private void handle(Socket s) {
        boolean started = false;
        try {
            s.setTcpNoDelay(true);
            s.setSoTimeout(READ_TIMEOUT_MS);
            InputStream rawIn = new BufferedInputStream(s.getInputStream(), 256 * 1024);
            OutputStream out = s.getOutputStream();

            String[] hello = readLine(rawIn).split("\t", 4);
            if (hello.length < 4 || !hello[0].equals("KIVETITO 1")) { listener.onLog("bad hello"); return; }
            String clientId = hello[1], token = hello[2], clientName = clean(hello[3]);

            String grantedToken = token;
            if (!auth.isTrusted(clientId, token)) {
                s.setSoTimeout(0);
                CountDownLatch latch = new CountDownLatch(1);
                boolean[] allowed = {false};
                AtomicBoolean answered = new AtomicBoolean(false);
                listener.onApprovalRequest(clientName, ok -> {
                    if (answered.compareAndSet(false, true)) { allowed[0] = ok; latch.countDown(); }
                });
                if (!latch.await(APPROVAL_TIMEOUT_S, TimeUnit.SECONDS)) {
                    answered.set(true);
                    write(out, "TIMEOUT\n");
                    return;
                }
                if (!allowed[0]) { write(out, "DENIED\n"); return; }
                grantedToken = auth.issueToken(clientId, clientName);
                s.setSoTimeout(READ_TIMEOUT_MS);
            }
            write(out, "OK\t" + grantedToken + "\n");

            // Take over from any previous sender.
            synchronized (sessionLock) {
                if (active != null && active != s) sayByeAndClose(active);
                active = s;
            }
            listener.onSessionStart(clientName);
            started = true;

            DataInputStream in = new DataInputStream(rawIn);
            byte[] buf = new byte[512 * 1024];
            while (running.get()) {
                int len = in.readInt();
                if (len == 0) continue; // keepalive
                if (len < 0 || len > MAX_FRAME) throw new IOException("bad frame length " + len);
                if (len > buf.length) buf = new byte[len + len / 2];
                in.readFully(buf, 0, len);
                listener.onFrame(buf, len);
            }
        } catch (EOFException | SocketException e) {
            // normal disconnect / takeover
        } catch (Exception e) {
            listener.onLog("session: " + e);
        } finally {
            boolean wasActive;
            synchronized (sessionLock) {
                wasActive = active == s;
                if (wasActive) active = null;
            }
            closeQuietly(s);
            if (started && wasActive) listener.onSessionEnd();
        }
    }

    // ---------- helpers ----------
    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1 && c != '\n') {
            b.write(c);
            if (b.size() > 4096) throw new IOException("line too long");
        }
        if (c == -1) throw new EOFException();
        return b.toString("UTF-8").replace("\r", "");
    }

    private static void write(OutputStream out, String s) throws IOException {
        out.write(s.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private static String clean(String s) {
        if (s == null) return "";
        s = s.replaceAll("[\\t\\r\\n]", " ").trim();
        return s.length() > 60 ? s.substring(0, 60) : s;
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c != null) try { c.close(); } catch (IOException ignored) {}
    }

    private static void thread(String name, Runnable r) {
        Thread t = new Thread(r, name);
        t.setDaemon(true);
        t.start();
    }
}
