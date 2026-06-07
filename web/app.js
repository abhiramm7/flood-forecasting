/* DMV Flood Watch — flood warning system frontend.
 *
 * Layout:
 *   ┌─────────────────────────┬───────────────┐
 *   │           MAP           │  GAUGE FEED   │
 *   │       + NEXRAD radar    │  (sorted by   │
 *   │       (severity dots)   │   severity)   │
 *   ├─────────────────────────┴───────────────┤
 *   │  STREAMFLOW: 7d backtest + 12h forecast │
 *   └─────────────────────────────────────────┘
 *
 * Single model: the 1D CNN at web/models/dmv-cnn-12h/. The picker UI is
 * preserved for forward-compat but currently only one entry is registered
 * in models/manifest.json.
 */

const FMT_FULL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const M3S_TO_CFS = 35.3147;
const HOUR_MS = 3600_000;

const state = {
  sites: null,
  preds: null,             // basin id -> {id, issue_time, series, backtest}
  unit: 'm3s',
  selected: null,
  map: null,
  radarLayer: null,
  radarOn: true,
  chart: null,
  markers: new Map(),
  updated: null,            // when the prediction data was generated
};

// ---- helpers --------------------------------------------------------------

const fmtFlow = (v) => {
  if (v == null || !isFinite(v)) return '—';
  const x = state.unit === 'cfs' ? v * M3S_TO_CFS : v;
  if (x >= 1000) return Math.round(x).toLocaleString();
  if (x >= 100) return x.toFixed(0);
  if (x >= 10) return x.toFixed(1);
  return x.toFixed(2);
};
const unitLabel = () => state.unit === 'cfs' ? 'cfs' : 'm³/s';
const severityFor = (flow, th) => {
  if (!th || flow == null) return 'untrained';
  if (flow >= th.extreme) return 'extreme';
  if (flow >= th.danger) return 'danger';
  if (flow >= th.warning) return 'warn';
  return 'ok';
};
const sevRank = { ok: 0, untrained: 0, warn: 1, danger: 2, extreme: 3 };
const sevLabel = { ok: 'normal', warn: 'warning', danger: 'danger', extreme: 'extreme', untrained: 'no data' };

function liveNow(s) {
  // Prefer the instantaneous (15-min) reading; fall back to last hourly obs
  // in the CNN's backtest, then to the daily values from sites.json.
  if (s.live_now?.o != null) return { o: s.live_now.o, d: s.live_now.t || s.live_now.d };
  const pred = state.preds?.get(s.id);
  const lastBacktest = pred?.backtest?.filter(b => b.o != null)?.slice(-1)[0];
  if (lastBacktest) return { o: lastBacktest.o, d: lastBacktest.t };
  if (s.live_obs?.length) return s.live_obs[s.live_obs.length - 1];
  return null;
}

/** Worst-case forecast flow for a site (max over the 12-hour window). */
function forecastPeak(s) {
  const pred = state.preds?.get(s.id);
  if (!pred?.series?.length) return null;
  let peak = -Infinity, peakT = null;
  for (const p of pred.series) {
    if (p.p != null && p.p > peak) { peak = p.p; peakT = p.d; }
  }
  return peak === -Infinity ? null : { o: peak, d: peakT };
}

/** Hours from now until forecast crosses the warning threshold (or null). */
function hoursToThreshold(s, level = 'warning') {
  const pred = state.preds?.get(s.id);
  if (!pred?.series?.length || !s.thresholds) return null;
  const th = s.thresholds[level];
  if (th == null) return null;
  const now = liveNow(s);
  const nowT = now ? new Date(now.d).getTime() : Date.now();
  for (const p of pred.series) {
    if (p.p == null) continue;
    if (p.p >= th) {
      const dt = new Date(p.d).getTime();
      return Math.max(0, (dt - nowT) / HOUR_MS);
    }
  }
  return null;
}

/** Best severity for a site combining current + peak-forecast. */
function siteSeverity(s) {
  const now = liveNow(s);
  const peak = forecastPeak(s);
  const sevs = [];
  if (now && s.thresholds) sevs.push(severityFor(now.o, s.thresholds));
  if (peak && s.thresholds) sevs.push(severityFor(peak.o, s.thresholds));
  if (!sevs.length) return 'untrained';
  return sevs.reduce((a, b) => sevRank[b] > sevRank[a] ? b : a);
}

// ---- bootstrap ------------------------------------------------------------

