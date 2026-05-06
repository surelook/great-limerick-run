import * as Plot from 'https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6/+esm';

const FINISH_KM = 42.195;

// Where on the course each race starts (km from marathon start line)
// Used only for chart x-axis positioning
const RACE_START_KM = {
  'Marathon':       0,
  'Marathon Relay': 0,
  'Half Marathon':  FINISH_KM - 21.0975,
  '6 Mile':         FINISH_KM - 9.656,
};

const RACE_ROUTE = {
  'Marathon':       'full',
  'Marathon Relay': 'full',
  'Half Marathon':  'half',
  '6 Mile':         '6',
};

const YEAR_COLORS = { 2025: '#60a5fa', 2026: '#f97316' };

const KM_BIN   = 0.1;
const NUM_BINS = Math.ceil(FINISH_KM / KM_BIN);

let allParticipants = [];
let currentMinute   = 0;
let minMinute       = 0;
let maxMinute       = 0;
let globalMax       = 10;
let playInterval    = null;

let routes         = {};
let leafletMap     = null;
let dotLayers      = { 2025: null, 2026: null };
let canvasRenderer = null;
let dotSample      = [];

// --- helpers -----------------------------------------------------------------

function parseTimeToSeconds(str) {
  if (!str) return null;
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function minutesToLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Look up a lat/lng point at distM metres along a route.
 * Route points have a .dis property in metres from that route's own start.
 */
function latlngAtDist(routeKey, distM) {
  const pts = routes[routeKey];
  if (!pts || !pts.length) return null;
  if (distM <= pts[0].dis) return pts[0];
  const last = pts[pts.length - 1];
  if (distM >= last.dis) return last;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].dis <= distM) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const t = (distM - a.dis) / (b.dis - a.dis);
  return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
}

// --- position interpolation --------------------------------------------------

/**
 * Returns the runner's position in race-relative km
 * (0 = their start mat, raceDistKm = finish line).
 *
 * This is intentionally NOT offset by RACE_START_KM — that offset is only
 * applied when placing the runner on the chart x-axis or converting to
 * metres along the full course route. For sub-routes (half, 6 mile) the
 * route's own .dis values start at 0, so we pass race-relative metres
 * directly to latlngAtDist.
 */
function raceKmAtClockMinute(participant, clockMinute) {
  const { startMin, anchors } = participant;
  if (clockMinute < startMin) return null;

  const elapsedS = (clockMinute - startMin) * 60;
  const last     = anchors[anchors.length - 1];
  if (elapsedS >= last.elapsed_s) return null; // already finished

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    if (elapsedS >= a.elapsed_s && elapsedS < b.elapsed_s) {
      const t = (elapsedS - a.elapsed_s) / (b.elapsed_s - a.elapsed_s);
      return a.km + t * (b.km - a.km);
    }
  }

  return null;
}

// --- map ---------------------------------------------------------------------

function makeLabelIcon({ text, bg, color }) {
  return L.divIcon({
    html: `<span class="map-label" style="background:${bg};color:${color};">${text}</span>`,
    className: '',
    iconAnchor: [0, 10],
  });
}

function initMap() {
  canvasRenderer = L.canvas({ padding: 0.5 });
  leafletMap = L.map('map', { zoomControl: false, attributionControl: false, preferCanvas: true })
    .setView([52.655, -8.62], 13);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
  }).addTo(leafletMap);

  const routeStyles = { full: '#2d3f5e', half: '#1a3a2a', '6': '#3a2a1a' };
  let allBounds = null;
  for (const [key, pts] of Object.entries(routes)) {
    const lls  = pts.map(p => [p.lat, p.lng]);
    const line = L.polyline(lls, { color: routeStyles[key] ?? '#2d3f5e', weight: 4, opacity: 0.9 }).addTo(leafletMap);
    allBounds  = allBounds ? allBounds.extend(line.getBounds()) : line.getBounds();
  }
  if (allBounds) leafletMap.fitBounds(allBounds, { padding: [20, 20] });

  const finish = routes.full[routes.full.length - 1];
  L.marker([finish.lat, finish.lng],
    { icon: makeLabelIcon({ text: 'Finish', bg: '#854d0e', color: '#fef3c7' }) }).addTo(leafletMap);
  L.marker([routes.full[0].lat, routes.full[0].lng],
    { icon: makeLabelIcon({ text: 'Marathon start', bg: '#1e293b', color: '#cbd5e1' }) }).addTo(leafletMap);
  L.marker([routes.half[0].lat, routes.half[0].lng],
    { icon: makeLabelIcon({ text: 'HM start', bg: '#1e3a5f', color: '#93c5fd' }) }).addTo(leafletMap);
  L.marker([routes['6'][0].lat, routes['6'][0].lng],
    { icon: makeLabelIcon({ text: '6M start', bg: '#431407', color: '#fed7aa' }) }).addTo(leafletMap);
}

