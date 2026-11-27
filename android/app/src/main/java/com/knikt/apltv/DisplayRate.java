package com.knikt.apltv;

import android.app.Activity;
import android.hardware.display.DisplayManager;
import android.os.Handler;
import android.view.Display;
import android.view.Window;
import android.view.WindowManager;

/** Requests same-resolution HDMI modes on Android TV, including Android 11 on SHIELD. */
final class DisplayRate implements DisplayManager.DisplayListener {
    private static final float RATE_TOLERANCE = 0.01f;
    private final Activity activity;
    private final Window window;
    private final DisplayManager displays;
    private final Handler ui;
    private final Runnable switched;
    private int requestedMode;
    private boolean changing;
    private final Runnable finish = this::finishSwitch;

    DisplayRate(Activity activity, Handler ui, Runnable switched) {
        this.activity = activity;
        this.window = activity.getWindow();
        this.ui = ui;
        this.switched = switched;
        displays = activity.getSystemService(DisplayManager.class);
        if (displays != null) displays.registerDisplayListener(this, ui);
    }

    private Display display() { return activity.getWindowManager().getDefaultDisplay(); }

    boolean isChanging() { return changing; }
    float refreshRate() { return display().getMode().getRefreshRate(); }

    void match(float fps) {
        Display d = display();
        Display.Mode current = d.getMode();
        Display.Mode target = choose(current, d.getSupportedModes(), fps);
        if (target == null) {
            if (fps > 0) reset();
            return;
        }
        if (target.getModeId() == requestedMode) return;
        if (target.getModeId() == current.getModeId() && requestedMode == 0) return;

        // A mode already active can still be the right answer while a different request is pending.
        changing = target.getModeId() != current.getModeId();
        setMode(target.getModeId());
        ui.removeCallbacks(finish);
        if (changing) ui.postDelayed(finish, 2500);
    }

    static Display.Mode choose(Display.Mode current, Display.Mode[] modes, float fps) {
        if (!(fps >= 15f && fps <= 125f)) return null;
        // Prefer field-rate output for 25/29.97/30 fps, including interlaced IPTV.
        int minimum = fps >= 24.9f && fps <= 30.01f ? 2 : 1;
        int currentMultiple = multiple(current.getRefreshRate(), fps);
        if (currentMultiple >= minimum) return current;
        Display.Mode best = null;
        int bestRank = Integer.MAX_VALUE;
        for (Display.Mode mode : modes) {
            if (mode.getPhysicalWidth() != current.getPhysicalWidth() || mode.getPhysicalHeight() != current.getPhysicalHeight()) continue;
            int multiple = multiple(mode.getRefreshRate(), fps);
            if (multiple == 0) continue;
            int rank = multiple >= minimum ? multiple : 100;
            if (rank < bestRank) { best = mode; bestRank = rank; }
        }
        return best;
    }

    private static int multiple(float hz, float fps) {
        int multiple = Math.round(hz / fps);
        return multiple >= 1 && Math.abs(hz / multiple - fps) < RATE_TOLERANCE ? multiple : 0;
    }

    void reset() {
        ui.removeCallbacks(finish);
        changing = false;
        if (requestedMode != 0) setMode(0);
    }

    private void setMode(int modeId) {
        requestedMode = modeId;
        WindowManager.LayoutParams attrs = window.getAttributes();
        attrs.preferredDisplayModeId = modeId;
        window.setAttributes(attrs);
    }

    private void finishSwitch() {
        if (!changing) return;
        changing = false;
        switched.run();
    }

    @Override public void onDisplayChanged(int id) {
        if (!changing || id != display().getDisplayId() || display().getMode().getModeId() != requestedMode) return;
        ui.removeCallbacks(finish);
        ui.postDelayed(finish, 500);
    }

    @Override public void onDisplayAdded(int id) {}
    @Override public void onDisplayRemoved(int id) {}

    void release() {
        reset();
        if (displays != null) displays.unregisterDisplayListener(this);
    }
}