(async function init() {
  try {
    const sites = await fetch('sites.json').then(r => r.json());
    state.sites = sites.sites;
    state.updated = sites.updated;
    document.getElementById('updated-sub').textContent =
      sites.updated ? `last refresh: ${FMT_FULL.format(new Date(sites.updated))}`
                    : 'monitoring DC / MD / VA gauges';

    document.getElementById('unit-toggle').addEventListener('click', e => {
      if (e.target.tagName !== 'BUTTON') return;
      state.unit = e.target.dataset.unit;
      document.querySelectorAll('#unit-toggle button').forEach(b =>
        b.classList.toggle('active', b.dataset.unit === state.unit));
      refresh();
    });
    document.getElementById('radar-toggle').addEventListener('click', toggleRadar);

    setupMap();
    await loadPredictions();
  } catch (e) {
    console.error(e);
    document.body.innerHTML = `<div style="padding:40px;color:#f59e0b;font-family:monospace">
      Could not load data. Serve this folder:<br>
      <code style="background:#131821;padding:10px;border-radius:6px;display:block">
cd web && python3 -m http.server 8765</code>
      then open http://localhost:8765<br><br>${e}</div>`;
  }
})();

async function loadPredictions() {
  try {
    const data = await fetch('models/dmv-cnn-12h/preds.json').then(r => r.json());
    state.preds = new Map((data.predictions || []).map(p => [p.id, p]));
  } catch { state.preds = new Map(); }
  refresh();
}

function refresh() {
  refreshMarkers();
  renderHero();
  renderSummary();
  renderGaugeList();
  if (!state.selected) {
    // auto-select the most severe gauge with predictions
    const monitored = visibleSites().filter(s => state.preds?.get(s.id)?.series?.length);
    if (monitored.length) {
      monitored.sort((a, b) => sevRank[siteSeverity(b)] - sevRank[siteSeverity(a)]);
      select(monitored[0].id);
      return;
    }
  }
  if (state.selected) renderChart(state.selected);
}

// ---- map ------------------------------------------------------------------

function setupMap() {
  state.map = L.map('map', { zoomControl: true, preferCanvas: true })
    .setView([38.8, -77.3], 9);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 18, subdomains: 'abcd',
  }).addTo(state.map);

  // NEXRAD composite reflectivity. Newer "n0q" layer is higher-resolution
  // than the legacy n0r and supports up to 256 dBZ values. Bumped opacity
  // so visible echoes stand out from the dark basemap.
  state.radarLayer = L.tileLayer.wms(
    'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi', {
      layers: 'nexrad-n0r-900913',
      format: 'image/png', transparent: true,
      attribution: 'NEXRAD &copy; Iowa State Mesonet',
      opacity: 0.75,
    });
  state.radarLayer.addTo(state.map);

  // Diagnostic: log when tiles load successfully and when none have echo
  let radarTilesLoaded = 0;
  state.radarLayer.on('tileload', () => { radarTilesLoaded++; });
  state.radarLayer.on('load', () => {
    console.log(`NEXRAD: ${radarTilesLoaded} tiles loaded (empty tiles mean no precipitation in that area)`);
  });

  // Markers built on first refresh (depends on model selection for severity).
}

function visibleSites() {
  // All 10 monitored gauges. sites.json contains only the trained set now.
  return state.sites;
}

