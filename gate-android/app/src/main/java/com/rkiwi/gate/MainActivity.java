package com.rkiwi.gate;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private TextView gateButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureSmallWindow();
        GateConfig.ensureDefaultLogin(this);
        showPulseScreen();
        playPressTone();
        Toast.makeText(this, "Gate signal sending", Toast.LENGTH_SHORT).show();

        new Thread(() -> {
            GateCommandClient.Result result = GateCommandClient.sendPulse(
                this,
                GateConfig.email(this),
                GateConfig.password(this)
            );
            runOnUiThread(() -> {
                Toast.makeText(this, result.ok ? "Gate signal sent" : "Gate " + result.message, Toast.LENGTH_SHORT).show();
                finish();
            });
        }).start();
    }

    private void configureSmallWindow() {
        Window window = getWindow();
        if (window == null) return;
        window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        window.setDimAmount(0.0f);
        WindowManager.LayoutParams params = window.getAttributes();
        params.width = (int) (220 * getResources().getDisplayMetrics().density);
        params.height = (int) (72 * getResources().getDisplayMetrics().density);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.y = (int) (36 * getResources().getDisplayMetrics().density);
        window.setAttributes(params);
    }

    private void showPulseScreen() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.TRANSPARENT);

        gateButton = new TextView(this);
        gateButton.setText("GATE");
        gateButton.setTextColor(Color.WHITE);
        gateButton.setTextSize(20);
        gateButton.setGravity(Gravity.CENTER);
        gateButton.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        gateButton.setBackgroundResource(R.drawable.gate_pulse_tile);

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        );
        params.gravity = Gravity.CENTER;
        root.addView(gateButton, params);
        setContentView(root);

        gateButton.setScaleX(0.92f);
        gateButton.setScaleY(0.92f);
        gateButton.animate()
            .scaleX(1.08f)
            .scaleY(1.08f)
            .alpha(0.85f)
            .setDuration(160)
            .withEndAction(() -> gateButton.animate()
                .scaleX(1.0f)
                .scaleY(1.0f)
                .alpha(1.0f)
                .setDuration(140)
                .start())
            .start();
    }

    private void playPressTone() {
        try {
            ToneGenerator tone = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 70);
            tone.startTone(ToneGenerator.TONE_PROP_ACK, 120);
            gateButton.postDelayed(tone::release, 220);
        } catch (RuntimeException ignored) {
        }
    }
}
