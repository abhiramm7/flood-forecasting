/* DMV Flood Watch — UI driver.
 *
 * Layout:
 *   Header (status banner)
 *   ┌──────────────────────┬────────────────────┐
 *   │   MAP + radar        │   GAUGE DETAIL     │
 *   │                      │   - now / peak     │
 *   │                      │   - threshold bar  │
 *   │                      │   - other gauges   │
 *   ├──────────────────────┴────────────┬───────┤
 *   │   STREAMFLOW CHART (30d + 12h)    │ MODEL │
 *   │                                   │ + QPF │
 *   └───────────────────────────────────┴───────┘
 *
 * Data: sites.json (gauges + metadata) + models/dmv-cnn-12h/preds.json
 * (per-gauge backtest + series). Single model, no picker.
 */

const FMT_FULL = new Intl.DateTimeFormat('en-US',
  { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const FMT_REL = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
const M3S_TO_CFS = 35.3147;
const HOUR_MS = 3600_000;

const state = {
  sites: null,
  preds: null,            // gauge id -> {issue_time, series, backtest, metrics}
  unit: 'm3s',
  selected: null,
  map: null,
  radarLayer: null,
  radarOn: true,
  chart: null,
  precipChart: null,
  markers: new Map(),
  updated: null,
};

// ---- helpers --------------------------------------------------------------

const fmtFlow = (v, signed = false) => {
  if (v == null || !isFinite(v)) return '—';
  const x = state.unit === 'cfs' ? v * M3S_TO_CFS : v;
  const abs = Math.abs(x);
  let s;
  if (abs >= 1000) s = Math.round(x).toLocaleString();
  else if (abs >= 100) s = x.toFixed(0);
  else if (abs >= 10) s = x.toFixed(1);
  else s = x.toFixed(2);
  return signed && x >= 0 ? '+' + s : s;
};
const unitLabel = () => state.unit === 'cfs' ? 'cfs' : 'm³/s';

const severityFor = (flow, th) => {
  if (!th || flow == null) return null;
  if (flow >= th.extreme) return 'extreme';
  if (flow >= th.danger) return 'danger';
  if (flow >= th.warning) return 'warn';
  return 'ok';
};
const sevRank = { ok: 0, warn: 1, danger: 2, extreme: 3 };

function liveNow(s) {
  if (s.live_now?.o != null) return { o: s.live_now.o, d: s.live_now.t || s.live_now.d };
  const pred = state.preds?.get(s.id);
  const lastBacktest = pred?.backtest?.filter(b => b.o != null)?.slice(-1)[0];
  if (lastBacktest) return { o: lastBacktest.o, d: lastBacktest.t };
  if (s.live_obs?.length) return s.live_obs[s.live_obs.length - 1];
  return null;
}

function forecastPeak(s) {
  const pred = state.preds?.get(s.id);
  if (!pred?.series?.length) return null;
  let peak = -Infinity, peakT = null;
  for (const p of pred.series) {
    if (p.p != null && p.p > peak) { peak = p.p; peakT = p.d; }
  }
  return peak === -Infinity ? null : { o: peak, d: peakT };
}

function siteSeverity(s) {
  const now = liveNow(s);
  const peak = forecastPeak(s);
  let worst = null;
  for (const r of [now, peak]) {
    if (r && s.thresholds) {
      const sev = severityFor(r.o, s.thresholds);
      if (sev && (!worst || sevRank[sev] > sevRank[worst])) worst = sev;
    }
  }
  return worst;
}

function backtestNSE(s) {
  const pred = state.preds?.get(s.id);
  if (!pred?.backtest?.length) return null;
  const paired = pred.backtest.filter(b => b.o != null && b.p1 != null);
  if (paired.length < 20) return null;
  const obs = paired.map(b => b.o);
  const sim = paired.map(b => b.p1);
  const mean = obs.reduce((a, c) => a + c, 0) / obs.length;
  const ss = obs.reduce((a, o, i) => a + (o - sim[i]) ** 2, 0);
  const st = obs.reduce((a, o) => a + (o - mean) ** 2, 0);
  return 1 - ss / (st + 1e-9);
}

// ---- bootstrap ------------------------------------------------------------

(async function init() {
  try {
    const sites = await fetch('sites.json').then(r => r.json());
    state.sites = sites.sites;
    state.updated = sites.updated;

    document.getElementById('unit-toggle').addEventListener('click', e => {
      if (e.target.tagName !== 'BUTTON') return;
      state.unit = e.target.dataset.unit;
      document.querySelectorAll('#unit-toggle button').forEach(b =>
        b.classList.toggle('on', b.dataset.unit === state.unit));
      if (state.selected) renderDetail(state.selected);
      renderOtherGauges();
    });
    document.getElementById('radar-toggle').addEventListener('click', toggleRadar);

    setupMap();
    await loadPredictions();
  } catch (e) {
    console.error(e);
    document.body.innerHTML = `<div style="padding:40px;color:#d8a93f;font-family:ui-monospace,monospace">
      Data load failed. Serve <code>web/</code> via a static server and reload.<br><br>${e}</div>`;
  }
})();

async function loadPredictions() {
  try {
    const data = await fetch('models/dmv-cnn-12h/preds.json').then(r => r.json());
    state.preds = new Map((data.predictions || []).map(p => [p.id, p]));
    state.predsUpdated = data.updated;
  } catch { state.preds = new Map(); }
  refresh();
}

function refresh() {
  refreshMarkers();
  renderStatusBanner();
  renderOtherGauges();
  if (!state.selected) {
    const ranked = state.sites
      .filter(s => state.preds?.get(s.id)?.series?.length)
      .sort((a, b) => (sevRank[siteSeverity(b)] || 0) - (sevRank[siteSeverity(a)] || 0));
    if (ranked.length) { select(ranked[0].id); return; }
  }
  if (state.selected) renderDetail(state.selected);
}

// ---- map ------------------------------------------------------------------

function setupMap() {
  state.map = L.map('map', { zoomControl: true, preferCanvas: true })
    .setView([38.93, -77.05], 10);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    maxZoom: 18, subdomains: 'abcd',
  }).addTo(state.map);

  state.radarLayer = L.tileLayer.wms(
    'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi', {
      layers: 'nexrad-n0r-900913',
      format: 'image/png', transparent: true,
      attribution: 'NEXRAD · Iowa State Mesonet',
      opacity: 0.7,
    });
  state.radarLayer.addTo(state.map);
}

