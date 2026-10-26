package com.racedash.app;

/** Trip history, fuel cost and "where I parked" (assets/dash/trips.html). */
public class TripsActivity extends MainActivity {
    @Override
    protected String pageUrl() {
        String tab = getIntent().getStringExtra("tab");
        return "file:///android_asset/dash/trips.html" + ("parked".equals(tab) ? "#parked" : "");
    }
}
