package com.knikt.apltv;

import android.net.Uri;

import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.TransferListener;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** A replacement may reuse the decoder, but its HTTP loads wait for the previous item's loads to close. */
final class StreamConnections {
    private final Map<Long, Integer> active = new HashMap<>();
    private long current;

    synchronized void activate(long source) {
        current = source;
        notifyAll();
    }

    private synchronized void acquire(long source) throws InterruptedIOException {
        while (source == current && active.size() > (active.containsKey(source) ? 1 : 0)) {
            try { wait(); }
            catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new InterruptedIOException("Stream load cancelled");
            }
        }
        if (source != current) throw new InterruptedIOException("Stream replaced");
        Integer count = active.get(source);
        active.put(source, count == null ? 1 : count + 1);
    }

    private synchronized void release(long source) {
        int remaining = active.get(source) - 1;
        if (remaining == 0) active.remove(source);
        else active.put(source, remaining);
        notifyAll();
    }

    DataSource.Factory forSource(DataSource.Factory upstream, long source) {
        return () -> new DataSource() {
            private final DataSource data = upstream.createDataSource();
            private boolean acquired;

            @Override public long open(DataSpec spec) throws IOException {
                acquire(source);
                acquired = true;
                try { return data.open(spec); }
                catch (IOException | RuntimeException e) {
                    try { close(); } catch (IOException closing) { e.addSuppressed(closing); }
                    throw e;
                }
            }

            @Override public void close() throws IOException {
                if (!acquired) return;
                try { data.close(); }
                finally {
                    acquired = false;
                    release(source);
                }
            }

            @Override public int read(byte[] buffer, int offset, int length) throws IOException {
                return data.read(buffer, offset, length);
            }
            @Override public Uri getUri() { return data.getUri(); }
            @Override public Map<String, List<String>> getResponseHeaders() { return data.getResponseHeaders(); }
            @Override public void addTransferListener(TransferListener listener) { data.addTransferListener(listener); }
        };
    }
}
