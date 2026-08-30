package com.rkiwi.gate;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.ui.PlayerView;

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
 */
public class MainActivity extends Activity {
    private static final String TAG = "GateCam";
    private static final String CAMERA_RTSP_URL =
        "rtsp://101.183.193.134:10554/user=admin&password=&channel=7&stream=0.sdp?";

    private ExoPlayer player;
    private LinearLayout cameraPlaceholder;
    private TextView cameraStatusText;
    private Button gateButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        cameraPlaceholder = findViewById(R.id.cameraPlaceholder);
        cameraStatusText = findViewById(R.id.cameraStatusText);
        gateButton = findViewById(R.id.gateButton);

        PlayerView playerView = findViewById(R.id.playerView);

        // Force the software H.265 decoder (see class javadoc for why).
        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(this);
        renderersFactory.setMediaCodecSelector(MediaCodecSelector.PREFER_SOFTWARE);

        player = new ExoPlayer.Builder(this, renderersFactory).build();
        playerView.setPlayer(player);
        player.setMediaItem(MediaItem.fromUri(CAMERA_RTSP_URL));
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
            }
        });
        player.prepare();

        gateButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                sendPulse();
            }
        });
    }

    private void sendPulse() {
        gateButton.setEnabled(false);
        cameraStatusText.setText(getString(R.string.sending_pulse));
        GatePulse.openGate(new GatePulse.Callback() {
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
        if (player != null) {
            player.release();
            player = null;
        }
    }
}
