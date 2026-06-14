package com.rkiwi.gate;

import android.content.Context;
import android.content.SharedPreferences;

final class GateConfig {
    static final String PREFS = "gate_config";
    static final String KEY_EMAIL = "email";
    static final String KEY_PASSWORD = "password";
    static final String KEY_ID_TOKEN = "id_token";
    static final String KEY_REFRESH_TOKEN = "refresh_token";
    static final String KEY_UID = "uid";
    static final String KEY_TOKEN_EMAIL = "token_email";
    static final String KEY_TOKEN_EXPIRES_AT = "token_expires_at";
    static final String KEY_PROFILE_NAME = "profile_name";
    static final String KEY_PROFILE_ACCESS_GROUP = "profile_access_group";
    static final String KEY_PROFILE_ENABLED = "profile_enabled";
    static final String KEY_PROFILE_EXPIRES_AT = "profile_expires_at";
    static final String KEY_PROFILE_UPDATED_AT = "profile_updated_at";
    static final String DEFAULT_EMAIL = "user@example.com";
    static final String DEFAULT_PASSWORD = "change-me";

    static final String API_KEY = "YOUR_FIREBASE_WEB_API_KEY";
    static final String DB_URL = "https://YOUR_PROJECT-default-rtdb.YOUR_REGION.firebasedatabase.app";
    static final int COMMAND_TTL_MS = 3000;

    private GateConfig() {}

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String email(Context context) {
        return prefs(context).getString(KEY_EMAIL, DEFAULT_EMAIL);
    }

    static String password(Context context) {
        return prefs(context).getString(KEY_PASSWORD, DEFAULT_PASSWORD);
    }

    static boolean hasLogin(Context context) {
        return !email(context).isEmpty() && !password(context).isEmpty();
    }

    static void ensureDefaultLogin(Context context) {
        SharedPreferences preferences = prefs(context);
        if (!preferences.contains(KEY_EMAIL) || !preferences.contains(KEY_PASSWORD)) {
            preferences.edit()
                .putString(KEY_EMAIL, DEFAULT_EMAIL)
                .putString(KEY_PASSWORD, DEFAULT_PASSWORD)
                .apply();
        }
    }
}
