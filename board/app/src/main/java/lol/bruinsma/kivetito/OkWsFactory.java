package lol.bruinsma.kivetito;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import lol.bruinsma.kivetito.core.RelayClient;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** OkHttp implementation of the relay's WebSocket abstraction. */
final class OkWsFactory implements RelayClient.WsFactory {
    private final OkHttpClient client = new OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)   // detects dead Wi-Fi, keeps Cloudflare happy
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();

    @Override
    public RelayClient.Ws connect(String url, RelayClient.WsListener l) {
        final AtomicReference<WebSocket> ref = new AtomicReference<>();
        final AtomicBoolean closed = new AtomicBoolean(false);

        final RelayClient.Ws self = new RelayClient.Ws() {
            @Override public void sendBinary(byte[] b, int off, int len) {
                WebSocket w = ref.get();
                if (w != null) w.send(ByteString.of(b, off, len));
            }
            @Override public void close() {
                WebSocket w = ref.get();
                if (w != null) w.cancel();
                if (closed.compareAndSet(false, true)) l.onClosed("local close");
            }
        };

        Request req = new Request.Builder().url(url).build();
        WebSocket ws = client.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket w, Response response) {
                ref.set(w);
                l.onOpen(self);
            }
            @Override public void onMessage(WebSocket w, String text) { l.onText(text); }
            @Override public void onMessage(WebSocket w, ByteString bytes) { l.onBinary(bytes.toByteArray()); }
            @Override public void onClosing(WebSocket w, int code, String reason) {
                w.close(1000, null);
                if (closed.compareAndSet(false, true)) l.onClosed(code + " " + reason);
            }
            @Override public void onClosed(WebSocket w, int code, String reason) {
                if (closed.compareAndSet(false, true)) l.onClosed(code + " " + reason);
            }
            @Override public void onFailure(WebSocket w, Throwable t, Response response) {
                if (closed.compareAndSet(false, true)) l.onClosed(String.valueOf(t));
            }
        });
        ref.compareAndSet(null, ws);
        return self;
    }
}
