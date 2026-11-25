package io.agenticop.desk;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

// Checks the desk-chats branch of each paired repo about every 15 minutes while the app is closed, and posts an Android
// notification for a new permission prompt (approvals/<host>.json) or a chat that finished (an "end" line in jobs/<host>.jsonl).
// Same files the app reads in mobile/github.ts. Android's WebView has no Notification API, so this is the only alert path.
public class DeskWatchWorker extends Worker {
    static final String PREFS = "deskwatch";
    private static final String API = "https://api.github.com";
    private static final String CHANNEL = "desk";
    private static final String SAFE_REPO = "^[\\w.-]+/[\\w.-]+$";

    public DeskWatchWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        SharedPreferences prefs = getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String token = prefs.getString("token", "");
        long now = System.currentTimeMillis();
        if (token.isEmpty()) return Result.success();
        if (MainActivity.visible) { // the open app shows its own cards and finished chats
            prefs.edit().putLong("since", now).apply();
            return Result.success();
        }
        long since = prefs.getLong("since", now);
        SharedPreferences.Editor edit = prefs.edit();
        try {
            for (String repo : prefs.getString("repos", "").split(" ")) {
                if (!repo.matches(SAFE_REPO)) continue;
                Http ref = get(token, "/repos/" + repo + "/git/ref/heads/desk-chats", false);
                if (ref.code == 401) {
                    prefs.edit().remove("token").apply(); // signed out on github.com; stop until the app signs in again
                    return Result.success();
                }
                if (ref.code != 200) continue;
                String head = new JSONObject(ref.body).getJSONObject("object").getString("sha");
                if (head.equals(prefs.getString("head:" + repo, ""))) continue;
                JSONArray tree = new JSONObject(get(token, "/repos/" + repo + "/git/trees/" + head + "?recursive=1", false).body).getJSONArray("tree");
                Set<String> seen = prefs.getStringSet("seen:" + repo, new HashSet<>());
                Set<String> open = new HashSet<>();
                Set<String> finished = new HashSet<>();
                for (int i = 0; i < tree.length(); i++) {
                    String path = tree.getJSONObject(i).getString("path");
                    if (path.matches("^approvals/[\\w.-]+\\.json$")) {
                        JSONArray list = new JSONArray(raw(token, repo, path, "[]"));
                        for (int k = 0; k < list.length(); k++) {
                            JSONObject a = list.getJSONObject(k);
                            String request = a.optString("request");
                            open.add(request);
                            if (!seen.contains(request)) notify(request.hashCode(), "Needs your answer", a.optString("summary"));
                        }
                    } else if (path.matches("^jobs/[\\w.-]+\\.jsonl$")) {
                        for (String line : raw(token, repo, path, "").split("\n")) {
                            try {
                                JSONObject j = new JSONObject(line);
                                if ("end".equals(j.optString("ev")) && j.optLong("at") > since) finished.add(j.optString("chat"));
                            } catch (Exception half) { /* a half-written line */ }
                        }
                    }
                }
                if (!finished.isEmpty()) {
                    JSONArray chats = new JSONArray(raw(token, repo, "chats.json", "[]"));
                    for (String chat : finished) {
                        String title = "Untitled chat";
                        for (int i = 0; i < chats.length(); i++) {
                            JSONObject c = chats.getJSONObject(i);
                            if (chat.equals(c.optString("id")) && !c.optString("title").isEmpty()) title = c.optString("title");
                        }
                        notify(chat.hashCode(), "Chat finished", title);
                    }
                }
                edit.putString("head:" + repo, head).putStringSet("seen:" + repo, open);
            }
            edit.putLong("since", now).apply();
            return Result.success();
        } catch (Exception e) {
            edit.apply(); // keep the repos that were read, so their alerts don't repeat
            return Result.retry();
        }
    }

    private void notify(int id, String title, String body) {
        Context ctx = getApplicationContext();
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (!nm.areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= 26) {
            ctx.getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "Desk alerts", NotificationManager.IMPORTANCE_DEFAULT));
        }
        PendingIntent open = PendingIntent.getActivity(ctx, 0, new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
        try {
            nm.notify(id, new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build());
        } catch (SecurityException denied) { /* the user turned notifications off */ }
    }

    private static String raw(String token, String repo, String path, String missing) throws Exception {
        Http r = get(token, "/repos/" + repo + "/contents/" + path + "?ref=desk-chats", true);
        return r.code == 200 ? r.body : missing;
    }

    private static class Http { int code; String body = ""; }

    private static Http get(String token, String path, boolean raw) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(API + path).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Accept", raw ? "application/vnd.github.raw+json" : "application/vnd.github+json");
        Http r = new Http();
        r.code = c.getResponseCode();
        if (r.code == 200) {
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                r.body = out.toString(StandardCharsets.UTF_8.name());
            }
        }
        c.disconnect();
        return r;
    }
}
