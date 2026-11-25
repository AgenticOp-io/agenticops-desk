package io.agenticop.desk;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.TimeUnit;

// The app hands its GitHub token and repo list to DeskWatchWorker here. Stored in app-private SharedPreferences,
// the same protection as the WebView's localStorage that already holds the token (see the shortcut note in mobile/github.ts).
@CapacitorPlugin(name = "DeskWatch")
public class DeskWatchPlugin extends Plugin {
    private static final String WORK = "deskwatch";

    @PluginMethod
    public void setup(PluginCall call) {
        Context ctx = getContext();
        boolean fresh = !ctx.getSharedPreferences(DeskWatchWorker.PREFS, Context.MODE_PRIVATE).contains("token");
        android.content.SharedPreferences.Editor e = ctx.getSharedPreferences(DeskWatchWorker.PREFS, Context.MODE_PRIVATE).edit()
            .putString("token", call.getString("token", ""))
            .putString("repos", call.getString("repos", ""));
        if (fresh) e.putLong("since", System.currentTimeMillis()); // no alerts for chats that ended before the watch began
        e.apply();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP,
            new PeriodicWorkRequest.Builder(DeskWatchWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build());
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().getSharedPreferences(DeskWatchWorker.PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        WorkManager.getInstance(getContext()).cancelUniqueWork(WORK);
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("enabled", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        call.resolve(r);
    }

    // Android 13+ asks at run time; older versions allow notifications by default.
    @PluginMethod
    public void ask(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7377);
        }
        call.resolve();
    }
}
