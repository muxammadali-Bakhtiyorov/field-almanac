/* NASA data layers: fetchers + parsers.  Browser: window.Layers   Node: module.exports (for tests)
 *
 *  1. MERRA-2   (NASA GMAO)       temperature, rainfall, root-zone soil wetness      via NASA POWER API
 *  2. CERES SYN1deg               surface sunlight (solar radiation)                 via NASA POWER API
 *  3. GPM IMERG (Final/Late run)  satellite rainfall                                 via NASA POWER API
 *  4. MODIS Terra MOD13Q1         vegetation index (NDVI), 250 m, 16-day             via ORNL DAAC MODIS web service
 *  5. EONET                       live natural-hazard events (storms, fires, floods) via NASA EONET v3 API
 *
 * Every layer fails independently and is reported honestly in the UI. If a browser is blocked by CORS the
 * request is retried through the site's own /api/nasa proxy (web/api/nasa.js, host allow-listed).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Layers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const POWER = 'https://power.larc.nasa.gov/api/temporal/daily/point';
  const META = {
    merra2: { name: 'MERRA-2 reanalysis', agency: 'NASA GMAO · via NASA POWER', use: 'Temperature, frost, rainfall and root-zone soil wetness: the core of the planting model and season simulation' },
    ceres:  { name: 'CERES surface sunlight', agency: 'NASA CERES SYN1deg · via NASA POWER', use: 'Sunny vs cloudy seasons scale crop growth (radiation-use efficiency) in the yield simulation' },
    imerg:  { name: 'GPM IMERG rainfall', agency: 'NASA/JAXA GPM · via NASA POWER', use: 'Satellite-measured rain cross-checks the soil-moisture water supply for rain-fed crops' },
    ndvi:   { name: 'MODIS vegetation index (NDVI)', agency: 'NASA MODIS Terra MOD13Q1 · via ORNL DAAC', use: 'Satellite greenness: is vegetation stressed now, when does it peak, and does it track the simulated yields?' },
    eonet:  { name: 'EONET natural events', agency: 'NASA Earth Observatory', use: 'Live storm, wildfire, flood, drought and heat-wave alerts near your field' },
  };

  /* ------------------------------------------------------------------ network */
  async function fetchJSON(url, ms) {
    ms = ms || 30000;
    const once = async (u) => {
      const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
      try { const r = await fetch(u, { signal: c.signal, headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
      finally { clearTimeout(t); }
    };
    try { return await once(url); }
    catch (e) {
      if (typeof location === 'undefined' || !/^https?:/.test(location.protocol)) throw e;
      try { return await once('/api/nasa?u=' + encodeURIComponent(url)); }
      catch (e2) { throw new Error(e.message + ' (direct); ' + e2.message + ' (proxy)'); }
    }
  }
  const powerUrl = (lat, lon, params, y0, endYMD) => POWER + '?parameters=' + params + '&community=AG&longitude=' + lon + '&latitude=' + lat + '&start=' + y0 + '0101&end=' + endYMD + '&format=JSON';

  /* -------------------------------------------------- NASA POWER (MERRA-2, CERES, IMERG) */
  function parseImerg(j) {
    const p = j && j.properties && j.properties.parameter && j.properties.parameter.IMERG_PRECTOT;
    if (!p) throw new Error('response has no IMERG_PRECTOT series');
    return p;                                           // { 'YYYYMMDD': mm/day }
  }
  async function loadWeather(lat, lon, E) {
    const end = new Date(), y0 = end.getFullYear() - 20, endS = E.fmtYMD(end);
    const main = fetchJSON(powerUrl(lat, lon, 'T2M,T2M_MIN,T2M_MAX,PRECTOTCORR,GWETROOT,ALLSKY_SFC_SW_DWN', y0, endS), 60000);
    const im = fetchJSON(powerUrl(lat, lon, 'IMERG_PRECTOT', y0, endS), 60000).then(j => ({ ok: true, j }), e => ({ ok: false, e }));
    const data = E.parsePower(await main), layers = [];
    layers.push({ id: 'merra2', state: 'ok', detail: data.Y + ' complete years (' + data.years[0] + '–' + data.years[data.years.length - 1] + ')' });
    let rv = 0; for (const v of data.flat.RAD) if (isFinite(v)) rv++;
    const rcov = rv / data.flat.RAD.length;
    layers.push({ id: 'ceres', state: rcov > 0.5 ? 'ok' : 'failed', detail: rcov > 0.5 ? Math.round(rcov * 100) + '% of days' : 'no sunlight data returned' });
    const r = await im;
    if (r.ok) {
      try { const cov = E.attachImerg(data, parseImerg(r.j)); layers.push({ id: 'imerg', state: cov > 0.5 ? 'ok' : 'failed', detail: Math.round(cov * 100) + '% of days covered' }); }
      catch (e) { layers.push({ id: 'imerg', state: 'failed', detail: e.message }); }
    } else layers.push({ id: 'imerg', state: 'failed', detail: String((r.e && r.e.message) || r.e) });
    return { data, layers };
  }
  const demoLayers = () => ['merra2', 'ceres', 'imerg'].map(id => ({ id, state: 'demo', detail: 'offline demo climate (not NASA)' }));

  /* --------------------------------------------------------------- MODIS NDVI */
  const pad3 = (n) => String(n).padStart(3, '0');
  function ndviRequests(lat, lon, thisYear, todayDoy, nYears) {
    const reqs = [];
    for (let y = thisYear - (nYears - 1); y <= thisYear; y++) {
      const doys = []; for (let d = 1; d <= 353; d += 16) if (y < thisYear || d <= todayDoy - 8) doys.push(d);
      for (let i = 0; i < doys.length; i += 10) {
        const c = doys.slice(i, i + 10);
        reqs.push('https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset?latitude=' + lat + '&longitude=' + lon + '&band=250m_16_days_NDVI&startDate=A' + y + pad3(c[0]) + '&endDate=A' + y + pad3(c[c.length - 1]) + '&kmAboveBelow=1&kmLeftRight=1');
      }
    }
    return reqs;
  }
  function parseNdvi(j) {                               // -> [{y, doy, ndvi}]
    const out = [];
    for (const s of (j && j.subset) || []) {
      const d = s.modis_date || '', y = +d.slice(1, 5), doy = +d.slice(5, 8);
      const v = (s.data || []).filter(x => x > -2000 && x <= 10000);       // -3000 = fill value
      if (!y || !doy || !v.length) continue;
      out.push({ y, doy, ndvi: v.reduce((a, b) => a + b, 0) / v.length * 0.0001 });
    }
    return out;
  }
  function analyseNdvi(points, thisYear) {
    const by = {}; points.forEach(p => { (by[p.y] = by[p.y] || []).push(p); });
    const past = Object.keys(by).map(Number).filter(y => y < thisYear);
    const doys = [...new Set(points.map(p => p.doy))].sort((a, b) => a - b);
    const clim = doys.map(d => { const v = past.map(y => (by[y].find(p => p.doy === d) || {}).ndvi).filter(v => v != null); return { doy: d, mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN, n: v.length }; }).filter(c => c.n >= 2);
    const cur = (by[thisYear] || []).slice().sort((a, b) => a.doy - b.doy), last = cur[cur.length - 1];
    let latest = null;
    if (last) { const c = clim.find(x => x.doy === last.doy); if (c) latest = { doy: last.doy, ndvi: last.ndvi, clim: c.mean, rel: (last.ndvi - c.mean) / c.mean }; }
    const peaks = {}; past.forEach(y => { if (by[y].length >= 18) peaks[y] = Math.max(...by[y].map(p => p.ndvi)); });
    const pk = clim.length ? clim.reduce((a, b) => b.mean > a.mean ? b : a) : null;
    return { clim, cur, latest, peaks, peakDoy: pk && pk.doy, peakNdvi: pk && pk.mean };
  }
  async function loadNdvi(lat, lon, onProgress) {
    const now = new Date(), thisYear = now.getFullYear(), todayDoy = Math.round((now - new Date(thisYear, 0, 0)) / 864e5);
    const urls = ndviRequests(lat.toFixed(3), lon.toFixed(3), thisYear, todayDoy, 5), pts = []; let done = 0, fails = 0, lastErr = '';
    const queue = urls.slice();
    await Promise.all([0, 1, 2, 3].map(async () => {
      while (queue.length) { const u = queue.shift(); try { pts.push(...parseNdvi(await fetchJSON(u, 40000))); } catch (e) { fails++; lastErr = e.message; } done++; if (onProgress) onProgress(done, urls.length); }
    }));
    if (pts.length < 30) throw new Error('only ' + pts.length + ' satellite observations returned' + (lastErr ? ' (' + lastErr + ')' : ''));
    return Object.assign(analyseNdvi(pts, thisYear), { n: pts.length, failedRequests: fails });
  }
  function spearman(a, b) {
    const rank = (v) => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = Array(v.length); for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
    const ra = rank(a), rb = rank(b), n = a.length, ma = ra.reduce((x, y) => x + y) / n, mb = rb.reduce((x, y) => x + y) / n;
    let sab = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { sab += (ra[i] - ma) * (rb[i] - mb); sa += (ra[i] - ma) ** 2; sb += (rb[i] - mb) ** 2; }
    return sa && sb ? sab / Math.sqrt(sa * sb) : NaN;
  }
  /* do the simulated yields rise and fall with satellite-observed peak greenness in the same years? */
  function compareToSimulation(peaks, simRows) {
    const yrs = simRows.filter(r => peaks[r.year] != null).map(r => r.year);
    if (yrs.length < 4) return { n: yrs.length, rho: NaN };
    return { n: yrs.length, rho: spearman(yrs.map(y => peaks[y]), yrs.map(y => simRows.find(r => r.year === y).yieldFrac)) };
  }

  /* ------------------------------------------------------------------ EONET */
  const km = (la1, lo1, la2, lo2) => { const r = Math.PI / 180, a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(a)); };
  function parseEonet(j, lat, lon, maxKm) {
    maxKm = maxKm || 400; const out = [];
    for (const e of (j && j.events) || []) {
      const g = (e.geometry || [])[(e.geometry || []).length - 1]; if (!g) continue;
      let c = g.coordinates; if (g.type !== 'Point') { while (Array.isArray(c) && Array.isArray(c[0])) c = c[0]; }
      if (!Array.isArray(c) || c.length < 2) continue;
      const d = km(lat, lon, c[1], c[0]); if (d > maxKm) continue;
      const cat = (e.categories || [])[0] || {};
      out.push({ id: e.id, title: e.title, cat: cat.id || '', catTitle: cat.title || 'Event', date: (g.date || '').slice(0, 10), km: d, link: e.link });
    }
    return out.sort((a, b) => a.km - b.km);
  }
  async function loadHazards(lat, lon) {
    const s = 3, url = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=60&bbox=' + [lon - s, lat + s, lon + s, lat - s].map(v => v.toFixed(2)).join(',');
    const j = await fetchJSON(url, 30000);
    if (!j || !Array.isArray(j.events)) throw new Error('unexpected EONET response');
    return parseEonet(j, lat, lon, 400);
  }
  const HAZ_ADVICE = { wildfires: 'Fire and smoke risk — protect stored crop and avoid field burning', severeStorms: 'Storm or cyclone — delay sowing/spraying, check drainage', floods: 'Flooding — avoid low fields, delay planting', drought: 'Drought declared — plan irrigation or drought-tolerant crops', tempExtremes: 'Temperature extreme — heat or cold wave, protect seedlings', dustHaze: 'Dust/haze — lower sunlight and air quality', landslides: 'Landslide risk on slopes', volcanoes: 'Volcanic ash may affect crops and machinery' };

  /* ------------------------------------------------------------------ HTML */
  function layersCard(layers, esc) {
    const by = {}; layers.forEach(l => { by[l.id] = l; });
    const icon = { ok: '✅', failed: '⚠️', loading: '⏳', demo: '⚠️', skipped: '➖' };
    const rows = Object.keys(META).map(id => { const m = META[id], l = by[id] || { state: 'skipped', detail: 'used on the planting planner page' };
      return '<tr><td style="width:28px">' + (icon[l.state] || '') + '</td><td><b>' + esc(m.name) + '</b><br><span class="note">' + esc(m.agency) + '</span></td><td class="note">' + esc(m.use) + '</td><td class="note">' + esc(l.detail || (l.state === 'loading' ? 'loading…' : '')) + '</td></tr>'; }).join('');
    const ok = layers.filter(l => l.state === 'ok').length, tot = layers.length || 5;
    return '<div class="card"><h2>NASA data layers used · ' + ok + ' of ' + tot + ' loaded live</h2><table><tr><th></th><th>Dataset</th><th>What it does here</th><th>Status</th></tr>' + rows + '</table></div>';
  }
  function hazardsCard(events, esc) {
    if (!events.length) return '<div class="alert" style="border-left-color:var(--good)">🛰️ <b>NASA EONET:</b> no tracked storms, fires, floods or extremes within 400 km in the last 60 days.</div>';
    return '<div class="alert err"><b>⚠️ Hazard watch (NASA EONET, within 400 km)</b><ul style="margin:6px 0 0;padding-left:20px">' + events.slice(0, 5).map(e => '<li><b>' + esc(e.title) + '</b> · ' + esc(e.catTitle) + ' · ' + Math.round(e.km) + ' km away · seen ' + esc(e.date) + (HAZ_ADVICE[e.cat] ? '<br><span class="note">' + esc(HAZ_ADVICE[e.cat]) + '</span>' : '') + '</li>').join('') + '</ul></div>';
  }
  return { META, fetchJSON, powerUrl, loadWeather, demoLayers, parseImerg, parseNdvi, analyseNdvi, ndviRequests, loadNdvi, spearman, compareToSimulation, parseEonet, loadHazards, layersCard, hazardsCard };
});
