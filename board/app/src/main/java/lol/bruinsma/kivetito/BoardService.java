package lol.bruinsma.kivetito;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import java.security.SecureRandom;
import java.util.UUID;

import lol.bruinsma.kivetito.core.BoardServer;

/** Runs the receiver 24/7 (started at boot) and brings the activity to front when someone shares. */
public class BoardService extends Service {
    private static final String TAG = "Kivetito";
    private static final String CHANNEL = "kivetito";
    static final String PREFS = "kivetito";

    private final Handler main = new Handler(Looper.getMainLooper());
    private WifiManager.MulticastLock multicastLock;
    private BoardServer server;

    static void start(Context ctx) {
        Intent i = new Intent(ctx, BoardService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        startForeground(1, buildNotification());

        // Some Wi-Fi drivers drop broadcast packets unless a multicast lock is held.
        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi != null) {
            multicastLock = wifi.createMulticastLock("kivetito");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
        }

        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String id = p.getString("boardId", null);
        if (id == null) { id = UUID.randomUUID().toString(); p.edit().putString("boardId", id).apply(); }

        server = new BoardServer(id, boardName(this), new PrefsAuth(p), new ServiceListener());
        Hub.server = server;
        new Thread(() -> {
            try { server.start(); }
            catch (Exception e) {
                Log.e(TAG, "server start failed", e);
                main.postDelayed(this::stopSelf, 5000); // START_STICKY will restart us
            }
        }, "kv-start").start();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }

    @Override
    public void onDestroy() {
        if (server != null) server.stop();
        Hub.server = null;
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        super.onDestroy();
    }

    static String boardName(Context ctx) {
        String n = ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getString("boardName", null);
        if (n != null && !n.isEmpty()) return n;
        try {
            String dn = Settings.Global.getString(ctx.getContentResolver(), "device_name");
            if (dn != null && !dn.isEmpty()) return dn;
        } catch (Exception ignored) {}
        return "Tábla (" + Build.MODEL + ")";
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Kivetítő", NotificationManager.IMPORTANCE_MIN));
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        PendingIntent pi = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE);
        return b.setContentTitle("Kivetítő")
                .setContentText("Várakozás képernyőmegosztásra")
                .setSmallIcon(android.R.drawable.ic_menu_slideshow)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void bringActivityToFront() {
        Intent i = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                .putExtra(MainActivity.EXTRA_AUTO, true);
        try { startActivity(i); } catch (Exception e) { Log.w(TAG, "cannot start activity", e); }
    }

    // ---------------------------------------------------------------------------------------

    private final class ServiceListener implements BoardServer.Listener {
        private final BitmapFactory.Options opts = new BitmapFactory.Options();
        { opts.inPreferredConfig = Bitmap.Config.RGB_565; } // half the memory, fine for slides

        @Override
        public void onApprovalRequest(String clientName, BoardServer.Approval approval) {
            main.post(() -> {
                Hub.pendingName = clientName;
                Hub.pendingApproval = ok -> {
                    Hub.pendingApproval = null;
                    Hub.pendingName = null;
                    approval.answer(ok);
                };
                Hub.Ui ui = Hub.ui;
                if (ui != null) ui.approvalRequested(clientName, Hub.pendingApproval);
                else bringActivityToFront();
            });
            // Drop the dialog when the server-side wait expires.
            main.postDelayed(() -> {
                if (Hub.pendingName != null && Hub.pendingName.equals(clientName)) {
                    Hub.pendingApproval = null;
                    Hub.pendingName = null;
                    Hub.Ui ui = Hub.ui;
                    if (ui != null) ui.approvalCancelled();
                }
            }, 61_000);
        }

        @Override
        public void onSessionStart(String clientName) {
            main.post(() -> {
                Hub.live = true;
                Hub.liveName = clientName;
                Hub.Ui ui = Hub.ui;
                if (ui != null) ui.sessionStarted(clientName); else bringActivityToFront();
            });
        }

        @Override
        public void onFrame(byte[] jpeg, int length) {
            Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, length, opts);
            if (bmp == null) return;
            Hub.lastFrame = bmp;
            Hub.Ui ui = Hub.ui;
            if (ui != null) ui.showFrame(bmp);
        }

        @Override
        public void onSessionEnd() {
            main.post(() -> {
                Hub.live = false;
                Hub.liveName = null;
                Hub.lastFrame = null;
                Hub.Ui ui = Hub.ui;
                if (ui != null) ui.sessionEnded();
            });
        }

        @Override public void onLog(String msg) { Log.i(TAG, msg); }
    }

    /** Trusted laptops are remembered as clientId → token in SharedPreferences. */
    static final class PrefsAuth implements BoardServer.Auth {
        private final SharedPreferences p;
        private final SecureRandom rnd = new SecureRandom();
        PrefsAuth(SharedPreferences p) { this.p = p; }

        @Override public boolean isTrusted(String clientId, String token) {
            String t = p.getString("tok_" + clientId, null);
            return t != null && t.equals(token);
        }

        @Override public String issueToken(String clientId, String clientName) {
            byte[] b = new byte[16];
            rnd.nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            String t = sb.toString();
            p.edit().putString("tok_" + clientId, t).putString("name_" + clientId, clientName).apply();
            return t;
        }
    }

    static void forgetAllLaptops(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        SharedPreferences.Editor e = p.edit();
        for (String k : p.getAll().keySet()) if (k.startsWith("tok_") || k.startsWith("name_")) e.remove(k);
        e.apply();
    }

    static int trustedCount(Context ctx) {
        int n = 0;
        for (String k : ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getAll().keySet()) if (k.startsWith("tok_")) n++;
        return n;
    }
}
