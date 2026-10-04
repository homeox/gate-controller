package com.rkiwi.gate;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class FeedFreshnessTrackerTest {
    @Test
    public void reportsWhenStartupNeverProducesAFrame() {
        FeedFreshnessTracker tracker = new FeedFreshnessTracker();
        tracker.reset(1_000L);

        assertNull(tracker.unhealthyReason(10_999L, 10_000L, 6_000L));
        assertEquals(
            FeedFreshnessTracker.NO_VIDEO_FRAMES,
            tracker.unhealthyReason(11_000L, 10_000L, 6_000L)
        );
    }

    @Test
    public void reportsWhenFramesStopArriving() {
        FeedFreshnessTracker tracker = new FeedFreshnessTracker();
        tracker.reset(0L);
        tracker.onFrame(1_000L, 1_000_000L);
        tracker.onFrame(2_000L, 2_000_000L);

        assertEquals(
            FeedFreshnessTracker.NO_VIDEO_FRAMES,
            tracker.unhealthyReason(12_000L, 10_000L, 6_000L)
        );
    }

    @Test
    public void acceptsAStreamThatKeepsPaceWithRealTime() {
        FeedFreshnessTracker tracker = new FeedFreshnessTracker();
        tracker.reset(0L);
        tracker.onFrame(1_000L, 1_000_000L);
        tracker.onFrame(31_000L, 31_000_000L);

        assertNull(tracker.unhealthyReason(31_500L, 10_000L, 6_000L));
    }

    @Test
    public void reportsAStreamThatContinuesRenderingOldBufferedVideo() {
        FeedFreshnessTracker tracker = new FeedFreshnessTracker();
        tracker.reset(0L);
        tracker.onFrame(1_000L, 1_000_000L);
        tracker.onFrame(11_000L, 4_000_000L);

        assertEquals(
            FeedFreshnessTracker.VIDEO_FALLING_BEHIND,
            tracker.unhealthyReason(11_000L, 10_000L, 6_000L)
        );
    }

    @Test
    public void timestampResetStartsANewDriftBaseline() {
        FeedFreshnessTracker tracker = new FeedFreshnessTracker();
        tracker.reset(0L);
        tracker.onFrame(1_000L, 10_000_000L);
        tracker.onFrame(2_000L, 11_000_000L);
        tracker.onFrame(3_000L, 500_000L);
        tracker.onFrame(4_000L, 1_500_000L);

        assertNull(tracker.unhealthyReason(4_000L, 10_000L, 6_000L));
    }
}