function refreshMarkers() {
  state.markers.forEach(m => state.map.removeLayer(m));
  state.markers.clear();

  const bounds = [];
  for (const s of state.sites) {
    if (s.lat == null || s.lon == null) continue;
    bounds.push([s.lat, s.lon]);
    const sev = siteSeverity(s) || 'ok';
    const icon = L.divIcon({
      className: '', html: `<div class="m ${sev}" data-id="${s.id}"></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    });
    const now = liveNow(s);
    const tip = now
      ? `<b>${s.name}</b><br>${fmtFlow(now.o)} ${unitLabel()}`
      : `<b>${s.name}</b><br>no recent data`;
    const m = L.marker([s.lat, s.lon], { icon })
      .bindTooltip(tip, { direction: 'top' })
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
    btn.classList.remove('on');
    state.radarOn = false;
  } else {
    state.radarLayer.addTo(state.map);
    btn.classList.add('on');
    state.radarOn = true;
  }
}

// ---- header status banner ------------------------------------------------

function renderStatusBanner() {
  let worst = 'ok'; let worstSite = null;
  for (const s of state.sites) {
    const sev = siteSeverity(s);
    if (sev && (sevRank[sev] > (sevRank[worst] || 0))) {
      worst = sev; worstSite = s;
    }
  }
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const detail = document.getElementById('status-detail');
  dot.className = 'dot ' + worst;
  if (worst === 'extreme') { text.textContent = 'Extreme'; detail.innerHTML = `${worstSite.name} above Q10`; }
  else if (worst === 'danger') { text.textContent = 'Flood Warning'; detail.innerHTML = `${worstSite.name} above Q5`; }
  else if (worst === 'warn') { text.textContent = 'Watch'; detail.innerHTML = `${worstSite.name} approaching Q2`; }
  else { text.textContent = 'All Clear'; detail.textContent = ''; }

  const u = state.updated || state.predsUpdated;
  if (u) {
    const updated = new Date(u);
    const minsAgo = Math.round((Date.now() - updated.getTime()) / 60_000);
    const stamp = minsAgo < 60 ? `${minsAgo}m ago` : `${Math.round(minsAgo/60)}h ago`;
    detail.innerHTML = (detail.innerHTML ? detail.innerHTML + ' · ' : '') +
      `<span style="color:var(--paper-soft)">refreshed ${stamp}</span>`;
  }
}

// ---- gauge list (right pane bottom) ---------------------------------------

function renderOtherGauges() {
  const sites = state.sites.slice().sort((a, b) => {
    const sa = sevRank[siteSeverity(a)] || -1;
    const sb = sevRank[siteSeverity(b)] || -1;
    if (sa !== sb) return sb - sa;
    return (a.drain_area_sqmi || 0) > (b.drain_area_sqmi || 0) ? -1 : 1;
  });
  const list = document.getElementById('other-list');
  list.innerHTML = sites.map(s => {
    const sev = siteSeverity(s);
    const dot = sev || 'none';
    const now = liveNow(s);
    const peak = forecastPeak(s);
    const arrow = (now && peak)
      ? (peak.o > now.o * 1.05 ? '↗' : peak.o < now.o * 0.95 ? '↘' : '→')
      : '';
    const nowVal = now ? `${fmtFlow(now.o)}` : '—';
    const cls = state.selected?.id === s.id ? ' selected' : '';
    return `<div class="row${cls}" data-id="${s.id}">
      <span class="dot ${dot}"></span>
      <span class="name">${s.name}</span>
      <span class="now">${nowVal} ${unitLabel()}</span>
      <span class="arrow">${arrow}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.row').forEach(el =>
    el.addEventListener('click', () => select(el.dataset.id)));
}

function select(gid) {
  const s = state.sites.find(x => x.id === gid);
  if (!s) return;
  if (state.selected) {
    state.markers.get(state.selected.id)?.getElement()?.querySelector('.m')?.classList.remove('selected');
  }
  state.selected = s;
  state.markers.get(gid)?.getElement()?.querySelector('.m')?.classList.add('selected');
  renderOtherGauges();
  renderDetail(s);
}

// ---- detail pane ---------------------------------------------------------

function renderDetail(s) {
  const pred = state.preds?.get(s.id);
  const now = liveNow(s);
  const peak = forecastPeak(s);
  const th = s.thresholds;

  // Header card
  document.getElementById('gauge-id').textContent = `USGS ${s.id}`;
  document.getElementById('gauge-name').textContent = s.name;
  const metaParts = [];
  if (s.drain_area_sqmi) metaParts.push(`${s.drain_area_sqmi.toLocaleString()} mi² drainage`);
  if (s.state) metaParts.push(s.state);
  if (s.kind) metaParts.push(s.kind);
  document.getElementById('gauge-meta').textContent = metaParts.join(' · ');

  // Big numbers
  document.getElementById('now-val').innerHTML = now
    ? `${fmtFlow(now.o)} <span class="unit">${unitLabel()}</span>`
    : `— <span class="unit">${unitLabel()}</span>`;
  document.getElementById('peak-val').innerHTML = peak
    ? `${fmtFlow(peak.o)} <span class="unit">${unitLabel()}</span>`
    : `— <span class="unit">${unitLabel()}</span>`;
  const deltaEl = document.getElementById('delta');
  if (now && peak) {
    const d = peak.o - now.o;
    const pct = (d / Math.max(now.o, 0.001)) * 100;
    const cls = d > now.o * 0.05 ? 'up' : d < -now.o * 0.05 ? 'down' : '';
    const direction = d > 0 ? 'rising' : d < 0 ? 'falling' : 'steady';
    deltaEl.className = 'delta ' + cls;
    deltaEl.innerHTML = `<b>${direction}</b> · ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% over the next 12h`;
  } else {
    deltaEl.className = 'delta';
    deltaEl.innerHTML = 'trend pending';
  }

  renderThresholdBar(th, now?.o);
  renderModelCard(s, pred);
  renderPrecip(s, pred);
  renderChart(s, pred);
}

function renderThresholdBar(th, nowFlow) {
  const wrap = document.getElementById('bar-wrap');
  const pct = document.getElementById('pct-warning');
  if (!th) {
    wrap.innerHTML = `<div style="color:var(--paper-soft);font:11px var(--mono)">no historical thresholds</div>`;
    pct.textContent = '—';
    return;
  }
  pct.textContent = nowFlow != null
    ? `${(nowFlow / th.warning * 100).toFixed(0)}% of Q2`
    : '—';
  const stops = { warning: 33, danger: 60, extreme: 85, max: 100 };
  function pctPos(v) {
    if (v <= th.warning) return (v / th.warning) * stops.warning;
    if (v <= th.danger)  return stops.warning + ((v - th.warning) / (th.danger - th.warning)) * (stops.danger - stops.warning);
    if (v <= th.extreme) return stops.danger + ((v - th.danger) / (th.extreme - th.danger)) * (stops.extreme - stops.danger);
    return Math.min(99, stops.extreme + ((v - th.extreme) / Math.max(0.001, th.max_observed - th.extreme)) * (stops.max - stops.extreme));
  }
  wrap.innerHTML = `
    <div class="bar-tick" style="left:${stops.warning}%">
      <b>${fmtFlow(th.warning)}</b><br>Q2 warning</div>
    <div class="bar-tick" style="left:${stops.danger}%">
      <b>${fmtFlow(th.danger)}</b><br>Q5 danger</div>
    <div class="bar-tick" style="left:${stops.extreme}%">
      <b>${fmtFlow(th.extreme)}</b><br>Q10 extreme</div>
    <div class="bar-segs">
      <div class="seg-ok"      style="width:${stops.warning}%"></div>
      <div class="seg-warn"    style="width:${stops.danger - stops.warning}%"></div>
      <div class="seg-danger"  style="width:${stops.extreme - stops.danger}%"></div>
      <div class="seg-extreme" style="width:${stops.max - stops.extreme}%"></div>
    </div>
    ${nowFlow != null ? `<div class="bar-cursor" style="left:${pctPos(nowFlow)}%"></div>` : ''}
  `;
}

function renderModelCard(s, pred) {
  const btNSE = backtestNSE(s);
  const testNSE = pred?.metrics?.nse_overall;
  document.getElementById('model-bt-nse').innerHTML =
    btNSE != null ? `<b>${btNSE.toFixed(2)}</b> NSE / last 30 days` : `<b>—</b> NSE / last 30 days`;
  document.getElementById('model-test-nse').innerHTML =
    testNSE != null ? `<b>${testNSE.toFixed(2)}</b> held-out 15% of 3yr` : `<b>—</b> held-out 15% of 3yr`;
  const updated = pred?.issue_time;
  document.getElementById('model-updated').textContent = updated
    ? FMT_FULL.format(new Date(updated)) + ' UTC'
    : '—';
}

function renderPrecip(s, pred) {
  const canvas = document.getElementById('precip-bars');
  const empty = document.getElementById('precip-empty');
  const totalEl = document.getElementById('precip-total');
  const fcPrecip = (pred?.series || []).filter(p => p.precip_mm != null && p.p != null);
  if (!fcPrecip.length) {
    canvas.style.display = 'none';
    empty.style.display = 'block';
    totalEl.textContent = '';
    if (state.precipChart) { state.precipChart.destroy(); state.precipChart = null; }
    return;
  }
  canvas.style.display = 'block';
  empty.style.display = 'none';
  const total = fcPrecip.reduce((a, p) => a + p.precip_mm, 0);
  totalEl.textContent = `${total.toFixed(1)} mm`;
  if (state.precipChart) state.precipChart.destroy();
  state.precipChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: fcPrecip.map(p => p.d),
      datasets: [{
        data: fcPrecip.map(p => p.precip_mm),
        backgroundColor: 'rgba(136, 152, 193, 0.7)',
        borderColor: 'rgba(136, 152, 193, 1)',
        borderWidth: 1, barThickness: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false },
                  tooltip: { backgroundColor: '#161d28', borderColor: '#2a3242', borderWidth: 1,
                              titleColor: '#ede8de', bodyColor: '#ede8de', padding: 7,
                              callbacks: {
                                title: items => FMT_FULL.format(new Date(items[0].label)),
                                label: ctx => `${ctx.parsed.y.toFixed(1)} mm/h`,
                              } } },
      scales: {
        x: { type: 'time', time: { unit: 'hour', displayFormats: { hour: 'ha' } },
             ticks: { color: '#6e6a5e', font: { size: 9, family: 'ui-monospace' }, maxRotation: 0 },
             grid: { display: false } },
        y: { ticks: { color: '#6e6a5e', font: { size: 9, family: 'ui-monospace' },
                       callback: v => `${v}mm` },
              grid: { color: 'rgba(42,50,66,0.5)' }, beginAtZero: true },
      },
    },
  });
}