function updateMapDots(clockMinute) {
  const enabledYears = [];

  if (toggle2025.checked) enabledYears.push(2025);
  if (toggle2026.checked) enabledYears.push(2026);

  // Remove ALL existing layers first
  for (const yr of [2025, 2026]) {
    if (dotLayers[yr]) {
      leafletMap.removeLayer(dotLayers[yr]);
      dotLayers[yr] = null;
    }
  }

  const dots = { 2025: [], 2026: [] };

  for (let i = 0; i < allParticipants.length; i++) {
    if (!dotSample[i]) continue;

    const p = allParticipants[i];

    // Skip disabled years
    if (!enabledYears.includes(p.year)) continue;

    const raceKm = raceKmAtClockMinute(p, clockMinute);
    if (raceKm === null) continue;

    const routePts = routes[p.routeKey];
    if (!routePts) continue;

    const ll = latlngAtDist(p.routeKey, raceKm * 1000);

    if (ll) dots[p.year].push(ll);
  }

  // Only render enabled years
  for (const yr of enabledYears) {
    dotLayers[yr] = L.layerGroup(
      dots[yr].map(ll =>
        L.circleMarker([ll.lat, ll.lng], {
          renderer:    canvasRenderer,
          radius:      2,
          color:       'transparent',
          fillColor:   YEAR_COLORS[yr],
          fillOpacity: 0.6,
        })
      )
    ).addTo(leafletMap);
  }
}
// --- chart -------------------------------------------------------------------

function processParticipants(results) {
  return results.flatMap(r => {
    const raceStartKm = RACE_START_KM[r.race];
    const routeKey    = RACE_ROUTE[r.race];
    if (raceStartKm === undefined || !routeKey) return [];

    const anchors = r.split_anchors ?? [];
    if (anchors.length < 2) return [];

    const startMin  = parseTimeToSeconds(anchors[0].clock_time) / 60;
    const finishMin = parseTimeToSeconds(anchors[anchors.length - 1].clock_time) / 60;

    if (!startMin || !finishMin || finishMin <= startMin) return [];

    return [{
      year:         r.year,
      race:         r.race,
      raceStartKm,  // course offset — used only for chart x-axis
      routeKey,
      startMin,
      finishMin,
      anchors,      // km values are race-relative (0 = start mat)
    }];
  });
}

function computeBins(participants, clockMinute) {
  const bins = {
    2025: new Float32Array(NUM_BINS),
    2026: new Float32Array(NUM_BINS),
  };

  for (const p of participants) {
    if (clockMinute < p.startMin || clockMinute >= p.finishMin) continue;

    // Race-relative km → add course offset for chart x-axis position
    const raceKm   = raceKmAtClockMinute(p, clockMinute);
    if (raceKm === null) continue;

    const courseKm = p.raceStartKm + raceKm;
    const binIdx   = Math.min(Math.floor(courseKm / KM_BIN), NUM_BINS - 1);
    bins[p.year][binIdx]++;
  }

  return bins;
}

function computeGlobalMax(participants) {
  let max = 0;
  for (let t = minMinute; t <= maxMinute; t += 2) {
    const bins = computeBins(participants, t);
    for (let i = 0; i < NUM_BINS; i++) {
      const total = bins[2025][i] + bins[2026][i];
      if (total > max) max = total;
    }
  }
  return max;
}

