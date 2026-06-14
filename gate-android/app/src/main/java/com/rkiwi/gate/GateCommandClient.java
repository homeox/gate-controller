package com.rkiwi.gate;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.OutputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;

final class GateCommandClient {
    private static final long TOKEN_REFRESH_MARGIN_MS = 30000L;
    private static final long PROFILE_CACHE_MS = 10L * 60L * 1000L;

    static final class Result {
        final boolean ok;
        final String message;

        Result(boolean ok, String message) {
            this.ok = ok;
            this.message = message;
        }
    }

    private static final class Profile {
        final String name;
        final String accessGroup;
        final boolean enabled;
        final long expiresAt;

        Profile(String name, String accessGroup, boolean enabled, long expiresAt) {
            this.name = name;
            this.accessGroup = accessGroup;
            this.enabled = enabled;
            this.expiresAt = expiresAt;
        }
    }

    private static final class Session {
        final String idToken;
        final String refreshToken;
        final String uid;
        final String email;

        Session(String idToken, String refreshToken, String uid, String email) {
            this.idToken = idToken;
            this.refreshToken = refreshToken;
            this.uid = uid;
            this.email = email;
        }
    }

    private GateCommandClient() {}

    static void warmSession(Context context, String email, String password) {
        new Thread(() -> {
            try {
                sessionFor(context, email, password);
            } catch (Exception ignored) {
            }
        }).start();
    }

    static Result sendPulse(Context context, String email, String password) {
        try {
            Session session = sessionFor(context, email, password);
            Profile profile = cachedProfile(context, session);
            if (profile != null && !profile.enabled) {
                return new Result(false, "Access off");
            }

            long now = System.currentTimeMillis();
            if (profile != null && profile.expiresAt <= now) {
                return new Result(false, "Expired");
            }

            String id = UUID.randomUUID().toString();
            String name = profile != null ? profile.name : session.email;
            String accessGroup = profile != null ? profile.accessGroup : "guest";
            boolean alertEligible = !"family".equals(accessGroup);

            JSONObject command = buildCommand(id, session.uid, name);
            int liveCode = putJson(dbPath("gate/liveCommand", session.idToken), command);
            if (liveCode < 200 || liveCode >= 300) {
                return new Result(false, "HTTP " + liveCode);
            }

            logCommandAsync(context, session, command, accessGroup, alertEligible, id);
            return new Result(true, "Sent");
        } catch (Exception e) {
            return new Result(false, compact(e.getMessage()));
        }
    }

    private static JSONObject buildCommand(String id, String uid, String name) throws Exception {
        long now = System.currentTimeMillis();
        JSONObject command = new JSONObject();
            command.put("id", id);
            command.put("type", "pulse");
            command.put("status", "pending");
            command.put("sessionId", "android-app");
        command.put("requestedBy", uid);
            command.put("requestedByName", name);
            JSONObject serverTimestamp = new JSONObject().put(".sv", "timestamp");
            command.put("requestedAt", serverTimestamp);
            command.put("requestedAtEsp", serverTimestamp);
            command.put("requestedAtClient", now);
            command.put("serverReceivedAt", new JSONObject().put(".sv", "timestamp"));
            command.put("ttlMs", GateConfig.COMMAND_TTL_MS);
            command.put("expiresAt", now + GateConfig.COMMAND_TTL_MS);
            command.put("source", "android_app");
        return command;
    }

    private static void logCommandAsync(Context context, Session session, JSONObject command, String accessGroup, boolean alertEligible, String id) {
        new Thread(() -> {
            try {
                long now = command.optLong("requestedAt", System.currentTimeMillis());
            JSONObject record = new JSONObject(command.toString());
            record.put("accessGroup", accessGroup);
            record.put("alertEligible", alertEligible);
            record.put("liveSlotClaimed", true);
            record.put("liveSlotClaimedAt", now);
            record.put("resultReason", "android_app_requested");

            JSONObject event = new JSONObject();
            event.put("commandId", id);
            event.put("event", "android_app_requested");
            event.put("at", now);
            event.put("actorUid", session.uid);
            event.put("sessionId", "android-app");
            event.put("status", "pending");
            event.put("reason", "app_icon_press");

            JSONObject updates = new JSONObject();
            updates.put("gate/logs/" + id, record);
            updates.put("gate/commandRecords/" + id, record);
            updates.put("gate/commandEvents/" + id + "/" + now + "_android_app_requested", event);
            updates.put("userLogs/" + session.uid + "/" + id, record);
            patchJson(GateConfig.DB_URL + "/.json?auth=" + session.idToken, updates);

            refreshProfileAsync(context, session);
            } catch (Exception ignored) {
            }
        }).start();
    }

