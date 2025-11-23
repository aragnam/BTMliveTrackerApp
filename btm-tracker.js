<script>
// ---------------------------------------------------------------------
//  COMMON UTILITIES & STORAGE
// ---------------------------------------------------------------------
const db = localforage.createInstance({ name: 'BTM_Tracker', storeName: 'tracks' });

function toRad(v){ return v * Math.PI / 180; }
function toDeg(v){ return v * 180 / Math.PI; }
function haversine(a,b){
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat),
        dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat/2)**2 +
            Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function bearing(a,b){
  const lat1 = toRad(a.lat),
        lat2 = toRad(b.lat),
        dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon)*Math.cos(lat2);
  const x = Math.cos(lat1)*Math.sin(lat2) -
            Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  return (toDeg(Math.atan2(y,x)) + 360) % 360;
}

// basic classifier (still used for simulated tracks)
function classifyActivity(speedKmh){
  if(speedKmh < 0.5)  return 'stationary';
  if(speedKmh < 6)    return 'walking';
  if(speedKmh < 15)   return 'running';
  if(speedKmh < 30)   return 'cycling';
  return 'driving';
}

function shortTs(ts){ return new Date(ts).toLocaleTimeString(); }
function uuid(){ return 't_'+Date.now()+'_'+Math.random().toString(36).slice(2,8); }

// NEW: Helper: normalize lat/lon regardless of format
function getLatLonFromPoint(p) {
  const lat = (p.filtered && typeof p.filtered.lat === 'number')
    ? p.filtered.lat
    : (typeof p.lat === 'number' ? p.lat : null);
  const lon = (p.filtered && typeof p.filtered.lon === 'number')
    ? p.filtered.lon
    : (typeof p.lon === 'number' ? p.lon : null);

  if (
    lat === null || lon === null ||
    !Number.isFinite(lat) || !Number.isFinite(lon)
  ) {
    return null;
  }
  return { lat, lon };
}

// ---------------------------------------------------------------------
//  ENHANCED QUALITY SCORING SYSTEM
// ---------------------------------------------------------------------

// NEW: Comprehensive quality scoring
function calculateQualityScore(coords) {
  let score = 100;
  const flags = [];
  
  // Accuracy penalty (0-100 scale)
  if (coords.accuracy > 100) {
    score -= 40;
    flags.push('poor_accuracy');
  } else if (coords.accuracy > 50) {
    score -= 20;
    flags.push('medium_accuracy');
  } else if (coords.accuracy > 20) {
    score -= 10;
  }
  
  // Speed sanity check
  const speedKmh = (coords.speed || 0) * 3.6;
  if (speedKmh > 200) {
    score -= 30;
    flags.push('implausible_speed');
  } else if (speedKmh > 100) {
    score -= 15;
    flags.push('high_speed');
  }
  
  // Altitude sanity (if available)
  if (coords.altitude !== null) {
    if (coords.altitude > 10000 || coords.altitude < -500) {
      score -= 25;
      flags.push('implausible_altitude');
    } else if (coords.altitude > 5000 || coords.altitude < -100) {
      score -= 10;
      flags.push('extreme_altitude');
    }
  }
  
  return {
    score: Math.max(0, score),
    flags: flags
  };
}

// NEW: Advanced spike detection (handles old + new formats)
function detectQualityFlags(currentCoords, prevPoint) {
  const flags = [];
  if (!prevPoint) return flags;

  // Handle both old and new data formats for previous point
  const prevRaw = prevPoint.raw || {
    lat: prevPoint.lat,
    lon: prevPoint.lon,
    altitude: prevPoint.altitude,
    timestamp: prevPoint.ts
  };

  // Determine timestamps safely
  const currentTs = typeof currentCoords.timestamp === 'number'
    ? currentCoords.timestamp
    : Date.now();

  const timeGap = (currentTs - prevRaw.timestamp) / 1000;
  if (Number.isFinite(timeGap) && timeGap > 30) {
    flags.push('large_time_gap');
  }

  // Position spike detection
  const distance = haversine(
    { lat: prevRaw.lat, lon: prevRaw.lon },
    { lat: currentCoords.latitude, lon: currentCoords.longitude }
  );
  const timeDiff = timeGap > 0 ? timeGap : 1;
  const speedMs = distance / timeDiff;
  
  if (speedMs > 50) { // ~180 km/h
    flags.push('position_spike');
  } else if (speedMs > 30) { // ~108 km/h
    flags.push('high_speed_jump');
  }
  
  // Altitude spike detection
  if (
    currentCoords.altitude !== null &&
    currentCoords.altitude !== undefined &&
    prevRaw.altitude !== null &&
    prevRaw.altitude !== undefined
  ) {
    const altDiff = Math.abs(currentCoords.altitude - prevRaw.altitude);
    const verticalSpeed = altDiff / timeDiff;
    
    if (verticalSpeed > 10) { // 10 m/s
      flags.push('altitude_spike');
    } else if (verticalSpeed > 5) { // 5 m/s
      flags.push('rapid_altitude_change');
    }
  }
  
  return flags;
}

// NEW: Altitude filtering
function filterAltitude(currentAlt, prevPoint) {
  if (currentAlt === null) return null;
  
  if (!prevPoint) return currentAlt;
  
  const prevAlt = prevPoint.filtered?.altitude || prevPoint.raw?.altitude;
  if (prevAlt === null || prevAlt === undefined) return currentAlt;
  
  const altDiff = Math.abs(currentAlt - prevAlt);
  const timeDiff = (Date.now() - prevPoint.ts) / 1000;
  
  if (timeDiff > 0 && (altDiff / timeDiff) > 5) { // 5 m/s max
    return prevAlt; // Return previous value instead of spike
  }
  
  return currentAlt;
}

// NEW: Calculate confidence based on multiple factors
function calculateConfidence(coords, qualityScore, flags) {
  let confidence = qualityScore / 100;
  
  // Reduce confidence for specific flags
  if (flags.includes('position_spike')) confidence *= 0.3;
  if (flags.includes('altitude_spike')) confidence *= 0.5;
  if (flags.includes('implausible_speed')) confidence *= 0.2;
  
  return Math.max(0, Math.min(1, confidence));
}

// ---------------------------------------------------------------------
//  MAP INIT  (online-aware tiles)
// ---------------------------------------------------------------------
let map, baseLayer, liveMarker;

function addBaseLayerIfOnline(){
  if(!baseLayer && navigator.onLine){
    baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  }
}

function initMap(){
  map = L.map('map').setView([0,0], 2);

  // tiles only if online
  addBaseLayerIfOnline();
  window.addEventListener('online', addBaseLayerIfOnline);

  // small dot for current position
  liveMarker = L.circleMarker([0,0], {
    radius: 6,
    color: '#1f2937',
    weight: 1.5,
    fillColor: '#3b82f6',
    fillOpacity: 0.95
  }).addTo(map).bindPopup('No data yet');

  setTimeout(()=>map.invalidateSize(), 300);
  window.addEventListener('resize', ()=> map.invalidateSize());
}

// ---------------------------------------------------------------------
//  STATE
// ---------------------------------------------------------------------
let recording = false;
let watchId = null;

let currentTrackId = null;
let currentPolyline = null;
let prevPoint = null;

let allTracks   = {};
let polylineMap = {};
let segmentMap  = {};
let visibility  = {};

let alertMarkers = [];
let geofences = [];
let eventLog = [];   // investigator event timeline

let predictorModel = null;
let predictorReady = false;

let sessionRecords = [];

// --- DIAGNOSTIC MODE GLOBALS ---
let currentScenario = 'UNKNOWN';

// for gap detection
let lastFixTsForGap = null;
const GAP_THRESHOLD_SEC = 10;

// online/offline state
let lastOnlineState = navigator.onLine;

// ---------------------------------------------------------------------
//  POWER MODE + BATTERY INDICATOR
// ---------------------------------------------------------------------
let powerMode = 'balanced';  // we can still wire this later to a dropdown

// Battery info (if supported by browser)
let batteryInfo = {
  level: null,    // 0..1
  charging: null
};
let lastSuggestedMode = null;
let lastSuggestedPct  = null;

  
function suggestModeFromBattery(level) {
  if (level === null || !Number.isFinite(level)) return null;
  const pct = Math.round(level * 100);

  if (pct >= 60) return 'high';
  if (pct >= 30) return 'balanced';
  return 'battery';
}

