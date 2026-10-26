/* RaceDash Trips: history list, route map coloured by speed, speed graph, fuel cost,
 * and "where I parked". Data comes from window.Native (TripStore); a desktop browser
 * gets generated sample trips. */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const NATIVE = window.Native || null;
  const THEMES = window.RD_THEMES;
  const TILE = 256;

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
  const DEF = { theme: 'apex', units: 'kmh', night: 'off', fuelKmpl: 15, fuelPrice: 102, autoRecord: true };
  let cfg = Object.assign({}, DEF, store.get('cfg', {}));
  function saveCfg(patch) {
    const saved = store.get('cfg', {}); // merge so the dashboard's settings are kept
    Object.assign(saved, patch); store.set('cfg', saved); Object.assign(cfg, patch);
  }

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mph = () => cfg.units === 'mph';
  const distTxt = (m) => { const d = mph() ? m / 1609.344 : m / 1000; return (d < 100 ? d.toFixed(1) : Math.round(d)) + (mph() ? ' mi' : ' km'); };
  const distNum = (m) => { const d = mph() ? m / 1609.344 : m / 1000; return d < 100 ? d.toFixed(1) : String(Math.round(d)); };
  const spd = (ms) => Math.round(ms * (mph() ? 2.2369363 : 3.6));
  const spdU = () => (mph() ? 'mph' : 'km/h');
  const money = (v) => '₹' + Math.round(v).toLocaleString('en-IN');
  const dur = (s) => { const m = Math.round(s / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
  const timeOf = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function dayLabel(t) {
    const d = new Date(t), now = new Date();
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()), b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((b - a) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function hav(la1, lo1, la2, lo2) {
    const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 12742000 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearing(la1, lo1, la2, lo2) {
    const r = Math.PI / 180, y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
    const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }
  const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const dir8 = (h) => DIRS[Math.round(h / 45) % 8];
  const fuelOf = (t) => { const kmpl = t.kmpl || cfg.fuelKmpl, price = t.price || cfg.fuelPrice; const l = t.dist / 1000 / kmpl; return { l, cost: l * price }; };

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ------------------------------------------------------------------ theme
  let night = false;
  function vars() { return (THEMES[night ? 'stealth' : cfg.theme] || THEMES.apex).vars; }
  function applyTheme() {
    if (cfg.night === 'clock') { const h = new Date().getHours(); night = h >= 19 || h < 6; } else night = false;
    const v = vars(), root = document.documentElement.style;
    Object.keys(v).forEach((k) => root.setProperty('--' + k, v[k]));
  }

  // ------------------------------------------------------------------ map view (north-up)
  function project(lat, lon, z) {
    const s = TILE * Math.pow(2, z), sin = Math.sin(clamp(lat, -85, 85) * Math.PI / 180);
    return [(lon + 180) / 360 * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  }
  function unproject(x, y, z) {
    const s = TILE * Math.pow(2, z), n = Math.PI - 2 * Math.PI * y / s;
    return [180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), x / s * 360 - 180];
  }
  function MapView(root) {
    const layer = root.querySelector('.layer'), cv = root.querySelector('.overlay');
    const m = { z: 14, lat: 0, lon: 0, ox: 0, oy: 0, tiles: new Map(), W: 0, H: 0, ctx: null, draw: null, oz: -1 };
    function resize() {
      m.W = root.clientWidth; m.H = root.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(m.W * dpr); cv.height = Math.round(m.H * dpr);
      m.ctx = cv.getContext('2d'); m.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function render() {
      if (!m.W) resize();
      const [cx, cy] = project(m.lat, m.lon, m.z);
      if (m.oz !== m.z) { // new zoom: new local origin keeps CSS coordinates small
        m.oz = m.z; m.ox = Math.floor(cx / TILE) * TILE; m.oy = Math.floor(cy / TILE) * TILE;
        m.tiles.forEach((img) => img.remove()); m.tiles.clear();
      }
      const left = cx - m.W / 2, top = cy - m.H / 2, n = Math.pow(2, m.z), need = new Set();
      for (let x = Math.floor(left / TILE); x <= Math.floor((left + m.W) / TILE); x++) {
        for (let y = Math.floor(top / TILE); y <= Math.floor((top + m.H) / TILE); y++) {
          if (y < 0 || y >= n) continue;
          const k = x + ',' + y; need.add(k);
          if (m.tiles.has(k)) continue;
          const img = new Image(); img.draggable = false;
          img.style.left = (x * TILE - m.ox) + 'px'; img.style.top = (y * TILE - m.oy) + 'px';
          img.onerror = () => { img.style.visibility = 'hidden'; };
          img.src = 'https://tile.openstreetmap.org/' + m.z + '/' + (((x % n) + n) % n) + '/' + y + '.png';
          layer.appendChild(img); m.tiles.set(k, img);
        }
      }
      m.tiles.forEach((img, k) => { if (!need.has(k)) { img.remove(); m.tiles.delete(k); } });
      layer.style.transform = 'translate(' + (m.ox - left).toFixed(1) + 'px,' + (m.oy - top).toFixed(1) + 'px)';
      m.ctx.clearRect(0, 0, m.W, m.H);
      if (m.draw) m.draw(m.ctx, (lat, lon) => { const p = project(lat, lon, m.z); return [p[0] - left, p[1] - top]; });
    }
    function fit(pts, maxZ) {
      resize();
      let a = 90, b = -90, c = 180, d = -180;
      pts.forEach((p) => { a = Math.min(a, p[0]); b = Math.max(b, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[1]); });
      let z = maxZ;
      for (; z > 3; z--) {
        const p0 = project(b, c, z), p1 = project(a, d, z);
        if (p1[0] - p0[0] <= m.W - 70 && p1[1] - p0[1] <= m.H - 70) break;
      }
      const p0 = project(b, c, z), p1 = project(a, d, z);
      const ll = unproject((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, z);
      m.z = z; m.lat = ll[0]; m.lon = ll[1]; render();
    }
    function zoom(dz) { m.z = clamp(m.z + dz, 3, 18); render(); }
    root.querySelectorAll('.mapBtns button').forEach((b) => b.addEventListener('click', () => zoom(+b.dataset.z)));
    let drag = null;
    root.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; drag = [e.clientX, e.clientY]; root.setPointerCapture(e.pointerId); });
    root.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [cx, cy] = project(m.lat, m.lon, m.z);
      const ll = unproject(cx - (e.clientX - drag[0]), cy - (e.clientY - drag[1]), m.z);
      m.lat = ll[0]; m.lon = ll[1]; drag = [e.clientX, e.clientY]; render();
    });
    ['pointerup', 'pointercancel'].forEach((t) => root.addEventListener(t, () => { drag = null; }));
    root.addEventListener('dblclick', () => zoom(1));
    return { m, fit, render, resize, zoom, center(lat, lon, z) { resize(); m.lat = lat; m.lon = lon; m.z = z; render(); } };
  }

  // speed → green / yellow / red
  function speedColor(f) {
    const stops = [[25, 229, 122], [255, 196, 0], [255, 59, 48]];
    const t = clamp(f, 0, 1) * 2, i = Math.min(1, Math.floor(t)), u = t - i;
    const a = stops[i], b = stops[i + 1];
    return 'rgb(' + a.map((v, k) => Math.round(v + (b[k] - v) * u)).join(',') + ')';
  }
  function dot(x, ctx, p, r, fill, label) {
    ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
    if (label) { ctx.fillStyle = '#fff'; ctx.font = '700 ' + Math.round(r * 1.1) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, p[0], p[1] + 1); }
  }

  // ------------------------------------------------------------------ data
  let trips = [], sel = null, selFull = null;
  function loadTrips() {
    if (NATIVE) { try { trips = JSON.parse(NATIVE.trips()) || []; } catch (e) { trips = []; } }
    else trips = MOCK.map((t) => Object.assign({}, t, { pts: undefined }));
  }
  function loadTrip(id) {
    if (NATIVE) { try { return JSON.parse(NATIVE.trip(id)); } catch (e) { return null; } }
    return MOCK.find((t) => t.id === id) || null;
  }

  // ------------------------------------------------------------------ list
  function renderList() {
    const list = $('#list'); list.innerHTML = '';
    const live = NATIVE ? safeJson(NATIVE.liveTrip()) : null;
    if (live && live.rec) {
      const el = document.createElement('div'); el.className = 'trip live';
      el.innerHTML = '<b>Recording now</b><span></span>';
      el.lastChild.textContent = distTxt(live.dist) + ' · started ' + timeOf(live.start);
      list.appendChild(el);
    }
    let lastDay = '';
    trips.forEach((t) => {
      const day = dayLabel(t.start);
      if (day !== lastDay) { lastDay = day; const h = document.createElement('div'); h.className = 'day'; h.textContent = day; list.appendChild(h); }
      const b = document.createElement('button');
      b.className = 'trip' + (sel === t.id ? ' sel' : ''); b.dataset.id = t.id;
      const f = fuelOf(t);
      b.innerHTML = '<b></b><span></span>';
      b.firstChild.textContent = timeOf(t.start) + ' – ' + timeOf(t.end);
      b.lastChild.innerHTML = distTxt(t.dist) + ' · ' + dur((t.end - t.start) / 1000) + ' · <em></em>';
      b.lastChild.lastChild.textContent = money(f.cost);
      b.addEventListener('click', () => select(t.id));
      list.appendChild(b);
    });
    const none = trips.length === 0;
    $('#empty').classList.toggle('hidden', !none || !!(live && live.rec) && false);
    $('#detail').classList.toggle('hidden', none);
    $('#list').classList.toggle('hidden', none && !(live && live.rec));
    if (none) $('#empty').classList.remove('hidden');
    renderTotals();
  }
  function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function renderTotals() {
    const since = Date.now() - 7 * 86400000;
    let d = 0, c = 0;
    trips.forEach((t) => { if (t.start >= since) { d += t.dist; c += fuelOf(t).cost; } });
    $('#totals').innerHTML = '<small>7 DAYS</small><span></span><b></b>';
    $('#totals span').textContent = distTxt(d);
    $('#totals b').textContent = money(c);
  }

  // ------------------------------------------------------------------ detail
  const tripMap = MapView($('#map'));
  function select(id) {
    sel = id;
    document.querySelectorAll('.trip').forEach((b) => b.classList.toggle('sel', b.dataset.id === id));
    selFull = loadTrip(id);
    if (!selFull) { toast('Trip data missing'); return; }
    const t = selFull, f = fuelOf(t), secs = (t.end - t.start) / 1000;
    $('#dTitle').textContent = dayLabel(t.start) + ', ' + timeOf(t.start) + ' – ' + timeOf(t.end);
    const from = (t.lat0 != null && t.lat1 != null) ? distTxt(hav(t.lat0, t.lon0, t.lat1, t.lon1)) + ' start → finish' : '';
    $('#dSub').textContent = from;
    const cells = [
      ['DIST', distNum(t.dist), mph() ? 'mi' : 'km'],
      ['TIME', secs < 3600 ? Math.round(secs / 60) : (secs / 3600).toFixed(1), secs < 3600 ? 'min' : 'h'],
      ['AVG', t.move > 5 ? spd(t.dist / t.move) : 0, spdU()],
      ['MAX', spd(t.max), spdU()],
      ['FUEL', f.l.toFixed(1), 'L'],
      ['COST', money(f.cost), ''],
    ];
    $('#dStats').innerHTML = cells.map((c, i) => '<div class="st' + (i === 5 ? ' cost' : '') + '"><label>' + c[0] + '</label><b>' + c[1] + '</b><small>' + c[2] + '</small></div>').join('');

    const pts = (t.pts || []).map((p) => [p[1] / 1e5, p[2] / 1e5, p[3] / 36, p[0]]); // lat, lon, m/s, sec
    const vmax = Math.max(1, ...pts.map((p) => p[2]));
    tripMap.m.draw = (ctx, toXY) => {
      if (pts.length < 2) return;
      const step = Math.max(1, Math.floor(pts.length / 1500));
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); pts.forEach((p, i) => { if (i % step) return; const q = toXY(p[0], p[1]); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
      ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
      ctx.lineWidth = 5;
      let prev = toXY(pts[0][0], pts[0][1]);
      for (let i = step; i < pts.length; i += step) {
        const q = toXY(pts[i][0], pts[i][1]);
        ctx.strokeStyle = speedColor(pts[i][2] / vmax);
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
        prev = q;
      }
      dot(null, ctx, toXY(pts[0][0], pts[0][1]), 9, '#19e57a', '');
      dot(null, ctx, toXY(pts[pts.length - 1][0], pts[pts.length - 1][1]), 11, '#1f6bff', 'P');
    };
    if (pts.length) tripMap.fit(pts, 17); else tripMap.center(t.lat0 || 0, t.lon0 || 0, 14);
    drawGraph(pts, t);
  }

  function drawGraph(pts, t) {
    const cv = $('#graph'), W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
    const v = vars();
    x.fillStyle = v.bg; x.strokeStyle = v.line; x.lineWidth = 1;
    roundRect(x, 0.5, 0.5, W - 1, H - 1, 10); x.fill(); x.stroke();
    if (pts.length < 2) return;
    const T = Math.max(1, pts[pts.length - 1][3]), vmax = Math.max(1, t.max, ...pts.map((p) => p[2]));
    const px = (s) => 10 + (s / T) * (W - 20), py = (ms) => H - 8 - (ms / vmax) * (H - 26);
    x.beginPath(); x.moveTo(px(0), H - 8);
    pts.forEach((p) => x.lineTo(px(p[3]), py(p[2])));
    x.lineTo(px(T), H - 8); x.closePath();
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, rgba(v.accent, 0.45)); g.addColorStop(1, rgba(v.accent, 0.02));
    x.fillStyle = g; x.fill();
    x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(px(p[3]), py(p[2])) : x.moveTo(px(p[3]), py(p[2]))));
    x.strokeStyle = v.accent; x.lineWidth = 2; x.stroke();
    if (t.move > 5) {
      const ay = py(t.dist / t.move);
      x.setLineDash([5, 5]); x.strokeStyle = v.dim; x.lineWidth = 1;
      x.beginPath(); x.moveTo(10, ay); x.lineTo(W - 10, ay); x.stroke(); x.setLineDash([]);
    }
    x.font = '700 12px sans-serif'; x.fillStyle = v.dim; x.textAlign = 'left'; x.textBaseline = 'top';
    x.fillText('SPEED · max ' + spd(t.max) + ' ' + spdU() + '  ·  dashed = average', 14, 6);
  }
  function roundRect(x, a, b, w, h, r) {
    x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r);
    x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath();
  }
  function rgba(hex, a) { const n = parseInt(hex.replace('#', ''), 16); return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }

  $('#btnDelete').addEventListener('click', () => { if (sel) $('#confirm').classList.remove('hidden'); });
  $('#cNo').addEventListener('click', () => $('#confirm').classList.add('hidden'));
  $('#cYes').addEventListener('click', () => {
    $('#confirm').classList.add('hidden');
    if (NATIVE) NATIVE.deleteTrip(sel); else { const i = MOCK.findIndex((t) => t.id === sel); if (i >= 0) MOCK.splice(i, 1); }
    loadTrips(); sel = null; renderList();
    if (trips.length) select(trips[0].id);
    toast('Trip deleted');
  });

  // ------------------------------------------------------------------ parked
  const parkMap = MapView($('#pmap'));
  let here = null, parked = null;
  function showParked() {
    parked = NATIVE ? safeJson(NATIVE.parked()) : MOCK_PARKED;
    const card = $('#parkCard');
    if (!parked) {
      $('#pAgo').textContent = 'No parking spot yet';
      $('#pWhen').textContent = 'Saved automatically when a trip ends.';
      $('#pDist').textContent = ''; $('#pClear').classList.add('hidden');
      parkMap.m.draw = null;
      if (here) parkMap.center(here.lat, here.lon, 16); else parkMap.render();
      card.classList.remove('hidden');
      return;
    }
    $('#pClear').classList.remove('hidden');
    updateParkText();
    parkMap.m.draw = (ctx, toXY) => {
      if (here) {
        const q = toXY(here.lat, here.lon);
        ctx.beginPath(); ctx.arc(q[0], q[1], 16, 0, Math.PI * 2); ctx.fillStyle = rgba(vars().accent, 0.2); ctx.fill();
        dot(null, ctx, q, 8, vars().accent, '');
      }
      const p = toXY(parked.lat, parked.lon);
      ctx.fillStyle = '#1f6bff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      roundRect(ctx, p[0] - 16, p[1] - 38, 32, 32, 8); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p[0] - 6, p[1] - 7); ctx.lineTo(p[0], p[1]); ctx.lineTo(p[0] + 6, p[1] - 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '700 20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('P', p[0], p[1] - 21);
    };
    if (here && hav(here.lat, here.lon, parked.lat, parked.lon) > 30) parkMap.fit([[parked.lat, parked.lon], [here.lat, here.lon]], 17);
    else parkMap.center(parked.lat, parked.lon, 17);
  }
  function updateParkText() {
    if (!parked) return;
    const mins = Math.max(0, Math.round((Date.now() - parked.t) / 60000));
    $('#pAgo').textContent = mins < 1 ? 'Parked just now' : mins < 60 ? 'Parked ' + mins + ' min ago'
      : mins < 1440 ? 'Parked ' + Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min ago' : 'Parked ' + Math.floor(mins / 1440) + ' days ago';
    $('#pWhen').textContent = timeOf(parked.t) + ' · ' + dayLabel(parked.t);
    if (here) {
      const d = hav(here.lat, here.lon, parked.lat, parked.lon);
      $('#pDist').textContent = d < 25 ? 'You are here' : distTxt(d) + ' away · ' + dir8(bearing(here.lat, here.lon, parked.lat, parked.lon));
    } else $('#pDist').textContent = 'Waiting for GPS…';
  }
  $('#pClear').addEventListener('click', () => { if (NATIVE) NATIVE.clearParked(); else MOCK_PARKED = null; showParked(); toast('Parking spot cleared'); });

  // ------------------------------------------------------------------ tabs, fuel sheet, nav
  let tab = 'trips';
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('sel', x === b));
    $('#tripsView').classList.toggle('hidden', tab !== 'trips');
    $('#parkedView').classList.toggle('hidden', tab !== 'parked');
    if (tab === 'parked') showParked(); else if (sel) select(sel);
  });
  function refreshFuel() {
    $('#vKmpl').textContent = cfg.fuelKmpl.toFixed(1);
    $('#vPrice').textContent = '₹' + cfg.fuelPrice.toFixed(1);
    document.querySelectorAll('#segRec button').forEach((b) => b.classList.toggle('sel', String(cfg.autoRecord) === b.dataset.v));
  }
  $('#btnFuel').addEventListener('click', () => { refreshFuel(); $('#fuelSheet').classList.remove('hidden'); });
  $('#fuelDone').addEventListener('click', () => { $('#fuelSheet').classList.add('hidden'); renderList(); if (sel && tab === 'trips') select(sel); });
  document.querySelectorAll('#fuelSheet .stepper button').forEach((b) => b.addEventListener('click', () => {
    const d = +b.dataset.d;
    if (b.dataset.k === 'kmpl') saveCfg({ fuelKmpl: clamp(Math.round((cfg.fuelKmpl + d) * 2) / 2, 3, 60) });
    else saveCfg({ fuelPrice: clamp(Math.round((cfg.fuelPrice + d) * 2) / 2, 10, 500) });
    refreshFuel();
  }));
  $('#segRec').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const on = b.dataset.v === 'true';
    saveCfg({ autoRecord: on }); if (NATIVE) NATIVE.setAutoRecord(on);
    refreshFuel(); toast(on ? 'Trips will record automatically' : 'Trip recording off');
  });
  ['#fuelSheet', '#confirm'].forEach((s) => $(s).addEventListener('click', (e) => { if (e.target === $(s)) $(s).classList.add('hidden'); }));
  $('#back').addEventListener('click', () => { if (NATIVE) NATIVE.close(); else history.back(); });

  // ------------------------------------------------------------------ native events
  function onNative(msg) {
    if (msg && msg.t === 'loc' && (msg.gps || msg.stale)) {
      const first = !here;
      here = { lat: msg.lat, lon: msg.lon };
      if (tab === 'parked') { updateParkText(); if (first) showParked(); else parkMap.render(); }
    }
  }
  window.dash = {
    onNative,
    onBack() {
      for (const s of ['#confirm', '#fuelSheet']) if (!$(s).classList.contains('hidden')) { $(s).classList.add('hidden'); return true; }
      return false;
    },
  };

  // ------------------------------------------------------------------ sample data (browser preview)
  let MOCK = [], MOCK_PARKED = null;
  if (!NATIVE) {
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const day = 86400000, now = Date.now();
    [[0.05, 34], [0.4, 18], [1.2, 52], [1.5, 22], [3.3, 75], [5.1, 28]].forEach(([dAgo, mins], k) => {
      const start = now - dAgo * day - 3600000 * (k + 1), pts = [];
      // sample drives start in the city and head inland (west), away from the coast
      let lat = 13.06 + (rnd() - 0.5) * 0.04, lon = 80.24 + (rnd() - 0.5) * 0.03, brg = 200 + rnd() * 110, v = 0, dist = 0, move = 0, max = 0;
      const brg0 = brg;
      for (let s = 0; s <= mins * 60; s += 3) {
        const target = 8 + 10 * Math.abs(Math.sin(s / 140 + k)) + (k === 4 ? 12 : 0) * (s > 600 ? 1 : 0);
        v += clamp(target - v, -2.5, 1.5); if ((s / 3) % 70 < 4) v = Math.max(0, v - 4);
        brg = brg0 + 35 * Math.sin(s / 260 + k) + (rnd() - 0.5) * 10;
        const d = v * 3; dist += d; if (v > 0.5) move += 3; max = Math.max(max, v);
        lat += Math.cos(brg * Math.PI / 180) * d / 111320; lon += Math.sin(brg * Math.PI / 180) * d / (111320 * Math.cos(lat * Math.PI / 180));
        pts.push([s, Math.round(lat * 1e5), Math.round(lon * 1e5), Math.round(v * 36)]);
      }
      MOCK.push({ id: String(start), start, end: start + mins * 60000, dist, move, max, lat0: pts[0][1] / 1e5, lon0: pts[0][2] / 1e5,
        lat1: lat, lon1: lon, kmpl: 15, price: 102, pts });
    });
    MOCK_PARKED = { lat: MOCK[0].lat1, lon: MOCK[0].lon1, t: MOCK[0].end };
    here = { lat: MOCK[0].lat1 + 0.004, lon: MOCK[0].lon1 + 0.003 };
  }

  // ------------------------------------------------------------------ boot
  applyTheme();
  loadTrips();
  renderList();
  if (trips.length) select(trips[0].id);
  if (location.hash === '#parked') document.querySelector('#tabs [data-tab=parked]').click();
  setInterval(() => { if (tab === 'parked') updateParkText(); else if (NATIVE) { const l = safeJson(NATIVE.liveTrip()); if (l && l.rec) renderList(); } }, 15000);
  window.addEventListener('resize', () => { tripMap.resize(); parkMap.resize(); if (tab === 'trips' && sel) select(sel); else if (tab === 'parked') showParked(); });
})();