    private static Session sessionFor(Context context, String email, String password) throws Exception {
        SharedPreferences prefs = GateConfig.prefs(context);
        long now = System.currentTimeMillis();
        String cachedEmail = prefs.getString(GateConfig.KEY_TOKEN_EMAIL, "");
        String idToken = prefs.getString(GateConfig.KEY_ID_TOKEN, "");
        String refreshToken = prefs.getString(GateConfig.KEY_REFRESH_TOKEN, "");
        String uid = prefs.getString(GateConfig.KEY_UID, "");
        long expiresAt = prefs.getLong(GateConfig.KEY_TOKEN_EXPIRES_AT, 0);

        if (email.equals(cachedEmail) && !idToken.isEmpty() && !uid.isEmpty() && expiresAt > now + TOKEN_REFRESH_MARGIN_MS) {
            return new Session(idToken, refreshToken, uid, cachedEmail);
        }

        if (email.equals(cachedEmail) && !refreshToken.isEmpty()) {
            try {
                return refreshSession(context, refreshToken, email);
            } catch (Exception ignored) {
            }
        }

        return signIn(context, email, password);
    }

    private static Profile cachedProfile(Context context, Session session) {
        SharedPreferences prefs = GateConfig.prefs(context);
        long updatedAt = prefs.getLong(GateConfig.KEY_PROFILE_UPDATED_AT, 0);
        if (System.currentTimeMillis() - updatedAt > PROFILE_CACHE_MS) {
            refreshProfileAsync(context, session);
        }

        if (updatedAt == 0) {
            refreshProfileAsync(context, session);
            return null;
        }

        return new Profile(
            prefs.getString(GateConfig.KEY_PROFILE_NAME, session.email),
            prefs.getString(GateConfig.KEY_PROFILE_ACCESS_GROUP, "guest"),
            prefs.getBoolean(GateConfig.KEY_PROFILE_ENABLED, true),
            prefs.getLong(GateConfig.KEY_PROFILE_EXPIRES_AT, Long.MAX_VALUE)
        );
    }

    private static void refreshProfileAsync(Context context, Session session) {
        new Thread(() -> {
            try {
                refreshProfileCache(context, session);
            } catch (Exception ignored) {
            }
        }).start();
    }

    private static Profile refreshProfileCache(Context context, Session session) throws Exception {
        JSONObject profile = getJson(dbPath("users/" + session.uid, session.idToken));
        if (profile == null) {
            return null;
        }
        Profile cached = new Profile(
            profile.optString("name", session.email),
            profile.optString("accessGroup", "guest"),
            profile.optBoolean("enabled", false),
            profile.optLong("expiresAt", 0)
        );
        GateConfig.prefs(context).edit()
            .putString(GateConfig.KEY_PROFILE_NAME, cached.name)
            .putString(GateConfig.KEY_PROFILE_ACCESS_GROUP, cached.accessGroup)
            .putBoolean(GateConfig.KEY_PROFILE_ENABLED, cached.enabled)
            .putLong(GateConfig.KEY_PROFILE_EXPIRES_AT, cached.expiresAt)
            .putLong(GateConfig.KEY_PROFILE_UPDATED_AT, System.currentTimeMillis())
            .apply();
        return cached;
    }