function updateBatteryBanner() {
  const banner = document.getElementById('batteryBanner');
  const hint   = document.getElementById('batteryHint');
  if (!banner) return;

  if (batteryInfo.level === null) {
    banner.textContent = 'Battery: unknown – mode: ' + powerMode;
    if (hint) {
      hint.style.opacity = 0;
      hint.textContent = '';
    }
    return;
  }

  const pct = Math.round(batteryInfo.level * 100);
  const suggested = suggestModeFromBattery(batteryInfo.level);

  let line = `Battery ${pct}%`;
  if (batteryInfo.charging === true) {
    line += ' (charging)';
  }

  let humanLabel = '';
  if (suggested === 'high')     humanLabel = 'High detail';
  if (suggested === 'balanced') humanLabel = 'Balanced';
  if (suggested === 'battery')  humanLabel = 'Battery saver';

  if (suggested) {
    line += ` – suggested: ${humanLabel}`;
  }

  line += ` – current: ${powerMode}`;
  banner.textContent = line;

  // --- Micro-banner when suggestion flips ---
  if (hint && suggested && suggested !== lastSuggestedMode) {
    const targetLabel = humanLabel || suggested;
    hint.textContent = `Battery ${pct}% → suggest ${targetLabel}`;
    hint.style.opacity = 1;

    // fade out after a few seconds
    setTimeout(() => {
      // only hide if the text hasn't changed since
      if (hint.textContent === `Battery ${pct}% → suggest ${targetLabel}`) {
        hint.style.opacity = 0;
      }
    }, 4500);

    lastSuggestedMode = suggested;
    lastSuggestedPct  = pct;
  }
}

// NEW: movement / chart throttling / follow-live helpers
let lastSavedPoint = null;
const MIN_MOVE_FOR_SAVE_METERS = 5;
const MIN_TIME_FOR_SAVE_SEC    = 5;

let lastChartUpdateTs = 0;
const CHART_UPDATE_INTERVAL_MS_HIGH     = 1000;
const CHART_UPDATE_INTERVAL_MS_BALANCED = 1500;
const CHART_UPDATE_INTERVAL_MS_BATTERY  = 3000;

let followLive = true;

// Helper: geolocation options based on power mode
function getGeoOptions() {
  if (powerMode === 'high') {
    // Max detail: best for court-grade reconstruction
    return {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 5000
    };
  }

  if (powerMode === 'battery') {
    // Low-power: let OS reuse fixes, don't force GPS constantly
    return {
      enableHighAccuracy: false,
      maximumAge: 15000,
      timeout: 10000
    };
  }

  // Balanced (default)
  return {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 7000
  };
}

const activityColor = {
  stationary:'#6b7280',
  walking   :'#16a34a',
  running   :'#f97316',
  cycling   :'#2563eb',
  driving   :'#dc2626'
};
const activityOrder = ['stationary','walking','running','cycling','driving'];
const activityLabel = {
  stationary:'Stationary',
  walking   :'Walking',
  running   :'Running',
  cycling   :'Cycling',
  driving   :'Driving'
};
const palette = ['#1f77b4','#9467bd','#8c564b','#e377c2','#17becf','#7f7f7f'];
// ---------------------------------------------------------------------
//  STYLE CONFIG — tweak these for presentation
// ---------------------------------------------------------------------
const STYLE = {
  // Polyline thicknesses
  segmentWeight: 8,        // coloured segments by activity
  segmentOpacity: 1.0,
  baseWeight: 4,           // thin base track
  baseOpacity: 0.8,
  liveTrackWeight: 10,     // live track polyline

  // Start-of-track marker
  startMarker: {
    radius: 10,
    color: '#ff0000',
    weight: 3,
    fillColor: '#ff0000',
    fillOpacity: 1
  },

  // Alert markers (change colours here)
  genericAlertMarker: {
    radius: 5,
    color: '#f97316',
    weight: 1.2,
    fillColor: '#facc15',
    fillOpacity: 0.95
  },
  sharpTurnMarker: {
    radius: 7,
    color: '#e11d48',      // reddish-pink
    weight: 2,
    fillColor: '#fb7185',
    fillOpacity: 0.95
  },
  gpsGapMarker: {
    radius: 7,
    color: '#7c3aed',      // purple
    weight: 2,
    fillColor: '#a855f7',
    fillOpacity: 0.95
  },
  deviationMarker: {
    radius: 7,
    color: '#f97316',      // orange
    weight: 2,
    fillColor: '#facc15',
    fillOpacity: 0.95
  },
  geofenceMarker: {
    radius: 7,
    color: '#0ea5e9',      // blue
    weight: 2,
    fillColor: '#38bdf8',
    fillOpacity: 0.95
  }
};

// --- extra globals for filtering noise ---
let prevFixForSpeed = null;
let speedWindow     = [];
let lastSmoothedSpeed = 0;
let fastStreak      = 0;
let activityWindow  = [];

// robust speed estimate (km/h)
function safeSpeedKmhFromFix(c){
  const now = Date.now();
  const cur = { lat: c.latitude, lon: c.longitude, t: now };

  let vGps = (c.speed || 0) * 3.6;
  if (!Number.isFinite(vGps)) vGps = 0;

  let vDist = null;
  if (prevFixForSpeed) {
    const dt = (now - prevFixForSpeed.t) / 1000;
    if (dt > 0 && dt < 60) {
      const d = haversine(
        { lat: prevFixForSpeed.lat, lon: prevFixForSpeed.lon },
        { lat: cur.lat,            lon: cur.lon }
      );
      const km  = d / 1000;
      const hrs = dt / 3600;
      vDist = km / hrs;
    }
  }
  prevFixForSpeed = cur;

  let v = vDist !== null ? vDist : vGps;
  if (!Number.isFinite(v) || v < 0) v = 0;

  if (c.accuracy && c.accuracy > 40) {
    v = Math.min(v, 4);
  }

  if (v > 120) v = 120;

  speedWindow.push(v);
  if (speedWindow.length > 5) speedWindow.shift();
  let avg = speedWindow.reduce((a,b)=>a+b,0) / speedWindow.length;

  if (lastSmoothedSpeed !== null){
    const maxDelta = 5;
    const delta    = avg - lastSmoothedSpeed;
    if (Math.abs(delta) > maxDelta){
      avg = lastSmoothedSpeed + Math.sign(delta) * maxDelta;
    }
  }
  lastSmoothedSpeed = avg;

  return avg;
}

// conservative classifier
function classifyActivityFromSpeed(speedKmh){
  if (!Number.isFinite(speedKmh)) speedKmh = 0;

  if (speedKmh < 0.5){
    fastStreak = 0;
    return 'stationary';
  }
  if (speedKmh < 7){
    fastStreak = 0;
    return 'walking';
  }

  if (speedKmh > 20){
    fastStreak++;
  } else {
    fastStreak = Math.max(0, fastStreak - 1);
  }

  if (fastStreak >= 10){
    if (speedKmh > 45) return 'driving';
    return 'cycling';
  }

  return 'walking';
}

// majority of last N labels
function smoothActivity(raw){
  activityWindow.push(raw);
  if (activityWindow.length > 7) activityWindow.shift();

  const counts = {};
  activityWindow.forEach(a => { counts[a] = (counts[a] || 0) + 1; });

  let best = raw, bestCount = 0;
  for (const a in counts){
    if (counts[a] > bestCount){
      bestCount = counts[a];
      best = a;
    }
  }
  return best;
}

// ---------------------------------------------------------------------
//  CHARTS
// ---------------------------------------------------------------------
let speedChart, activityChart;
function initCharts(){
  const ctxSpeed = document.getElementById('speedChart').getContext('2d');
  speedChart = new Chart(ctxSpeed, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Speed (km/h)',
          data: [],
          borderColor: '#ef4444',
          yAxisID: 'y1',
          tension: 0.2,
          fill: true,
          backgroundColor: 'rgba(239,68,68,0.08)'
        },
        {
          label: 'Heading (°)',
          data: [],
          borderColor: '#06b6d4',
          yAxisID: 'y2',
          tension: 0.2,
          fill: false
        }
      ]
    },
    options: {
      animation: false,
      scales: {
        y1: { position:'left', beginAtZero:true },
        y2: { position:'right', min:0, max:360 }
      }
    }
  });

  const ctxAct = document.getElementById('activityChart').getContext('2d');
  activityChart = new Chart(ctxAct, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{ label:'activity', data:[], backgroundColor:[] }]
    },
    options: {
      animation:false,
      plugins:{ legend:{ display:false } },
      scales:{ x:{ display:false }, y:{ display:false } }
    }
  });
}

