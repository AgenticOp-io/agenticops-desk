package io.agenticop.desk;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

// Secrets (GitHub token, API key, cloud desk token) sealed with AES-GCM under a key held in the Android Keystore,
// so the stored file alone is useless off this phone. Values live in their own SharedPreferences file.
final class Vault {
    private static final String ALIAS = "agenticops-desk-vault";
    private static final String PREFS = "vault";

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return g.generateKey();
    }

    static String seal(String plain) throws Exception {
        if (plain == null || plain.isEmpty()) return "";
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
    }

    // "" for nothing stored or a value that no longer opens (key wiped by a backup restore to another phone).
    static String open(String sealed) {
        try {
            if (sealed == null || sealed.isEmpty()) return "";
            String[] p = sealed.split(":", 2);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(p[0], Base64.NO_WRAP)));
            return new String(c.doFinal(Base64.decode(p[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    static String get(Context ctx, String name) {
        return open(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(name, ""));
    }

    static void put(Context ctx, String name, String value) throws Exception {
        android.content.SharedPreferences.Editor e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (value == null || value.isEmpty()) e.remove(name);
        else e.putString(name, seal(value));
        e.commit();
    }
}
