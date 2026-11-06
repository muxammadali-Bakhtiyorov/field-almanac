// Run:  node tests/test_engine.js
// 1) JS forward pass must match scikit-learn on saved parity vectors.
// 2) Sanity checks on a calendar built from a real-format CSV (demo Tashkent file).
const fs = require('fs'), path = require('path');
const E = require('../web/engine.js');
const root = path.join(__dirname, '..');
const model = JSON.parse(fs.readFileSync(path.join(root, 'web/model.json')));
let fail = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + ' ' + extra); if (!ok) fail++; };

// 1) parity
const vecs = JSON.parse(fs.readFileSync(path.join(root, 'data/parity_vectors.json')));
const maxErr = Math.max(...vecs.map(v => Math.abs(E.predict(model, v.x) - v.p)));
check('JS MLP matches scikit-learn', maxErr < 1e-4, 'max abs err ' + maxErr.toExponential(2));

// 2) build a NASA-POWER-shaped JSON from the demo CSV and run the whole engine
const rows = fs.readFileSync(path.join(root, 'data/raw/demo_tashkent_uz.csv'), 'utf8').trim().split('\n').slice(1).map(r => r.split(','));
const par = { T2M: {}, T2M_MIN: {}, T2M_MAX: {}, PRECTOTCORR: {}, GWETROOT: {} };
for (const r of rows) { const k = r[0].replace(/-/g, ''); par.T2M[k] = +r[1]; par.T2M_MIN[k] = +r[2]; par.T2M_MAX[k] = +r[3]; par.PRECTOTCORR[k] = +r[4]; par.GWETROOT[k] = +r[5]; }
const data = E.parsePower({ properties: { parameter: par } });
check('parsed complete years', data.Y === 21, 'years=' + data.Y);
const clim = E.buildClimate(data, model.crops);
const now = E.nowcast(clim, data.obs);

const cal = (crop, y, m, d, irr = false) => E.calendar(model, clim, { t: 0, sw: 0, p: 0 }, crop, new Date(y, m, d), irr);
const mid = (w) => new Date((w.start.getTime() + w.end.getTime()) / 2);
const maize = cal('maize', 2026, 0, 1), cotton = cal('cotton', 2026, 0, 1), wheat = cal('winter_wheat', 2026, 0, 1);
console.log('maize best window  :', E.fmt(maize.window.start), '->', E.fmt(maize.window.end), 'peak', maize.window.peakP.toFixed(2));
console.log('cotton best window :', E.fmt(cotton.window.start), '->', E.fmt(cotton.window.end), 'peak', cotton.window.peakP.toFixed(2));
console.log('wheat best window  :', E.fmt(wheat.window.start), '->', E.fmt(wheat.window.end), 'peak', wheat.window.peakP.toFixed(2));
check('maize window is spring/early summer (Mar-Jun)', [2, 3, 4, 5].includes(mid(maize.window).getMonth()));
check('winter wheat window is autumn (Sep-Dec)', [8, 9, 10, 11].includes(mid(wheat.window).getMonth()));
check('maize NOT recommended on Jan 1 (frost/cold)', maize.now.level === 'bad', 'p=' + maize.now.p.toFixed(2));
const cf = cotton.weeks.find(w => w.date >= cotton.window.start);
check('cotton window respects its 15C sowing minimum', cf.f.c_T14 >= model.crops.cotton.tmin_plant - 1.5, 'T14=' + cf.f.c_T14.toFixed(1));
const wsp = wheat.weeks.find(w => w.date.getMonth() === 3);
check('winter wheat NOT recommended for April sowing (no vernalization)', wsp.p < 0.35, 'p=' + wsp.p.toFixed(2));
check('warning drivers explain the bad date', maize.now.drivers.length > 0, maize.now.drivers.map(d => d.id).join(','));
const dry = cal('chickpea', 2026, 3, 1, false), wet = cal('chickpea', 2026, 3, 1, true);
check('irrigation never lowers suitability', wet.now.p >= dry.now.p - 1e-9);

// 3) rotation
const fits = {}; for (const k of Object.keys(model.crops)) fits[k] = { p: cal(k, 2026, 0, 1).window.peakP };
const rot = E.rotation(model, fits, ['maize'], { texture: 'loam', om: 'low' }, { soil: 4, water: 3, income: 2 });
console.log('rotation after maize:', rot.slice(0, 4).map(r => r.label + ' ' + r.score.toFixed(2)).join(' | '));
check('maize after maize is penalised', rot.findIndex(r => r.key === 'maize') > 2);
check('a legume tops the list on low-organic-matter soil after a cereal', model.crops[rot[0].key].legume || model.crops[rot[1].key].legume);

// 4) demo-mode fallback
const dd = E.demoData(41.31, 69.24), dc = E.buildClimate(dd, model.crops);
const dcal = E.calendar(model, dc, E.nowcast(dc, dd.obs), 'maize', new Date(2026, 10, 5), false);
check('demo-mode calendar produces 53 weeks', dcal.weeks.length === 53);
console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
