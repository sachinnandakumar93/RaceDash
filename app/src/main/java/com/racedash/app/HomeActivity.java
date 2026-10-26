package com.racedash.app;

import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Race-themed home screen (assets/dash/home.html). It can be opened like a normal app,
 * or chosen as the Home app; the SYSTEM button always jumps to the box's own launcher.
 * It never changes the default launcher itself — that choice stays with the user.
 */
public class HomeActivity extends MainActivity {

    private static final int ICON_PX = 96;

    private final Map<String, String> iconCache = new ConcurrentHashMap<>();
    private BroadcastReceiver packageReceiver;

    @Override
    protected String pageUrl() {
        return "file:///android_asset/dash/home.html";
    }

    @Override
    protected void onWebCreated(WebView web) {
        web.addJavascriptInterface(new HomeBridge(), "Home");
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        packageReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                Uri data = intent.getData();
                if (data != null) iconCache.keySet().removeIf(k -> k.startsWith(data.getSchemeSpecificPart() + "/"));
                pushEvent("apps", null);
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_PACKAGE_ADDED);
        f.addAction(Intent.ACTION_PACKAGE_REMOVED);
        f.addAction(Intent.ACTION_PACKAGE_CHANGED);
        f.addDataScheme("package");
        registerReceiver(packageReceiver, f);
    }

    @Override
    protected void onDestroy() {
        if (packageReceiver != null) unregisterReceiver(packageReceiver);
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Home pressed while already home: close menus, scroll back to the top.
        pushEvent("home", null);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // As the Home app there is nowhere to go back to; just close open panels.
        // When opened as a normal app, Back leaves it like any other app.
        if (isDefaultHome()) {
            pushEvent("back", null);
        } else {
            super.onBackPressed();
        }
    }

    private void pushEvent(String type, String msg) {
        try {
            JSONObject o = new JSONObject().put("t", type);
            if (msg != null) o.put("msg", msg);
            push(o);
        } catch (JSONException ignored) {
        }
    }

    private boolean isDefaultHome() {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        ResolveInfo ri = getPackageManager().resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY);
        return ri != null && ri.activityInfo != null && getPackageName().equals(ri.activityInfo.packageName);
    }

    /** The box's own launcher: another HOME activity, preferring system apps; never Settings' FallbackHome. */
    private ComponentName findSystemHome() {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        List<ResolveInfo> list = getPackageManager().queryIntentActivities(home, 0);
        ComponentName fallback = null;
        for (ResolveInfo ri : list) {
            String pkg = ri.activityInfo.packageName;
            if (pkg.equals(getPackageName()) || pkg.equals("com.android.settings")) continue;
            ComponentName cn = new ComponentName(pkg, ri.activityInfo.name);
            boolean system = (ri.activityInfo.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
            if (system) return cn;
            if (fallback == null) fallback = cn;
        }
        return fallback;
    }

    private static String drawableToDataUrl(Drawable d) {
        Bitmap bmp = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        d.setBounds(0, 0, ICON_PX, ICON_PX);
        d.draw(c);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
        bmp.recycle();
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    private class HomeBridge {
        @JavascriptInterface
        public String apps() {
            PackageManager pm = getPackageManager();
            Intent i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            JSONArray arr = new JSONArray();
            for (ResolveInfo ri : pm.queryIntentActivities(i, 0)) {
                String pkg = ri.activityInfo.packageName, cls = ri.activityInfo.name;
                if (cls.equals(HomeActivity.class.getName())) continue;
                try {
                    arr.put(new JSONObject().put("pkg", pkg).put("cls", cls)
                            .put("label", String.valueOf(ri.loadLabel(pm))));
                } catch (JSONException ignored) {
                }
            }
            return arr.toString();
        }

        @JavascriptInterface
        public String icon(String pkg, String cls) {
            String key = pkg + "/" + cls;
            String cached = iconCache.get(key);
            if (cached != null) return cached;
            try {
                String url = drawableToDataUrl(getPackageManager().getActivityIcon(new ComponentName(pkg, cls)));
                iconCache.put(key, url);
                return url;
            } catch (PackageManager.NameNotFoundException | RuntimeException e) {
                return "";
            }
        }

        @JavascriptInterface
        public void launch(String pkg, String cls) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                        .setComponent(new ComponentName(pkg, cls))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
                try {
                    startActivity(i);
                } catch (ActivityNotFoundException | SecurityException e) {
                    pushEvent("toast", "Couldn't open that app");
                }
            });
        }

        @JavascriptInterface
        public boolean exitToSystem() {
            ComponentName cn = findSystemHome();
            if (cn == null) return false;
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                            .setComponent(cn).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (ActivityNotFoundException | SecurityException e) {
                    pushEvent("toast", "Couldn't open the system launcher");
                }
            });
            return true;
        }

        @JavascriptInterface
        public boolean isDefault() {
            return isDefaultHome();
        }

        @JavascriptInterface
        public void homeSettings() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_HOME_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (ActivityNotFoundException e) {
                    startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                }
            });
        }

        @JavascriptInterface
        public void appInfo(String pkg) {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", pkg, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (ActivityNotFoundException ignored) {
                }
            });
        }
    }
}
