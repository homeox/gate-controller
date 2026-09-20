package com.rkiwi.gate;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Process-wide Firebase session with an encrypted, persistent refresh token.
 *
 * ID tokens are reused in memory until shortly before expiry. After an app or
 * phone restart the saved refresh token obtains a new ID token silently. The
 * email/password sign-in is only the bootstrap/fallback path.
 */
final class FirebaseSessionManager {
    private static final String TAG = "GateCamAuth";
    private static final String PREFS = "gatecam_firebase_session";
    private static final String REFRESH_TOKEN = "refresh_token";
    private static final String KEY_ALIAS = "gatecam_firebase_refresh_token";
    private static final long EXPIRY_MARGIN_MS = 60_000L;

    private static volatile FirebaseSessionManager instance;

    private final SharedPreferences preferences;
    private Session session;

    static FirebaseSessionManager get(Context context) {
        if (instance == null) {
            synchronized (FirebaseSessionManager.class) {
                if (instance == null) {
                    instance = new FirebaseSessionManager(context.getApplicationContext());
                }
            }
        }
        return instance;
    }

    private FirebaseSessionManager(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized Session getValidSession() throws Exception {
        long now = System.currentTimeMillis();
        if (session != null && session.expiresAtMs - now > EXPIRY_MARGIN_MS) {
            return session;
        }

        String refreshToken = loadRefreshToken();
        if (!refreshToken.isEmpty()) {
            try {
                session = refresh(refreshToken);
                saveRefreshToken(session.refreshToken);
                Log.i(TAG, "Firebase session restored using refresh token");
                return session;
            } catch (AuthException error) {
                if (error.httpCode != 400 && error.httpCode != 401) {
                    throw error;
                }
                // A revoked/corrupt refresh token falls back to the configured
                // account. A pulse is not submitted until authentication has
                // completed, so this cannot duplicate a gate command.
                clearRefreshToken();
            }
        }

        session = signIn();
        saveRefreshToken(session.refreshToken);
        Log.i(TAG, "Firebase session bootstrapped using configured account");
        return session;
    }

    private static Session signIn() throws Exception {
        JSONObject body = new JSONObject();
        body.put("email", GateSecrets.EMAIL);
        body.put("password", GateSecrets.PASSWORD);
        body.put("returnSecureToken", true);

        JSONObject response = postJson(
            "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key="
                + GateSecrets.FIREBASE_API_KEY,
            "application/json; charset=utf-8",
            body.toString()
        );
        return sessionFrom(response, "idToken", "localId", "refreshToken", "expiresIn");
    }

    private static Session refresh(String refreshToken) throws Exception {
        String body = "grant_type=refresh_token&refresh_token=" +
            java.net.URLEncoder.encode(refreshToken, "UTF-8");
        JSONObject response = postJson(
            "https://securetoken.googleapis.com/v1/token?key=" + GateSecrets.FIREBASE_API_KEY,
            "application/x-www-form-urlencoded; charset=utf-8",
            body
        );
        return sessionFrom(response, "id_token", "user_id", "refresh_token", "expires_in");
    }

    private static Session sessionFrom(
            JSONObject response, String idTokenKey, String uidKey,
            String refreshKey, String expiresKey) throws Exception {
        long expiresInSeconds = Long.parseLong(response.optString(expiresKey, "3600"));
        return new Session(
            response.getString(idTokenKey),
            response.getString(uidKey),
            response.getString(refreshKey),
            System.currentTimeMillis() + expiresInSeconds * 1000L
        );
    }

    private static JSONObject postJson(String url, String contentType, String body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", contentType);
        conn.setDoOutput(true);
        conn.setConnectTimeout(10_000);
        conn.setReadTimeout(15_000);
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(bytes);
        }
        int code = conn.getResponseCode();
        String text = readAll(conn, code);
        conn.disconnect();
        if (code < 200 || code >= 300) {
            throw new AuthException(code);
        }
        return new JSONObject(text);
    }

    private void saveRefreshToken(String refreshToken) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] encrypted = cipher.doFinal(refreshToken.getBytes(StandardCharsets.UTF_8));
        String encoded = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
            Base64.encodeToString(encrypted, Base64.NO_WRAP);
        preferences.edit().putString(REFRESH_TOKEN, encoded).apply();
    }

    private String loadRefreshToken() {
        String encoded = preferences.getString(REFRESH_TOKEN, "");
        if (encoded == null || encoded.isEmpty()) return "";
        try {
            String[] parts = encoded.split("\\.", 2);
            if (parts.length != 2) return "";
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP))
            );
            byte[] clear = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
            return new String(clear, StandardCharsets.UTF_8);
        } catch (Exception error) {
            clearRefreshToken();
            return "";
        }
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore"
        );
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return generator.generateKey();
    }

    private void clearRefreshToken() {
        preferences.edit().remove(REFRESH_TOKEN).apply();
    }

    private static String readAll(HttpURLConnection conn, int code) throws Exception {
        InputStream stream = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
        if (stream == null) return "";
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int count;
        while ((count = stream.read(chunk)) > 0) {
            buffer.write(chunk, 0, count);
        }
        stream.close();
        return buffer.toString("UTF-8");
    }

    private static final class AuthException extends Exception {
        final int httpCode;

        AuthException(int httpCode) {
            super("Firebase auth HTTP " + httpCode);
            this.httpCode = httpCode;
        }
    }

    static final class Session {
        final String idToken;
        final String uid;
        final String refreshToken;
        final long expiresAtMs;

        Session(String idToken, String uid, String refreshToken, long expiresAtMs) {
            this.idToken = idToken;
            this.uid = uid;
            this.refreshToken = refreshToken;
            this.expiresAtMs = expiresAtMs;
        }
    }
}
