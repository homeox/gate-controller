package com.rkiwi.gate;

import android.app.Activity;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.ui.PlayerView;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Standalone gate controller: DVR camera feed (RTSP) + one-tap gate pulse.
 *
 * Talks directly to Firebase - no web app shell. The camera feed is the DVR
 * RTSP stream rendered by ExoPlayer's built-in RTSP extension; the gate
 * button writes a command intent to Firebase (see GatePulse).
 *
 * The DVR encodes H.265 at the non-standard "1080N" resolution (944x1080),
 * which the Samsung hardware HEVC decoder rejects (MediaCodec Error 0xe).
 * We therefore force the software HEVC decoder via
 * MediaCodecSelector.PREFER_SOFTWARE - slower frame rate, but it decodes
 * everywhere.
 *
 * The feed self-heals: when playback fails (e.g. the ISP reassigns the home
 * WAN IP), the app asks the ESP32 via Firebase (gate/network/wanIp) for the
 * current WAN IP, rebuilds the RTSP URL, and retries.
 */
public class MainActivity extends Activity {
    private static final String TAG = "GateCam";
    private static final String CAMERA_RTSP_HOST = "101.183.230.99";
    private static final String CAMERA_RTSP_PORT = "10554";
    private static final String CAMERA_RTSP_PATH =
        "/user=admin&password=&channel=7&stream=0.sdp?";
    private static final long RECOVERY_MIN_INTERVAL_MS = 30000L;

    private ExoPlayer player;
    private LinearLayout cameraPlaceholder;
    private TextView cameraStatusText;
    private Button gateButton;
    private String currentRtspHost = CAMERA_RTSP_HOST;
    private long lastRecoveryAttemptMs = 0;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback cellularCallback;
    private final AtomicBoolean appStarted = new AtomicBoolean(false);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        cameraPlaceholder = findViewById(R.id.cameraPlaceholder);
        cameraStatusText = findViewById(R.id.cameraStatusText);
        gateButton = findViewById(R.id.gateButton);
        gateButton.setEnabled(false);

        PlayerView playerView = findViewById(R.id.playerView);

        // Force the software H.265 decoder (see class javadoc for why).
        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(this);
        renderersFactory.setMediaCodecSelector(MediaCodecSelector.PREFER_SOFTWARE);

        player = new ExoPlayer.Builder(this, renderersFactory).build();
        playerView.setPlayer(player);
        player.setPlayWhenReady(true);