function pushToCharts(pt){
  const maxN = 120;
  const lbl = shortTs(pt.ts);

  if(speedChart.data.labels.length >= maxN){
    speedChart.data.labels.shift();
    speedChart.data.datasets.forEach(ds => ds.data.shift());
  }
  speedChart.data.labels.push(lbl);
  speedChart.data.datasets[0].data.push(pt.filtered?.speed || pt.speed || 0);
  speedChart.data.datasets[1].data.push(pt._bearing || 0);
  speedChart.update('none');

  if(activityChart.data.labels.length >= 240){
    activityChart.data.labels.shift();
    activityChart.data.datasets[0].data.shift();
    activityChart.data.datasets[0].backgroundColor.shift();
  }
  activityChart.data.labels.push(lbl);
  activityChart.data.datasets[0].data.push(1);
  activityChart.data.datasets[0].backgroundColor.push(activityColor[pt.filtered?.activity || pt.activity] || '#888');
  activityChart.update('none');
}

// ---------------------------------------------------------------------
//  UI HELPERS
// ---------------------------------------------------------------------
// kind = 'generic' | 'gps_gap' | 'sharp_turn' | 'deviation' | 'geofence'
function showAlert(msg, latlng, kind = 'generic'){
  const el = document.getElementById('alerts');
  const ts = Date.now();

  el.textContent = msg;
  setTimeout(()=>{ if(el.textContent === msg) el.textContent = ''; }, 6000);

  eventLog.push({
    ts,
    localTime: new Date(ts).toLocaleString(),
    message : msg,
    lat     : latlng ? latlng[0] : null,
    lon     : latlng ? latlng[1] : null,
    kind
  });

  if(map && latlng){
    let style;
    switch(kind){
      case 'gps_gap':    style = STYLE.gpsGapMarker;    break;
      case 'sharp_turn': style = STYLE.sharpTurnMarker; break;
      case 'deviation':  style = STYLE.deviationMarker; break;
      case 'geofence':   style = STYLE.geofenceMarker;  break;
      default:           style = STYLE.genericAlertMarker;
    }
    const mk = L.circleMarker(latlng, style).bindPopup(msg).addTo(map);
    alertMarkers.push(mk);
  }
}

function clearAlerts(){
  alertMarkers.forEach(m => map.removeLayer(m));
  alertMarkers = [];
  document.getElementById('alerts').textContent = '';
}

// ---------------------------------------------------------------------
//  ONLINE / OFFLINE DIAGNOSTIC EVENTS
// ---------------------------------------------------------------------
window.addEventListener('online', () => {
  const ts = Date.now();
  eventLog.push({
    ts,
    localTime: new Date(ts).toLocaleString(),
    message: 'Browser went ONLINE',
    lat: null,
    lon: null
  });
  lastOnlineState = true;
});

window.addEventListener('offline', () => {
  const ts = Date.now();
  eventLog.push({
    ts,
    localTime: new Date(ts).toLocaleString(),
    message: 'Browser went OFFLINE',
    lat: null,
    lon: null
  });
  lastOnlineState = false;
});

// ---------------------------------------------------------------------
//  ACTIVITY SUMMARY
// ---------------------------------------------------------------------
function updateActivitySummary(){
  const el = document.getElementById('activitySummary');
  if(!el) return;

  const stats = {
    stationary:0,
    walking:0,
    running:0,
    cycling:0,
    driving:0
  };

  for(const tid of Object.keys(allTracks)){
    const pts = allTracks[tid];
    if(!pts || pts.length < 2) continue;
    for(let i=1;i<pts.length;i++){
      const prev = pts[i-1];
      const cur  = pts[i];

      const act = prev.filtered?.activity || prev.activity || classifyActivity(prev.filtered?.speed || prev.speed || 0);

      let tPrev = typeof prev.ts === 'number' ? prev.ts : Date.parse(prev.ts);
      let tCur  = typeof cur.ts  === 'number' ? cur.ts  : Date.parse(cur.ts);
      if(!Number.isFinite(tPrev) || !Number.isFinite(tCur)) continue;

      const dtSec = (tCur - tPrev) / 1000;
      if(dtSec <= 0 || dtSec > 3600) continue;

      if(stats[act] !== undefined){
        stats[act] += dtSec;
      }
    }
  }

  let totalSec = 0;
  activityOrder.forEach(a => totalSec += stats[a]);

  let html = `<div style="font-weight:600;margin-bottom:4px;">Activity summary (all tracks)</div>`;
  if(totalSec === 0){
    html += `<div style="font-size:0.8rem;color:#64748b;">No tracked time yet.</div>`;
  } else {
    html += `<ul style="list-style:none;padding-left:0;margin:0;">`;
    activityOrder.forEach(a=>{
      const mins = stats[a] / 60;
      html += `<li style="margin-bottom:2px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:${activityColor[a]};margin-right:4px;"></span>
        ${activityLabel[a]}: ${mins.toFixed(1)} min
      </li>`;
    });
    html += `</ul>`;
  }
  el.innerHTML = html;
}

// ---------------------------------------------------------------------
//  TRACK STORAGE & RENDERING
// ---------------------------------------------------------------------
async function savePoint(trackId, point){
  const arr = (await db.getItem(trackId)) || [];
  arr.push(point);
  await db.setItem(trackId, arr);
  allTracks[trackId] = arr;

  if(currentTrackId === trackId){
    drawLivePoint(point);
  }
  refreshTrackList();
  updateActivitySummary();
}

async function loadAllTracks(){
  allTracks = {};
  await db.iterate((value, key) => {
    if(key !== '__geofences__') {
      const enhancedPoints = value.map(point => {
        if (point.raw && point.quality) {
          return point;
        }
        return {
          raw: {
            lat: point.lat,
            lon: point.lon,
            altitude: point.altitude,
            accuracy: point.accuracy,
            heading: point.heading,
            speed: point.speed,
            timestamp: point.ts
          },
          quality: calculateQualityScore({
            latitude: point.lat,
            longitude: point.lon,
            altitude: point.altitude,
            accuracy: point.accuracy,
            heading: point.heading,
            speed: point.speed
          }),
          filtered: {
            lat: point.lat,
            lon: point.lon,
            altitude: point.altitude,
            speed: point.speed,
            activity: point.activity,
            is_quality_point: true
          },
          ts: point.ts,
          scenario: point.scenario,
          online: point.online,
          pageVisible: point.pageVisible,
          gapFromPrevSec: point.gapFromPrevSec
        };
      });
      allTracks[key] = enhancedPoints;
    }
  });

  clearAllPolylines();
  let i = 0;
  for(const tid of Object.keys(allTracks)){
    const color = palette[i % palette.length]; i++;
    visibility[tid] = true;
    drawFullTrack(tid, color);
    addTrackListItem(tid, color, allTracks[tid].length);
  }
  map.invalidateSize();
  updateActivitySummary();
}

function clearAllPolylines(){
  Object.values(polylineMap).forEach(p => map.removeLayer(p));
  polylineMap = {};
  Object.values(segmentMap).flat().forEach(s => map.removeLayer(s));
  segmentMap = {};
}

