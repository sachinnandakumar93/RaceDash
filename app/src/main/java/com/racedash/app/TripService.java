package com.racedash.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONObject;

/**
 * Foreground service that watches GPS and records drives into TripStore, whichever app is
 * on screen. A drive starts after 3 fixes above ~9 km/h and ends after 8 minutes without
 * moving (long enough to sit through a traffic signal or jam).
 */
public class TripService extends Service implements LocationListener {

    private static final String CHANNEL = "trips";
    private static final int NOTIF_ID = 7;
    private static final float START_SPEED = 2.5f;     // m/s ≈ 9 km/h
    private static final float MOVING_SPEED = 1.0f;    // m/s
    private static final long STOP_END_MS = 8 * 60_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private LocationManager lm;
    private TripStore store;
    private int fastFixes;
    private long lastMoveAt;
    private final Runnable stopCheck = new Runnable() {
        @Override
        public void run() {
            if (store.isRecording() && System.currentTimeMillis() - lastMoveAt > STOP_END_MS) endTrip();
            handler.postDelayed(this, 30_000);
        }
    };

    static boolean autoRecordEnabled(Context c) {
        try {
            String cfg = c.getSharedPreferences("dash", MODE_PRIVATE).getString("cfg", null);
            return cfg == null || new JSONObject(cfg).optBoolean("autoRecord", true);
        } catch (Exception e) {
            return true;
        }
    }

    static double[] fuel(Context c) {
        double kmpl = 15, price = 102;
        try {
            String cfg = c.getSharedPreferences("dash", MODE_PRIVATE).getString("cfg", null);
            if (cfg != null) {
                JSONObject o = new JSONObject(cfg);
                kmpl = o.optDouble("fuelKmpl", kmpl);
                price = o.optDouble("fuelPrice", price);
            }
        } catch (Exception ignored) {
        }
        return new double[]{kmpl, price};
    }

    static void start(Context c) {
        if (c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return;
        if (!autoRecordEnabled(c)) return;
        try {
            c.startForegroundService(new Intent(c, TripService.class));
        } catch (RuntimeException ignored) {
            // e.g. background-start restrictions; the activities will retry on next open
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, TripService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        store = TripStore.get(this);
        double[] f = fuel(this);
        store.recoverUnfinished(f[0], f[1]);
        lm = (LocationManager) getSystemService(LOCATION_SERVICE);

        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Trip recording",
                NotificationManager.IMPORTANCE_MIN));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification(false), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIF_ID, notification(false));
        }
    }

    @SuppressLint("MissingPermission")
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            lm.removeUpdates(this);
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this, Looper.getMainLooper());
        } catch (SecurityException | IllegalArgumentException e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        handler.removeCallbacks(stopCheck);
        handler.postDelayed(stopCheck, 30_000);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(stopCheck);
        if (lm != null) lm.removeUpdates(this);
        // Keep an in-progress trip on disk; it is finished on next start if the car stays off.
        store.flush();
        super.onDestroy();
    }

    @Override
    public void onLocationChanged(Location l) {
        float spd = l.hasSpeed() ? l.getSpeed() : 0f;
        long now = System.currentTimeMillis();
        if (!store.isRecording()) {
            fastFixes = spd > START_SPEED ? fastFixes + 1 : 0;
            if (fastFixes >= 3) {
                store.begin(l);
                lastMoveAt = now;
                updateNotification(true);
            }
            return;
        }
        if (spd > MOVING_SPEED) {
            lastMoveAt = now;
            store.add(l);
        } else if (now - lastMoveAt > STOP_END_MS) {
            endTrip();
        } else {
            store.add(l);
        }
    }

    private void endTrip() {
        double[] f = fuel(this);
        store.finish(f[0], f[1]);
        fastFixes = 0;
        updateNotification(false);
    }

    private void updateNotification(boolean recording) {
        getSystemService(NotificationManager.class).notify(NOTIF_ID, notification(recording));
    }

    private Notification notification(boolean recording) {
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, TripsActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(recording ? "Recording trip" : "RaceDash trips")
                .setContentText(recording ? "Your drive is being logged" : "Will record your next drive")
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }

    @Override
    public void onProviderEnabled(String provider) {
    }

    @Override
    public void onProviderDisabled(String provider) {
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onStatusChanged(String provider, int status, Bundle extras) {
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