    private static Session refreshSession(Context context, String refreshToken, String email) throws Exception {
        String body = "grant_type=refresh_token&refresh_token=" + refreshToken;
        JSONObject response = postForm(
            "https://securetoken.googleapis.com/v1/token?key=" + GateConfig.API_KEY,
            body
        );

        long expiresInMs = Long.parseLong(response.optString("expires_in", "3600")) * 1000L;
        Session session = new Session(
            response.getString("id_token"),
            response.getString("refresh_token"),
            response.getString("user_id"),
            email
        );
        saveSession(context, session, expiresInMs);
        return session;
    }

    private static Session signIn(Context context, String email, String password) throws Exception {
        JSONObject body = new JSONObject();
        body.put("email", email);
        body.put("password", password);
        body.put("returnSecureToken", true);

        JSONObject response = postJson(
            "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + GateConfig.API_KEY,
            body
        );

        long expiresInMs = Long.parseLong(response.optString("expiresIn", "3600")) * 1000L;
        Session session = new Session(
            response.getString("idToken"),
            response.optString("refreshToken", ""),
            response.getString("localId"),
            response.optString("email", email)
        );
        saveSession(context, session, expiresInMs);
        refreshProfileAsync(context, session);
        return session;
    }

    private static void saveSession(Context context, Session session, long expiresInMs) {
        GateConfig.prefs(context).edit()
            .putString(GateConfig.KEY_ID_TOKEN, session.idToken)
            .putString(GateConfig.KEY_REFRESH_TOKEN, session.refreshToken)
            .putString(GateConfig.KEY_UID, session.uid)
            .putString(GateConfig.KEY_TOKEN_EMAIL, session.email)
            .putLong(GateConfig.KEY_TOKEN_EXPIRES_AT, System.currentTimeMillis() + expiresInMs)
            .apply();
    }

    private static String dbPath(String path, String token) {
        return String.format(Locale.US, "%s/%s.json?auth=%s", GateConfig.DB_URL, path, token);
    }

    private static JSONObject postJson(String url, JSONObject body) throws Exception {
        HttpURLConnection conn = open(url, "POST");
        writeBody(conn, body);
        return readJson(conn);
    }

    private static JSONObject postForm(String url, String body) throws Exception {
        HttpURLConnection conn = open(url, "POST");
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        conn.setDoOutput(true);
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(bytes);
        }
        return readJson(conn);
    }

    private static JSONObject getJson(String url) throws Exception {
        HttpURLConnection conn = open(url, "GET");
        String text = readText(conn);
        if (text == null || text.equals("null") || text.isEmpty()) {
            return null;
        }
        return new JSONObject(text);
    }

    private static int putJson(String url, JSONObject body) throws Exception {
        HttpURLConnection conn = open(url, "PUT");
        writeBody(conn, body);
        readText(conn);
        return conn.getResponseCode();
    }

    private static void patchJson(String url, JSONObject body) throws Exception {
        HttpURLConnection conn = open(url, "PATCH");
        writeBody(conn, body);
        readText(conn);
    }

    private static HttpURLConnection open(String url, String method) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(4000);
        conn.setReadTimeout(4000);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        conn.setRequestProperty("Accept", "application/json");
        return conn;
    }

    private static void writeBody(HttpURLConnection conn, JSONObject body) throws Exception {
        conn.setDoOutput(true);
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(bytes);
        }
    }

    private static JSONObject readJson(HttpURLConnection conn) throws Exception {
        String text = readText(conn);
        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new IllegalStateException("HTTP " + code + " " + text);
        }
        return new JSONObject(text);
    }

    private static String readText(HttpURLConnection conn) throws Exception {
        int code = conn.getResponseCode();
        BufferedReader reader = new BufferedReader(new InputStreamReader(
            code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream(),
            StandardCharsets.UTF_8
        ));
        StringBuilder builder = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            builder.append(line);
        }
        return builder.toString();
    }

    private static String compact(String message) {
        if (message == null || message.trim().isEmpty()) {
            return "Failed";
        }
        String oneLine = message.replace('\n', ' ').replace('\r', ' ').trim();
        return oneLine.length() > 40 ? oneLine.substring(0, 40) : oneLine;
    }
}
