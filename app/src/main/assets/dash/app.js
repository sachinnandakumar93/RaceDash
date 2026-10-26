/* RaceDash dashboard. Data arrives from the Android host via dash.onNative(msg);
 * in a desktop browser (no window.Native) it runs on a simulated drive. */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const NATIVE = window.Native || null;
  const TAU = Math.PI * 2;
  const G = 9.80665;

  // ------------------------------------------------------------------ storage
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

  // ------------------------------------------------------------------ themes
  const THEMES = window.RD_THEMES;

  const LAYOUTS = ['race', 'gauge', 'map'];
  const GMAX = { kmh: [160, 200, 240, 300], mph: [100, 120, 160, 200] };

  const cfg = Object.assign({
    theme: 'apex', layout: 'race', units: 'kmh', limitKmh: 0, limitMph: 0,
    sound: true, gmaxKmh: 240, gmaxMph: 160, night: 'off', demo: !NATIVE, zoomOff: 0,
  }, store.get('cfg', {}));
  if (!NATIVE) cfg.demo = true;
  const saveCfg = () => store.set('cfg', cfg);

  const newTrip = () => ({ dist: 0, move: 0, max: 0, peakG: 0 });
  let realTrip = Object.assign(newTrip(), store.get('trip', {}));
  let odo = store.get('odo', 0);
  let demoTrip = newTrip();

  // ------------------------------------------------------------------ live state
  const S = {
    hasFix: false, gpsFix: false, fixAt: 0, lat: 0, lon: 0, acc: 999, gpsAlt: -9999, sats: 0, seen: 0,
    target: 0, disp: 0, headingTarget: 0, heading: 0, brgValid: false,
    aLon: 0, yaw: 0, yawAt: 0, gpsYaw: 0, gx: 0, gy: 0, pressure: -1, lux: -1,
    last: null, over: false, lastBeep: 0, perm: true, theme: null, night: false,
    pred: { x: 0, y: 0 },
  };

  const unitK = () => (cfg.units === 'mph' ? 2.2369363 : 3.6); // m/s -> display units
  const distK = () => (cfg.units === 'mph' ? 1 / 1609.344 : 1 / 1000); // m -> km|mi
  const limit = () => (cfg.units === 'mph' ? cfg.limitMph : cfg.limitKmh);
  const gmax = () => (cfg.units === 'mph' ? cfg.gmaxMph : cfg.gmaxKmh);
  const trip = () => (cfg.demo ? demoTrip : realTrip);

  // ------------------------------------------------------------------ helpers
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const angDiff = (a, b) => ((a - b + 540) % 360) - 180; // a-b in [-180,180)
  const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const dirName = (h) => DIRS[Math.round(((h % 360) + 360) % 360 / 22.5) % 16];
  const pad3 = (n) => ('00' + Math.round(((n % 360) + 360) % 360) % 360).slice(-3);
  function hav(la1, lo1, la2, lo2) {
    const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 12742000 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function hexRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    const A = hexRgb(a), B = hexRgb(b);
    return 'rgb(' + A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',') + ')';
  }
  function rgba(hex, a) { const c = hexRgb(hex); return 'rgba(' + c.join(',') + ',' + a + ')'; }
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function setupCanvas(cv, w, h) {
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  // ------------------------------------------------------------------ theme
  function effectiveTheme() { return S.night ? 'stealth' : cfg.theme; }
  function applyTheme() {
    const id = effectiveTheme();
    const th = THEMES[id] || THEMES.apex;
    const root = document.documentElement.style;
    Object.keys(th.vars).forEach((k) => root.setProperty('--' + k, th.vars[k]));
    document.body.dataset.gauge = th.gauge;
    S.theme = id;
    gauge.dirty = true; gauge.cache = null;
  }

  // ------------------------------------------------------------------ LEDs
  const LED_N = 15;
  const ledEls = [];
  (function buildLeds() {
    const box = $('#leds');
    for (let i = 0; i < LED_N; i++) {
      const el = document.createElement('i');
      el.className = i < 9 ? 'g' : i < 13 ? 'y' : 'r';
      box.appendChild(el); ledEls.push(el);
    }
  })();
  let ledLit = -1;
  function updateLeds(spdU) {
    const lim = limit();
    const top = lim > 0 ? lim : gmax();
    const n = clamp(Math.round((spdU / top) * LED_N), 0, LED_N);
    if (n === ledLit) return;
    ledLit = n;
    ledEls.forEach((el, i) => el.classList.toggle('on', i < n));
  }

  // ------------------------------------------------------------------ speedometer
  const A0 = Math.PI * 0.75, SWEEP = Math.PI * 1.5;
  const gauge = { cv: $('#gauge'), ctx: null, size: 0, dirty: true, cache: null, drawn: -1 };

  function labelStep(max) {
    for (const s of [10, 20, 25, 30, 40, 50]) if (max / s <= 12) return s;
    return 50;
  }
  function vars() { return (THEMES[effectiveTheme()] || THEMES.apex).vars; }

  function buildGaugeCache() {
    const W = gauge.size; if (!W) return;
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement('canvas');
    c.width = Math.round(W * dpr); c.height = Math.round(W * dpr);
    const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = vars(), style = THEMES[effectiveTheme()].gauge, max = gmax(), lim = limit();
    const cx = W / 2, cy = W / 2, r = W * 0.47;
    const ang = (s) => A0 + SWEEP * clamp(s / max, 0, 1);
    const step = labelStep(max);

    // dial face
    const face = x.createRadialGradient(cx, cy * 0.85, r * 0.1, cx, cy, r);
    face.addColorStop(0, rgba(v.panel, 1)); face.addColorStop(1, rgba(v.bg, 1));
    x.fillStyle = face; x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
    x.lineWidth = Math.max(1, W * 0.006); x.strokeStyle = v.line;
    x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.stroke();

    x.textAlign = 'center'; x.textBaseline = 'middle';
    const font = (px) => '700 ' + px + "px 'sans-serif-condensed','Roboto Condensed','Arial Narrow',sans-serif";

    if (style === 'segment') {
      const N = 60, r1 = r * 0.80, r2 = r * 0.95, seg = SWEEP / N;
      for (let i = 0; i < N; i++) {
        const a = A0 + i * seg + seg * 0.14, b = A0 + (i + 1) * seg - seg * 0.14;
        const inLim = lim > 0 && (i + 0.5) / N * max >= lim;
        x.fillStyle = inLim ? rgba(v.danger, 0.28) : v.line;
        x.beginPath(); x.arc(cx, cy, r2, a, b); x.arc(cx, cy, r1, b, a, true); x.closePath(); x.fill();
      }
      x.font = font(Math.round(r * 0.095)); x.fillStyle = v.dim;
      for (let s = 0; s <= max; s += step) {
        const a = ang(s); x.fillText(String(s), cx + Math.cos(a) * r * 0.66, cy + Math.sin(a) * r * 0.66);
      }
    } else if (style === 'needle') {
      // redline band
      const red0 = lim > 0 ? lim : max * 0.85;
      x.lineWidth = r * 0.06; x.strokeStyle = rgba(v.danger, 0.85); x.lineCap = 'butt';
      x.beginPath(); x.arc(cx, cy, r * 0.9, ang(red0), ang(max)); x.stroke();
      // ticks
      const minor = step / 2;
      for (let s = 0; s <= max + 0.01; s += minor) {
        const a = ang(s), major = Math.abs(s / step - Math.round(s / step)) < 1e-6;
        const ri = r * (major ? 0.78 : 0.84), ro = r * 0.94;
        x.strokeStyle = major ? v.text : v.dim; x.lineWidth = major ? W * 0.008 : W * 0.004;
        x.beginPath(); x.moveTo(cx + Math.cos(a) * ri, cy + Math.sin(a) * ri);
        x.lineTo(cx + Math.cos(a) * ro, cy + Math.sin(a) * ro); x.stroke();
      }
      x.font = font(Math.round(r * 0.11)); x.fillStyle = v.text;
      for (let s = 0; s <= max; s += step) {
        const a = ang(s); x.fillText(String(s), cx + Math.cos(a) * r * 0.64, cy + Math.sin(a) * r * 0.64);
      }
    } else { // ring
      x.lineCap = 'round'; x.lineWidth = r * 0.12; x.strokeStyle = v.line;
      x.beginPath(); x.arc(cx, cy, r * 0.84, A0, A0 + SWEEP); x.stroke();
      x.font = font(Math.round(r * 0.08)); x.fillStyle = v.dim;
      for (let s = 0; s <= max; s += step * 2) {
        const a = ang(s); x.fillText(String(s), cx + Math.cos(a) * r * 0.64, cy + Math.sin(a) * r * 0.64);
      }
      if (lim > 0) {
        const a = ang(lim); x.lineCap = 'butt'; x.lineWidth = W * 0.012; x.strokeStyle = v.danger;
        x.beginPath(); x.moveTo(cx + Math.cos(a) * r * 0.74, cy + Math.sin(a) * r * 0.74);
        x.lineTo(cx + Math.cos(a) * r * 0.97, cy + Math.sin(a) * r * 0.97); x.stroke();
      }
    }
    gauge.cache = c;
  }

  function drawGauge(spdU) {
    const W = gauge.size; if (!W || !gauge.ctx) return;
    if (!gauge.cache) buildGaugeCache();
    if (!gauge.dirty && Math.abs(spdU - gauge.drawn) < 0.05) return;
    gauge.dirty = false; gauge.drawn = spdU;
    const x = gauge.ctx, v = vars(), style = THEMES[effectiveTheme()].gauge, max = gmax(), lim = limit();
    const cx = W / 2, cy = W / 2, r = W * 0.47;
    const f = clamp(spdU / max, 0, 1), aCur = A0 + SWEEP * f;
    x.clearRect(0, 0, W, W);
    x.drawImage(gauge.cache, 0, 0, W, W);

    if (style === 'segment') {
      const N = 60, r1 = r * 0.80, r2 = r * 0.95, seg = SWEEP / N, lit = f * N;
      if (lit > 0.01) { // soft glow band under lit segments
        x.lineWidth = r * 0.24; x.lineCap = 'butt'; x.strokeStyle = rgba(v.accent, 0.10);
        x.beginPath(); x.arc(cx, cy, (r1 + r2) / 2, A0, aCur); x.stroke();
      }
      for (let i = 0; i < N && i < lit; i++) {
        const a = A0 + i * seg + seg * 0.14;
        const b = A0 + Math.min(i + 1, lit) * seg - seg * 0.14;
        if (b <= a) break;
        const inLim = lim > 0 && (i + 0.5) / N * max >= lim;
        x.fillStyle = inLim ? v.danger : mix(v.accent2, v.accent, i / N);
        x.beginPath(); x.arc(cx, cy, r2, a, b); x.arc(cx, cy, r1, b, a, true); x.closePath(); x.fill();
      }
    } else if (style === 'needle') {
      x.lineCap = 'round'; x.lineWidth = r * 0.025; x.strokeStyle = rgba(v.accent, 0.7);
      if (f > 0.002) { x.beginPath(); x.arc(cx, cy, r * 0.985, A0, aCur); x.stroke(); }
      const ca = Math.cos(aCur), sa = Math.sin(aCur), px = -sa, py = ca;
      const tip = r * 0.88, tail = r * 0.16, wb = r * 0.035;
      x.save();
      x.shadowColor = v.glow; x.shadowBlur = r * 0.08;
      x.fillStyle = v.accent;
      x.beginPath();
      x.moveTo(cx + ca * tip, cy + sa * tip);
      x.lineTo(cx + px * wb - ca * tail, cy + py * wb - sa * tail);
      x.lineTo(cx - px * wb - ca * tail, cy - py * wb - sa * tail);
      x.closePath(); x.fill();
      x.restore();
      x.fillStyle = v.panel; x.strokeStyle = v.accent; x.lineWidth = r * 0.025;
      x.beginPath(); x.arc(cx, cy, r * 0.075, 0, TAU); x.fill(); x.stroke();
    } else { // ring
      if (f > 0.002) {
        const over = lim > 0 && spdU > lim;
        x.lineCap = 'round';
        x.lineWidth = r * 0.22; x.strokeStyle = rgba(over ? v.danger : v.accent, 0.12);
        x.beginPath(); x.arc(cx, cy, r * 0.84, A0, aCur); x.stroke();
        let grad = over ? v.danger : v.accent;
        if (!over && x.createConicGradient) {
          grad = x.createConicGradient(A0, cx, cy);
          grad.addColorStop(0, v.accent2); grad.addColorStop(0.75, v.accent); grad.addColorStop(1, v.accent2);
        }
        x.lineWidth = r * 0.12; x.strokeStyle = grad;
        x.beginPath(); x.arc(cx, cy, r * 0.84, A0, aCur); x.stroke();
        x.fillStyle = '#fff';
        x.beginPath(); x.arc(cx + Math.cos(aCur) * r * 0.84, cy + Math.sin(aCur) * r * 0.84, r * 0.035, 0, TAU); x.fill();
      }
    }
  }

  // ------------------------------------------------------------------ G meter + compass
  const gmini = { cv: $('#gmini'), ctx: null, size: 0 };
  const gbig = { cv: $('#gbig'), ctx: null, size: 0 };
  const comp = { cv: $('#compass'), ctx: null, size: 0, drawn: 999 };
  const gTrail = [];

  function drawG(m, showTrail) {
    if (!m.ctx || !m.size) return;
    const key = S.gx.toFixed(3) + ',' + S.gy.toFixed(3) + ',' + S.theme;
    if (m.key === key) return;
    m.key = key;
    const x = m.ctx, W = m.size, c = W / 2, r = W * 0.46, v = vars(), scale = r / 1.0; // 1 g at rim
    x.clearRect(0, 0, W, W);
    x.strokeStyle = v.line; x.lineWidth = 1;
    [0.5, 1].forEach((g) => { x.beginPath(); x.arc(c, c, g * scale, 0, TAU); x.stroke(); });
    x.beginPath(); x.moveTo(c - r, c); x.lineTo(c + r, c); x.moveTo(c, c - r); x.lineTo(c, c + r); x.stroke();
    if (showTrail) {
      for (let i = 0; i < gTrail.length; i++) {
        const p = gTrail[i];
        x.fillStyle = rgba(v.accent, (i / gTrail.length) * 0.5);
        x.beginPath(); x.arc(c + clamp(p[0], -1.2, 1.2) * scale, c + clamp(p[1], -1.2, 1.2) * scale, W * 0.02, 0, TAU); x.fill();
      }
      x.font = '700 ' + Math.round(W * 0.06) + 'px sans-serif'; x.fillStyle = v.dim; x.textAlign = 'center';
      x.fillText('BRAKE', c, c - r * 0.78); x.fillText('ACCEL', c, c + r * 0.86);
    }
    const gx = clamp(S.gx, -1.2, 1.2), gy = clamp(S.gy, -1.2, 1.2);
    x.save(); x.shadowColor = v.glow; x.shadowBlur = W * 0.06;
    x.fillStyle = v.accent; x.beginPath(); x.arc(c + gx * scale, c + gy * scale, W * (showTrail ? 0.045 : 0.075), 0, TAU); x.fill();
    x.restore();
  }

  function drawCompass() {
    if (!comp.ctx || !comp.size) return;
    if (Math.abs(angDiff(S.heading, comp.drawn)) < 0.2 && !comp.force) return;
    comp.drawn = S.heading; comp.force = false;
    const x = comp.ctx, W = comp.size, c = W / 2, r = W * 0.46, v = vars();
    x.clearRect(0, 0, W, W);
    x.strokeStyle = v.line; x.lineWidth = W * 0.01;
    x.beginPath(); x.arc(c, c, r, 0, TAU); x.stroke();
    x.save(); x.translate(c, c); x.rotate(-S.heading * Math.PI / 180);
    for (let d = 0; d < 360; d += 15) {
      const a = d * Math.PI / 180 - Math.PI / 2, major = d % 45 === 0;
      x.strokeStyle = major ? v.text : v.dim; x.lineWidth = major ? W * 0.012 : W * 0.006;
      x.beginPath(); x.moveTo(Math.cos(a) * r * (major ? 0.8 : 0.87), Math.sin(a) * r * (major ? 0.8 : 0.87));
      x.lineTo(Math.cos(a) * r * 0.96, Math.sin(a) * r * 0.96); x.stroke();
    }
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '700 ' + Math.round(W * 0.11) + 'px sans-serif';
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([t, d]) => {
      const a = d * Math.PI / 180 - Math.PI / 2;
      x.fillStyle = t === 'N' ? v.danger : v.text;
      x.save(); x.translate(Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62); x.rotate(S.heading * Math.PI / 180);
      x.fillText(t, 0, 0); x.restore();
    });
    x.restore();
    // fixed heading pointer
    x.fillStyle = v.accent;
    x.beginPath(); x.moveTo(c, c - r * 1.02); x.lineTo(c - W * 0.05, c - r * 0.82); x.lineTo(c + W * 0.05, c - r * 0.82); x.closePath(); x.fill();
  }

  // ------------------------------------------------------------------ map (heading-up slippy tiles)
  const TILE = 256;
  const M = { z: 0, autoZ: 16, wantZ: 16, wantSince: 0, ox: 0, oy: 0, key: '', tiles: new Map(),
    W: 0, H: 0, ok: 0, fail: 0, trail: [], trailDirty: true, visible: true };
  const layerEl = $('#layer'), tilesEl = $('#tiles'), trailEl = $('#trailLine');

  function project(lat, lon, z) {
    const s = TILE * Math.pow(2, z);
    const sin = Math.sin(clamp(lat, -85, 85) * Math.PI / 180);
    return [(lon + 180) / 360 * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  }
  function tileUrl(z, x, y) {
    const n = Math.pow(2, z), xx = ((x % n) + n) % n;
    return 'https://tile.openstreetmap.org/' + z + '/' + xx + '/' + y + '.png';
  }
  function clearTiles() {
    M.tiles.forEach((img) => img.remove()); M.tiles.clear(); M.key = ''; M.ok = 0; M.fail = 0;
  }
  function setZoom(z) {
    if (z === M.z) return;
    M.z = z;
    const [x, y] = project(S.lat, S.lon, z);
    M.ox = Math.floor(x / TILE) * TILE; M.oy = Math.floor(y / TILE) * TILE;
    clearTiles(); M.trailDirty = true;
    S.pred.x = x; S.pred.y = y;
  }
  function updateTiles(px, py) {
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    const key = M.z + ':' + tx + ':' + ty + ':' + M.W + 'x' + M.H + '';
    if (key === M.key) return;
    M.key = key;
    const d = Math.hypot(M.W / 2, M.H * 0.68) + 32;
    const n = Math.pow(2, M.z), need = new Set();
    for (let x = Math.floor((px - d) / TILE); x <= Math.floor((px + d) / TILE); x++) {
      for (let y = Math.floor((py - d) / TILE); y <= Math.floor((py + d) / TILE); y++) {
        if (y < 0 || y >= n) continue;
        const nx = clamp(px, x * TILE, (x + 1) * TILE), ny = clamp(py, y * TILE, (y + 1) * TILE);
        if (Math.hypot(nx - px, ny - py) > d) continue; // tile corner outside the visible circle
        const k = x + ',' + y; need.add(k);
        if (!M.tiles.has(k)) {
          const img = new Image();
          img.decoding = 'async'; img.draggable = false;
          img.style.left = (x * TILE - M.ox) + 'px'; img.style.top = (y * TILE - M.oy) + 'px';
          img.onload = () => { M.ok++; };
          img.onerror = () => { M.fail++; img.style.visibility = 'hidden'; };
          img.src = tileUrl(M.z, x, y);
          tilesEl.appendChild(img); M.tiles.set(k, img);
        }
      }
    }
    M.tiles.forEach((img, k) => { if (!need.has(k)) { img.remove(); M.tiles.delete(k); } });
  }
  function addTrailPoint(lat, lon) {
    const t = M.trail, last = t[t.length - 1];
    if (last && hav(last[0], last[1], lat, lon) < 6) return;
    t.push([lat, lon]); if (t.length > 3000) t.splice(0, t.length - 3000);
    M.trailDirty = true;
  }
  function updateTrail() {
    if (!M.trailDirty) return;
    M.trailDirty = false;
    const pts = [];
    for (const p of M.trail) { const q = project(p[0], p[1], M.z); pts.push((q[0] - M.ox).toFixed(1) + ',' + (q[1] - M.oy).toFixed(1)); }
    trailEl.setAttribute('points', pts.join(' '));
  }
  function autoZoomFor(kmh) { return kmh < 25 ? 17 : kmh < 60 ? 16 : kmh < 100 ? 15 : 14; }

  function updateMap(dt, now) {
    if (!M.visible || !S.hasFix) return;
    // auto zoom by speed, applied only after the new level has been wanted for 2.5 s
    const want = autoZoomFor(S.disp * 3.6);
    if (want !== M.wantZ) { M.wantZ = want; M.wantSince = now; }
    if (M.wantZ !== M.autoZ && now - M.wantSince > 2500) M.autoZ = M.wantZ;
    setZoom(clamp(M.autoZ + cfg.zoomOff, 3, 19));

    // dead-reckon between 1 Hz GPS fixes so the map glides instead of jumping
    const [fx, fy] = project(S.lat, S.lon, M.z);
    const since = clamp((Date.now() - S.fixAt) / 1000, 0, 2);
    const mpp = 40075016.686 * Math.cos(S.lat * Math.PI / 180) / (TILE * Math.pow(2, M.z));
    const h = S.heading * Math.PI / 180, ahead = (S.target * since) / mpp;
    const tx = fx + Math.sin(h) * ahead, ty = fy - Math.cos(h) * ahead;
    const k = 1 - Math.exp(-dt / 0.25);
    if (Math.hypot(tx - S.pred.x, ty - S.pred.y) > 400) { S.pred.x = tx; S.pred.y = ty; }
    S.pred.x += (tx - S.pred.x) * k; S.pred.y += (ty - S.pred.y) * k;
    M.settled = Math.abs(tx - S.pred.x) < 0.3 && Math.abs(ty - S.pred.y) < 0.3;

    updateTiles(S.pred.x, S.pred.y);
    updateTrail();
    const cx = M.W / 2, cy = M.H * 0.68;
    const tf = 'translate(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px) rotate(' + (-S.heading).toFixed(2) +
      'deg) translate(' + (M.ox - S.pred.x).toFixed(1) + 'px,' + (M.oy - S.pred.y).toFixed(1) + 'px)';
    if (tf !== M.tf) { M.tf = tf; layerEl.style.transform = tf; }
    northEl.style.transform = 'rotate(' + (-S.heading).toFixed(1) + 'deg)';
  }
  const northEl = $('#northBtn svg');

  // ------------------------------------------------------------------ data input
  function handleFix(f) {
    S.lat = f.lat; S.lon = f.lon; S.acc = f.acc; S.hasFix = true;
    if (f.alt > -9000) S.gpsAlt = f.alt;
    $('#waitGps').classList.add('hidden');
    if (!f.gps && !f.demo) return; // coarse network fix: position only
    if (f.stale) return;           // last-known fix at startup: position only
    S.gpsFix = true; S.fixAt = Date.now();

    const now = f.time;
    let v = f.spd;
    const L = S.last;
    if (v < 0 && L) { const dt = (now - L.time) / 1000; v = dt > 0 ? hav(L.lat, L.lon, f.lat, f.lon) / dt : 0; }
    if (v < 0.45) v = 0; // ~1.6 km/h noise floor while parked

    if (L) {
      const dt = (now - L.time) / 1000;
      if (dt > 0.2 && dt < 3) {
        S.aLon = S.aLon * 0.4 + ((v - L.v) / dt) * 0.6;
        const T = trip();
        if (v > 0 && f.acc < 35) {
          const d = hav(L.lat, L.lon, f.lat, f.lon);
          if (d < Math.max(v, L.v) * dt * 1.6 + 15) {
            T.dist += d; if (!cfg.demo) odo += d;
          }
          T.move += dt;
        }
        if (f.hasBrg && L.hasBrg && v > 2) S.gpsYaw = -angDiff(f.brg, L.brg) * Math.PI / 180 / dt;
        else S.gpsYaw = 0;
      } else S.aLon = 0;
    }
    S.target = v;
    trip().max = Math.max(trip().max, v);
    if (f.hasBrg && v > 1.5) { S.headingTarget = f.brg; S.brgValid = true; }
    addTrailPoint(f.lat, f.lon);
    S.last = { time: now, v, lat: f.lat, lon: f.lon, brg: f.brg, hasBrg: f.hasBrg };
  }

  function onNative(m) {
    if (!m || !m.t) return;
    if (m.t === 'loc') {
      S.realLast = m; wake();
      if (!cfg.demo) handleFix(m);
      else if (!S.hasFix) { S.lat = m.lat; S.lon = m.lon; }
    } else if (m.t === 'imu') {
      S.yaw = m.yaw; S.yawAt = Date.now(); S.pressure = m.p; S.lux = m.lux;
    } else if (m.t === 'msl') {
      S.mslAlt = m.alt; S.mslAt = Date.now();
    } else if (m.t === 'gnss') {
      S.sats = m.sats; S.seen = m.seen;
    } else if (m.t === 'perm') {
      S.perm = m.granted;
      if (!m.granted) toast('Allow location access for speed & map — tap the GPS badge');
    }
  }

  // ------------------------------------------------------------------ demo drive
  const D = { t: 0, v: 0, brg: 40, lat: 13.0827, lon: 80.2707, yawDeg: 0, timer: 0 };
  function startDemo() {
    if (D.timer) return;
    const src = S.realLast || (S.hasFix ? { lat: S.lat, lon: S.lon } : null);
    if (src) { D.lat = src.lat; D.lon = src.lon; }
    D.v = 0; D.t = 0; S.last = null; M.trail = []; M.trailDirty = true; demoTrip = newTrip();
    D.timer = setInterval(demoTick, 1000);
    demoTick();
  }
  function stopDemo() {
    clearInterval(D.timer); D.timer = 0; S.last = null; S.target = 0; S.yaw = 0;
    M.trail = []; M.trailDirty = true;
    if (S.realLast) handleFix(Object.assign({}, S.realLast, { stale: true }));
  }
  function demoTick() {
    D.t++;
    const cyc = D.t % 70;
    let vT = cyc < 6 ? 0 : 20 + 13 * Math.sin(D.t / 9) + 7 * Math.sin(D.t / 3.3); // m/s
    D.v += clamp(vT - D.v, -5, 3.2);
    if (D.v < 0) D.v = 0;
    D.yawDeg = D.v > 1 ? 14 * Math.sin(D.t / 6) * (cyc > 50 ? 1.8 : 1) : 0;
    D.brg = (D.brg + D.yawDeg + 360) % 360;
    const r = D.brg * Math.PI / 180, d = D.v;
    D.lat += (Math.cos(r) * d) / 111320;
    D.lon += (Math.sin(r) * d) / (111320 * Math.cos(D.lat * Math.PI / 180));
    S.yaw = -D.yawDeg * Math.PI / 180; S.yawAt = Date.now();
    S.sats = 12;
    handleFix({ lat: D.lat, lon: D.lon, spd: D.v, brg: D.brg, hasBrg: true, acc: 4, alt: 18, gps: true, demo: true, time: Date.now() });
  }

  // ------------------------------------------------------------------ sound
  let ac = null;
  function beep() {
    if (!cfg.sound) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime;
      [[0, 880], [0.17, 1320]].forEach(([d, f]) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.5, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.15);
        o.connect(g); g.connect(ac.destination); o.start(t + d); o.stop(t + d + 0.16);
      });
    } catch (e) { /* no audio */ }
  }

  // ------------------------------------------------------------------ text panels
  // Only touch the DOM when a value really changes (avoids needless re-layout/repaint).
  function setText(node, v) { v = String(v); if (node._t !== v) { node._t = v; node.textContent = v; } }
  function setClass(node, v) { if (node.className !== v) node.className = v; }
  const el = {
    speed: $('#speed'), unit: $('#unit'), mapSpeed: $('#mapSpeedVal'), mapSpeedUnit: $('#mapSpeedUnit'),
    clock: $('#clock'), date: $('#date'), gps: $('#gps'), gpsTxt: $('#gps span'), limitTag: $('#limitTag'),
    trip: $('#trip'), tripU: $('#tripU'), drive: $('#drive'), avg: $('#avg'), max: $('#max'),
    alt: $('#alt'), altU: $('#altU'), odo: $('#odo'), odoU: $('#odoU'), gval: $('#gval'),
    heading: $('#heading'), hdgBig: $('#hdgBig'), hdgDeg: $('#hdgDeg'), gbigVal: $('#gbigVal'), gpeak: $('#gpeak'),
  };
  let shownSpeed = -1;
  function setSpeedText(spdU) {
    const n = Math.round(spdU);
    if (n === shownSpeed) return;
    shownSpeed = n; el.speed.textContent = n; el.mapSpeed.textContent = n;
  }
  function fmtDist(m) { const d = m * distK(); return d < 100 ? d.toFixed(1) : Math.round(d).toString(); }

  function updateSlow() {
    const now = new Date();
    setText(el.clock, now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    setText(el.date, now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }));

    const T = trip(), uK = unitK(), mph = cfg.units === 'mph';
    setText(el.trip, fmtDist(T.dist));
    const mins = Math.floor(T.move / 60);
    setText(el.drive, Math.floor(mins / 60) + ':' + ('0' + (mins % 60)).slice(-2));
    setText(el.avg, T.move > 5 ? Math.round((T.dist / T.move) * uK) : 0);
    setText(el.max, Math.round(T.max * uK));
    setText(el.odo, Math.round(odo * distK()));

    let alt = null;
    if (S.mslAt && Date.now() - S.mslAt < 15000) alt = S.mslAlt;
    else if (S.pressure > 0) alt = 44330 * (1 - Math.pow(S.pressure / 1013.25, 0.1903));
    else if (cfg.demo && S.gpsAlt > -9000) alt = S.gpsAlt;
    setText(el.alt, alt == null ? '--' : Math.round(mph ? alt * 3.28084 : alt));

    const hd = dirName(S.heading), deg = pad3(S.heading) + '°';
    setText(el.heading, hd + ' · ' + deg); setText(el.hdgBig, hd); setText(el.hdgDeg, deg);
    const gTot = Math.hypot(S.gx, S.gy);
    setText(el.gval, gTot.toFixed(2) + 'g');
    setText(el.gbigVal, gTot.toFixed(2));
    setText(el.gpeak, (T.peakG || 0).toFixed(2));

    // GPS badge
    const age = Date.now() - S.fixAt;
    let cls = 'bad', txt = 'NO GPS';
    if (cfg.demo) { cls = 'demo'; txt = 'DEMO'; }
    else if (!S.perm) { txt = 'ALLOW GPS'; }
    else if (S.gpsFix && age < 5000) {
      cls = S.acc < 15 ? 'ok' : S.acc < 40 ? 'mid' : 'bad';
      txt = (S.sats ? S.sats + ' SAT · ' : '') + '±' + Math.round(S.acc) + 'm';
    } else if (S.seen) { txt = 'SEARCHING ' + S.seen; }
    setClass(el.gps, 'pill ' + cls); setText(el.gpsTxt, txt);
    if (!cfg.demo && S.gpsFix && age > 6000) S.target = 0; // signal lost: don't freeze a stale speed

    const lim = limit();
    el.limitTag.classList.toggle('hidden', !(lim > 0));
    setText(el.limitTag, 'LIMIT ' + lim);

    if (M.visible) {
      $('#noMap').classList.toggle('hidden', !(M.fail > 4 && M.ok === 0));
      if (!S.hasFix) $('#waitGps').classList.remove('hidden');
    }
    checkNight();
    updateRec();
  }

  // night mode
  let luxAvg = -1, nightSince = 0;
  function checkNight() {
    let want = false;
    if (cfg.night === 'clock') { const h = new Date().getHours(); want = h >= 19 || h < 6; }
    else if (cfg.night === 'sensor' && S.lux >= 0) {
      luxAvg = luxAvg < 0 ? S.lux : luxAvg * 0.8 + S.lux * 0.2;
      want = S.night ? luxAvg < 40 : luxAvg < 12; // hysteresis
    }
    if (want !== S.night) {
      if (!nightSince) nightSince = Date.now();
      if (Date.now() - nightSince > (cfg.night === 'sensor' ? 4000 : 0)) {
        S.night = want; nightSince = 0; applyTheme(); layout(); comp.force = true;
      }
    } else nightSince = 0;
  }

  // ------------------------------------------------------------------ main loop
  // Animates at full frame rate only while something is moving; when parked and settled it
  // drops to one frame every 500 ms (clock, saves) and wakes instantly on GPS or touch.
  let rafOn = false, lastFrameAt = 0, idleTimer = 0;
  function wake() {
    // Older WebViews can drop a frame request made while the screen was in the background,
    // so a request that hasn't produced a frame within 1 s is treated as lost and re-sent.
    if (rafOn && Date.now() - lastFrameAt < 1000) return;
    clearTimeout(idleTimer); rafOn = true; lastFrameAt = Date.now();
    requestAnimationFrame(frame);
  }
  setInterval(wake, 1000); // safety net: the loop can never stay stalled
  function isActive() {
    return cfg.demo || S.target > 0 || S.disp > 0.01 || Math.abs(S.gx) > 0.002 || Math.abs(S.gy) > 0.002 ||
      Math.abs(S.aLon) > 0.02 || Math.abs(angDiff(S.headingTarget, S.heading)) > 0.1 ||
      (gauge.dirty && gauge.size > 0 && cfg.layout !== 'map') ||
      (M.visible && S.hasFix && !M.settled);
  }
  let lastT = performance.now(), slowAt = 0, saveAt = Date.now(), gTrailAt = 0;
  function frame(t) {
    lastFrameAt = Date.now();
    const dt = clamp((t - lastT) / 1000, 0, 0.1); lastT = t;
    const now = Date.now();

    S.disp += (S.target - S.disp) * (1 - Math.exp(-dt / 0.35));
    if (S.disp < 0.05 && S.target === 0) S.disp = 0;
    S.heading = (S.heading + angDiff(S.headingTarget, S.heading) * (1 - Math.exp(-dt / 0.45)) + 360) % 360;

    const spdU = S.disp * unitK();
    drawGauge(spdU);
    setSpeedText(spdU);
    updateLeds(spdU);

    // speed alert
    const lim = limit();
    const over = lim > 0 && (S.over ? spdU > lim - 1 : spdU > lim + 0.5);
    if (over !== S.over) {
      S.over = over; document.body.classList.toggle('over', over);
      if (over) { beep(); S.lastBeep = now; }
      gauge.dirty = true;
    } else if (over && now - S.lastBeep > 12000) { beep(); S.lastBeep = now; }

    // felt g-force: lateral from yaw rate × speed, longitudinal from GPS speed change
    const yaw = now - S.yawAt < 1000 ? S.yaw : S.gpsYaw;
    const tgx = S.disp > 1 ? (S.disp * yaw) / G : 0;
    if (now - S.fixAt > 2500) S.aLon *= 0.9;
    const tgy = S.aLon / G;
    const kg = 1 - Math.exp(-dt / 0.25);
    S.gx += (clamp(tgx, -1.5, 1.5) - S.gx) * kg; S.gy += (clamp(tgy, -1.5, 1.5) - S.gy) * kg;
    const gt = Math.hypot(S.gx, S.gy);
    if (S.disp > 3 && gt > (trip().peakG || 0)) trip().peakG = gt;
    if (t - gTrailAt > 60) { gTrailAt = t; gTrail.push([S.gx, S.gy]); if (gTrail.length > 25) gTrail.shift(); }

    if (cfg.layout === 'gauge') { drawG(gbig, true); drawCompass(); }
    drawG(gmini, false);
    updateMap(dt, now);

    if (t - slowAt > 500) { slowAt = t; updateSlow(); }
    if (now - saveAt > 10000) { saveAt = now; saveTrip(); }
    if (isActive()) requestAnimationFrame(frame);
    else { rafOn = false; idleTimer = setTimeout(wake, 500); }
  }
  function saveTrip() { store.set('trip', realTrip); store.set('odo', odo); }

  // ------------------------------------------------------------------ layout
  function layout() {
    wake();
    document.body.classList.remove('layout-race', 'layout-gauge', 'layout-map');
    document.body.classList.add('layout-' + cfg.layout);
    const main = $('#main');
    const mh = main.clientHeight - 8, mw = main.clientWidth - 16;
    if (cfg.layout !== 'map') {
      const s = Math.floor(Math.min(mh, cfg.layout === 'gauge' ? mw * 0.5 : mw * 0.56));
      const gw = $('#gaugeWrap');
      gw.style.width = s + 'px'; gw.style.height = s + 'px';
      gauge.size = s; gauge.ctx = setupCanvas(gauge.cv, s, s); gauge.cache = null; gauge.dirty = true;
      const needle = THEMES[effectiveTheme()].gauge === 'needle';
      el.speed.style.fontSize = Math.round(s * (needle ? 0.2 : 0.27)) + 'px';
      el.unit.style.fontSize = Math.round(s * 0.05) + 'px';
    }
    const gm = gmini.cv.getBoundingClientRect().width;
    gmini.size = gm; gmini.ctx = setupCanvas(gmini.cv, gm, gm); gmini.key = null; gbig.key = null;
    if (cfg.layout === 'gauge') {
      const side = $('#sideL');
      const cs = Math.floor(Math.min(side.clientWidth - 20, side.clientHeight - 90));
      [gbig, comp].forEach((m) => {
        m.cv.style.width = cs + 'px'; m.cv.style.height = cs + 'px';
        m.size = cs; m.ctx = setupCanvas(m.cv, cs, cs);
      });
      comp.force = true;
    }
    const mw2 = $('#mapWrap');
    M.visible = cfg.layout !== 'gauge';
    M.W = mw2.clientWidth; M.H = mw2.clientHeight; M.key = '';
    const uLabel = cfg.units === 'mph' ? 'MPH' : 'KM/H';
    el.unit.textContent = uLabel; el.mapSpeedUnit.textContent = uLabel;
    document.querySelectorAll('.spdU').forEach((n) => { n.textContent = uLabel.toLowerCase(); });
    el.tripU.textContent = cfg.units === 'mph' ? 'mi' : 'km';
    el.odoU.textContent = cfg.units === 'mph' ? 'mi' : 'km';
    el.altU.textContent = cfg.units === 'mph' ? 'ft' : 'm';
    shownSpeed = -1; ledLit = -1;
  }

  // ------------------------------------------------------------------ settings UI
  const settingsEl = $('#settings');
  function buildThemeGrid() {
    const grid = $('#themeGrid');
    grid.innerHTML = '';
    Object.keys(THEMES).forEach((id) => {
      const th = THEMES[id], v = th.vars;
      const b = document.createElement('button');
      b.className = 'tcard'; b.dataset.theme = id;
      b.style.background = v.bg; b.style.color = v.text;
      b.innerHTML = '<div class="ring"></div><span></span>';
      const ring = b.firstChild;
      ring.style.setProperty('--c', v.panel);
      ring.style.backgroundImage = 'conic-gradient(from 225deg,' + v.accent2 + ' 0deg,' + v.accent + ' 200deg,' + v.line + ' 200deg 270deg,transparent 270deg)';
      b.lastChild.textContent = th.name;
      b.addEventListener('click', () => {
        cfg.theme = id; saveCfg();
        if (S.night) toast('Night mode is on — turn it off to see ' + th.name);
        applyTheme(); layout(); refreshSettings();
      });
      grid.appendChild(b);
    });
  }
  function refreshSettings() {
    document.querySelectorAll('.tcard').forEach((b) => b.classList.toggle('sel', b.dataset.theme === cfg.theme));
    const seg = $('#gmaxSeg');
    seg.innerHTML = GMAX[cfg.units].map((v) => '<button data-v="' + v + '">' + v + '</button>').join('');
    document.querySelectorAll('.seg').forEach((s) => {
      const key = s.dataset.key;
      let cur = key === 'gmax' ? gmax() : cfg[key];
      s.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', String(cur) === b.dataset.v));
    });
    const lim = limit();
    $('#limVal').textContent = lim > 0 ? lim + (cfg.units === 'mph' ? ' mph' : ' km/h') : 'Off';
  }
  document.querySelectorAll('.seg').forEach((s) => {
    s.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const key = s.dataset.key; let v = b.dataset.v;
      if (v === 'true' || v === 'false') v = v === 'true';
      if (key === 'gmax') { if (cfg.units === 'mph') cfg.gmaxMph = +v; else cfg.gmaxKmh = +v; }
      else cfg[key] = v;
      saveCfg();
      if (key === 'demo') { if (cfg.demo) startDemo(); else stopDemo(); }
      if (key === 'night') { S.night = false; checkNight(); applyTheme(); }
      if (key === 'sound' && cfg.sound) beep();
      gauge.cache = null; gauge.dirty = true;
      layout(); refreshSettings();
    });
  });
  function stepLimit(dir) {
    const mph = cfg.units === 'mph', step = mph ? 5 : 10, lo = mph ? 20 : 30, hi = mph ? 120 : 200;
    let v = limit();
    if (v === 0) v = dir > 0 ? lo : 0;
    else { v += dir * step; if (v < lo) v = 0; if (v > hi) v = hi; }
    if (mph) cfg.limitMph = v; else cfg.limitKmh = v;
    saveCfg(); gauge.cache = null; gauge.dirty = true; ledLit = -1; refreshSettings();
  }
  $('#limUp').addEventListener('click', () => stepLimit(1));
  $('#limDown').addEventListener('click', () => stepLimit(-1));
  $('#resetTrip').addEventListener('click', () => resetTrip());
  function resetTrip() {
    if (cfg.demo) demoTrip = newTrip(); else { realTrip = newTrip(); saveTrip(); }
    M.trail = []; M.trailDirty = true; toast('Trip reset');
  }
  function openSettings() { refreshSettings(); settingsEl.classList.remove('hidden'); }
  function closeSettings() { settingsEl.classList.add('hidden'); }
  $('#btnSettings').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', closeSettings);
  settingsEl.addEventListener('click', (e) => { if (e.target === settingsEl) closeSettings(); });

  $('#btnTrips').addEventListener('click', () => { if (NATIVE) NATIVE.openTrips('trips'); else location.href = 'trips.html'; });
  let recAt = 0;
  function updateRec() {
    if (!NATIVE || Date.now() - recAt < 5000) return;
    recAt = Date.now();
    let rec = false; try { rec = JSON.parse(NATIVE.liveTrip()).rec; } catch (e) { /* */ }
    $('#rec').classList.toggle('hidden', !rec);
  }
  $('#btnLayout').addEventListener('click', () => {
    cfg.layout = LAYOUTS[(LAYOUTS.indexOf(cfg.layout) + 1) % LAYOUTS.length];
    saveCfg(); layout(); toast(cfg.layout.toUpperCase() + ' layout');
  });
  $('#zin').addEventListener('click', () => { cfg.zoomOff = clamp(cfg.zoomOff + 1, -6, 4); saveCfg(); toast('Map zoom ' + (cfg.zoomOff >= 0 ? '+' : '') + cfg.zoomOff); });
  $('#zout').addEventListener('click', () => { cfg.zoomOff = clamp(cfg.zoomOff - 1, -6, 4); saveCfg(); toast('Map zoom ' + (cfg.zoomOff >= 0 ? '+' : '') + cfg.zoomOff); });
  $('#mapWrap').addEventListener('dblclick', () => { cfg.zoomOff = 0; saveCfg(); toast('Map zoom reset'); });
  $('#gps').addEventListener('click', () => {
    if (!S.perm && NATIVE) NATIVE.requestLocation();
    else toast(S.gpsFix ? 'GPS: ' + S.sats + ' satellites in use, accuracy ±' + Math.round(S.acc) + ' m' : 'Searching for satellites…');
  });
  // long-press TRIP to reset it
  (function () {
    let t = 0;
    const tripEl = $('#tripStat');
    tripEl.addEventListener('touchstart', () => { t = setTimeout(resetTrip, 800); }, { passive: true });
    ['touchend', 'touchcancel', 'touchmove'].forEach((e) => tripEl.addEventListener(e, () => clearTimeout(t), { passive: true }));
  })();
  // unlock audio on first touch
  document.addEventListener('touchstart', () => { if (!ac && cfg.sound) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* */ } } }, { once: true, passive: true });
  document.addEventListener('pointerdown', wake, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveTrip(); return; }
    rafOn = false; gauge.dirty = true; wake();
    // the launcher may have switched the theme while we were in the background
    const t = store.get('cfg', {}).theme;
    if (t && t !== cfg.theme && THEMES[t]) { cfg.theme = t; applyTheme(); layout(); }
  });
  window.addEventListener('resize', () => layout());

  // ------------------------------------------------------------------ boot
  window.dash = {
    onNative,
    onBack() { if (!settingsEl.classList.contains('hidden')) { closeSettings(); return true; } return false; },
  };
  buildThemeGrid();
  checkNight();
  applyTheme();
  layout();
  updateSlow();
  if (cfg.demo) startDemo();
  wake();
})();
