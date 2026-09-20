package com.rkiwi.gate;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Sends one gate command intent to Firebase.
 *
 * Contract (see README + cloud functions):
 * - Writes ONLY a command intent to /gate/commandRequests/{id}
 * - Never authors timing fields (requestedAt, expiresAt, ttlMs) - Firebase stamps those
 * - Never writes /gate/liveCommand directly
 * - id must equal the request path key
 * - requestedBy (uid) is required by the cloud validator
 */
final class GatePulse {

    interface Callback {
        void onResult(boolean ok, String message);
    }

    private GatePulse() {}

    static void openGate(Context context, final Callback callback) {
        final FirebaseSessionManager sessions = FirebaseSessionManager.get(context);
        Thread thread = new Thread(() -> {
            try {
                FirebaseSessionManager.Session session = sessions.getValidSession();
                String id = UUID.randomUUID().toString().replace("-", "");
                JSONObject request = new JSONObject();
                request.put("id", id);
                request.put("type", "pulse");
                request.put("status", "pending");
                request.put("sessionId", "gatecam-android");
                request.put("requestedBy", session.uid);
                request.put("requestedByName", "Richard");

                HttpURLConnection conn = (HttpURLConnection) new URL(
                    GateSecrets.RTDB_URL + "/gate/commandRequests/" + id + ".json?auth=" + session.idToken
                ).openConnection();
                conn.setRequestMethod("PUT");
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                conn.setDoOutput(true);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(15000);
                byte[] body = request.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body);
                }
                int code = conn.getResponseCode();
                String text = readAll(conn, code);
                if (code >= 200 && code < 300) {
                    if (callback != null) callback.onResult(true, "Sent");
                } else {
                    if (callback != null) callback.onResult(false, "HTTP " + code + " " + trim(text));
                }
            } catch (Exception e) {
                if (callback != null) callback.onResult(false, trim(e.getMessage()));
            }
        });
        thread.setDaemon(true);
        thread.start();
    }

    private static String readAll(HttpURLConnection conn, int code) throws Exception {
        InputStream stream = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
        if (stream == null) return "";
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        while ((n = stream.read(chunk)) > 0) {
            buffer.write(chunk, 0, n);
        }
        stream.close();
        return buffer.toString("UTF-8");
    }

    private static String trim(String s) {
        if (s == null) return "Failed";
        String one = s.replace('\n', ' ').replace('\r', ' ').trim();
        return one.length() > 60 ? one.substring(0, 60) : one;
    }
}
