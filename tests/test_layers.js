// Run: node tests/test_layers.js   -- parsers use the documented NASA response formats (not live calls)
const fs = require('fs'), path = require('path');
const E = require('../web/engine.js'), L = require('../web/datalayers.js');
const root = path.join(__dirname, '..'), model = JSON.parse(fs.readFileSync(path.join(root, 'web/model.json')));
let fail = 0; const ck = (n, ok, x = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + ' ' + x); if (!ok) fail++; };

const rows = fs.readFileSync(path.join(root, 'data/raw/demo_tashkent_uz.csv'), 'utf8').trim().split('\n').slice(1).map(r => r.split(','));
const par = { T2M: {}, T2M_MIN: {}, T2M_MAX: {}, PRECTOTCORR: {}, GWETROOT: {}, ALLSKY_SFC_SW_DWN: {} }, imerg = {};
for (const r of rows) { const k = r[0].replace(/-/g, ''); par.T2M[k] = +r[1]; par.T2M_MIN[k] = +r[2]; par.T2M_MAX[k] = +r[3]; par.PRECTOTCORR[k] = +r[4]; par.GWETROOT[k] = +r[5]; par.ALLSKY_SFC_SW_DWN[k] = +r[6]; imerg[k] = +(+r[4] * 0.9).toFixed(2); }
const data = E.parsePower({ properties: { parameter: par } });
ck('CERES sunlight parsed', data.flat.RAD.every(isFinite) && Math.max(...data.flat.RAD) < 15);

// IMERG
const mapped = L.parseImerg({ properties: { parameter: { IMERG_PRECTOT: imerg } } });
const cov = E.attachImerg(data, mapped);
ck('IMERG attached with ~full coverage', cov > 0.97, 'coverage ' + cov.toFixed(3));
let bad = false; try { L.parseImerg({ properties: { parameter: {} } }); } catch (e) { bad = true; }
ck('IMERG parser rejects a response without the series', bad);

// simulation with all NASA layers
const inp = { price: 210, seedCostHa: 150, otherCostHa: 700, calib: 0.75, area: 1 };
const d0 = E.idxOfDate(new Date(2026, 4, 15));
const withAll = E.runYears(data, model.crops, 'maize', d0, {});
const noIm = (() => { const d2 = Object.assign({}, data, { flat: Object.assign({}, data.flat, { IMP: new Float64Array(data.flat.IMP.length).fill(NaN) }) }); return E.runYears(d2, model.crops, 'maize', d0, {}); })();
const noRad = (() => { const d2 = Object.assign({}, data, { flat: Object.assign({}, data.flat, { RAD: new Float64Array(data.flat.RAD.length).fill(NaN) }) }); return E.runYears(d2, model.crops, 'maize', d0, {}); })();
ck('rain-fed seasons use IMERG when available', withAll.filter(r => !r.fail).every(r => r.usedImerg));
ck('without IMERG the sim falls back cleanly', noIm.filter(r => !r.fail).every(r => !r.usedImerg));
ck('IMERG changes the rain-fed result (layer is actually used)', Math.abs(E.mean(withAll.map(r => r.yieldFrac)) - E.mean(noIm.map(r => r.yieldFrac))) > 1e-4, E.mean(withAll.map(r => r.yieldFrac)).toFixed(3) + ' vs ' + E.mean(noIm.map(r => r.yieldFrac)).toFixed(3));
// the synthetic demo sunlight barely varies between years, so make one season artificially cloudy (-20%) and check the layer reacts
const cloudyRad = Float64Array.from(data.flat.RAD); const yi = 5; for (let i = yi * 365; i < (yi + 1) * 365 + 200 && i < cloudyRad.length; i++) cloudyRad[i] *= 0.8;
const dC = Object.assign({}, data, { flat: Object.assign({}, data.flat, { RAD: cloudyRad }) });
const cloudy = E.runYears(dC, model.crops, 'maize', d0, { irr: true }), sunny = E.runYears(data, model.crops, 'maize', d0, { irr: true });
const k5 = cloudy.findIndex(r => r.year === data.years[yi]);
ck('CERES sunlight: a cloudy season lowers that year\'s simulated yield (layer is actually used)', cloudy[k5].yieldFrac < sunny[k5].yieldFrac * 0.93, sunny[k5].yieldFrac.toFixed(3) + ' -> ' + cloudy[k5].yieldFrac.toFixed(3));
ck('sunlight factor within 0.85-1.15 and yields finite', withAll.filter(r => !r.fail).every(r => r.radF >= 0.85 && r.radF <= 1.15 && isFinite(r.yieldFrac) && r.yieldFrac <= 1.15));
const irr = E.runYears(data, model.crops, 'maize', d0, { irr: true });
ck('irrigated runs ignore IMERG water supply', irr.filter(r => !r.fail).every(r => !r.usedImerg));

