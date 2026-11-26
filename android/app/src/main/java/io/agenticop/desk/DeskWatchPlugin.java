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

// The app hands its GitHub token and repo list to DeskWatchWorker here; the token is sealed by Vault (Android Keystore).
// secretGet/secretSet keep the app's own secrets (mobile/secrets.ts) in the same vault instead of the WebView's storage.
@CapacitorPlugin(name = "DeskWatch")
public class DeskWatchPlugin extends Plugin {
    private static final String WORK = "deskwatch";

    @PluginMethod
    public void secretGet(PluginCall call) {
        JSObject r = new JSObject();
        r.put("value", Vault.get(getContext(), call.getString("key", "")));
        call.resolve(r);
    }

    @PluginMethod
    public void secretSet(PluginCall call) {
        try {
            Vault.put(getContext(), call.getString("key", ""), call.getString("value", ""));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not store the secret: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setup(PluginCall call) {
        Context ctx = getContext();
        boolean fresh = !ctx.getSharedPreferences(DeskWatchWorker.PREFS, Context.MODE_PRIVATE).contains("token");
        String sealed;
        try {
            sealed = Vault.seal(call.getString("token", ""));
        } catch (Exception ex) {
            call.reject("Could not store the token: " + ex.getMessage());
            return;
        }
        android.content.SharedPreferences.Editor e = ctx.getSharedPreferences(DeskWatchWorker.PREFS, Context.MODE_PRIVATE).edit()
            .putString("token", sealed)
            .putString("repos", call.getString("repos", ""));
        if (fresh) e.putLong("since", System.currentTimeMillis()); // no alerts for chats that ended before the watch began
        e.apply();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP,
            new PeriodicWorkRequest.Builder(DeskWatchWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build());
        call.resolve();
    }

    // A cloud-agent call to the superadmin desk. Its certificate is self-signed, so the WebView's fetch would refuse it;
    // this trusts exactly one key: the sha256 public-key pin the desk put in the pairing QR (like curl --pinnedpubkey).
    @PluginMethod
    public void cloud(PluginCall call) {
        String url = call.getString("url", ""), pin = call.getString("pin", ""), token = call.getString("token", ""), body = call.getString("body");
        if (!url.startsWith("https://") || pin.isEmpty()) { call.reject("https and a pin only"); return; }
        new Thread(() -> {
            try {
                byte[] want = android.util.Base64.decode(pin, android.util.Base64.NO_WRAP);
                javax.net.ssl.X509TrustManager tm = new javax.net.ssl.X509TrustManager() {
                    public void checkClientTrusted(java.security.cert.X509Certificate[] c, String a) throws java.security.cert.CertificateException { throw new java.security.cert.CertificateException("no client certs"); }
                    public void checkServerTrusted(java.security.cert.X509Certificate[] c, String a) throws java.security.cert.CertificateException {
                        try {
                            byte[] got = java.security.MessageDigest.getInstance("SHA-256").digest(c[0].getPublicKey().getEncoded());
                            if (!java.security.MessageDigest.isEqual(got, want)) throw new java.security.cert.CertificateException("not the desk's key");
                        } catch (java.security.NoSuchAlgorithmException e) { throw new java.security.cert.CertificateException(e); }
                    }
                    public java.security.cert.X509Certificate[] getAcceptedIssuers() { return new java.security.cert.X509Certificate[0]; }
                };
                javax.net.ssl.SSLContext ssl = javax.net.ssl.SSLContext.getInstance("TLS");
                ssl.init(null, new javax.net.ssl.TrustManager[] { tm }, null);
                javax.net.ssl.HttpsURLConnection c = (javax.net.ssl.HttpsURLConnection) new java.net.URL(url).openConnection();
                c.setSSLSocketFactory(ssl.getSocketFactory());
                c.setHostnameVerifier((h, s) -> true); // the pinned key identifies the desk; its address may change
                c.setConnectTimeout(10_000);
                c.setReadTimeout(30_000);
                c.setRequestProperty("authorization", "Bearer " + token);
                c.setRequestProperty("content-type", "application/json");
                if (body != null) {
                    c.setRequestMethod("POST");
                    c.setDoOutput(true);
                    try (java.io.OutputStream o = c.getOutputStream()) { o.write(body.getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
                }
                int status = c.getResponseCode();
                java.io.InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = "";
                if (in != null) try (java.util.Scanner sc = new java.util.Scanner(in, "UTF-8").useDelimiter("\\A")) { text = sc.hasNext() ? sc.next() : ""; }
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("body", text);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Could not reach the desk: " + e.getMessage());
            }
        }).start();
    }

    // External links go to the system browser; navigating the WebView would replace the app with a web page.
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://")) { call.reject("https only"); return; }
        getActivity().startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)));
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
