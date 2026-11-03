package lol.bruinsma.kivetito;

import android.graphics.Bitmap;

import lol.bruinsma.kivetito.core.BoardServer;

/** In-process bridge between the always-running service and the (sometimes visible) activity. */
final class Hub {
    interface Ui {
        void showFrame(Bitmap bitmap);
        void sessionStarted(String clientName);
        void sessionEnded();
        void approvalRequested(String clientName, BoardServer.Approval approval);
        void approvalCancelled();
    }

    static volatile BoardServer server;
    static volatile Ui ui;

    static volatile boolean live;
    static volatile String liveName;
    static volatile Bitmap lastFrame;

    static volatile String pendingName;
    static volatile BoardServer.Approval pendingApproval;

    private Hub() {}
}