function refreshMarkers() {
  // Clear & rebuild — visibility depends on selected model.
  state.markers.forEach(m => state.map.removeLayer(m));
  state.markers.clear();

  const sites = visibleSites();
  const bounds = [];
  for (const s of sites) {
    if (s.lat == null || s.lon == null) continue;
    bounds.push([s.lat, s.lon]);
    const sev = siteSeverity(s);
    const icon = L.divIcon({
      className: '', html: `<div class="m ${sev}" data-id="${s.id}"></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    });
    const m = L.marker([s.lat, s.lon], { icon })
      .bindTooltip(`<b>${s.name}</b><br>${sevLabel[sev]}`, { direction: 'top' })
      .on('click', () => select(s.id));
    m.addTo(state.map);
    state.markers.set(s.id, m);
  }
  if (bounds.length) state.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
  if (state.selected) {
    state.markers.get(state.selected.id)?.getElement()?.querySelector('.m')?.classList.add('selected');
  }
}

function toggleRadar() {
  const btn = document.getElementById('radar-toggle');
  if (state.radarOn) {
    state.map.removeLayer(state.radarLayer);
    btn.textContent = 'NEXRAD off';
    btn.classList.remove('on');
    state.radarOn = false;
  } else {
    state.radarLayer.addTo(state.map);
    btn.textContent = 'NEXRAD on';
    btn.classList.add('on');
    state.radarOn = true;
  }
}

// ---- hero status banner ---------------------------------------------------

function renderHero() {
  const hero = document.getElementById('hero');
  const levelEl = document.getElementById('hero-level');
  const msgEl = document.getElementById('hero-msg');
  let worst = 'ok';
  let worstSite = null;
  for (const s of visibleSites()) {
    const sev = siteSeverity(s);
    if (sevRank[sev] > sevRank[worst]) { worst = sev; worstSite = s; }
  }
  hero.className = 'hero ' + worst;
  if (worst === 'extreme') {
    levelEl.textContent = 'Extreme Flooding';
    msgEl.textContent = `${worstSite.name} forecast above Q10 (10-yr return level).`;
  } else if (worst === 'danger') {
    levelEl.textContent = 'Flood Warning';
    msgEl.textContent = `${worstSite.name} forecast above Q5 (5-yr return level).`;
  } else if (worst === 'warn') {
    levelEl.textContent = 'Watch';
    msgEl.textContent = `${worstSite.name} approaching Q2 (2-yr return level).`;
  } else {
    levelEl.textContent = 'All Clear';
    const count = visibleSites().filter(s => state.preds?.get(s.id)?.series?.length).length;
    msgEl.textContent = `${count} gauge${count === 1 ? '' : 's'} monitored · no warning crossings forecast in 12h.`;
  }
}

// ---- summary stats --------------------------------------------------------

function renderSummary() {
  const sites = visibleSites();
  const monitored = sites.filter(s => state.preds?.get(s.id)?.series?.length);
  let warnings = 0;
  let totalPrecip = 0;
  let precipSites = 0;
  for (const s of sites) {
    const sev = siteSeverity(s);
    if (sev === 'warn' || sev === 'danger' || sev === 'extreme') warnings++;
    const pred = state.preds?.get(s.id);
    if (pred?.series) {
      const totalP = pred.series.reduce((a, p) => a + (p.precip_mm || 0), 0);
      if (totalP > 0) { totalPrecip += totalP; precipSites++; }
    }
  }
  const avgPrecip = precipSites ? totalPrecip / precipSites : 0;
  document.getElementById('summary').innerHTML = `
    <div class="stat"><b>${monitored.length}</b>monitored</div>
    <div class="stat"><b style="color:${warnings ? 'var(--warn)' : 'var(--ok)'}">${warnings}</b>at-risk</div>
    <div class="stat"><b>${avgPrecip.toFixed(1)}mm</b>avg rain 12h</div>
  `;
}

// ---- gauge feed -----------------------------------------------------------

function renderGaugeList() {
  const list = document.getElementById('gauge-list');
  const sites = visibleSites().slice();
  // Sort: severity desc, then peak forecast desc, then name
  sites.sort((a, b) => {
    const sa = sevRank[siteSeverity(a)], sb = sevRank[siteSeverity(b)];
    if (sa !== sb) return sb - sa;
    const fa = forecastPeak(a)?.o ?? -Infinity, fb = forecastPeak(b)?.o ?? -Infinity;
    if (fa !== fb) return fb - fa;
    return a.name.localeCompare(b.name);
  });
  list.innerHTML = sites.map(s => {
    const sev = siteSeverity(s);
    const now = liveNow(s);
    const peak = forecastPeak(s);
    const flowNow = now ? fmtFlow(now.o) : '—';
    const flowPeak = peak ? fmtFlow(peak.o) : '—';
    const delta = (now && peak) ? peak.o - now.o : 0;
    const deltaCls = delta > 0.05 ? 'up' : 'down';
    const deltaTxt = (now && peak)
      ? (delta > 0 ? '↑ ' : '↓ ') + fmtFlow(Math.abs(delta))
      : '';
    const hours = hoursToThreshold(s, 'warning');
    const meta = hours != null && hours < 12
        ? `<b style="color:var(--warn)">warning in ~${Math.round(hours)}h</b>`
        : (peak ? `peak ${flowPeak} ${unitLabel()}` : `${s.kind || ''}`);
    const sel = state.selected?.id === s.id ? ' selected' : '';
    return `<div class="gauge${sel}" data-id="${s.id}">
      <div class="severity ${sev}"></div>
      <div class="info">
        <div class="name">${s.name}</div>
        <div class="meta">${meta}</div>
      </div>
      <div class="flow">
        <span class="now">${flowNow}</span>
        <span class="delta ${deltaCls}">${deltaTxt}</span>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.gauge').forEach(el => {
    el.addEventListener('click', () => select(el.dataset.id));
  });
}

function select(gid) {
  const s = state.sites.find(x => x.id === gid);
  if (!s) return;
  if (state.selected) {
    state.markers.get(state.selected.id)?.getElement()
      ?.querySelector('.m')?.classList.remove('selected');
  }
  state.selected = s;
  state.markers.get(gid)?.getElement()?.querySelector('.m')?.classList.add('selected');
  // re-render list to highlight
  renderGaugeList();
  renderChart(s);
}

// ---- chart ----------------------------------------------------------------

function renderChart(s) {
  const canvas = document.getElementById('chart');
  const empty = document.getElementById('chart-empty');
  const pred = state.preds?.get(s.id);
  const conv = state.unit === 'cfs' ? M3S_TO_CFS : 1;

  document.getElementById('chart-site').textContent = s.name;

  if (!pred?.series?.length && !pred?.backtest?.length) {
    canvas.style.display = 'none';
    empty.style.display = 'block';
    empty.innerHTML = `No predictions available for ${s.name} yet.`;
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    renderChartStats(s, [], []);
    return;
  }

  // Chart x-axis spans the backtest start (7 days back) → forecast horizon
  // (issue + 12h). Hourly tick density, daily-formatted ticks for legibility.
  const backtest = pred.backtest ?? [];
  const series = pred.series ?? [];
  const xMin = backtest.length ? backtest[0].t : series[0].d;
  const xMax = series.length ? series[series.length - 1].d : backtest[backtest.length - 1].t;
  const todayISO = pred.issue_time;

  // Observed: backtest's hourly observed + the 24h obs at the end (in series).
  const obsData = backtest
    .filter(b => b.o != null).map(b => ({ x: b.t, y: b.o * conv }))
    .concat(series.filter(p => p.o != null).map(p => ({ x: p.d, y: p.o * conv })));

  // Backtest nowcast: 1h-ahead at each historical hour (dashed orange).
  const backtestPred = backtest.map(b => ({ x: b.t, y: b.p1 * conv }));

  // Live forecast: solid orange going forward into the 12h horizon.
  const liveForecast = series
    .filter(p => p.p != null).map(p => ({ x: p.d, y: p.p * conv }));

  // Hourly precip bars across the whole window (CNN bundles precip_mm in series).
  const precipBars = series.filter(p => p.precip_mm != null)
    .map(p => ({ x: p.d, y: p.precip_mm }));

  renderChartStats(s, liveForecast, backtestPred);

  canvas.style.display = 'block';
  empty.style.display = 'none';
  canvas.style.display = 'block';
  empty.style.display = 'none';

  const thresholdLines = !s.thresholds ? [] : [
    { y: s.thresholds.warning * conv, color: 'rgba(250,204,21,0.6)', label: `Q2 warning` },
    { y: s.thresholds.danger  * conv, color: 'rgba(249,115,22,0.6)', label: `Q5 danger` },
    { y: s.thresholds.extreme * conv, color: 'rgba(239,68,68,0.6)',  label: `Q10 extreme` },
  ];

  const datasets = [];
  if (obsData.length) datasets.push({
    label: 'Observed (USGS)', data: obsData, borderColor: '#22c55e',
    backgroundColor: 'rgba(34,197,94,0.10)', borderWidth: 2, pointRadius: 0,
    tension: 0.1, fill: true,
  });
  if (backtestPred.length) datasets.push({
    label: 'Model nowcast (1h-ahead, past week)', data: backtestPred,
    borderColor: '#f97316', backgroundColor: 'transparent',
    borderWidth: 1.4, pointRadius: 0, tension: 0.1, borderDash: [3, 3],
  });
  if (liveForecast.length) datasets.push({
    label: 'Forecast 12h', data: liveForecast, borderColor: '#f97316',
    backgroundColor: 'transparent', borderWidth: 2.5, pointRadius: 2.5,
    pointBackgroundColor: '#f97316', tension: 0.1,
  });
  if (precipBars.length) datasets.push({
    label: 'Precip mm/h', data: precipBars, type: 'bar',
    backgroundColor: 'rgba(129,140,248,0.55)', borderColor: 'rgba(129,140,248,1)',
    borderWidth: 1, borderRadius: 2, yAxisID: 'yPrecip',
    barThickness: 3,
  });

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true, position: 'top', align: 'end',
          labels: { color: '#8b96a4', font: { size: 10 }, boxWidth: 10, boxHeight: 2 },
        },
        tooltip: {
          backgroundColor: '#11161e', borderColor: '#364253', borderWidth: 1,
          titleColor: '#e6edf3', bodyColor: '#e6edf3', padding: 8,
          callbacks: {
            label: (ctx) => ctx.dataset.yAxisID === 'yPrecip'
              ? `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} mm`
              : `${ctx.dataset.label}: ${fmtFlow(ctx.parsed.y)} ${unitLabel()}`,
            title: (items) => FMT_FULL.format(new Date(items[0].parsed.x)),
          },
        },
        thresholdLines: { lines: thresholdLines, forecastBand: { from: todayISO, to: xMax } },
      },
      scales: {
        x: { type: 'time', min: xMin, max: xMax,
             time: { unit: 'day', displayFormats: { day: 'MMM d', hour: 'ha' },
                     tooltipFormat: 'MMM d, h:mma' },
             ticks: { color: '#8b96a4', maxRotation: 0, font: { size: 9 } },
             grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#8b96a4', font: { size: 9 }, callback: v => fmtFlow(v) },
             grid: { color: 'rgba(255,255,255,0.04)' },
             title: { display: true, text: unitLabel(), color: '#8b96a4', font: { size: 10 } } },
        yPrecip: {
          display: !!datasets.find(d => d.yAxisID === 'yPrecip'),
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: 'rgba(129,140,248,0.7)', font: { size: 9 }, callback: v => `${v}mm` },
          title: { display: true, text: 'precip', color: 'rgba(129,140,248,0.7)', font: { size: 9 } },
          beginAtZero: true,
        },
      },
    },
    plugins: [{
      id: 'thresholdLines',
      beforeDraw(chart, _, opts) {
        const lines = opts?.lines ?? [];
        const band = opts?.forecastBand;
        const { ctx, chartArea: a, scales: { x, y } } = chart;
        if (!a) return;
        if (band) {
          const x1 = x.getPixelForValue(new Date(band.from).getTime());
          const x2 = x.getPixelForValue(new Date(band.to).getTime());
          ctx.save();
          ctx.fillStyle = 'rgba(249,115,22,0.05)';
          ctx.fillRect(x1, a.top, x2 - x1, a.bottom - a.top);
          ctx.strokeStyle = 'rgba(249,115,22,0.4)';
          ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x1, a.top); ctx.lineTo(x1, a.bottom); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(249,115,22,0.85)'; ctx.font = '10px sans-serif';
          ctx.fillText('FORECAST', x1 + 6, a.top + 12);
          ctx.restore();
        }
        ctx.save();
        for (const ln of lines) {
          const yPx = y.getPixelForValue(ln.y);
          if (yPx < a.top || yPx > a.bottom) continue;
          ctx.strokeStyle = ln.color;
          ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.left, yPx); ctx.lineTo(a.right, yPx); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = ln.color; ctx.font = '10px sans-serif';
          ctx.fillText(ln.label, a.left + 6, yPx - 3);
        }
        ctx.restore();
      },
    }],
  });
}