function render(clockMinute) {
  const bins = computeBins(allParticipants, clockMinute);

  const rows = [];
  for (let i = 0; i < NUM_BINS; i++) {
    const km = i * KM_BIN + KM_BIN / 2;
    if (toggle2025.checked) {
      rows.push({ km, year: '2025', count: bins[2025][i] });
    }
    if (toggle2026.checked) {
      rows.push({ km, year: '2026', count: bins[2026][i] });
    }
  }

  const startMarkers = [
    { km: RACE_START_KM['Half Marathon'], label: 'HM start' },
    { km: RACE_START_KM['6 Mile'],        label: '6M start' },
  ];

  const chart = Plot.plot({
    width:        900,
    height:       360,
    marginLeft:   50,
    marginBottom: 44,
    marginRight:  20,
    marginTop:    16,
    style: { background: 'transparent', color: '#94a3b8', fontSize: '12px' },
    x: {
      label: 'Distance from marathon start (km) →',
      domain: [0, FINISH_KM],
      ticks: 10,
    },
    y: {
      label: `Runners per ${KM_BIN * 1000}m sector`,
      domain: [0, globalMax * 1.1],
      grid: true,
    },
    marks: [
      Plot.areaY(rows.filter(r => r.year === '2025'), {
        x: 'km', y: 'count',
        fill: YEAR_COLORS[2025], fillOpacity: 0.08,
        curve: 'catmull-rom',
      }),
      Plot.areaY(rows.filter(r => r.year === '2026'), {
        x: 'km', y: 'count',
        fill: YEAR_COLORS[2026], fillOpacity: 0.08,
        curve: 'catmull-rom',
      }),
      Plot.lineY(rows.filter(r => r.year === '2025'), {
        x: 'km', y: 'count',
        stroke: YEAR_COLORS[2025], strokeWidth: 2.5,
        curve: 'catmull-rom',
      }),
      Plot.lineY(rows.filter(r => r.year === '2026'), {
        x: 'km', y: 'count',
        stroke: YEAR_COLORS[2026], strokeWidth: 2.5,
        curve: 'catmull-rom',
      }),
      Plot.ruleX(startMarkers, {
        x: 'km', stroke: '#475569',
        strokeWidth: 1, strokeDasharray: '4,4',
      }),
      Plot.text(startMarkers, {
        x: 'km', y: globalMax * 1.05,
        text: 'label', fill: '#64748b',
        fontSize: 10, textAnchor: 'start', dx: 4,
      }),
      Plot.ruleX([FINISH_KM], {
        stroke: '#64748b', strokeWidth: 1, strokeDasharray: '4,4',
      }),
      Plot.text([{ km: FINISH_KM, label: 'Finish' }], {
        x: 'km', y: globalMax * 1.05,
        text: 'label', fill: '#64748b',
        fontSize: 10, textAnchor: 'end', dx: -4,
      }),
    ],
  });

  const chartEl = document.getElementById('chart');
  chartEl.innerHTML = '';
  chartEl.appendChild(chart);

  updateMapDots(clockMinute);
}

// --- controls ----------------------------------------------------------------

window.onSlider = function(val) {
  currentMinute = minMinute + (val / 100) * (maxMinute - minMinute);
  document.getElementById('clockDisplay').textContent = minutesToLabel(currentMinute);
  render(currentMinute);
};

window.togglePlay = function() {
  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
    document.getElementById('playBtn').textContent = '▶ Play';
    return;
  }
  document.getElementById('playBtn').textContent = '⏸ Pause';
  playInterval = setInterval(() => {
    const slider = document.getElementById('timeSlider');
    let val = Number(slider.value) + 0.3;
    if (val > 100) val = 0;
    slider.value = val;
    window.onSlider(val);
  }, 50);
};

window.toggleYear = function(year) {
  render(currentMinute);
};

// --- init --------------------------------------------------------------------

async function main() {
  const parseRoute = data =>
    (data.points ?? [])
      .filter(p => p.dis !== undefined && p.lat && p.lng)
      .sort((a, b) => a.dis - b.dis);

  const [{ results }, routeFull, routeHalf, route6] = await Promise.all([
    fetch('results.json').then(r => r.json()),
    fetch('route-full.json').then(r => r.json()),
    fetch('route-half.json').then(r => r.json()),
    fetch('route-6.json').then(r => r.json()),
  ]);

  routes.full = parseRoute(routeFull);
  routes.half = parseRoute(routeHalf);
  routes['6'] = parseRoute(route6);

  allParticipants = processParticipants(results);
  dotSample = allParticipants.map(() => Math.random() < 0.2);

  const startMins  = allParticipants.map(p => p.startMin);
  const finishMins = allParticipants.map(p => p.finishMin);
  minMinute = Math.min(...startMins);
  maxMinute = Math.max(...finishMins);

  document.getElementById('sliderMin').textContent = minutesToLabel(minMinute);
  document.getElementById('sliderMax').textContent = minutesToLabel(maxMinute);
  document.getElementById('loading').textContent   = 'Computing y-axis range…';

  globalMax = computeGlobalMax(allParticipants);

  // Open at peak congestion
  let peakMinute = minMinute;
  let peakCount  = 0;
  for (let t = minMinute; t <= maxMinute; t += 1) {
    let count = 0;
    for (const p of allParticipants) {
      if (t >= p.startMin && t < p.finishMin) count++;
    }
    if (count > peakCount) { peakCount = count; peakMinute = t; }
  }
  currentMinute = peakMinute;

  const sliderVal = ((peakMinute - minMinute) / (maxMinute - minMinute)) * 100;
  document.getElementById('timeSlider').value         = sliderVal;
  document.getElementById('clockDisplay').textContent = minutesToLabel(peakMinute);

  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display     = 'block';

  initMap();
  render(currentMinute);
}

main().catch(err => {
  document.getElementById('loading').textContent = 'Error: ' + err.message;
  console.error(err);
});