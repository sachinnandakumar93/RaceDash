package com.racedash.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.location.OnNmeaMessageListener;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.net.http.HttpResponseCache;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Hosts the dashboard UI (assets/dash) in a fullscreen WebView and streams GPS and
 * motion-sensor data into it as JSON via window.dash.onNative(...).
 *
 * Messages sent to the page:
 *   {t:"loc",  lat, lon, spd (m/s, -1 if unknown), brg, hasBrg, acc, alt, time}
 *   {t:"imu",  yaw (rad/s about the gravity axis, + = turning left), p (hPa or -1), lux (-1 if none)}
 *   {t:"gnss", sats (used in fix), seen}
 *   {t:"msl",  alt (metres above sea level, from NMEA GGA)}
 *   {t:"perm", granted}
 */
public class MainActivity extends Activity implements LocationListener, SensorEventListener {

    private static final int REQ_LOCATION = 1;
    private static final long IMU_PUSH_MS = 80;          // while driving (G-force meter)
    private static final long IMU_PUSH_PARKED_MS = 1000; // parked: only light level matters

    private WebView web;
    private boolean pageReady;
    private LocationManager locationManager;
    private SensorManager sensorManager;
    private GnssStatus.Callback gnssCallback;
    private OnNmeaMessageListener nmeaListener;
    private long lastMslPush;
    private SharedPreferences prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());

    // Unit vector pointing "up" (opposite gravity) in device coordinates.
    private final float[] up = {0f, 0f, 1f};
    private boolean haveGravitySensor;
    private float yawRate;
    private float pressure = -1f;
    private float lux = -1f;
    private long lastImuPush;
    private float lastSpeed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences("dash", MODE_PRIVATE);
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        sensorManager = (SensorManager) getSystemService(SENSOR_SERVICE);

        try {
            // Map tiles are fetched natively (see fetchTile) and cached here across drives.
            HttpResponseCache.install(new File(getCacheDir(), "tiles"), 150L * 1024 * 1024);
        } catch (IOException ignored) {
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        setContentView(web);
        setupWebView();
        web.loadUrl(pageUrl());
    }

    /** Page to show; HomeActivity overrides this with the launcher page. */
    protected String pageUrl() {
        return "file:///android_asset/dash/index.html";
    }

    /** Hook for subclasses to add extra JavaScript interfaces before the page loads. */
    protected void onWebCreated(WebView web) {
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMinimumFontSize(1);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        web.addJavascriptInterface(new Bridge(), "Native");
        onWebCreated(web);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                // JS errors/warnings show up in `adb logcat -s RaceDashJS`
                if (m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR
                        || m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.WARNING) {
                    android.util.Log.w("RaceDashJS", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                if ("tile.openstreetmap.org".equals(req.getUrl().getHost())) {
                    return fetchTile(req.getUrl().toString());
                }
                return null;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                pushLastKnownLocation();
                sendPermissionState();
            }
        });
    }

    /**
     * OpenStreetMap's tile policy requires an identifying User-Agent, which WebView image
     * requests from a file:// page don't send, so tiles are loaded here instead.
     */
    private WebResourceResponse fetchTile(String url) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestProperty("User-Agent", "RaceDash/1.0 (Android in-car dashboard; personal use)");
            c.setUseCaches(true);
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            int code = c.getResponseCode();
            if (code != 200) {
                c.disconnect();
                return new WebResourceResponse("image/png", null, 404, "Not Found",
                        Collections.emptyMap(), null);
            }
            InputStream in = c.getInputStream();
            return new WebResourceResponse("image/png", null, 200, "OK",
                    Collections.singletonMap("Access-Control-Allow-Origin", "*"), in);
        } catch (IOException e) {
            return new WebResourceResponse("image/png", null, 503, "Offline",
                    Collections.emptyMap(), null);
        }
    }

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        hideSystemUi();
        if (hasLocationPermission()) {
            startLocation();
            TripService.start(this);
        } else {
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
        }
        startSensors();
    }

    @Override
    protected void onStop() {
        super.onStop();
        HttpResponseCache cache = HttpResponseCache.getInstalled();
        if (cache != null) cache.flush();
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        stopLocation();
        sensorManager.unregisterListener(this);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Let the page close its settings panel first.
        web.evaluateJavascript("window.dash ? dash.onBack() : false", value -> {
            if (!"true".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    // ---------------------------------------------------------------- location

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_LOCATION) {
            sendPermissionState();
            if (hasLocationPermission()) {
                startLocation();
                pushLastKnownLocation();
                TripService.start(this);
            }
        }
    }

    @SuppressLint("MissingPermission")
    private void startLocation() {
        if (!hasLocationPermission() || locationManager == null) return;
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                        LocationManager.GPS_PROVIDER, 0L, 0f, this, Looper.getMainLooper());
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                // Coarse fallback so the map appears before the first satellite fix.
                locationManager.requestLocationUpdates(
                        LocationManager.NETWORK_PROVIDER, 5000L, 0f, this, Looper.getMainLooper());
            }
            if (gnssCallback == null) {
                gnssCallback = new GnssStatus.Callback() {
                    @Override
                    public void onSatelliteStatusChanged(GnssStatus status) {
                        int used = 0;
                        for (int i = 0; i < status.getSatelliteCount(); i++) {
                            if (status.usedInFix(i)) used++;
                        }
                        try {
                            push(new JSONObject().put("t", "gnss").put("sats", used)
                                    .put("seen", status.getSatelliteCount()));
                        } catch (JSONException ignored) {
                        }
                    }
                };
            }
            locationManager.registerGnssStatusCallback(gnssCallback, handler);
            if (nmeaListener == null) {
                // GGA sentences carry altitude above sea level; Location.getAltitude() on
                // Android 13 is height above the WGS84 ellipsoid (often tens of metres off).
                nmeaListener = (msg, ts) -> {
                    if (msg.length() < 7 || !msg.startsWith("GGA", 3)) return;
                    String[] f = msg.split(",");
                    if (f.length < 10 || f[6].isEmpty() || "0".equals(f[6]) || f[9].isEmpty()) return;
                    long now = System.currentTimeMillis();
                    if (now - lastMslPush < 2000) return;
                    lastMslPush = now;
                    try {
                        push(new JSONObject().put("t", "msl").put("alt", Double.parseDouble(f[9])));
                    } catch (JSONException | NumberFormatException ignored) {
                    }
                };
            }
            locationManager.addNmeaListener(nmeaListener, handler);
        } catch (SecurityException | IllegalArgumentException ignored) {
        }
    }

    private void stopLocation() {
        if (locationManager == null) return;
        locationManager.removeUpdates(this);
        if (gnssCallback != null) locationManager.unregisterGnssStatusCallback(gnssCallback);
        if (nmeaListener != null) locationManager.removeNmeaListener(nmeaListener);
    }

    @SuppressLint("MissingPermission")
    private void pushLastKnownLocation() {
        if (!pageReady || !hasLocationPermission()) return;
        try {
            Location gps = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            Location net = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            Location best = gps != null ? gps : net;
            if (best != null) pushLocation(best, true);
        } catch (SecurityException ignored) {
        }
    }

    @Override
    public void onLocationChanged(Location l) {
        // Ignore coarse network fixes once real GPS fixes are flowing.
        if (LocationManager.NETWORK_PROVIDER.equals(l.getProvider()) && lastGpsFix != 0
                && System.currentTimeMillis() - lastGpsFix < 10000) {
            return;
        }
        if (LocationManager.GPS_PROVIDER.equals(l.getProvider())) {
            lastGpsFix = System.currentTimeMillis();
        }
        pushLocation(l, false);
    }

    private long lastGpsFix;

    private void pushLocation(Location l, boolean stale) {
        if (!stale && l.hasSpeed()) lastSpeed = l.getSpeed();
        try {
            JSONObject o = new JSONObject()
                    .put("t", "loc")
                    .put("lat", l.getLatitude())
                    .put("lon", l.getLongitude())
                    .put("spd", l.hasSpeed() ? l.getSpeed() : -1)
                    .put("brg", l.hasBearing() ? l.getBearing() : 0)
                    .put("hasBrg", l.hasBearing())
                    .put("acc", l.hasAccuracy() ? l.getAccuracy() : 999)
                    .put("alt", l.hasAltitude() ? l.getAltitude() : -9999)
                    .put("gps", LocationManager.GPS_PROVIDER.equals(l.getProvider()))
                    .put("stale", stale)
                    .put("time", System.currentTimeMillis());
            push(o);
        } catch (JSONException ignored) {
        }
    }

    @Override
    public void onProviderEnabled(String provider) {
        startLocation();
    }

    @Override
    public void onProviderDisabled(String provider) {
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onStatusChanged(String provider, int status, Bundle extras) {
    }

    private void sendPermissionState() {
        try {
            push(new JSONObject().put("t", "perm").put("granted", hasLocationPermission()));
        } catch (JSONException ignored) {
        }
    }

    // ---------------------------------------------------------------- sensors

    private void startSensors() {
        Sensor gravity = sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY);
        haveGravitySensor = gravity != null;
        Sensor accel = haveGravitySensor ? gravity
                : sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        register(accel, SensorManager.SENSOR_DELAY_GAME);
        register(sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE), SensorManager.SENSOR_DELAY_GAME);
        register(sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE), SensorManager.SENSOR_DELAY_NORMAL);
        register(sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT), SensorManager.SENSOR_DELAY_NORMAL);
    }

    private void register(Sensor s, int rate) {
        if (s != null) sensorManager.registerListener(this, s, rate);
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        switch (e.sensor.getType()) {
            case Sensor.TYPE_GRAVITY:
            case Sensor.TYPE_ACCELEROMETER: {
                float x = e.values[0], y = e.values[1], z = e.values[2];
                float n = (float) Math.sqrt(x * x + y * y + z * z);
                if (n < 1f) return;
                // Raw accelerometer needs heavy low-pass to approximate gravity.
                float k = haveGravitySensor ? 1f : 0.05f;
                up[0] += (x / n - up[0]) * k;
                up[1] += (y / n - up[1]) * k;
                up[2] += (z / n - up[2]) * k;
                break;
            }
            case Sensor.TYPE_GYROSCOPE: {
                // Rotation about the vertical axis = yaw rate, whatever way the box is mounted.
                float yaw = e.values[0] * up[0] + e.values[1] * up[1] + e.values[2] * up[2];
                yawRate += (yaw - yawRate) * 0.2f;
                long now = System.currentTimeMillis();
                if (now - lastImuPush >= (lastSpeed > 1f ? IMU_PUSH_MS : IMU_PUSH_PARKED_MS)) {
                    lastImuPush = now;
                    try {
                        push(new JSONObject().put("t", "imu").put("yaw", yawRate)
                                .put("p", pressure).put("lux", lux));
                    } catch (JSONException ignored) {
                    }
                }
                break;
            }
            case Sensor.TYPE_PRESSURE:
                pressure = e.values[0];
                break;
            case Sensor.TYPE_LIGHT:
                lux = e.values[0];
                break;
            default:
                break;
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
    }

    // ---------------------------------------------------------------- bridge

    protected void push(JSONObject o) {
        if (!pageReady) return;
        web.evaluateJavascript("window.dash&&dash.onNative(" + o + ")", null);
    }

    private class Bridge {
        @JavascriptInterface
        public String load(String key) {
            return prefs.getString(key, null);
        }

        @JavascriptInterface
        public void save(String key, String value) {
            prefs.edit().putString(key, value).apply();
        }

        // ---- trips (TripStore) ----
        @JavascriptInterface
        public String trips() {
            return TripStore.get(MainActivity.this).index();
        }

        @JavascriptInterface
        public String trip(String id) {
            return TripStore.get(MainActivity.this).trip(id);
        }

        @JavascriptInterface
        public boolean deleteTrip(String id) {
            return TripStore.get(MainActivity.this).delete(id);
        }

        @JavascriptInterface
        public String parked() {
            return TripStore.get(MainActivity.this).parked();
        }

        @JavascriptInterface
        public void clearParked() {
            TripStore.get(MainActivity.this).clearParked();
        }

        @JavascriptInterface
        public String liveTrip() {
            return TripStore.get(MainActivity.this).live();
        }

        @JavascriptInterface
        public void setAutoRecord(boolean on) {
            runOnUiThread(() -> {
                if (on) TripService.start(MainActivity.this);
                else TripService.stop(MainActivity.this);
            });
        }

        @JavascriptInterface
        public void openTrips(String tab) {
            runOnUiThread(() -> startActivity(new android.content.Intent(MainActivity.this, TripsActivity.class)
                    .putExtra("tab", tab)));
        }

        @JavascriptInterface
        public void close() {
            runOnUiThread(MainActivity.this::finish);
        }

        @JavascriptInterface
        public void requestLocation() {
            runOnUiThread(() -> requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION));
        }
    }
}