function renderChartStats(s, liveForecast, backtestPred) {
  const el = document.getElementById('chart-stats');
  const now = liveNow(s);
  const peak = forecastPeak(s);
  const sev = siteSeverity(s);
  const th = s.thresholds;
  const peakRatio = (peak && th) ? (peak.o / th.warning * 100) : null;

  // Compute backtest NSE if we have it (model nowcast vs observed)
  const pred = state.preds?.get(s.id);
  let backtestNSE = null;
  if (pred?.backtest?.length) {
    const paired = pred.backtest.filter(b => b.o != null);
    if (paired.length > 10) {
      const obs = paired.map(b => b.o);
      const sim = paired.map(b => b.p1);
      const mean = obs.reduce((a, c) => a + c, 0) / obs.length;
      const ss = obs.reduce((a, o, i) => a + (o - sim[i]) ** 2, 0);
      const st = obs.reduce((a, o) => a + (o - mean) ** 2, 0);
      backtestNSE = 1 - ss / (st + 1e-9);
    }
  }

  const parts = [];
  if (now) parts.push(`<span>now <b>${fmtFlow(now.o)} ${unitLabel()}</b></span>`);
  if (peak) {
    const cls = sev !== 'ok' && sev !== 'untrained' ? ` class="${sev}"` : '';
    parts.push(`<span${cls}>peak 12h <b>${fmtFlow(peak.o)} ${unitLabel()}</b></span>`);
  }
  if (peakRatio != null) {
    parts.push(`<span>vs warning <b>${peakRatio.toFixed(0)}%</b></span>`);
  }
  if (backtestNSE != null) {
    parts.push(`<span>7d NSE <b>${backtestNSE.toFixed(3)}</b></span>`);
  }
  if (s.drain_area_sqmi) {
    parts.push(`<span>drainage <b>${s.drain_area_sqmi.toLocaleString()} mi²</b></span>`);
  }
  el.innerHTML = parts.join('');
}
