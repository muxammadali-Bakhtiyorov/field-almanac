/* Farm planner engine: NASA POWER parsing, feature building (mirrors ml/train.py),
 * MLP inference, planting calendar, warnings, explanations and rotation scoring.
 * Works in the browser (window.FarmEngine) and in node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FarmEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const N = 365;
  const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* ---------------------------------------------------------------- dates */
  function idxOfDate(d) { const m = d.getMonth(), day = d.getDate(); return (m === 1 && day === 29) ? 58 : CUM[m] + day - 1; }
  function addDays(d, k) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + k); return x; }
  function fmt(d) { return MONTHS[d.getMonth()] + ' ' + d.getDate(); }
  function fmtYMD(d) { return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }

  /* ------------------------------------------------------- window statistics */
  function winStat(x, a, b, kind) {
    const n = x.length, c = new Float64Array(n + 1), out = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + (isNaN(x[i]) ? 0 : x[i]);
    for (let i = 0; i < n; i++) {
      if (i + a < 0 || i + b > n) continue;
      const s = c[i + b] - c[i + a];
      out[i] = kind === 'sum' ? s : kind === 'any' ? (s > 0 ? 1 : 0) : s / (b - a);
    }
    return out;
  }
  function climMean(stat, Y) {
    const out = new Float64Array(N);
    for (let d = 0; d < N; d++) {
      let s = 0, k = 0;
      for (let y = 0; y < Y; y++) { const v = stat[y * N + d]; if (!isNaN(v)) { s += v; k++; } }
      out[d] = k ? s / k : NaN;
    }
    return out;
  }
  function fillNaN(a) {
    let last = NaN;
    for (let i = 0; i < a.length; i++) { if (!isNaN(a[i])) last = a[i]; else if (!isNaN(last)) a[i] = last; }
    let nxt = NaN;
    for (let i = a.length - 1; i >= 0; i--) { if (!isNaN(a[i])) nxt = a[i]; else if (!isNaN(nxt)) a[i] = nxt; }
    return a;
  }

  /* --------------------------------------------------------- NASA POWER parse */
  function parsePower(j) {
    const p = j.properties.parameter;
    const keys = Object.keys(p.T2M).sort();
    const get = (nm, k) => { const v = p[nm] && p[nm][k]; return (v === undefined || v === null || v < -900) ? NaN : v; };
    const byYear = {};
    const allDays = [];
    for (const k of keys) {
      const y = +k.slice(0, 4), m = +k.slice(4, 6) - 1, d = +k.slice(6, 8);
      allDays.push({ k, y, m, d, T: get('T2M', k), P: get('PRECTOTCORR', k), SW: get('GWETROOT', k) });
      if (m === 1 && d === 29) continue;
      const idx = CUM[m] + d - 1;
      const Y = byYear[y] || (byYear[y] = { n: 0, T: new Float64Array(N).fill(NaN), Tn: new Float64Array(N).fill(NaN),
        Tx: new Float64Array(N).fill(NaN), P: new Float64Array(N).fill(NaN), SW: new Float64Array(N).fill(NaN) });
      Y.T[idx] = get('T2M', k); Y.Tn[idx] = get('T2M_MIN', k); Y.Tx[idx] = get('T2M_MAX', k);
      Y.P[idx] = get('PRECTOTCORR', k); Y.SW[idx] = get('GWETROOT', k);
      if (!isNaN(Y.T[idx])) Y.n++;
    }
    const ok = Object.keys(byYear).map(Number).filter(y => byYear[y].n >= 360).sort((a, b) => a - b);
    if (!ok.length) throw new Error('NASA response contained no complete years');
    let runs = [], cur = [ok[0]];
    for (let i = 1; i < ok.length; i++) { if (ok[i] === cur[cur.length - 1] + 1) cur.push(ok[i]); else { runs.push(cur); cur = [ok[i]]; } }
    runs.push(cur);
    const years = runs.reduce((a, b) => (b.length > a.length ? b : a));
    const Yn = years.length, flat = {};
    for (const f of ['T', 'Tn', 'Tx', 'P', 'SW']) {
      const a = new Float64Array(Yn * N);
      years.forEach((y, i) => a.set(byYear[y][f], i * N));
      flat[f] = fillNaN(a);
    }
    // most recent observed days (including the current, incomplete year) for the nowcast
    const valid = allDays.filter(r => !isNaN(r.T));
    const tail = valid.slice(-21);
    const last = tail[tail.length - 1];
    const obs = { T: tail.map(r => r.T), P: tail.map(r => isNaN(r.P) ? 0 : r.P), SW: tail.map(r => r.SW),
      lastDate: new Date(last.y, last.m, last.d) };
    return { years, Y: Yn, flat, obs };
  }

  /* ------------------------------------------------------------- climatology */
  function buildClimate(data, crops) {
    const { flat: f, Y } = data, c = { Y, crop: {} };
    c.T14 = climMean(winStat(f.T, 0, 14, 'mean'), Y);
    c.T30 = climMean(winStat(f.T, 0, 30, 'mean'), Y);
    c.Tv = climMean(winStat(f.T, 45, 120, 'mean'), Y);
    c.P21 = climMean(winStat(f.P, 0, 21, 'sum'), Y);
    c.SW21 = climMean(winStat(f.SW, 0, 21, 'mean'), Y);
    c.cbT7 = climMean(winStat(f.T, -7, 0, 'mean'), Y);
    c.cbSW7 = climMean(winStat(f.SW, -7, 0, 'mean'), Y);
    c.cbP14 = climMean(winStat(f.P, -14, 0, 'sum'), Y);
    for (const [k, cp] of Object.entries(crops)) {
      const ef = Float64Array.from(f.Tn, v => v < cp.frost_tol ? 1 : 0);
      const eh = Float64Array.from(f.Tx, v => v > cp.tmax ? 1 : 0);
      c.crop[k] = {
        fe: climMean(winStat(ef, 0, 35, 'any'), Y),
        fl: climMean(winStat(ef, cp.season - 20, cp.season, 'any'), Y),
        hf: climMean(winStat(eh, cp.flower_day, cp.flower_day + 20, 'mean'), Y),
      };
    }
    return c;
  }
  /* recent weather vs. normal -> anomalies used to adjust the near-term forecast */
  function nowcast(clim, obs) {
    const n = obs.T.length, mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const di = idxOfDate(addDays(obs.lastDate, 1));
    const sw = obs.SW.filter(v => !isNaN(v));
    return {
      t: mean(obs.T.slice(n - 7)) - clim.cbT7[di],
      sw: sw.length ? mean(sw.slice(-7)) - clim.cbSW7[di] : 0,
      p: obs.P.slice(n - 14).reduce((s, v) => s + v, 0) - clim.cbP14[di],
      lastDate: obs.lastDate,
    };
  }

  /* ------------------------------------------------------------ MLP inference */
  function predict(model, x) {
    let h = x.map((v, i) => (v - model.scaler.mean[i]) / model.scaler.scale[i]);
    model.layers.forEach((L, li) => {
      const out = L.b.slice();
      for (let j = 0; j < out.length; j++) { let s = out[j]; for (let i = 0; i < h.length; i++) s += h[i] * L.W[i][j]; out[j] = s; }
      h = li < model.layers.length - 1 ? out.map(v => v > 0 ? v : 0) : out;
    });
    return 1 / (1 + Math.exp(-h[0]));
  }

  function featureMap(clim, cropKey, cp, di, wgt, an, irrigated) {
    const c = clim.crop[cropKey];
    const f = {
      doy_sin: Math.sin(2 * Math.PI * di / N), doy_cos: Math.cos(2 * Math.PI * di / N),
      c_T14: clim.T14[di], c_T30: clim.T30[di], c_P21: clim.P21[di], c_SW21: clim.SW21[di],
      c_fe: c.fe[di], c_fl: c.fl[di], c_hf: c.hf[di], c_Tv: clim.Tv[di], winter: cp.winter ? 1 : 0,
      t_anom: an.t * wgt, sw_anom: an.sw * wgt, p14_anom: an.p * wgt,
      tmin_plant: cp.tmin_plant, tmax_plant: cp.tmax_plant, tmax: cp.tmax, frost_tol: cp.frost_tol,
      moist: cp.moist, season: cp.season, flower_day: cp.flower_day,
    };
    f.t_now = clim.cbT7[di] + f.t_anom;
    f.sw_now = clim.cbSW7[di] + f.sw_anom;
    if (irrigated) {            // irrigation removes the soil-moisture constraint
      const floor = cp.moist + 0.05;
      f.c_SW21 = Math.max(f.c_SW21, floor); f.sw_now = Math.max(f.sw_now, floor);
    }
    return f;
  }
  const toVec = (model, f) => model.features.map(n => f[n]);

  /* ---------------------------------------------- explanation by "what-if" occlusion */
  function explain(model, cp, f, p0) {
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    const lo = cp.tmin_plant + 2, hi = cp.tmax_plant - 2;
    const tryF = (patch) => predict(model, toVec(model, Object.assign({}, f, patch)));
    const groups = [
      { id: 'frost', p: tryF({ c_fe: 0, c_fl: 0 }) },
      { id: 'cold', p: tryF({ c_T14: clamp(f.c_T14, lo, Infinity), c_T30: clamp(f.c_T30, lo, Infinity),
          t_now: clamp(f.t_now, lo, Infinity), t_anom: Math.max(f.t_anom, 0) }) },
      { id: 'hot', p: tryF({ c_T14: clamp(f.c_T14, -Infinity, hi), c_T30: clamp(f.c_T30, -Infinity, hi),
          t_now: clamp(f.t_now, -Infinity, hi), t_anom: Math.min(f.t_anom, 0) }) },
      { id: 'dry', p: tryF({ c_SW21: Math.max(f.c_SW21, cp.moist + 0.1), sw_now: Math.max(f.sw_now, cp.moist + 0.1),
          sw_anom: Math.max(f.sw_anom, 0), p14_anom: Math.max(f.p14_anom, 0) }) },
      { id: 'flowerheat', p: tryF({ c_hf: 0 }) },
      { id: 'vern', p: cp.winter ? tryF({ c_Tv: Math.min(f.c_Tv, 5) }) : p0 },
    ];
    const lg = v => Math.log(Math.min(Math.max(v, 1e-4), 1 - 1e-4) / (1 - Math.min(Math.max(v, 1e-4), 1 - 1e-4)));
    return groups.map(g => ({ id: g.id, gain: lg(g.p) - lg(p0) })).sort((a, b) => b.gain - a.gain);   // log-odds gain: still ranks causes when several act at once
  }
  function explainText(id, cp, f) {
    const pct = v => Math.round(v * 100) + '%';
    switch (id) {
      case 'frost': {
        const parts = [];
        if (f.c_fe >= 0.03) parts.push(pct(f.c_fe) + ' of past years saw a freeze below ' + cp.frost_tol + '°C within 5 weeks of this date');
        if (f.c_fl >= 0.03) parts.push(pct(f.c_fl) + ' saw one before the crop would mature (~' + cp.season + ' days)');
        return 'Frost risk: ' + (parts.join('; ') || 'frost can hit seedlings or the late season');
      }
      case 'cold': return 'Too cold to start well: expect ~' + f.c_T14.toFixed(1) + '°C over the next 2 weeks, but ' + cp.label + ' needs ≥' + cp.tmin_plant + '°C';
      case 'hot': return 'Too hot to sow: expect ~' + f.c_T14.toFixed(1) + '°C, above the ' + cp.tmax_plant + '°C comfort limit for sowing';
      case 'dry': return 'Dry root zone: soil wetness ~' + f.c_SW21.toFixed(2) + ' vs ≥' + cp.moist.toFixed(2) + ' needed (irrigation would fix this)';
      case 'vern': return 'No cold spell: ' + cp.label + ' is a winter crop and needs cool weather (~' + f.c_Tv.toFixed(0) + '°C expected 2-4 months after sowing, needs < 8°C) to flower';
      case 'flowerheat': return 'Heat at flowering: ~' + pct(f.c_hf) + ' of flowering-stage days exceed ' + cp.tmax + '°C';
    }
    return id;
  }

  /* -------------------------------------------------------- planting calendar */
  function levelOf(p) { return p >= 0.6 ? 'good' : p >= 0.35 ? 'marginal' : 'bad'; }

  function calendar(model, clim, now, cropKey, today, irrigated) {
    const cp = model.crops[cropKey], weeks = [];
    for (let k = 0; k < N; k += 7) {
      const date = addDays(today, k), di = idxOfDate(date);
      const wgt = Math.exp(-k / 10);
      const f = featureMap(clim, cropKey, cp, di, wgt, now, irrigated);
      const p = predict(model, toVec(model, f));
      weeks.push({ k, date, di, p, f });
    }
    // best contiguous window: weeks with p >= 0.55, highest total score
    let best = null, run = null;
    weeks.forEach((w, i) => {
      if (w.p >= 0.55) { if (!run) run = { s: i, e: i, sum: 0 }; run.e = i; run.sum += w.p; }
      else if (run) { if (!best || run.sum > best.sum) best = run; run = null; }
    });
    if (run && (!best || run.sum > best.sum)) best = run;
    let peak = weeks.reduce((a, b) => (b.p > a.p ? b : a));
    const win = best ? { start: weeks[best.s].date, end: addDays(weeks[best.e].date, 6), strong: true,
        weeks: best.e - best.s + 1, peakP: Math.max(...weeks.slice(best.s, best.e + 1).map(w => w.p)) }
      : { start: addDays(peak.date, -7), end: addDays(peak.date, 13), strong: false, weeks: 3, peakP: peak.p };
    const first = weeks[0];
    const drivers = explain(model, cp, first.f, first.p).filter(d => d.gain > 0.5).slice(0, 3)
      .map(d => ({ id: d.id, gain: d.gain, text: explainText(d.id, cp, first.f) }));
    const nextGood = first.p >= 0.6 ? null : (weeks.find(w => w.k > 0 && w.p >= 0.6) || null);
    return { weeks, window: win, peak, now: { p: first.p, level: levelOf(first.p), f: first.f, drivers, nextGood } };
  }

  /* ------------------------------------------------------------- rotation plan */
  function rotation(model, fits, history, soil, prios) {
    const crops = model.crops, out = [];
    const prev = history[0] ? crops[history[0]] : null, prev2 = history[1] ? crops[history[1]] : null;
    for (const [k, cp] of Object.entries(crops)) {
      const why = [], cons = [];
      let rot = 0.55;
      if (prev && prev.family === cp.family) { rot -= 0.35; cons.push('same crop family as last season (disease & pest carry-over)'); }
      else if (prev) { rot += 0.08; why.push('breaks the pest/disease cycle of ' + prev.label); }
      if (prev2 && prev2.family === cp.family) { rot -= 0.15; cons.push('same family as two seasons ago'); }
      if (prev && cp.legume && !prev.legume) { rot += 0.2; why.push('legume fixes nitrogen after ' + prev.label); }
      if (prev && prev.legume && cp.legume) { rot -= 0.2; cons.push('legume after legume builds disease pressure'); }
      if (prev && prev.legume && cp.n_demand === 'high') { rot += 0.15; why.push('uses the nitrogen left by ' + prev.label); }
      if (prev && prev.root !== cp.root) { rot += 0.07; why.push(cp.root + ' roots after ' + prev.root + ' roots uses different soil layers'); }
      rot = Math.min(1, Math.max(0, rot));
      let soilH = 0.3 + (cp.legume ? 0.35 : 0) + (cp.root === 'deep' ? 0.2 : 0) + (cp.n_demand === 'high' ? -0.1 : 0);
      if (soil.om === 'low' && cp.legume) soilH += 0.15;
      soilH = Math.min(1, Math.max(0, soilH));
      const water = Math.min(1, Math.max(0, 1 - cp.water_mm / 800));
      const soilFit = cp.soil_fit[soil.texture];
      const fit = fits[k].p;
      const ws = prios.soil, ww = prios.water, wi = prios.income;
      const score = (4 * fit + 2.5 * rot + ws * soilH + ww * water + wi * cp.income + 1.5 * soilFit) / (4 + 2.5 + ws + ww + wi + 1.5);
      if (fit >= 0.6) why.unshift('strong climate fit at this location (' + Math.round(fit * 100) + '%)');
      else if (fit < 0.35) cons.unshift('weak climate fit here (' + Math.round(fit * 100) + '%)');
      if (ww >= 3 && cp.water_mm <= 450) why.push('modest water use (~' + cp.water_mm + ' mm/season)');
      if (ww >= 3 && cp.water_mm >= 650) cons.push('thirsty crop (~' + cp.water_mm + ' mm/season)');
      if (ws >= 3 && cp.legume) why.push('builds soil nitrogen and organic matter');
      if (soilFit < 0.6) cons.push(soil.texture + ' soil is not ideal for ' + cp.label);
      out.push({ key: k, label: cp.label, score, fit, rot, soilH, water, income: cp.income, soilFit, why, cons });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }
  function rotationSequence(model, fits, history, soil, prios, seasons) {
    const seq = []; let h = history.slice();
    for (let i = 0; i < seasons; i++) {
      const r = rotation(model, fits, h, soil, prios)[0];
      seq.push(r); h = [r.key, h[0]].filter(Boolean);
    }
    return seq;
  }

  /* ------------------------------------------- offline demo climate (approximate) */
  function demoData(lat, lon) {
    let seed = Math.abs(Math.floor(lat * 100) * 7919 + Math.floor(lon * 100) * 104729) % 2147483647 || 1;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const al = Math.abs(lat), tmean = 30 - 0.42 * al, amp = 0.34 * al, peak = lat >= 0 ? 200 : 18, dr = 11;
    const Y = 12, n = Y * N;
    const T = new Float64Array(n), Tn = new Float64Array(n), Tx = new Float64Array(n), P = new Float64Array(n), SW = new Float64Array(n);
    let e = 0, w = 100;
    for (let i = 0; i < n; i++) {
      const d = i % N, sig = 1.5 + 0.22 * amp;
      e = 0.72 * e + gauss() * sig * Math.sqrt(1 - 0.72 * 0.72);
      T[i] = tmean + amp * Math.cos(2 * Math.PI * (d - peak) / 365) + e;
      Tn[i] = T[i] - dr / 2 + gauss() * 1.8; Tx[i] = T[i] + dr / 2 + gauss() * 1.8;
      const wet = Math.min(0.8, Math.max(0.05, 0.2 + 0.1 * Math.cos(2 * Math.PI * (d - (lat >= 0 ? 60 : 240)) / 365)));
      P[i] = rnd() < wet ? -Math.log(rnd() + 1e-9) * 6 : 0;
      const et = (0.3 + 0.12 * Math.max(T[i], 0)) * Math.min(1, Math.max(0.2, w / 150));
      w = Math.min(200, Math.max(0, w + P[i] - et)); SW[i] = w / 200;
    }
    const today = new Date(), lastDate = addDays(today, -7);
    const tail = (a) => Array.from(a.slice(n - 21));
    return { years: Array.from({ length: Y }, (_, i) => 2013 + i), Y, flat: { T, Tn, Tx, P, SW },
      obs: { T: tail(T), P: tail(P), SW: tail(SW), lastDate } };
  }

  return { N, MONTHS, idxOfDate, addDays, fmt, fmtYMD, parsePower, buildClimate, nowcast, predict, featureMap, toVec,
    calendar, levelOf, rotation, rotationSequence, demoData, winStat, climMean };
});
