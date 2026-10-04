package com.rkiwi.gate;

/**
 * Tracks whether a nominally-playing live stream is still producing fresh
 * frames. This class deliberately has no Android dependencies so its timing
 * rules can be unit tested on the host JVM.
 */
final class FeedFreshnessTracker {
    static final String NO_VIDEO_FRAMES = "no_video_frames";
    static final String VIDEO_FALLING_BEHIND = "video_falling_behind";

    private static final long UNSET = Long.MIN_VALUE;

    private long monitoringStartedAtMs = UNSET;
    private long lastFrameAtMs = UNSET;
    private long baselineFrameAtMs = UNSET;
    private long baselinePresentationUs = UNSET;
    private long lastPresentationUs = UNSET;

    synchronized void reset(long elapsedRealtimeMs) {
        monitoringStartedAtMs = elapsedRealtimeMs;
        lastFrameAtMs = UNSET;
        baselineFrameAtMs = UNSET;
        baselinePresentationUs = UNSET;
        lastPresentationUs = UNSET;
    }

    synchronized void stop() {
        monitoringStartedAtMs = UNSET;
        lastFrameAtMs = UNSET;
        baselineFrameAtMs = UNSET;
        baselinePresentationUs = UNSET;
        lastPresentationUs = UNSET;
    }

    synchronized void onFrame(long elapsedRealtimeMs, long presentationTimeUs) {
        if (monitoringStartedAtMs == UNSET) {
            reset(elapsedRealtimeMs);
        }

        // A reconnect or stream discontinuity may reset the RTSP timestamps.
        // Start a new drift baseline instead of treating that as stale video.
        if (lastPresentationUs != UNSET && presentationTimeUs < lastPresentationUs) {
            baselineFrameAtMs = elapsedRealtimeMs;
            baselinePresentationUs = presentationTimeUs;
        } else if (baselinePresentationUs == UNSET) {
            baselineFrameAtMs = elapsedRealtimeMs;
            baselinePresentationUs = presentationTimeUs;
        }

        lastFrameAtMs = elapsedRealtimeMs;
        lastPresentationUs = presentationTimeUs;
    }

    synchronized String unhealthyReason(
            long elapsedRealtimeMs,
            long noFrameTimeoutMs,
            long maximumLagGrowthMs) {
        if (monitoringStartedAtMs == UNSET) return null;

        long freshnessAnchorMs = lastFrameAtMs == UNSET
            ? monitoringStartedAtMs
            : lastFrameAtMs;
        if (elapsedRealtimeMs - freshnessAnchorMs >= noFrameTimeoutMs) {
            return NO_VIDEO_FRAMES;
        }

        if (baselinePresentationUs != UNSET && lastPresentationUs != UNSET) {
            long wallProgressMs = lastFrameAtMs - baselineFrameAtMs;
            long videoProgressMs = Math.max(
                0L,
                (lastPresentationUs - baselinePresentationUs) / 1000L
            );
            if (wallProgressMs - videoProgressMs >= maximumLagGrowthMs) {
                return VIDEO_FALLING_BEHIND;
            }
        }

        return null;
    }
}
