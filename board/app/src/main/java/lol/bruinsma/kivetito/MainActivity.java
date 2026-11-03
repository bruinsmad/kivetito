package lol.bruinsma.kivetito;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import lol.bruinsma.kivetito.core.BoardServer;

public class MainActivity extends Activity implements Hub.Ui {
    static final String EXTRA_AUTO = "auto";

    private ImageView screen;
    private LinearLayout idlePanel, liveBar;
    private TextView nameView, ipView, liveText, hintView;
    private Button overlayBtn, forgetBtn;
    private AlertDialog approvalDialog;

    private boolean visible;
    /** True when we were pulled to the front by an incoming share → go back afterwards. */
    private boolean autoOpened;

    private final AtomicReference<Bitmap> pendingFrame = new AtomicReference<>();
    private final Runnable drawFrame = () -> {
        Bitmap b = pendingFrame.getAndSet(null);
        if (b != null && Hub.live) screen.setImageBitmap(b);
    };
    private final Runnable hideBar = () -> liveBar.setVisibility(View.GONE);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        BoardService.start(this);
        setContentView(buildUi());
        autoOpened = getIntent().getBooleanExtra(EXTRA_AUTO, false);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (!visible) autoOpened = intent.getBooleanExtra(EXTRA_AUTO, false);
    }

    @Override
    protected void onStart() {
        super.onStart();
        visible = true;
        Hub.ui = this;
        refreshIdleInfo();
        if (Hub.live) sessionStarted(Hub.liveName); else sessionEnded();
        if (Hub.lastFrame != null) screen.setImageBitmap(Hub.lastFrame);
        if (Hub.pendingApproval != null) approvalRequested(Hub.pendingName, Hub.pendingApproval);
    }

    @Override
    protected void onResume() {
        super.onResume();
        goImmersive();
        refreshIdleInfo();
    }

    @Override
    protected void onStop() {
        visible = false;
        if (Hub.ui == this) Hub.ui = null;
        super.onStop();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();
    }

    // ------------------------------------------------------------------ Hub.Ui

    @Override
    public void showFrame(Bitmap bitmap) {               // reader thread
        if (pendingFrame.getAndSet(bitmap) == null) screen.post(drawFrame);
    }

    @Override
    public void sessionStarted(String clientName) {
        idlePanel.setVisibility(View.GONE);
        screen.setVisibility(View.VISIBLE);
        liveText.setText("Megosztja: " + clientName);
    }

    @Override
    public void sessionEnded() {
        screen.setImageDrawable(null);
        screen.setVisibility(View.GONE);
        liveBar.setVisibility(View.GONE);
        idlePanel.setVisibility(View.VISIBLE);
        refreshIdleInfo();
        if (autoOpened && visible && Hub.pendingApproval == null) {
            autoOpened = false;
            moveTaskToBack(true); // return to whatever was on the board before
        }
    }

    @Override
    public void approvalRequested(String clientName, BoardServer.Approval approval) {
        if (approvalDialog != null) approvalDialog.dismiss();
        approvalDialog = new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle("Új laptop")
                .setMessage("„" + clientName + "” szeretné kivetíteni a képernyőjét erre a táblára.\n\n"
                        + "Ha engedélyezed, ez a laptop a jövőben kérdés nélkül csatlakozhat.")
                .setPositiveButton("Engedélyez", (d, w) -> approval.answer(true))
                .setNegativeButton("Elutasít", (d, w) -> {
                    approval.answer(false);
                    if (autoOpened && !Hub.live) { autoOpened = false; moveTaskToBack(true); }
                })
                .setCancelable(false)
                .create();
        approvalDialog.show();
    }

    @Override
    public void approvalCancelled() {
        if (approvalDialog != null) { approvalDialog.dismiss(); approvalDialog = null; }
    }

    // ------------------------------------------------------------------ UI

    private View buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        screen = new ImageView(this);
        screen.setScaleType(ImageView.ScaleType.FIT_CENTER);
        screen.setVisibility(View.GONE);
        screen.setOnClickListener(v -> {
            liveBar.setVisibility(View.VISIBLE);
            liveBar.removeCallbacks(hideBar);
            liveBar.postDelayed(hideBar, 4000);
        });
        root.addView(screen, match());

        // --- idle panel ---
        idlePanel = new LinearLayout(this);
        idlePanel.setOrientation(LinearLayout.VERTICAL);
        idlePanel.setGravity(Gravity.CENTER);
        idlePanel.setPadding(dp(40), dp(40), dp(40), dp(40));

        idlePanel.addView(text("Kivetítő", 28, Color.parseColor("#9CA3AF"), false));
        nameView = text("", 56, Color.WHITE, true);
        idlePanel.addView(nameView);
        hintView = text("", 22, Color.parseColor("#D1D5DB"), false);
        hintView.setPadding(0, dp(16), 0, dp(8));
        idlePanel.addView(hintView);
        ipView = text("", 16, Color.parseColor("#6B7280"), false);
        idlePanel.addView(ipView);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setGravity(Gravity.CENTER);
        buttons.setPadding(0, dp(32), 0, 0);
        buttons.addView(button("Tábla neve…", v -> renameDialog()));
        forgetBtn = button("", v -> forgetDialog());
        buttons.addView(forgetBtn);
        overlayBtn = button("Automatikus megjelenés engedélyezése", v -> requestOverlay());
        buttons.addView(overlayBtn);
        buttons.addView(button("Elrejtés", v -> moveTaskToBack(true)));
        idlePanel.addView(buttons);
        root.addView(idlePanel, match());

        // --- live bar (shown on tap) ---
        liveBar = new LinearLayout(this);
        liveBar.setGravity(Gravity.CENTER_VERTICAL);
        liveBar.setBackgroundColor(Color.argb(200, 0, 0, 0));
        liveBar.setPadding(dp(16), dp(8), dp(16), dp(8));
        liveText = text("", 18, Color.WHITE, false);
        liveBar.addView(liveText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        liveBar.addView(button("Leállítás", v -> {
            BoardServer s = Hub.server;
            if (s != null) new Thread(s::disconnectActive).start();
        }));
        liveBar.setVisibility(View.GONE);
        root.addView(liveBar, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));
        return root;
    }

    private void refreshIdleInfo() {
        String name = BoardService.boardName(this);
        nameView.setText(name);
        hintView.setText("A laptopon kattints a Kivetítő ikonra, és válaszd: „" + name + "”");
        List<String> ips = ipAddresses();
        ipView.setText(ips.isEmpty() ? "Nincs hálózati kapcsolat!" : "IP: " + TextUtils.join(", ", ips));
        int n = BoardService.trustedCount(this);
        forgetBtn.setText("Laptopok elfelejtése (" + n + ")");
        forgetBtn.setVisibility(n > 0 ? View.VISIBLE : View.GONE);
        boolean needOverlay = Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this);
        overlayBtn.setVisibility(needOverlay ? View.VISIBLE : View.GONE);
    }

    private void renameDialog() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        input.setText(BoardService.boardName(this));
        input.setSelectAllOnFocus(true);
        new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle("Tábla neve (pl. 204-es terem)")
                .setView(input)
                .setPositiveButton("Mentés", (d, w) -> {
                    String n = input.getText().toString().trim();
                    getSharedPreferences(BoardService.PREFS, MODE_PRIVATE).edit().putString("boardName", n).apply();
                    BoardServer s = Hub.server;
                    if (s != null) s.setBoardName(BoardService.boardName(this));
                    refreshIdleInfo();
                })
                .setNegativeButton("Mégse", null)
                .show();
    }

    private void forgetDialog() {
        new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle("Laptopok elfelejtése")
                .setMessage("Minden laptopnak újra engedélyt kell kérnie. Folytatod?")
                .setPositiveButton("Igen", (d, w) -> { BoardService.forgetAllLaptops(this); refreshIdleInfo(); })
                .setNegativeButton("Mégse", null)
                .show();
    }

    /** Needed on Android 10+ so the app can jump to the front when a share starts. */
    private void requestOverlay() {
        if (Build.VERSION.SDK_INT < 23) return;
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException e) {
            try { startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)); }
            catch (ActivityNotFoundException e2) {
                new AlertDialog.Builder(this).setMessage("Ezen a táblán nem érhető el ez a beállítás. "
                        + "Ilyenkor a Kivetítőt kézzel kell megnyitni a megosztás előtt.").show();
            }
        }
    }

    @SuppressWarnings("deprecation")
    private void goImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    // ------------------------------------------------------------------ helpers

    private static List<String> ipAddresses() {
        List<String> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses()))
                    if (a instanceof Inet4Address) out.add(a.getHostAddress());
            }
        } catch (Exception ignored) {}
        return out;
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button button(String s, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(8), 0, dp(8), 0);
        b.setLayoutParams(lp);
        return b;
    }

    private static FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }
}
