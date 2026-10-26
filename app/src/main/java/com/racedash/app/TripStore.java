package com.racedash.app;

import android.content.Context;
import android.location.Location;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * File-backed trip log in filesDir/trips:
 *   current.json  in-progress trip, flushed every 30 s so a power cut loses almost nothing
 *   index.json    trip summaries, newest first
 *   <id>.json     one finished trip: summary + points [secFromStart, lat*1e5, lon*1e5, km/h*10]
 *   parked.json   where the last trip ended
 * A trip left in current.json (car switched off mid-recording) is finished on next start.
 */
final class TripStore {

    private static final int MAX_TRIPS = 300;
    private static final float MIN_TRIP_M = 300f;
    private static final long FLUSH_MS = 30_000;
    private static final long POINT_MS = 3_000;
    private static TripStore instance;

    private final Context app;
    private final File dir;

    private JSONObject cur;      // summary of the trip being recorded
    private JSONArray curPts;
    private Location lastLoc;    // last accepted fix, for distance
    private long lastPointAt;
    private long lastFlushAt;

    static synchronized TripStore get(Context c) {
        if (instance == null) instance = new TripStore(c.getApplicationContext());
        return instance;
    }

    private TripStore(Context c) {
        app = c;
        dir = new File(c.getFilesDir(), "trips");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
    }

    // ------------------------------------------------------------ recording

    synchronized boolean isRecording() {
        return cur != null;
    }

    synchronized void begin(Location l) {
        long now = l.getTime() > 0 ? l.getTime() : System.currentTimeMillis();
        cur = new JSONObject();
        curPts = new JSONArray();
        lastLoc = null;
        lastPointAt = 0;
        try {
            cur.put("id", String.valueOf(now)).put("start", now).put("end", now)
                    .put("dist", 0.0).put("move", 0.0).put("max", 0.0)
                    .put("lat0", l.getLatitude()).put("lon0", l.getLongitude());
        } catch (JSONException ignored) {
        }
        add(l);
        flush();
    }

    /** Adds a GPS fix to the current trip. */
    synchronized void add(Location l) {
        if (cur == null) return;
        try {
            long now = l.getTime() > 0 ? l.getTime() : System.currentTimeMillis();
            float spd = l.hasSpeed() ? l.getSpeed() : 0f;
            boolean good = !l.hasAccuracy() || l.getAccuracy() < 35f;
            if (lastLoc != null && good) {
                double dt = (now - lastLoc.getTime()) / 1000.0;
                if (dt > 0 && dt < 30) {
                    float d = lastLoc.distanceTo(l);
                    float vmax = Math.max(spd, lastLoc.hasSpeed() ? lastLoc.getSpeed() : spd);
                    // ignore GPS jumps and parked jitter
                    if (spd > 0.5f && d < vmax * dt * 1.6 + 15) {
                        cur.put("dist", cur.getDouble("dist") + d);
                        cur.put("move", cur.getDouble("move") + dt);
                    }
                }
            }
            if (good) lastLoc = new Location(l);
            if (lastLoc != null && lastLoc.getTime() == 0) lastLoc.setTime(now);
            if (spd > cur.getDouble("max")) cur.put("max", spd);
            if (spd > 0.5f) {
                cur.put("end", now);
                cur.put("lat1", l.getLatitude()).put("lon1", l.getLongitude());
            }
            if (good && now - lastPointAt >= POINT_MS) {
                lastPointAt = now;
                long t0 = cur.getLong("start");
                curPts.put(new JSONArray()
                        .put((now - t0) / 1000)
                        .put(Math.round(l.getLatitude() * 1e5))
                        .put(Math.round(l.getLongitude() * 1e5))
                        .put(Math.round(spd * 36)));
            }
            if (now - lastFlushAt > FLUSH_MS) flush();
        } catch (JSONException ignored) {
        }
    }