// UPDATED: Loud drawFullTrack with centering + start marker
function drawFullTrack(tid, baseColor){
  const pts = allTracks[tid] || [];
  if(!pts.length) {
    console.log(`[drawFullTrack] No points for track ${tid}`);
    return;
  }

  console.log(`[drawFullTrack] Drawing track ${tid} with ${pts.length} points`);

  const segments = [];
  let curAct = pts[0].filtered?.activity || pts[0].activity || classifyActivity(pts[0].filtered?.speed || pts[0].speed || 0);
  let curPts = [pts[0]];

  for(let i=1;i<pts.length;i++){
    const a = pts[i].filtered?.activity || pts[i].activity || classifyActivity(pts[i].filtered?.speed || pts[i].speed || 0);
    if(a === curAct){
      curPts.push(pts[i]);
    } else {
      segments.push({ activity:curAct, pts:curPts });
      curAct = a;
      curPts = [pts[i]];
    }
  }
  segments.push({ activity:curAct, pts:curPts });

  const segLayers = [];
  segments.forEach(seg=>{
    if(seg.pts.length > 1){
      const coords = seg.pts.map(p => {
        const ll = getLatLonFromPoint(p);
        if (!ll) {
          console.warn('[drawFullTrack] Invalid point in segment:', p);
          return null;
        }
        return [ll.lat, ll.lon];
      }).filter(Boolean);

      if (coords.length > 1) {
        try {
          const poly = L.polyline(coords, {
            color: activityColor[seg.activity] || baseColor || '#ff0000',
            weight: STYLE.segmentWeight,
            opacity: STYLE.segmentOpacity,
            lineCap: 'round',
            lineJoin: 'round'
          }).addTo(map);

          segLayers.push(poly);
          console.log(`[drawFullTrack] Added segment (${seg.activity}) with ${coords.length} points`);
        } catch (e) {
          console.error('[drawFullTrack] Error creating segment polyline:', e, coords);
        }
      }
    }
  });
  segmentMap[tid] = segLayers;

  const baseCoords = pts.map(p => {
    const ll = getLatLonFromPoint(p);
    return ll ? [ll.lat, ll.lon] : null;
  }).filter(Boolean);

  if (baseCoords.length > 1) {
    try {
      const base = L.polyline(baseCoords, {
        color: baseColor || '#000000',
        weight: STYLE.baseWeight,
        opacity: STYLE.baseOpacity
      }).addTo(map);

      base.on('click', ()=>{ toggleVisibility(tid); });
      polylineMap[tid] = base;
      console.log(`[drawFullTrack] Added base track with ${baseCoords.length} points`);

      const first = baseCoords[0];
      L.circleMarker(first, STYLE.startMarker)
        .addTo(map)
        .bindPopup(`Track start: ${tid}`);

      const bounds = base.getBounds();
      map.fitBounds(bounds, { padding: [40, 40] });
      console.log('[drawFullTrack] Auto-centered map on track', tid, 'bounds=', bounds);

    } catch (e) {
      console.error('[drawFullTrack] Error creating base track polyline:', e);
    }
  } else {
    console.warn('[drawFullTrack] Not enough valid baseCoords to draw track', tid);
  }
}

// DEBUG helper: inspect data structures
function debugTrackData() {
  console.log('=== DEBUG TRACK DATA ===');
  console.log('All tracks:', Object.keys(allTracks));
  
  Object.keys(allTracks).forEach(tid => {
    const pts = allTracks[tid];
    console.log(`Track ${tid}: ${pts.length} points`);
    if (pts.length > 0) {
      console.log('First point:', pts[0]);
      console.log('Last point:', pts[pts.length-1]);
      
      const validPts = pts.filter(p => {
        const ll = getLatLonFromPoint(p);
        return !!ll;
      });
      console.log(`Valid coordinates: ${validPts.length}/${pts.length}`);
    }
  });
}