// ---- main chart -----------------------------------------------------------

function renderChart(s, pred) {
  const canvas = document.getElementById('chart');
  const conv = state.unit === 'cfs' ? M3S_TO_CFS : 1;

  if (!pred?.series?.length && !pred?.backtest?.length) {
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    return;
  }

  const backtest = pred.backtest ?? [];
  const series = pred.series ?? [];
  const xMin = backtest.length ? backtest[0].t : series[0].d;
  const xMax = series.length ? series[series.length - 1].d : backtest[backtest.length - 1].t;
  const issueISO = pred.issue_time;

  const obsData = backtest
    .filter(b => b.o != null).map(b => ({ x: b.t, y: b.o * conv }))
    .concat(series.filter(p => p.o != null).map(p => ({ x: p.d, y: p.o * conv })));
  const backtestPred = backtest.filter(b => b.p1 != null).map(b => ({ x: b.t, y: b.p1 * conv }));
  const liveForecast = series.filter(p => p.p != null).map(p => ({ x: p.d, y: p.p * conv }));

  const thresholdLines = !s.thresholds ? [] : [
    { y: s.thresholds.warning * conv, color: 'rgba(216,169,63,0.55)', label: 'Q2' },
    { y: s.thresholds.danger  * conv, color: 'rgba(200,117,68,0.55)', label: 'Q5' },
    { y: s.thresholds.extreme * conv, color: 'rgba(177,69,51,0.6)',  label: 'Q10' },
  ];

  const datasets = [];
  if (obsData.length) datasets.push({
    label: 'Observed', data: obsData, borderColor: '#5fa3d6',
    backgroundColor: 'rgba(95,163,214,0.10)', borderWidth: 1.6, pointRadius: 0,
    tension: 0.1, fill: true,
  });
  if (backtestPred.length) datasets.push({
    label: 'Model nowcast (1h-ahead)', data: backtestPred,
    borderColor: 'rgba(216,169,63,0.85)', backgroundColor: 'transparent',
    borderWidth: 1.2, pointRadius: 0, tension: 0.1, borderDash: [3, 3],
  });
  if (liveForecast.length) datasets.push({
    label: '12h forecast', data: liveForecast, borderColor: '#d8a93f',
    backgroundColor: 'transparent', borderWidth: 2.5, pointRadius: 2.2,
    pointBackgroundColor: '#d8a93f', tension: 0.1,
  });

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#161d28', borderColor: '#2a3242', borderWidth: 1,
          titleColor: '#ede8de', bodyColor: '#ede8de', padding: 8,
          titleFont: { family: 'ui-monospace', size: 10 },
          bodyFont:  { family: 'ui-monospace', size: 11 },
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${fmtFlow(ctx.parsed.y)} ${unitLabel()}`,
            title: items => FMT_FULL.format(new Date(items[0].parsed.x)),
          },
        },
        thresholdLines: { lines: thresholdLines, issueISO, xMax },
      },
      scales: {
        x: { type: 'time', min: xMin, max: xMax,
             time: { unit: 'day', displayFormats: { day: 'MMM d', hour: 'ha' },
                     tooltipFormat: 'MMM d, h:mma' },
             ticks: { color: '#6e6a5e', maxRotation: 0,
                       font: { family: 'ui-monospace', size: 10 } },
             grid: { color: 'rgba(42,50,66,0.45)' } },
        y: { ticks: { color: '#6e6a5e', font: { family: 'ui-monospace', size: 10 },
                       callback: v => fmtFlow(v) },
              grid: { color: 'rgba(42,50,66,0.45)' },
              title: { display: true, text: unitLabel(), color: '#6e6a5e',
                        font: { family: 'ui-monospace', size: 10 } } },
      },
    },
    plugins: [{
      id: 'thresholdLines',
      beforeDraw(chart, _, opts) {
        const lines = opts?.lines ?? [];
        const { ctx, chartArea: a, scales: { x, y } } = chart;
        if (!a) return;
        // Forecast band shading
        if (opts?.issueISO && opts?.xMax) {
          const x1 = x.getPixelForValue(new Date(opts.issueISO).getTime());
          const x2 = x.getPixelForValue(new Date(opts.xMax).getTime());
          ctx.save();
          ctx.fillStyle = 'rgba(216,169,63,0.06)';
          ctx.fillRect(x1, a.top, x2 - x1, a.bottom - a.top);
          ctx.strokeStyle = 'rgba(216,169,63,0.4)';
          ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x1, a.top); ctx.lineTo(x1, a.bottom); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(216,169,63,0.85)';
          ctx.font = '9px ui-monospace, monospace';
          ctx.fillText('FORECAST', x1 + 5, a.top + 11);
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
          ctx.fillStyle = ln.color; ctx.font = '9px ui-monospace, monospace';
          ctx.fillText(ln.label, a.left + 4, yPx - 2);
        }
        ctx.restore();
      },
    }],
  });
}