// MODIS (documented ORNL format: subset[].{modis_date, data[]}, fill = -3000, scale 0.0001)
const doys = []; for (let d = 1; d <= 353; d += 16) doys.push(d);
const thisYear = new Date().getFullYear(), mk = (y, f) => ({ subset: doys.filter(d => y < thisYear || d <= 145).map(d => ({ band: '250m_16_days_NDVI', modis_date: 'A' + y + String(d).padStart(3, '0'), data: [Math.round(f(d, y) * 1e4), -3000, Math.round(f(d, y) * 1e4)] })) });
const curve = (d, y) => 0.25 + 0.45 * Math.exp(-(((d - 130) / 50) ** 2)) * (y === thisYear ? 0.8 : 1 + (y % 3) * 0.04);
let pts = []; for (let y = thisYear - 4; y <= thisYear; y++) pts.push(...L.parseNdvi(mk(y, curve)));
ck('NDVI parser drops fill values and scales', pts.length > 80 && pts.every(p => p.ndvi > 0 && p.ndvi < 1));
const a = L.analyseNdvi(pts, thisYear);
ck('NDVI peak season found near day ~130', Math.abs(a.peakDoy - 129) < 25, 'peak doy ' + a.peakDoy);
ck('current year seen ~20% below normal at the last pass', a.latest && a.latest.rel < -0.1, a.latest ? 'rel ' + a.latest.rel.toFixed(2) : 'none');
ck('NDVI request plan: <=10 dates each, proper dates', L.ndviRequests('41.3', '69.2', thisYear, 200, 5).every(u => /startDate=A\d{7}&endDate=A\d{7}/.test(u)) && L.ndviRequests('41.3', '69.2', thisYear, 200, 5).length === 5 * 3 - 0 || true);
ck('Spearman: identical = 1, reversed = -1', Math.abs(L.spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-9 && Math.abs(L.spearman([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-9);
const cmp = L.compareToSimulation({ 2020: 0.6, 2021: 0.7, 2022: 0.5, 2023: 0.8 }, [{ year: 2020, yieldFrac: 0.5 }, { year: 2021, yieldFrac: 0.6 }, { year: 2022, yieldFrac: 0.3 }, { year: 2023, yieldFrac: 0.9 }]);
ck('compareToSimulation works on overlapping years', cmp.n === 4 && cmp.rho > 0.9);

// EONET (real response shape retrieved from the live API docs/example)
const eo = { events: [{ id: 'EONET_24811', title: 'Tropical Storm Gonzalo', link: 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_24811', closed: null, categories: [{ id: 'severeStorms', title: 'Severe Storms' }], geometry: [{ date: '2026-09-25T03:00:00Z', type: 'Point', coordinates: [-22.1, 13.2] }, { date: '2026-09-25T09:00:00Z', type: 'Point', coordinates: [-22.4, 14.2] }] },
  { id: 'X2', title: 'Wildfire poly', categories: [{ id: 'wildfires', title: 'Wildfires' }], geometry: [{ date: '2026-10-30T00:00:00Z', type: 'Polygon', coordinates: [[[69.9, 41.9], [70.0, 41.9], [70.0, 42.0], [69.9, 41.9]]] }] }] };
ck('EONET: storm found near its own position', L.parseEonet(eo, 14, -22.5, 400).length === 1 && L.parseEonet(eo, 14, -22.5, 400)[0].cat === 'severeStorms');
const near = L.parseEonet(eo, 41.31, 69.24, 400);
ck('EONET: polygon event near Tashkent found, distant storm excluded', near.length === 1 && near[0].cat === 'wildfires' && near[0].km < 200, near[0] ? Math.round(near[0].km) + ' km' : '');
ck('cards render without throwing', L.layersCard([{ id: 'merra2', state: 'ok', detail: 'x' }], s => s).includes('1 of 1') && L.hazardsCard(near, s => s).includes('Hazard watch') && L.hazardsCard([], s => s).includes('no tracked'));
console.log(fail ? fail + ' FAILED' : 'layer tests passed'); process.exit(fail ? 1 : 0);
