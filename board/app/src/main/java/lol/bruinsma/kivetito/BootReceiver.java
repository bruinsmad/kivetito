package lol.bruinsma.kivetito;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the receiver service when the board powers on (and after app updates). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        BoardService.start(context);
    }
}
