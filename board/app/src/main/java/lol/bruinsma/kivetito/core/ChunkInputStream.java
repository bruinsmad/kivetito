package lol.bruinsma.kivetito.core;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.net.SocketTimeoutException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * Turns pushed message chunks (WebSocket frames) into a blocking InputStream.
 * Bounded: {@link #feed} blocks when {@code capacity} bytes are waiting, which pushes back on the network.
 */
public final class ChunkInputStream extends InputStream {
    private static final byte[] EOF = new byte[0];

    private final LinkedBlockingQueue<byte[]> queue = new LinkedBlockingQueue<>();
    private final Semaphore space;
    private final int capacity;
    private volatile int timeoutMs;
    private volatile boolean closed;

    private byte[] cur;
    private int pos;
    private boolean eof;

    public ChunkInputStream(int capacity) {
        this.capacity = capacity;
        this.space = new Semaphore(capacity);
    }

    public void setTimeout(int ms) { timeoutMs = ms; }

    /** Called from the network thread. */
    public void feed(byte[] b) {
        if (closed || b.length == 0) return;
        space.acquireUninterruptibly(Math.min(b.length, capacity));
        if (closed) return;
        queue.add(b);
    }

    /** Remote side finished. */
    public void finish() { queue.add(EOF); }

    @Override
    public void close() {
        closed = true;
        queue.add(EOF);
        space.release(capacity); // unblock a waiting feed()
    }

    private boolean fill() throws IOException {
        if (eof) return false;
        if (cur != null && pos < cur.length) return true;
        if (cur != null) { space.release(Math.min(cur.length, capacity)); cur = null; }
        byte[] next;
        try {
            int t = timeoutMs;
            next = t > 0 ? queue.poll(t, TimeUnit.MILLISECONDS) : queue.take();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted");
        }
        if (next == null) throw new SocketTimeoutException("relay read timeout");
        if (next == EOF) {
            eof = true;
            if (closed) throw new EOFException("closed");
            return false;
        }
        cur = next;
        pos = 0;
        return true;
    }

    @Override
    public int read() throws IOException {
        if (!fill()) return -1;
        return cur[pos++] & 0xff;
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
        if (len == 0) return 0;
        if (!fill()) return -1;
        int n = Math.min(len, cur.length - pos);
        System.arraycopy(cur, pos, b, off, n);
        pos += n;
        return n;
    }

    @Override
    public int available() { return cur == null ? 0 : cur.length - pos; }
}
