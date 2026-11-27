package com.knikt.apltv;

import androidx.media3.common.Format;

/** Detects steady frame cadence when the container omits it, particularly H.264 MPEG-TS. */
final class VideoCadence {
    private Format format;
    private long lastUs = Long.MIN_VALUE, totalUs;
    private int gaps;
    private float reported;

    float sample(long ptsUs, Format next) {
        if (next != format) {
            format = next;
            lastUs = Long.MIN_VALUE;
            gaps = 0;
            totalUs = 0;
            reported = 0;
        }
        if (next.frameRate >= 15f && next.frameRate <= 125f) return report(next.frameRate);

        long delta = lastUs == Long.MIN_VALUE ? 0 : ptsUs - lastUs;
        lastUs = ptsUs;
        if (delta < 8000 || delta > 67000 || (gaps > 0 && Math.abs(delta - totalUs / gaps) > 1500)) {
            gaps = 0;
            totalUs = 0;
            return 0;
        }
        totalUs += delta;
        if (++gaps < 16) return 0f;

        float rate = 1_000_000f * gaps / totalUs;
        gaps = 0;
        totalUs = 0;
        return report(rate);
    }

    private float report(float rate) {
        if (Math.abs(rate - reported) < 0.01f) return 0f;
        reported = rate;
        return rate;
    }
}
