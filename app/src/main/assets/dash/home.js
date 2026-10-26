/* RaceDash Home launcher. App list/launching comes from window.Home (HomeActivity);
 * live speed/GPS from dash.onNative(msg) like the dashboard. In a desktop browser it
 * shows a mock app list. */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const NATIVE = window.Native || null;
  const HOME = window.Home || null;
  const THEMES = window.RD_THEMES;
  const TAU = Math.PI * 2;

  const store = {
    get(k, d) {
      try {
        const v = NATIVE ? NATIVE.load(k) : localStorage.getItem(k);
        return v == null || v === '' ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set(k, v) {
      try {
        const s = JSON.stringify(v);
        if (NATIVE) NATIVE.save(k, s); else localStorage.setItem(k, s);
      } catch (e) { /* ignore */ }
    },
  };

  const CFG_DEFAULTS = { theme: 'apex', units: 'kmh', limitKmh: 0, limitMph: 0, gmaxKmh: 240, gmaxMph: 160, night: 'off' };
  let cfg = Object.assign({}, CFG_DEFAULTS, store.get('cfg', {}));
  const home = Object.assign({ pins: null, seenHelp: false }, store.get('home', {}));
  const saveHome = () => store.set('home', home);

  // Pinned by default if installed ("pkg/" matches any activity of that package).
  const DEFAULT_PINS = [
    'com.racedash.app/com.racedash.app.MainActivity',
    'com.google.android.apps.maps/', 'com.spotify.music/', 'com.google.android.apps.youtube.music/',
    'com.google.android.youtube/', 'com.android.chrome/', 'com.android.settings/',
  ];
  const DOCK_MAX = 5;

  const unitK = () => (cfg.units === 'mph' ? 2.2369363 : 3.6);
  const limit = () => (cfg.units === 'mph' ? cfg.limitMph : cfg.limitKmh);
  const gmax = () => (cfg.units === 'mph' ? cfg.gmaxMph : cfg.gmaxKmh);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
  const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const dirName = (h) => DIRS[Math.round(((h % 360) + 360) % 360 / 22.5) % 16];
  const pad3 = (n) => ('00' + Math.round(((n % 360) + 360) % 360) % 360).slice(-3);

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ------------------------------------------------------------------ theme + night
  const S = { night: false, theme: null, target: 0, disp: 0, heading: 0, headingTarget: 0,
    fixAt: 0, gpsFix: false, acc: 999, sats: 0, lux: -1, over: false };

  function vars() { return (THEMES[S.night ? 'stealth' : cfg.theme] || THEMES.apex).vars; }
  function applyTheme() {
    const id = S.night ? 'stealth' : cfg.theme;
    const v = (THEMES[id] || THEMES.apex).vars;
    const root = document.documentElement.style;
    Object.keys(v).forEach((k) => root.setProperty('--' + k, v[k]));
    S.theme = id; ring.drawn = -1;
  }
  let luxAvg = -1, nightSince = 0;
  function checkNight() {
    let want = false;
    if (cfg.night === 'clock') { const h = new Date().getHours(); want = h >= 19 || h < 6; }
    else if (cfg.night === 'sensor' && S.lux >= 0) {
      luxAvg = luxAvg < 0 ? S.lux : luxAvg * 0.8 + S.lux * 0.2;
      want = S.night ? luxAvg < 40 : luxAvg < 12;
    }
    if (want !== S.night) {
      if (!nightSince) nightSince = Date.now();
      if (Date.now() - nightSince > (cfg.night === 'sensor' ? 4000 : 0)) { S.night = want; nightSince = 0; applyTheme(); }
    } else nightSince = 0;
  }
  function reloadCfg() { cfg = Object.assign({}, CFG_DEFAULTS, store.get('cfg', {})); S.night = false; checkNight(); applyTheme(); }

  $('#btnTheme').addEventListener('click', () => {
    const ids = Object.keys(THEMES);
    const next = ids[(ids.indexOf(cfg.theme) + 1) % ids.length];
    const saved = store.get('cfg', {}); saved.theme = next; store.set('cfg', saved); // keep the dash's other settings
    cfg.theme = next; applyTheme();
    toast(S.night ? 'Night mode on — ' + THEMES[next].name + ' shows in daytime' : THEMES[next].name);
  });

  // ------------------------------------------------------------------ LEDs
  const LED_N = 15, ledEls = [];
  (function () {
    const box = $('#leds');
    for (let i = 0; i < LED_N; i++) {
      const el = document.createElement('i');
      el.className = i < 9 ? 'g' : i < 13 ? 'y' : 'r';
      el.style.animationDelay = (i * 0.045) + 's';
      box.appendChild(el); ledEls.push(el);
    }
  })();
  let ledLit = -1;
  function updateLeds(spdU) {
    const lim = limit(), top = lim > 0 ? lim : gmax();
    const n = clamp(Math.round((spdU / top) * LED_N), 0, LED_N);
    if (n === ledLit) return;
    ledLit = n; ledEls.forEach((el, i) => el.classList.toggle('on', i < n));
  }

  // ------------------------------------------------------------------ speed ring
  const A0 = Math.PI * 0.75, SWEEP = Math.PI * 1.5;
  const ring = { cv: $('#ring'), ctx: null, size: 0, drawn: -1 };
  function sizeRing() {
    const s = Math.round($('#ringWrap').getBoundingClientRect().width);
    const dpr = window.devicePixelRatio || 1;
    ring.size = s; ring.cv.width = s * dpr; ring.cv.height = s * dpr;
    ring.ctx = ring.cv.getContext('2d'); ring.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ring.drawn = -1;
  }
  function drawRing(spdU) {
    if (!ring.ctx || Math.abs(spdU - ring.drawn) < 0.05) return;
    ring.drawn = spdU;
    const x = ring.ctx, W = ring.size, c = W / 2, r = W * 0.42, v = vars();
    const f = clamp(spdU / gmax(), 0, 1), a = A0 + SWEEP * f, lim = limit();
    x.clearRect(0, 0, W, W);
    x.lineCap = 'round'; x.lineWidth = W * 0.07; x.strokeStyle = v.line;
    x.beginPath(); x.arc(c, c, r, A0, A0 + SWEEP); x.stroke();
    // tick ring
    x.lineCap = 'butt'; x.lineWidth = 1.5; x.strokeStyle = v.dim;
    for (let i = 0; i <= 24; i++) {
      const t = A0 + SWEEP * i / 24, r1 = r - W * 0.075, r2 = r1 - (i % 4 === 0 ? W * 0.04 : W * 0.02);
      x.beginPath(); x.moveTo(c + Math.cos(t) * r1, c + Math.sin(t) * r1); x.lineTo(c + Math.cos(t) * r2, c + Math.sin(t) * r2); x.stroke();
    }
    if (lim > 0) {
      const t = A0 + SWEEP * clamp(lim / gmax(), 0, 1);
      x.lineWidth = W * 0.012; x.strokeStyle = v.danger;
      x.beginPath(); x.moveTo(c + Math.cos(t) * (r - W * 0.05), c + Math.sin(t) * (r - W * 0.05));
      x.lineTo(c + Math.cos(t) * (r + W * 0.05), c + Math.sin(t) * (r + W * 0.05)); x.stroke();
    }
    if (f > 0.002) {
      const over = lim > 0 && spdU > lim;
      const g = x.createLinearGradient(0, W, W, 0);
      g.addColorStop(0, over ? v.danger : v.accent2); g.addColorStop(1, over ? v.danger : v.accent);
      x.lineCap = 'round'; x.lineWidth = W * 0.07; x.strokeStyle = g;
      x.beginPath(); x.arc(c, c, r, A0, a); x.stroke();
    }
  }

  // ------------------------------------------------------------------ apps
  let apps = [];
  const iconUrls = new Map();
  // Browser-preview only: sample apps with drawn icons (on a head unit the real list is used).
  const MOCK = [['RaceDash', 'com.racedash.app', 'com.racedash.app.MainActivity', '🏁', '#ff2a2a', '#7a0010'],
    ['Maps', 'com.google.android.apps.maps', '.Main', '🗺️', '#34a853', '#0b5d2a'], ['Spotify', 'com.spotify.music', '.Main', '🎧', '#1ed760', '#0b4f26'],
    ['YT Music', 'com.google.android.apps.youtube.music', '.Main', '🎵', '#ff3d3d', '#6e0d0d'], ['Phone', 'com.android.dialer', '.Main', '📞', '#2f80ff', '#0a2f73'],
    ['Bluetooth Audio', 'com.bt.music', '.Main', '🔊', '#6c5ce7', '#2a1f73'], ['FM Radio', 'com.fm.radio', '.Main', '📻', '#ff9f1a', '#7a3d00'],
    ['Waze', 'com.waze', '.Main', '🚙', '#33ccff', '#0a4a66'], ['Weather', 'com.weather', '.Main', '⛅', '#4fc3f7', '#0d3a66'],
    ['Podcasts', 'com.podcasts', '.Main', '🎙️', '#b042ff', '#3d0a66'], ['Chrome', 'com.android.chrome', '.Main', '🌐', '#fbbc05', '#7a4a00'],
    ['Camera', 'com.android.camera', '.Main', '📷', '#8e9aaf', '#2d3440'], ['Files', 'com.android.files', '.Main', '📁', '#ffca28', '#7a5200'],
    ['Calendar', 'com.calendar', '.Main', '📅', '#ff5c5c', '#6e1a1a'], ['Play Store', 'com.android.vending', '.Main', '▶️', '#00c389', '#004d36'],
    ['Settings', 'com.android.settings', '.Main', '⚙️', '#9aa4b2', '#2b313b']]
    .map(([label, pkg, cls, glyph, c1, c2]) => ({ label, pkg, cls, glyph, c1, c2 }));
  function mockIcon(a) {
    if (!a.glyph) return '';
    const c = document.createElement('canvas'); c.width = c.height = 96;
    const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 96, 96);
    g.addColorStop(0, a.c1); g.addColorStop(1, a.c2);
    x.fillStyle = g; x.beginPath(); x.moveTo(24, 0); x.arcTo(96, 0, 96, 96, 24); x.arcTo(96, 96, 0, 96, 24); x.arcTo(0, 96, 0, 0, 24); x.arcTo(0, 0, 96, 0, 24); x.fill();
    x.font = '52px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(a.glyph, 48, 52);
    return c.toDataURL();
  }

  function loadApps() {
    let list = MOCK;
    if (HOME) { try { list = JSON.parse(HOME.apps()); } catch (e) { list = []; } }
    apps = list.map((a) => Object.assign({}, a, { key: a.pkg + '/' + a.cls }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    if (!home.pins) {
      home.pins = [];
      DEFAULT_PINS.forEach((p) => {
        const m = apps.find((a) => (p.endsWith('/') ? a.pkg + '/' === p : a.key === p));
        if (m && !home.pins.includes(m.key) && home.pins.length < DOCK_MAX) home.pins.push(m.key);
      });
      saveHome();
    }
    home.pins = home.pins.filter((k) => apps.some((a) => a.key === k)); // drop uninstalled
    render();
  }

  const iconQueue = [];
  let iconBusy = false;
  function queueIcon(a, ico) {
    const url = iconUrls.get(a.key);
    if (url) { setIcon(ico, url, a); return; }
    iconQueue.push([a, ico]);
    if (!iconBusy) { iconBusy = true; setTimeout(pumpIcons, 0); }
  }
  function pumpIcons() {
    // a few per tick so the screen stays responsive while icons stream in
    for (let n = 0; n < 4 && iconQueue.length; n++) {
      const [a, ico] = iconQueue.shift();
      let url = iconUrls.get(a.key);
      if (url == null) { url = HOME ? HOME.icon(a.pkg, a.cls) || '' : mockIcon(a); iconUrls.set(a.key, url); }
      if (url) setIcon(ico, url, a);
    }
    if (iconQueue.length) setTimeout(pumpIcons, 16); else iconBusy = false;
  }
  function setIcon(ico, url, a) {
    ico.classList.remove('letter'); ico.textContent = '';
    const img = new Image(); img.src = url; img.alt = ''; img.draggable = false; ico.appendChild(img);
    if (home.pins.includes(a.key)) addPinDot(ico);
  }
  function addPinDot(ico) { const p = document.createElement('i'); p.className = 'pin'; ico.appendChild(p); }

  function appEl(a) {
    const b = document.createElement('button');
    b.className = 'app';
    const ico = document.createElement('div');
    ico.className = 'ico letter'; ico.textContent = (a.label.trim()[0] || '?').toUpperCase();
    if (home.pins.includes(a.key)) addPinDot(ico);
    const s = document.createElement('span'); s.textContent = a.label;
    b.appendChild(ico); b.appendChild(s);
    bindPress(b, a);
    queueIcon(a, ico);
    return b;
  }
  function render() {
    iconQueue.length = 0;
    const grid = $('#apps'); grid.innerHTML = '';
    apps.forEach((a) => grid.appendChild(appEl(a)));
    $('#appCount').textContent = apps.length;
    const dock = $('#dock'); dock.innerHTML = '';
    home.pins.forEach((k) => { const a = apps.find((x) => x.key === k); if (a) dock.appendChild(appEl(a)); });
    for (let i = home.pins.length; i < DOCK_MAX; i++) {
      const e = document.createElement('div'); e.className = 'empty'; e.textContent = '+ Hold an app to pin'; dock.appendChild(e);
      if (i >= home.pins.length) break; // one hint tile is enough
    }
  }

  function bindPress(el, a) {
    let timer = 0, long = false, sx = 0, sy = 0;
    el.addEventListener('pointerdown', (e) => {
      long = false; sx = e.clientX; sy = e.clientY; el.classList.add('press');
      timer = setTimeout(() => { long = true; el.classList.remove('press'); openMenu(a); }, 550);
    });
    el.addEventListener('pointermove', (e) => {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 12) { clearTimeout(timer); el.classList.remove('press'); }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => el.addEventListener(t, () => { clearTimeout(timer); el.classList.remove('press'); }));
    el.addEventListener('click', () => { if (!long) launch(a); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  function launch(a) {
    if (HOME) HOME.launch(a.pkg, a.cls); else toast('Open ' + a.label);
  }

  // long-press menu
  let menuApp = null;
  function openMenu(a) {
    menuApp = a;
    const pinned = home.pins.includes(a.key);
    $('#menuLabel').textContent = a.label;
    const img = $('#menuIcon'); const url = iconUrls.get(a.key);
    img.style.display = url ? '' : 'none'; if (url) img.src = url;
    $('#menuPin').textContent = pinned ? 'Unpin from dock' : (home.pins.length >= DOCK_MAX ? 'Dock full — unpin one first' : 'Pin to dock');
    $('#menuPin').disabled = !pinned && home.pins.length >= DOCK_MAX;
    $('#menu').classList.remove('hidden');
  }
  const closeMenu = () => $('#menu').classList.add('hidden');
  $('#menuPin').addEventListener('click', () => {
    const k = menuApp.key, i = home.pins.indexOf(k);
    if (i >= 0) home.pins.splice(i, 1); else if (home.pins.length < DOCK_MAX) home.pins.push(k);
    saveHome(); closeMenu(); render();
  });
  $('#menuInfo').addEventListener('click', () => { if (HOME) HOME.appInfo(menuApp.pkg); closeMenu(); });
  $('#menuClose').addEventListener('click', closeMenu);
  $('#menu').addEventListener('click', (e) => { if (e.target.id === 'menu') closeMenu(); });

  // ------------------------------------------------------------------ exit / help
  $('#btnExit').addEventListener('click', () => {
    if (!HOME) { toast('Would switch to the system launcher'); return; }
    if (!HOME.exitToSystem()) { toast('No other launcher found — opening Home settings'); HOME.homeSettings(); }
  });
  $('#openDash').addEventListener('click', () => {
    const dash = apps.find((a) => a.pkg === 'com.racedash.app');
    if (dash) launch(dash); else toast('RaceDash');
  });
  const openTrips = (tab) => { if (NATIVE) NATIVE.openTrips(tab); else location.href = 'trips.html#' + tab; };
  $('#openTrips').addEventListener('click', () => openTrips('trips'));
  $('#openParked').addEventListener('click', () => openTrips('parked'));

  function openHelp() {
    $('#defaultState').textContent = HOME
      ? (HOME.isDefault() ? 'RaceDash Home is currently your home screen.' : 'The system launcher is currently your home screen.')
      : '';
    $('#help').classList.remove('hidden');
  }
  const closeHelp = () => { $('#help').classList.add('hidden'); if (!home.seenHelp) { home.seenHelp = true; saveHome(); } };
  $('#btnHelp').addEventListener('click', openHelp);
  $('#helpClose').addEventListener('click', closeHelp);
  $('#helpSettings').addEventListener('click', () => { closeHelp(); if (HOME) HOME.homeSettings(); else toast('Opens Android Home settings'); });
  $('#help').addEventListener('click', (e) => { if (e.target.id === 'help') closeHelp(); });

  // ------------------------------------------------------------------ native events
  function onNative(m) {
    if (!m || !m.t) return;
    if (m.t === 'loc') {
      if (!m.gps || m.stale) return;
      wake();
      let v = m.spd < 0 ? 0 : m.spd; if (v < 0.45) v = 0;
      S.target = v; S.acc = m.acc; S.fixAt = Date.now(); S.gpsFix = true;
      if (m.hasBrg && v > 1.5) S.headingTarget = m.brg;
    } else if (m.t === 'gnss') { S.sats = m.sats; }
    else if (m.t === 'imu') { S.lux = m.lux; }
    else if (m.t === 'apps') { loadApps(); }
    else if (m.t === 'home' || m.t === 'back') { closeMenu(); closeHelp(); if (m.t === 'home') $('#apps').scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (m.t === 'toast') { toast(m.msg); }
  }

  // ------------------------------------------------------------------ loop
  // Only touch the DOM when a value really changes (avoids needless re-layout/repaint).
  function setText(node, v) { v = String(v); if (node._t !== v) { node._t = v; node.textContent = v; } }
  function setClass(node, v) { if (node.className !== v) node.className = v; }
  // Full frame rate only while the speed ring/heading is moving; otherwise a 500 ms tick.
  let rafOn = false, lastFrameAt = 0, idleTimer = 0, introUntil = Date.now() + 1500;
  function wake() {
    // Older WebViews can drop a frame request made while the screen was in the background,
    // so a request that hasn't produced a frame within 1 s is treated as lost and re-sent.
    if (rafOn && Date.now() - lastFrameAt < 1000) return;
    clearTimeout(idleTimer); rafOn = true; lastFrameAt = Date.now();
    requestAnimationFrame(frame);
  }
  setInterval(wake, 1000); // safety net: the loop can never stay stalled
  function isActive() {
    return Date.now() < introUntil || S.target > 0 || S.disp > 0.01 || Math.abs(angDiff(S.headingTarget, S.heading)) > 0.1;
  }
  let lastT = performance.now(), slowAt = 0, shown = -1;
  function frame(t) {
    lastFrameAt = Date.now();
    const dt = clamp((t - lastT) / 1000, 0, 0.1); lastT = t;
    S.disp += (S.target - S.disp) * (1 - Math.exp(-dt / 0.35));
    if (S.disp < 0.05 && S.target === 0) S.disp = 0;
    S.heading = (S.heading + angDiff(S.headingTarget, S.heading) * (1 - Math.exp(-dt / 0.45)) + 360) % 360;
    const spdU = S.disp * unitK();
    drawRing(spdU);
    if (Math.round(spdU) !== shown) { shown = Math.round(spdU); setText($('#speed'), shown); }
    if (!document.body.classList.contains('intro')) updateLeds(spdU);
    const lim = limit(), over = lim > 0 && spdU > lim + 0.5;
    if (over !== S.over) { S.over = over; document.body.classList.toggle('over', over); }
    if (t - slowAt > 500) { slowAt = t; slow(); }
    if (isActive()) requestAnimationFrame(frame);
    else { rafOn = false; idleTimer = setTimeout(wake, 500); }
  }
  function slow() {
    const now = new Date();
    setText($('#clock'), now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    setText($('#date'), now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }));
    setText($('#heading'), dirName(S.heading) + ' · ' + pad3(S.heading) + '°');
    setText($('#unit'), cfg.units === 'mph' ? 'MPH' : 'KM/H');
    const age = Date.now() - S.fixAt;
    if (S.gpsFix && age > 6000) S.target = 0;
    let cls = NATIVE ? 'bad' : 'ok', txt = NATIVE ? 'NO GPS' : 'DEMO';
    if (S.gpsFix && age < 5000) { cls = S.acc < 15 ? 'ok' : S.acc < 40 ? 'mid' : 'bad'; txt = (S.sats ? S.sats + ' SAT · ' : '') + '±' + Math.round(S.acc) + 'm'; }
    setClass($('#gps'), 'pill ' + cls); setText($('#gps span'), txt);
    checkNight();
    if (NATIVE) {
      let rec = false; try { rec = JSON.parse(NATIVE.liveTrip()).rec; } catch (e) { /* */ }
      $('#rec').classList.toggle('hidden', !rec);
    }
  }

  document.addEventListener('pointerdown', wake, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { reloadCfg(); ledLit = -1; ring.drawn = -1; rafOn = false; wake(); } });
  window.addEventListener('resize', sizeRing);

  window.dash = {
    onNative,
    onBack() {
      const open = !$('#menu').classList.contains('hidden') || !$('#help').classList.contains('hidden');
      closeMenu(); closeHelp(); return open;
    },
  };

  // boot
  checkNight();
  applyTheme();
  sizeRing();
  loadApps();
  slow();
  document.body.classList.add('intro');
  setTimeout(() => { document.body.classList.remove('intro'); ledLit = -1; }, 1300);
  if (!home.seenHelp) setTimeout(openHelp, 600);
  wake();
})();
