package com.knikt.apltv;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.tv.TvContract;
import android.media.tv.TvContract.Channels;
import android.media.tv.TvContract.PreviewPrograms;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** An opt-in Android TV Home row. Its cards resolve the current item inside APL TV. */
final class HomeChannel {
    private static final String ROW = "apltv-home";
    private final Activity activity;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private String lastPayload;

    HomeChannel(Activity activity) { this.activity = activity; }

    boolean supported() {
        return Build.VERSION.SDK_INT >= 26 && activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
    }

    synchronized void sync(String payload, boolean request) {
        if (!supported() || payload == null || payload.length() > 8192 || worker.isShutdown()) return;
        worker.execute(() -> {
            try { update(payload, request); }
            catch (Exception e) {
                Log.w("APLTV", "Android TV Home row: " + e.getClass().getSimpleName());
                if (request) unavailable();
            }
        });
    }

    private void update(String payload, boolean request) throws Exception {
        if (!request && payload.equals(lastPayload)) return;
        ContentResolver resolver = activity.getContentResolver();
        long channel = findChannel(resolver);
        if (payload.isEmpty()) {
            if (channel >= 0) resolver.delete(TvContract.buildChannelUri(channel), null, null);
            lastPayload = payload;
            return;
        }
        JSONObject cards = new JSONObject(payload);
        // A row removed through the launcher is only recreated from the app's explicit Show on Home action.
        if (channel < 0 && !request) return;
        if (channel < 0) {
            ContentValues values = new ContentValues();
            values.put(Channels.COLUMN_TYPE, Channels.TYPE_PREVIEW);
            values.put(Channels.COLUMN_DISPLAY_NAME, activity.getApplicationInfo().loadLabel(activity.getPackageManager()).toString());
            values.put(Channels.COLUMN_INTERNAL_PROVIDER_ID, ROW);
            values.put(Channels.COLUMN_APP_LINK_INTENT_URI, launchUri(null));
            Uri created = resolver.insert(Channels.CONTENT_URI, values);
            if (created == null) throw new IllegalStateException("Channel insert failed");
            channel = ContentUris.parseId(created);
            try (InputStream image = activity.getResources().openRawResource(R.mipmap.ic_launcher);
                 OutputStream logo = resolver.openOutputStream(TvContract.buildChannelLogoUri(channel))) {
                if (logo == null) throw new IllegalStateException("Channel logo unavailable");
                byte[] buffer = new byte[8192];
                for (int n; (n = image.read(buffer)) != -1;) logo.write(buffer, 0, n);
            } catch (Exception e) {
                resolver.delete(created, null, null);
                throw e;
            }
        }
        upsert(resolver, channel, "last", cards.getString("lastLabel"), cards.optString("lastName"), 2);
        upsert(resolver, channel, "continue", cards.getString("continueLabel"), cards.optString("continueName"), 1);
        lastPayload = payload;
        if (request) askToShow(channel);
    }

    private long findChannel(ContentResolver resolver) {
        try (Cursor c = resolver.query(Channels.CONTENT_URI, new String[]{Channels._ID, Channels.COLUMN_INTERNAL_PROVIDER_ID}, null, null, null)) {
            while (c != null && c.moveToNext()) if (ROW.equals(c.getString(1))) return c.getLong(0);
        }
        return -1;
    }

    private void upsert(ContentResolver resolver, long channel, String action, String title, String description, int weight) {
        ContentValues values = new ContentValues();
        values.put(PreviewPrograms.COLUMN_CHANNEL_ID, channel);
        values.put(PreviewPrograms.COLUMN_INTERNAL_PROVIDER_ID, action);
        values.put(PreviewPrograms.COLUMN_TYPE, PreviewPrograms.TYPE_CLIP);
        values.put(PreviewPrograms.COLUMN_TITLE, title);
        values.put(PreviewPrograms.COLUMN_SHORT_DESCRIPTION, description);
        values.put(PreviewPrograms.COLUMN_INTENT_URI, launchUri(action));
        values.put(PreviewPrograms.COLUMN_POSTER_ART_URI, "android.resource://" + activity.getPackageName() + "/" + R.drawable.banner);
        values.put(PreviewPrograms.COLUMN_POSTER_ART_ASPECT_RATIO, PreviewPrograms.ASPECT_RATIO_16_9);
        values.put(PreviewPrograms.COLUMN_WEIGHT, weight);
        Uri programs = TvContract.buildPreviewProgramsUriForChannel(channel);
        try (Cursor c = resolver.query(programs, new String[]{PreviewPrograms._ID, PreviewPrograms.COLUMN_INTERNAL_PROVIDER_ID}, null, null, null)) {
            while (c != null && c.moveToNext()) {
                if (!action.equals(c.getString(1))) continue;
                resolver.update(TvContract.buildPreviewProgramUri(c.getLong(0)), values, null, null);
                return;
            }
        }
        if (resolver.insert(PreviewPrograms.CONTENT_URI, values) == null) throw new IllegalStateException("Program insert failed");
    }

    private String launchUri(String action) {
        Intent intent = new Intent(Intent.ACTION_VIEW).setClass(activity, MainActivity.class);
        if (action != null) intent.putExtra("play", action);
        return intent.toUri(Intent.URI_INTENT_SCHEME);
    }

    private void askToShow(long channel) {
        activity.runOnUiThread(() -> {
            if (activity.isFinishing() || activity.isDestroyed()) return;
            try {
                activity.startActivity(new Intent(TvContract.ACTION_REQUEST_CHANNEL_BROWSABLE).putExtra(TvContract.EXTRA_CHANNEL_ID, channel));
            } catch (ActivityNotFoundException | SecurityException e) { unavailable(); }
        });
    }

    private void unavailable() {
        activity.runOnUiThread(() -> {
            if (!activity.isFinishing() && !activity.isDestroyed())
                Toast.makeText(activity, "This launcher could not add the APL TV Home row.", Toast.LENGTH_LONG).show();
        });
    }

    synchronized void release() { worker.shutdown(); }
}