        player.addAnalyticsListener(new AnalyticsListener() {
            @Override
            public void onVideoDecoderInitialized(
                    EventTime eventTime, String decoderName,
                    long initializedTimestampMs, long initializationDurationMs) {
                Log.i(TAG, "video decoder: " + decoderName);
            }
        });

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) {
                    hidePlaceholder();
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                Log.e(TAG, "playback error: " + error.getErrorCodeName()
                    + " (" + error.getMessage() + ")");
                showCameraStatus(getString(R.string.camera_offline));
                recoverFeed();
            }
        });
        gateButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                sendPulse();
            }
        });

        startOnCellularNetwork();
    }

    /**
     * GateCam is deliberately independent of the home's Wi-Fi. Bind this
     * process to mobile data before Firebase or RTSP is opened, even when
     * Android has automatically reconnected the phone to Wi-Fi.
     */
    private void startOnCellularNetwork() {
        connectivityManager =
            (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkRequest request = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();
        cellularCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                if (connectivityManager.bindProcessToNetwork(network)) {
                    Log.i(TAG, "GateCam traffic bound to cellular network");
                } else {
                    Log.w(TAG, "Could not bind GateCam traffic to cellular network");
                }
                startAppOnce();
            }

            @Override
            public void onUnavailable() {
                Log.w(TAG, "Cellular network unavailable; using Android default network");
                startAppOnce();
            }
        };
        connectivityManager.requestNetwork(request, cellularCallback, 8000);
    }

    private void startAppOnce() {
        if (!appStarted.compareAndSet(false, true)) return;
        gateButton.setEnabled(true);
        new Thread(() -> {
            try {
                FirebaseSessionManager.get(this).getValidSession();
            } catch (Exception error) {
                Log.w(TAG, "Firebase session warm-up failed: " + error.getMessage());
            }
        }).start();
        startInitialFeed();
    }

    private static String rtspUrl(String host) {
        return "rtsp://" + host + ":" + CAMERA_RTSP_PORT + CAMERA_RTSP_PATH;
    }

    /** Resolve the ESP-published WAN address before starting RTSP playback. */
    private void startInitialFeed() {
        showCameraStatus(getString(R.string.camera_connecting));
        new Thread(() -> {
            try {
                String wanIp = fetchWanIp();
                if (wanIp != null && !wanIp.isEmpty()) {
                    currentRtspHost = wanIp;
                    Log.i(TAG, "Starting feed with Firebase WAN IP " + wanIp);
                } else {
                    Log.w(TAG, "Firebase WAN IP unavailable; using compiled fallback");
                }
            } catch (Exception error) {
                Log.w(TAG, "Initial WAN IP lookup failed; using compiled fallback: "
                    + error.getMessage());
            }

            runOnUiThread(() -> {
                if (player == null) return;
                player.setMediaItem(MediaItem.fromUri(rtspUrl(currentRtspHost)));
                player.prepare();
                player.setPlayWhenReady(true);
            });
        }).start();
    }

    /**
     * Ask the ESP (via Firebase) for the current home WAN IP, then reconnect
     * the feed against it. Rate-limited to avoid hammering on repeated errors.
     */
    private void recoverFeed() {
        final long now = System.currentTimeMillis();
        if (now - lastRecoveryAttemptMs < RECOVERY_MIN_INTERVAL_MS) {
            return;
        }
        lastRecoveryAttemptMs = now;

        new Thread(() -> {
            try {
                String wanIp = fetchWanIp();
                if (wanIp != null && !wanIp.isEmpty() && !wanIp.equals(currentRtspHost)) {
                    currentRtspHost = wanIp;
                    Log.i(TAG, "WAN IP updated to " + wanIp + ", reconnecting feed");
                }
                runOnUiThread(() -> {
                    player.stop();
                    player.clearMediaItems();
                    player.setMediaItem(MediaItem.fromUri(rtspUrl(currentRtspHost)));
                    player.prepare();
                    player.setPlayWhenReady(true);
                });
            } catch (Exception e) {
                Log.e(TAG, "feed recovery failed: " + e.getMessage());
            }
        }).start();
    }

    private String fetchWanIp() throws Exception {
        FirebaseSessionManager.Session session =
            FirebaseSessionManager.get(this).getValidSession();
        // Read the ESP-reported WAN IP. GET on a string leaf returns a bare
        // JSON string like "101.183.230.99" (or "null" if absent).
        HttpURLConnection conn = open(
            GateSecrets.RTDB_URL + "/gate/network/wanIp.json?auth=" + session.idToken,
            "GET"
        );
        String text = readText(conn);
        if (text == null || text.isEmpty() || text.equals("null")) {
            return "";
        }
        // Strip surrounding JSON quotes if present.
        String ip = text.trim();
        if (ip.length() >= 2 && ip.charAt(0) == '"' && ip.charAt(ip.length() - 1) == '"') {
            ip = ip.substring(1, ip.length() - 1);
        }
        return ip.trim();
    }

    private static HttpURLConnection open(String url, String method) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(8000);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        conn.setRequestProperty("Accept", "application/json");
        return conn;
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

    private void sendPulse() {
        gateButton.setEnabled(false);
        cameraStatusText.setText(getString(R.string.sending_pulse));
        GatePulse.openGate(this, new GatePulse.Callback() {
            @Override
            public void onResult(final boolean ok, final String message) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        gateButton.setEnabled(true);
                        if (ok) {
                            cameraStatusText.setText(getString(R.string.pulse_sent));
                        } else {
                            cameraStatusText.setText(getString(R.string.pulse_failed, message));
                        }
                        Toast.makeText(MainActivity.this,
                            ok ? getString(R.string.pulse_sent) : getString(R.string.pulse_failed, message),
                            Toast.LENGTH_SHORT).show();
                    }
                });
            }
        });
    }

    private void hidePlaceholder() {
        cameraPlaceholder.setVisibility(View.GONE);
    }

    private void showCameraStatus(String text) {
        runOnUiThread(() -> {
            cameraPlaceholder.setVisibility(View.VISIBLE);
            cameraStatusText.setText(text);
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (player != null) player.setPlayWhenReady(false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (player != null) player.setPlayWhenReady(true);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (connectivityManager != null && cellularCallback != null) {
            try {
                connectivityManager.unregisterNetworkCallback(cellularCallback);
            } catch (IllegalArgumentException ignored) {
                // Callback may already have timed out.
            }
            connectivityManager.bindProcessToNetwork(null);
        }
        if (player != null) {
            player.release();
            player = null;
        }
    }
}