    /** Ends the current trip. Tiny trips (parking-lot shuffles) are discarded. */
    synchronized void finish(double fuelKmpl, double fuelPrice) {
        if (cur == null) return;
        try {
            if (cur.getDouble("dist") >= MIN_TRIP_M) {
                if (!cur.has("lat1")) cur.put("lat1", cur.getDouble("lat0")).put("lon1", cur.getDouble("lon0"));
                cur.put("kmpl", fuelKmpl).put("price", fuelPrice);
                JSONObject full = new JSONObject(cur.toString()).put("pts", curPts);
                String id = cur.getString("id");
                write(new File(dir, id + ".json"), full.toString());

                JSONArray idx = readArray(new File(dir, "index.json"));
                JSONArray out = new JSONArray().put(cur);
                for (int i = 0; i < idx.length(); i++) {
                    JSONObject o = idx.getJSONObject(i);
                    if (id.equals(o.optString("id"))) continue;
                    if (out.length() < MAX_TRIPS) out.put(o);
                    else //noinspection ResultOfMethodCallIgnored
                        new File(dir, o.optString("id") + ".json").delete();
                }
                write(new File(dir, "index.json"), out.toString());

                write(new File(dir, "parked.json"), new JSONObject()
                        .put("lat", cur.getDouble("lat1")).put("lon", cur.getDouble("lon1"))
                        .put("t", cur.getLong("end")).put("trip", id).toString());
            }
        } catch (JSONException ignored) {
        }
        cur = null;
        curPts = null;
        lastLoc = null;
        //noinspection ResultOfMethodCallIgnored
        new File(dir, "current.json").delete();
    }

    synchronized void flush() {
        if (cur == null) return;
        lastFlushAt = System.currentTimeMillis();
        try {
            write(new File(dir, "current.json"), new JSONObject(cur.toString()).put("pts", curPts).toString());
        } catch (JSONException ignored) {
        }
    }

    /** Finishes a trip that was interrupted by the power going off. */
    synchronized void recoverUnfinished(double fuelKmpl, double fuelPrice) {
        File f = new File(dir, "current.json");
        if (cur != null || !f.exists()) return;
        try {
            JSONObject o = new JSONObject(read(f));
            curPts = o.optJSONArray("pts");
            if (curPts == null) curPts = new JSONArray();
            o.remove("pts");
            cur = o;
            finish(fuelKmpl, fuelPrice);
        } catch (JSONException | IOException e) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            cur = null;
        }
    }

    // ------------------------------------------------------------ reading (for the UI)

    synchronized String index() {
        return readArray(new File(dir, "index.json")).toString();
    }

    synchronized String trip(String id) {
        if (!id.matches("\\d+")) return "null";
        try {
            return read(new File(dir, id + ".json"));
        } catch (IOException e) {
            return "null";
        }
    }

    synchronized String parked() {
        try {
            return read(new File(dir, "parked.json"));
        } catch (IOException e) {
            return "null";
        }
    }

    synchronized void clearParked() {
        //noinspection ResultOfMethodCallIgnored
        new File(dir, "parked.json").delete();
    }

    synchronized String live() {
        try {
            JSONObject o = new JSONObject().put("rec", cur != null);
            if (cur != null) {
                o.put("dist", cur.getDouble("dist")).put("start", cur.getLong("start"))
                        .put("move", cur.getDouble("move"));
            }
            return o.toString();
        } catch (JSONException e) {
            return "{\"rec\":false}";
        }
    }

    synchronized boolean delete(String id) {
        if (!id.matches("\\d+")) return false;
        try {
            JSONArray idx = readArray(new File(dir, "index.json"));
            JSONArray out = new JSONArray();
            for (int i = 0; i < idx.length(); i++) {
                JSONObject o = idx.getJSONObject(i);
                if (!id.equals(o.optString("id"))) out.put(o);
            }
            write(new File(dir, "index.json"), out.toString());
            //noinspection ResultOfMethodCallIgnored
            new File(dir, id + ".json").delete();
            return true;
        } catch (JSONException e) {
            return false;
        }
    }

    // ------------------------------------------------------------ file helpers

    private static String read(File f) throws IOException {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    private static JSONArray readArray(File f) {
        try {
            return new JSONArray(read(f));
        } catch (IOException | JSONException e) {
            return new JSONArray();
        }
    }

    /** Write to a temp file then rename, so a power cut never leaves a half-written file. */
    private static void write(File f, String s) {
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(s.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (IOException e) {
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        tmp.renameTo(f);
    }
}