// ENHANCED: Drawing with quality indicators
function drawLivePoint(point){
  if(!currentPolyline){
    currentPolyline = L.polyline([], {
      color: activityColor[point.filtered?.activity || point.activity] || '#1f77b4',
      weight: STYLE.liveTrackWeight,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map);
  }
  
  const ll = getLatLonFromPoint(point);
  if (!ll) {
    console.warn('[drawLivePoint] Invalid point, skipping', point);
    return;
  }
  
  currentPolyline.addLatLng([ll.lat, ll.lon]);
  
  const quality = point.quality?.score || 100;
  let color = '#3b82f6';
  if (quality < 60) {
    color = '#f59e0b';
  }  
  if (quality < 30) {
    color = '#ef4444';
  }
  
  liveMarker.setLatLng([ll.lat, ll.lon]);
  liveMarker.setStyle({
    fillColor: color,
    color: color
  });
  
  const flags = point.quality?.flags || [];
  const popupText = `Quality: ${quality}%<br>
Flags: ${flags.length > 0 ? flags.join(', ') : 'none'}<br>
Lat: ${ll.lat.toFixed(6)}<br>
Lon: ${ll.lon.toFixed(6)}`;
  liveMarker.bindPopup(popupText);
}

// ---------------------------------------------------------------------
//  TRACK LIST UI
// ---------------------------------------------------------------------
function addTrackListItem(tid, color, count){
  if(document.getElementById('item_'+tid)) return;
  const list = document.getElementById('trackList');
  const div = document.createElement('div');
  div.className = 'track-item';
  div.id = 'item_'+tid;
  div.innerHTML = `
    <div class="track-meta">
      <span class="track-color" style="background:${color}"></span>
      <div>
        <div style="font-size:0.85rem;font-weight:600">${tid}</div>
        <div style="font-size:0.75rem;color:#64748b">${count} pts</div>
      </div>
    </div>
    <div style="display:flex;gap:4px;align-items:center">
      <button class="small" onclick="playTrack('${tid}')" title="Play">▶</button>
      <button class="small" onclick="exportTrackCSV('${tid}')" title="CSV">CSV</button>
      <button class="small" onclick="exportTrackGPX('${tid}')" title="GPX">GPX</button>
      <button class="small" onclick="toggleVisibility('${tid}')" title="Toggle">👁</button>
      <button class="small" onclick="deleteTrack('${tid}')" title="Delete">🗑</button>
    </div>`;
  list.prepend(div);
}

function refreshTrackList(){
  const list = document.getElementById('trackList');
  list.innerHTML = '';
  let i=0;
  for(const tid of Object.keys(allTracks).sort().reverse()){
    const cnt   = allTracks[tid].length;
    const color = palette[i % palette.length]; i++;
    addTrackListItem(tid, color, cnt);
  }
}

// ---------------------------------------------------------------------
//  VISIBILITY TOGGLES
// ---------------------------------------------------------------------
function toggleVisibility(tid){
  visibility[tid] = !visibility[tid];
  if(polylineMap[tid]){
    if(visibility[tid]) polylineMap[tid].addTo(map);
    else map.removeLayer(polylineMap[tid]);
  }
  if(segmentMap[tid]){
    segmentMap[tid].forEach(s=>{
      if(visibility[tid]) s.addTo(map); else map.removeLayer(s);
    });
  }
}
window.toggleVisibility = toggleVisibility;

// ---------------------------------------------------------------------
//  EXPORT / DELETE
// ---------------------------------------------------------------------
async function exportTrackCSV(tid){
  const pts = allTracks[tid];
  if(!pts) return alert('No points for this track.');
  let csv = 'timestamp,raw_lat,raw_lon,filtered_lat,filtered_lon,raw_altitude,filtered_altitude,raw_speed_ms,filtered_speed_kmh,accuracy,heading,activity,quality_score,quality_flags,scenario,online,pageVisible,gapFromPrevSec\n';
  pts.forEach(p => {
    const flags = p.quality?.flags?.join(';') || '';
    csv += [
      new Date(p.ts).toISOString(),
      p.raw?.lat ?? p.lat,
      p.raw?.lon ?? p.lon,
      p.filtered?.lat ?? p.lat,
      p.filtered?.lon ?? p.lon,
      p.raw?.altitude ?? p.altitude,
      p.filtered?.altitude ?? p.altitude,
      p.raw?.speed ?? '',
      p.filtered?.speed ?? p.speed,
      p.raw?.accuracy ?? p.accuracy,
      p.raw?.heading ?? p.heading,
      p.filtered?.activity ?? p.activity,
      p.quality?.score ?? '',
      flags,
      p.scenario ?? '',
      p.online ?? '',
      p.pageVisible ?? '',
      p.gapFromPrevSec ?? ''
    ].join(',') + '\n';
  });
  const blob = new Blob([csv], { type:'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${tid}_enhanced.csv`;
  a.click();
}
async function exportTrackGPX(tid){
  const pts = allTracks[tid];
  if(!pts) return alert('No points for this track.');
  const geojson = {
    type:'FeatureCollection',
    features: pts.map(p=>({
      type:'Feature',
      geometry:{ type:'Point', coordinates:[p.filtered?.lon || p.lon, p.filtered?.lat || p.lat] },
      properties:{ 
        ts:p.ts, 
        speed:p.filtered?.speed || p.speed, 
        activity:p.filtered?.activity || p.activity,
        quality_score: p.quality?.score,
        quality_flags: p.quality?.flags?.join(';')
      }
    }))
  };
  const gpx = togpx(geojson, { creator:'BTMLiveTracker_Enhanced' });
  const blob = new Blob([gpx], { type:'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${tid}.gpx`;
  a.click();
}
async function deleteTrack(tid){
  if(!confirm('Delete '+tid+'?')) return;
  await db.removeItem(tid);
  if(polylineMap[tid]){ map.removeLayer(polylineMap[tid]); delete polylineMap[tid]; }
  if(segmentMap[tid]){ segmentMap[tid].forEach(s=>map.removeLayer(s)); delete segmentMap[tid]; }
  delete allTracks[tid];
  const el = document.getElementById('item_'+tid);
  if(el) el.remove();
  updateActivitySummary();
}
window.exportTrackCSV = exportTrackCSV;
window.exportTrackGPX = exportTrackGPX;
window.deleteTrack    = deleteTrack;

// ---------------------------------------------------------------------
//  ENHANCED INVESTIGATION BUNDLE (ZIP)
// ---------------------------------------------------------------------
function buildInvestigationBundle(){
  if (Object.keys(allTracks).length === 0){
    alert('No tracks to export.');
    return;
  }

  const zip = new JSZip();

  let csv = 'track,timestamp,raw_lat,raw_lon,filtered_lat,filtered_lon,';
  csv += 'raw_altitude,filtered_altitude,raw_speed_ms,filtered_speed_kmh,';
  csv += 'accuracy,heading,activity,quality_score,quality_flags,';
  csv += 'scenario,online,pageVisible,gapFromPrevSec\n';
  
  for (const tid of Object.keys(allTracks)){
    (allTracks[tid] || []).forEach(p => {
      const flags = p.quality?.flags?.join(';') || '';
      csv += [
        tid,
        new Date(p.ts).toISOString(),
        p.raw?.lat ?? p.lat,
        p.raw?.lon ?? p.lon,
        p.filtered?.lat ?? p.lat,
        p.filtered?.lon ?? p.lon,
        p.raw?.altitude ?? p.altitude,
        p.filtered?.altitude ?? p.altitude,
        p.raw?.speed ?? '',
        p.filtered?.speed ?? p.speed,
        p.raw?.accuracy ?? p.accuracy,
        p.raw?.heading ?? p.heading,
        p.filtered?.activity ?? p.activity,
        p.quality?.score ?? '',
        flags,
        p.scenario ?? '',
        p.online ?? '',
        p.pageVisible ?? '',
        p.gapFromPrevSec ?? ''
      ].join(',') + '\n';
    });
  }
  zip.file('tracks_enhanced.csv', csv);

  const stats = {};
  for (const tid of Object.keys(allTracks)){
    const pts = allTracks[tid];
    if (!pts || pts.length < 2) continue;

    const startTs = pts[0].ts;
    const endTs   = pts[pts.length-1].ts;
    const durationSec = (endTs - startTs) / 1000;

    let distM = 0;
    const activityTime = {};
    const qualityStats = { excellent:0, good:0, medium:0, poor:0 };
    
    for (let i=1;i<pts.length;i++){
      distM += haversine(
        {lat: pts[i-1].filtered?.lat || pts[i-1].lat, lon: pts[i-1].filtered?.lon || pts[i-1].lon},
        {lat: pts[i].filtered?.lat || pts[i].lat, lon: pts[i].filtered?.lon || pts[i].lon}
      );
      const act = pts[i-1].filtered?.activity || pts[i-1].activity || 'unknown';
      const dt  = (pts[i].ts - pts[i-1].ts) / 1000;
      activityTime[act] = (activityTime[act] || 0) + dt;
      
      const quality = pts[i].quality?.score || 100;
      if (quality >= 80) qualityStats.excellent++;
      else if (quality >= 60) qualityStats.good++;
      else if (quality >= 40) qualityStats.medium++;
      else qualityStats.poor++;
    }

    stats[tid] = {
      start_time_iso : new Date(startTs).toISOString(),
      end_time_iso   : new Date(endTs).toISOString(),
      duration_sec   : durationSec,
      distance_m     : distM,
      distance_km    : distM / 1000,
      activity_time_sec: activityTime,
      quality_stats: qualityStats,
      total_points: pts.length
    };
  }
  zip.file('track_stats_enhanced.json', JSON.stringify(stats, null, 2));

  const gf = geofences.map(g => ({
    lat: g.lat, lon: g.lon, radius_m: g.radius
  }));
  zip.file('geofences.json', JSON.stringify(gf, null, 2));

  zip.file('events.json', JSON.stringify(eventLog, null, 2));

  const qualitySummary = {
    total_tracks: Object.keys(allTracks).length,
    total_points: Object.values(allTracks).reduce((sum, pts) => sum + pts.length, 0),
    generated_at: new Date().toISOString(),
    version: 'BTM Tracker Enhanced v2.0'
  };
  zip.file('quality_summary.json', JSON.stringify(qualitySummary, null, 2));

  zip.generateAsync({type:'blob'}).then(blob=>{
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url;
    a.download = 'btm_forensic_bundle.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

// ---------------------------------------------------------------------
//  CASE FILE TEXT SUMMARY
// ---------------------------------------------------------------------
function buildCaseSummary(){
  const tids = Object.keys(allTracks);
  if (tids.length === 0){
    alert('No tracks recorded yet.');
    return;
  }
  const tid = tids.sort().slice(-1)[0];
  const pts = allTracks[tid];
  if (!pts || pts.length < 2){
    alert('Track too short for summary.');
    return;
  }

  const start = new Date(pts[0].ts);
  const end   = new Date(pts[pts.length-1].ts);
  const durationMin = (pts[pts.length-1].ts - pts[0].ts) / 60000;

  let distM = 0;
  const actTime = {};
  const qualityStats = { excellent:0, good:0, medium:0, poor:0 };
  
  for (let i=1;i<pts.length;i++){
    distM += haversine(
      {lat: pts[i-1].filtered?.lat || pts[i-1].lat, lon: pts[i-1].filtered?.lon || pts[i-1].lon},
      {lat: pts[i].filtered?.lat || pts[i].lat, lon: pts[i].filtered?.lon || pts[i].lon}
    );
    const act = pts[i-1].filtered?.activity || pts[i-1].activity || 'unknown';
    const dt  = (pts[i].ts - pts[i-1].ts) / 1000;
    actTime[act] = (actTime[act] || 0) + dt;
    
    const quality = pts[i].quality?.score || 100;
    if (quality >= 80) qualityStats.excellent++;
    else if (quality >= 60) qualityStats.good++;
    else if (quality >= 40) qualityStats.medium++;
    else qualityStats.poor++;
  }
  const distKm = distM / 1000;

  const totalSec = Object.values(actTime).reduce((a,b)=>a+b,0) || 1;
  const pct = actTimeKey => ((actTime[actTimeKey] || 0) / totalSec * 100).toFixed(1);

  const numEvents = eventLog.length;
  const firstEvent = eventLog[0];
  const lastEvent  = eventLog[eventLog.length-1];

  const totalPoints = pts.length;
  const qualityPct = cat => ((qualityStats[cat] / totalPoints) * 100).toFixed(1);

  let summary = '';
  summary += `=== FORENSIC TRACK ANALYSIS ===\n\n`;
  summary += `Track ID : ${tid}\n`;
  summary += `Start time : ${start.toLocaleString()}\n`;
  summary += `End time   : ${end.toLocaleString()}\n`;
  summary += `Duration   : ${durationMin.toFixed(1)} minutes\n`;
  summary += `Distance   : ${distKm.toFixed(3)} km\n`;
  summary += `Total points: ${totalPoints}\n\n`;

  summary += `Data Quality Breakdown:\n`;
  summary += `  Excellent (80-100%): ${qualityPct('excellent')}%\n`;
  summary += `  Good (60-79%): ${qualityPct('good')}%\n`;
  summary += `  Medium (40-59%): ${qualityPct('medium')}%\n`;
  summary += `  Poor (0-39%): ${qualityPct('poor')}%\n\n`;

  summary += `Activity breakdown (by time):\n`;
  summary += `  Stationary: ${pct('stationary')}%\n`;
  summary += `  Walking   : ${pct('walking')}%\n`;
  summary += `  Running   : ${pct('running')}%\n`;
  summary += `  Cycling   : ${pct('cycling')}%\n`;
  summary += `  Driving   : ${pct('driving')}%\n\n`;

  if (numEvents === 0){
    summary += `No anomaly or geofence alerts were triggered.\n`;
  } else {
    summary += `${numEvents} alerts were triggered (sudden speed, sharp turns, route deviation and/or geofence).\n`;
    summary += `First alert: ${firstEvent.localTime} – ${firstEvent.message}\n`;
    summary += `Last alert : ${lastEvent.localTime} – ${lastEvent.message}\n`;
  }

  summary += `\n=== DATA COLLECTION METADATA ===\n`;
  summary += `Collection mode: Layered storage (raw + filtered)\n`;
  summary += `Quality scoring: Enabled\n`;
  summary += `Spike detection: Enabled\n`;
  summary += `Generated: ${new Date().toLocaleString()}\n`;

  const blob = new Blob([summary], {type:'text/plain'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `forensic_summary_${tid}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------
//  GEOFENCES
// ---------------------------------------------------------------------
function renderGeofenceUI(){
  const el = document.getElementById('geofenceList');
  el.innerHTML = geofences
    .map((g,i)=>`G${i+1}: ${g.lat.toFixed(4)}, ${g.lon.toFixed(4)} (r=${g.radius}m)`)
    .join('<br>');
}
function addGeofence(lat,lon,radius){
  const circle = L.circle([lat,lon], { radius, color:'#f59e0b', weight:1 }).addTo(map);
  geofences.push({ lat, lon, radius, leaflet:circle });
  renderGeofenceUI();
  db.setItem('__geofences__', geofences.map(g=>({lat:g.lat, lon:g.lon, radius:g.radius})));
}
function checkGeofencesForPoint(pt){
  geofences.forEach(g=>{
    const inside = haversine(pt, {lat:g.lat, lon:g.lon}) <= g.radius;
    if(!inside) showAlert('⚠️ Left geofence', [pt.lat, pt.lon], 'geofence');
  });
}

// ---------------------------------------------------------------------
//  ANOMALY DETECTION
// ---------------------------------------------------------------------
function detectAnomalies(point){
  if(prevPoint){
    const ds = (point.filtered?.speed || point.speed || 0) - (prevPoint.filtered?.speed || prevPoint.speed || 0);
    if(ds > 20){
      showAlert(
        '⚠️ Sudden speed increase +' + ds.toFixed(1) + ' km/h',
        [point.filtered?.lat || point.lat, point.filtered?.lon || point.lon],
        'deviation'
      );
    }

    if(prevPoint._bearing !== undefined){
      const bPrev = prevPoint._bearing;
      const bCur  = bearing(prevPoint, point);
      const diff  = Math.abs(((bCur - bPrev + 540) % 360) - 180);
      if(diff > 90){
        showAlert(
          '⚠️ Sharp turn detected',
          [point.filtered?.lat || point.lat, point.filtered?.lon || point.lon],
          'sharp_turn'
        );
      }
    }
    point._bearing = bearing(prevPoint, point);

    for(const histId of Object.keys(allTracks)){
      const hist = allTracks[histId];
      if(!hist || hist.length < 10) continue;
      let minD = Infinity;
      for(let i=0;i<hist.length;i+=Math.max(1, Math.floor(hist.length/60))){
        const d = haversine(point, hist[i]);
        if(d < minD) minD = d;
        if(minD < 50) break;
      }
      if(minD > 150){
        showAlert(
          '⚠️ Route deviation detected',
          [point.filtered?.lat || point.lat, point.filtered?.lon || point.lon],
          'deviation'
        );
        break;
      }
    }
  }
  prevPoint = point;
}

// ---------------------------------------------------------------------
//  AI PREDICTOR (TF.JS)
// ---------------------------------------------------------------------
async function trainPredictor(){
  const X = [], Y = [];
  for(const tid of Object.keys(allTracks)){
    const pts = allTracks[tid];
    if(!pts || pts.length < 10) continue;
    for(let i=3;i<pts.length;i++){
      const prev3 = pts.slice(i-3,i);
      const input = [];
      prev3.forEach(p => { 
        const ll = getLatLonFromPoint(p) || {lat:0, lon:0};
        input.push(
          ll.lat, 
          ll.lon, 
          p.filtered?.speed || p.speed || 0
        ); 
      });
      X.push(input);
      const cur = getLatLonFromPoint(pts[i]) || {lat:0, lon:0};
      Y.push([cur.lat, cur.lon]);
    }
  }
  if(X.length < 50){
    alert('Not enough data to train predictor (need about 50 windows).');
    return;
  }

  const xs = tf.tensor2d(X);
  const ys = tf.tensor2d(Y);

  const model = tf.sequential();
  model.add(tf.layers.dense({ inputShape:[X[0].length], units:64, activation:'relu' }));
  model.add(tf.layers.dense({ units:32, activation:'relu' }));
  model.add(tf.layers.dense({ units:2 }));
  model.compile({ optimizer:'adam', loss:'meanSquaredError' });

  showAlert('Training predictor (few seconds)...');
  await model.fit(xs, ys, { epochs:25, batchSize:64 });
  xs.dispose(); ys.dispose();

  predictorModel = model;
  predictorReady = true;
  showAlert('Predictor trained — enabled');
}

async function predictNext(ptSequence){
  if(!predictorReady || !predictorModel) return null;
  if(ptSequence.length < 3) return null;
  const input = [];
  ptSequence.slice(-3).forEach(p => { 
    const ll = getLatLonFromPoint(p) || {lat:0, lon:0};
    input.push(
      ll.lat, 
      ll.lon, 
      p.filtered?.speed || p.speed || 0
    ); 
  });
  const t = tf.tensor2d([input]);
  const pred = predictorModel.predict(t);
  const arr  = await pred.array();
  t.dispose(); pred.dispose();
  return { lat: arr[0][0], lon: arr[0][1] };
}

// ---------------------------------------------------------------------
//  ENHANCED SIMPLE-MODE FORMATTER
// ---------------------------------------------------------------------
function formatPos(pos){
  const c = pos.coords;
  const quality = calculateQualityScore(c);
  const qualityClass = quality.score >= 60 ? 'quality-good' : 
                       quality.score >= 30 ? 'quality-medium' : 'quality-poor';
  
  return `Lat: ${c.latitude.toFixed(6)}
Lng: ${c.longitude.toFixed(6)}
Accuracy: ${c.accuracy} m
Altitude: ${c.altitude === null ? 'n/a' : c.altitude + ' m'}
Quality: <span class="quality-indicator ${qualityClass}"></span>${quality.score}%
Flags: ${quality.flags.length > 0 ? quality.flags.join(', ') : 'none'}
Timestamp: ${new Date(pos.timestamp).toLocaleString()}`;
}

// ---------------------------------------------------------------------
//  ENHANCED MAIN GEO CALLBACK
// ---------------------------------------------------------------------
const latestEl   = document.getElementById('latest');
const exportBtn  = document.getElementById('exportBtn');
const copyBtn    = document.getElementById('copyBtn');

async function onPosition(pos){
  const c = pos.coords;

  const speedKmh     = safeSpeedKmhFromFix(c);
  const rawActivity  = classifyActivityFromSpeed(speedKmh);
  const activity     = smoothActivity(rawActivity);

  let gapFromPrevSec = null;
  if (lastFixTsForGap !== null) {
    gapFromPrevSec = (pos.timestamp - lastFixTsForGap) / 1000;
    if (gapFromPrevSec > GAP_THRESHOLD_SEC) {
      const msg = `⚠️ GPS gap of ${gapFromPrevSec.toFixed(1)} s`;
      showAlert(msg, [c.latitude, c.longitude], 'gps_gap');
      eventLog.push({
        ts: Date.now(),
        localTime: new Date().toLocaleString(),
        message: msg,
        lat: c.latitude,
        lon: c.longitude,
        gapSec: gapFromPrevSec,
        kind: 'gps_gap'
      });
    }
  }
  lastFixTsForGap = pos.timestamp;

  // ----------------- BATTERY-AWARE SKIPPING -----------------
  if (powerMode === 'battery' && lastSavedPoint) {
    const nowTs = pos.timestamp;
    const dtSec = (nowTs - lastSavedPoint.raw.timestamp) / 1000;

    const moveDist = haversine(
      { lat: lastSavedPoint.raw.lat, lon: lastSavedPoint.raw.lon },
      { lat: c.latitude,            lon: c.longitude }
    );

    // Tiny movement + short time: update UI only, skip heavy work
    if (dtSec < MIN_TIME_FOR_SAVE_SEC && moveDist < MIN_MOVE_FOR_SAVE_METERS) {
      latestEl.innerHTML = formatPos(pos);
      exportBtn.disabled = false;
      copyBtn.disabled   = false;
      return;
    }
  }

  const rec = {
    timestamp: new Date(pos.timestamp).toISOString(),
    latitude : c.latitude,
    longitude: c.longitude,
    accuracy : c.accuracy,
    altitude : c.altitude === null ? '' : c.altitude,
    heading  : c.heading  === null ? '' : c.heading,
    speed    : speedKmh / 3.6,
    scenario : currentScenario,
    online   : navigator.onLine,
    pageVisible: document.visibilityState,
    gapFromPrevSec
  };
  sessionRecords.push(rec);

  latestEl.innerHTML = formatPos(pos);
  exportBtn.disabled = false;
  copyBtn.disabled   = false;

  const qualityAnalysis = calculateQualityScore(c);
  const qualityInput = { ...c, timestamp: pos.timestamp };
  const qualityFlags = detectQualityFlags(qualityInput, prevPoint);
  const confidence = calculateConfidence(c, qualityAnalysis.score, qualityFlags);
  
  const pt = {
    raw: {
      lat: c.latitude,
      lon: c.longitude,
      altitude: c.altitude,
      accuracy: c.accuracy,
      heading: c.heading,
      speed: c.speed,
      timestamp: pos.timestamp
    },
    quality: {
      score: qualityAnalysis.score,
      flags: qualityFlags,
      confidence: confidence,
      suggested_action: confidence > 0.7 ? 'keep' : 'review'
    },
    filtered: {
      lat: c.latitude,
      lon: c.longitude, 
      altitude: filterAltitude(c.altitude, prevPoint),
      speed: speedKmh,
      activity: activity,
      is_quality_point: confidence > 0.5
    },
    ts: Date.now(),
    scenario: currentScenario,
    online: navigator.onLine,
    pageVisible: document.visibilityState,
    gapFromPrevSec: gapFromPrevSec
  };

  // Track last saved point (for battery-aware skipping)
  lastSavedPoint = pt;

  if(currentTrackId){
    await savePoint(currentTrackId, pt);
  }

  drawLivePoint(pt);
  const ll = getLatLonFromPoint(pt);
  if (ll && followLive) {
    map.setView([ll.lat, ll.lon], 16);
  }

  // ------------- THROTTLED CHART UPDATES -------------
  const nowMs = Date.now();
  let chartInterval = CHART_UPDATE_INTERVAL_MS_BALANCED;
  if (powerMode === 'high')    chartInterval = CHART_UPDATE_INTERVAL_MS_HIGH;
  if (powerMode === 'battery') chartInterval = CHART_UPDATE_INTERVAL_MS_BATTERY;

  if (nowMs - lastChartUpdateTs >= chartInterval) {
    pushToCharts(pt);
    lastChartUpdateTs = nowMs;
  }

  detectAnomalies(pt);
  checkGeofencesForPoint(pt);
  
  prevPoint = pt;
}

function onError(err){
  latestEl.textContent = `Error (${err.code}): ${err.message}`;
}

// ---------------------------------------------------------------------
//  START / STOP
// ---------------------------------------------------------------------
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');

async function startRecording(){
  if(recording) return;
  if(!('geolocation' in navigator)){
    alert('Geolocation not supported in this browser.');
    return;
  }

  const scenarioEl = document.getElementById('scenarioSelect');
  currentScenario = scenarioEl ? (scenarioEl.value || 'UNKNOWN') : 'UNKNOWN';

  lastFixTsForGap = null;

  recording = true;
  sessionRecords = [];
  currentTrackId   = uuid();
  currentPolyline  = null;
  prevPoint        = null;
  lastSavedPoint   = null;
  lastChartUpdateTs = 0;

  await db.setItem(currentTrackId, []);
  allTracks[currentTrackId] = [];
  addTrackListItem(currentTrackId,
    palette[Object.keys(allTracks).length % palette.length], 0);

  startBtn.disabled = true;
  stopBtn.disabled  = false;
  latestEl.textContent = 'Waiting for location... (grant permission if asked)';

  const geoOptions = getGeoOptions();
  watchId = navigator.geolocation.watchPosition(onPosition, onError, geoOptions);
}

async function stopRecording(){
  if(!recording) return;
  recording = false;
  if(watchId !== null){
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  startBtn.disabled = false;
  stopBtn.disabled  = true;
  latestEl.textContent += '\n\nTracking stopped.';

  await loadAllTracks();
  showAlert('Recording stopped');
}

// ---------------------------------------------------------------------
//  SIMPLE EXPORT / COPY FOR CURRENT SESSION
// ---------------------------------------------------------------------
document.getElementById('exportBtn').addEventListener('click', () => {
  if(sessionRecords.length === 0) return alert('No records to export.');
  const header = ['timestamp','latitude','longitude','accuracy','altitude','heading','speed'];
  const rows = [header.join(',')].concat(
    sessionRecords.map(r =>
      header.map(h => JSON.stringify(r[h] ?? '')).join(',')
    )
  );
  const blob = new Blob([rows.join('\n')], { type:'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `positions_${new Date().toISOString().replace(/[:.]/g,'-')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('copyBtn').addEventListener('click', async () => {
  if(sessionRecords.length === 0) return;
  const last = sessionRecords[sessionRecords.length-1];
  const text = `${last.latitude},${last.longitude} (accuracy ${last.accuracy} m)`;
  try{
    await navigator.clipboard.writeText(text);
    alert('Latest coords copied to clipboard:\n' + text);
  }catch(e){
    alert('Could not copy to clipboard. Here are the coords:\n' + text);
  }
});

// ---------------------------------------------------------------------
//  OTHER UI WIRING
// ---------------------------------------------------------------------
document.getElementById('addGeofence').addEventListener('click', ()=>{
  const lat = parseFloat(document.getElementById('gfLat').value);
  const lon = parseFloat(document.getElementById('gfLon').value);
  const rad = parseFloat(document.getElementById('gfRad').value);
  if(Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(rad)){
    addGeofence(lat, lon, rad);
  } else alert('Enter valid lat/lon/radius');
});
document.getElementById('showAll').addEventListener('click', ()=>{
  Object.values(polylineMap).forEach(p => p.addTo(map));
  Object.values(segmentMap).forEach(arr => arr.forEach(s => s.addTo(map)));
});
document.getElementById('hideAll').addEventListener('click', ()=>{
  Object.values(polylineMap).forEach(p => map.removeLayer(p));
  Object.values(segmentMap).forEach(arr => arr.forEach(s => map.removeLayer(s)));
});
document.getElementById('exportAll').addEventListener('click', async ()=>{
  let csv = 'track,timestamp,raw_lat,raw_lon,filtered_lat,filtered_lon,raw_altitude,filtered_altitude,raw_speed_ms,filtered_speed_kmh,accuracy,heading,activity,quality_score,quality_flags,scenario,online,pageVisible,gapFromPrevSec\n';
  for(const tid of Object.keys(allTracks)){
    (allTracks[tid]||[]).forEach(p=>{
      const flags = p.quality?.flags?.join(';') || '';
      csv += [
        tid,
        new Date(p.ts).toISOString(),
        p.raw?.lat ?? p.lat,
        p.raw?.lon ?? p.lon,
        p.filtered?.lat ?? p.lat,
        p.filtered?.lon ?? p.lon,
        p.raw?.altitude ?? p.altitude,
        p.filtered?.altitude ?? p.altitude,
        p.raw?.speed ?? '',
        p.filtered?.speed ?? p.speed,
        p.raw?.accuracy ?? p.accuracy,
        p.raw?.heading ?? p.heading,
        p.filtered?.activity ?? p.activity,
        p.quality?.score ?? '',
        flags,
        p.scenario ?? '',
        p.online ?? '',
        p.pageVisible ?? '',
        p.gapFromPrevSec ?? ''
      ].join(',') + '\n';
    });
  }
  const blob = new Blob([csv], { type:'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'all_tracks_enhanced.csv';
  a.click();
});
document.getElementById('clearAll').addEventListener('click', async ()=>{
  if(!confirm('Delete ALL tracks & geofences?')) return;
  await db.clear();
  allTracks = {};
  clearAllPolylines();
  document.getElementById('trackList').innerHTML = '';
  geofences.forEach(g => map.removeLayer(g.leaflet));
  geofences = [];
  renderGeofenceUI();
  updateActivitySummary();
  showAlert('All cleared');
});
document.getElementById('collapseBtn').addEventListener('click', ()=>{
  document.getElementById('sidebar').classList.toggle('collapsed');
  setTimeout(()=>map.invalidateSize(), 280);
});

// NEW: power mode selector wiring + visibilitychange handling
const powerModeSelect = document.getElementById('powerModeSelect');
if (powerModeSelect) {
  powerModeSelect.addEventListener('change', (e) => {
    powerMode = e.target.value || 'balanced';
    showAlert(`Power mode: ${powerMode}`, null, 'generic');
    updateBatteryBanner();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (powerMode === 'high') {
      powerMode = 'balanced';
      if (powerModeSelect) powerModeSelect.value = powerMode;
      updateBatteryBanner();
    }
  }
});

// NEW: follow-live button wiring
const followBtn = document.getElementById('followBtn');
if (followBtn) {
  followBtn.addEventListener('click', () => {
    followLive = !followLive;
    followBtn.textContent = followLive ? '🔒 Follow ON' : '🔓 Follow OFF';
  });
}

// UPDATED: guard AI training in battery mode
document.getElementById('trainAI').addEventListener('click', () => {
  if (powerMode === 'battery') {
    if (!confirm('Battery saver is ON. Training the predictor uses more CPU and battery. Continue?')) {
      return;
    }
  }
  trainPredictor();
});

document.getElementById('simulate').addEventListener('click', ()=>simulateTrack());
document.getElementById('bundleBtn').addEventListener('click', buildInvestigationBundle);
document.getElementById('summaryBtn').addEventListener('click', buildCaseSummary);

startBtn.addEventListener('click', startRecording);
stopBtn .addEventListener('click', stopRecording);

// ---------------------------------------------------------------------
//  PLAYBACK & SIMULATOR
// ---------------------------------------------------------------------
window.playTrack = function(tid){
  const pts = allTracks[tid];
  if(!pts || !pts.length) return alert('No points');
  const first = getLatLonFromPoint(pts[0]);
  if (first) {
    map.setView([first.lat, first.lon], 16);
  }

  let i=0;
  const marker = L.circleMarker(first ? [first.lat, first.lon] : [0,0], {
    radius:5, color:'#111827', weight:1, fillColor:'#111827', fillOpacity:1
  }).addTo(map);
  const poly   = L.polyline([], {color:'#000', weight:10}).addTo(map);
  const iv = setInterval(()=>{
    if(i >= pts.length){ clearInterval(iv); return; }
    const ll = getLatLonFromPoint(pts[i]);
    if (ll) {
      poly.addLatLng([ll.lat, ll.lon]);
      marker.setLatLng([ll.lat, ll.lon]);
      pushToCharts(pts[i]);
    }
    i++;
  }, 350);
};

// UPDATED SIMULATOR: safer test data + debug + uses drawFullTrack centering
window.simulateTrack = async function(centerLat=-29.1, centerLon=26.2, n=50){
  const tid = 'sim_'+Date.now();
  const pts = [];
  
  console.log(`[simulateTrack] Creating simulated track ${tid} at`, centerLat, centerLon);
  
  const baseTs = Date.now();
  for(let i=0;i<n;i++){
    const angle = (i/n)*Math.PI*2;
    const lat = centerLat + Math.sin(angle)*0.01;
    const lon = centerLon + Math.cos(angle)*0.01;
    const speed = 5 + 5*Math.abs(Math.sin(angle));
    
    const ts = baseTs + i*2000;
    const p = { 
      raw: { 
        lat: lat, 
        lon: lon, 
        altitude: 100 + Math.sin(angle)*20, 
        accuracy: 5, 
        heading: (angle * 180/Math.PI) % 360, 
        speed: speed/3.6, 
        timestamp: ts 
      },
      quality: { 
        score: 85, 
        flags: [], 
        confidence: 0.85, 
        suggested_action: 'keep' 
      },
      filtered: { 
        lat: lat, 
        lon: lon, 
        altitude: 100 + Math.sin(angle)*20, 
        speed: speed, 
        activity: classifyActivity(speed), 
        is_quality_point: true 
      },
      ts: ts
    };
    pts.push(p);
  }
  
  // Save in DB + memory
  await db.setItem(tid, pts);
  allTracks[tid] = pts;
  
  console.log(`[simulateTrack] Simulated track ${tid} stored with ${pts.length} points`);
  
  // Remove old polylines, then draw this track
  clearAllPolylines();
  const color = palette[Object.keys(allTracks).length % palette.length];

  console.log('[simulateTrack] Calling drawFullTrack for', tid);
  drawFullTrack(tid, color);
  addTrackListItem(tid, color, pts.length);
  updateActivitySummary();
  
  // 🔴 EXTRA: big red debug dots on every simulated point
  pts.forEach(p => {
    const lat = (p.filtered && typeof p.filtered.lat === 'number') ? p.filtered.lat
              : (typeof p.lat === 'number' ? p.lat
              : (p.raw && typeof p.raw.lat === 'number' ? p.raw.lat : null));
    const lon = (p.filtered && typeof p.filtered.lon === 'number') ? p.filtered.lon
              : (typeof p.lon === 'number' ? p.lon
              : (p.raw && typeof p.raw.lon === 'number' ? p.raw.lon : null));

    if (lat === null || lon === null || isNaN(lat) || isNaN(lon)) {
      console.warn('[simulateTrack] Skipping invalid debug point', p);
      return;
    }

    L.circleMarker([lat, lon], {
      radius: 8,
      color: '#ff0000',
      weight: 3,
      fillColor: '#ff0000',
      fillOpacity: 0.9
    }).addTo(map);
  });

  // 🔍 EXTRA: hard center + zoom on first point
  const first = pts[0];
  if (first) {
    const lat = (first.filtered && typeof first.filtered.lat === 'number') ? first.filtered.lat
              : (typeof first.lat === 'number' ? first.lat
              : (first.raw && typeof first.raw.lat === 'number' ? first.raw.lat : null));
    const lon = (first.filtered && typeof first.filtered.lon === 'number') ? first.filtered.lon
              : (typeof first.lon === 'number' ? first.lon
              : (first.raw && typeof first.raw.lon === 'number' ? first.raw.lon : null));

    if (lat !== null && lon !== null && !isNaN(lat) && !isNaN(lon)) {
      map.setView([lat, lon], 15);
      console.log('[simulateTrack] Hard setView to', lat, lon);
    } else {
      console.warn('[simulateTrack] Could not setView, invalid first point', first);
    }
  }

  showAlert('Enhanced simulated track added - check console for debug info');
  debugTrackData();
};

// ---------------------------------------------------------------------
//  STARTUP
// ---------------------------------------------------------------------
(async function startup(){
  initMap();
  initCharts();

  // Try Battery Status API (mostly Chrome/Android)
  if (navigator.getBattery && typeof navigator.getBattery === 'function') {
    try {
      const battery = await navigator.getBattery();
      batteryInfo.level    = battery.level;    // 0..1
      batteryInfo.charging = battery.charging; // true/false
      updateBatteryBanner();

      battery.addEventListener('levelchange', () => {
        batteryInfo.level = battery.level;
        updateBatteryBanner();
      });

      battery.addEventListener('chargingchange', () => {
        batteryInfo.charging = battery.charging;
        updateBatteryBanner();
      });
    } catch (e) {
      console.warn('Battery API error:', e);
      updateBatteryBanner();
    }
  } else {
    // No Battery API support: just show "unknown"
    updateBatteryBanner();
  }

  const savedGeos = await db.getItem('__geofences__');
  if(savedGeos && Array.isArray(savedGeos)){
    savedGeos.forEach(g => addGeofence(g.lat, g.radius ? g.radius : g.lat, g.radius));
  }
  await loadAllTracks();
  
  debugTrackData();
  
  setTimeout(()=>{
    map.invalidateSize();
    speedChart.update();
    activityChart.update();
  }, 400);

  if(/Mobi|Android/i.test(navigator.userAgent)){
    latestEl.textContent = 'Tap Start to allow location access and begin tracking.';
  }
})();
</script>

