// Run: (cd web && python3 -m http.server 8765 &) ; node tests/e2e_mock.js <screenshot.png>
// Mocks NASA POWER / ORNL MODIS / EONET in their documented formats and drives the real pages.
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const rows = fs.readFileSync(path.join(__dirname, '../data/raw/demo_tashkent_uz.csv'), 'utf8').trim().split('\n').slice(1).map(r => r.split(','));
const power = (imerg) => { const p = imerg ? { IMERG_PRECTOT: {} } : { T2M: {}, T2M_MIN: {}, T2M_MAX: {}, PRECTOTCORR: {}, GWETROOT: {}, ALLSKY_SFC_SW_DWN: {} };
  for (const r of rows) { const k = r[0].replace(/-/g, ''); if (imerg) p.IMERG_PRECTOT[k] = +(+r[4] * 0.9).toFixed(2); else { p.T2M[k] = +r[1]; p.T2M_MIN[k] = +r[2]; p.T2M_MAX[k] = +r[3]; p.PRECTOTCORR[k] = +r[4]; p.GWETROOT[k] = +r[5]; p.ALLSKY_SFC_SW_DWN[k] = +r[6]; } }
  return { properties: { parameter: p } }; };
const modis = (url) => { const q = new URL(url).searchParams, sd = q.get('startDate'), ed = q.get('endDate'), y = +sd.slice(1, 5), a = +sd.slice(5), b = +ed.slice(5), thisY = new Date().getFullYear();
  const out = []; for (let d = a; d <= b; d += 16) { const v = (0.25 + 0.45 * Math.exp(-(((d - 130) / 50) ** 2)) * (y === thisY ? 0.8 : 1)) * 1e4; out.push({ band: '250m_16_days_NDVI', modis_date: 'A' + y + String(d).padStart(3, '0'), proc_date: '2024001', data: [Math.round(v), Math.round(v * 1.02), -3000] }); }
  return { band: '250m_16_days_NDVI', latitude: 41.31, longitude: 69.24, subset: out }; };
const eonet = { title: 'EONET Events', events: [{ id: 'EONET_1', title: 'Wildfire - Tashkent Region', link: 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_1', closed: null, categories: [{ id: 'wildfires', title: 'Wildfires' }], geometry: [{ date: new Date().toISOString(), type: 'Point', coordinates: [70.2, 41.9] }] }] };
(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1250, height: 900 } }), errs = [], seen = { power: 0, imerg: 0, modis: 0, eonetDirect: 0, proxy: 0 };
  p.on('pageerror', e => errs.push(e.message));
  const json = (route, o) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
  await p.route('**/power.larc.nasa.gov/**', r => { const u = r.request().url(); if (u.includes('IMERG_PRECTOT')) { seen.imerg++; return json(r, power(true)); } seen.power++; return json(r, power(false)); });
  await p.route('**/modis.ornl.gov/**', r => { seen.modis++; return json(r, modis(r.request().url())); });
  await p.route('**/eonet.gsfc.nasa.gov/**', r => { seen.eonetDirect++; return r.abort('failed'); });                       // simulate CORS block
  await p.route('**/api/nasa**', r => { seen.proxy++; const u = new URL(r.request().url()).searchParams.get('u'); return u.includes('eonet') ? json(r, eonet) : r.abort(); });
  await p.goto('http://localhost:8765/index.html'); await p.selectOption('#crop', 'maize'); await p.click('#go');
  await p.waitForSelector('.banner', { timeout: 60000 });
  await p.waitForFunction(() => document.querySelector('#layers') && /5 of 5 loaded/.test(document.querySelector('#layers').innerText), null, { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(500);
  const t = async (sel) => (await p.$eval(sel, e => e.innerText).catch(() => 'MISSING')).replace(/\s+/g, ' ');
  console.log('requests seen', JSON.stringify(seen));
  console.log('LAYERS:', (await t('#layers')).slice(0, 700));
  console.log('HAZARD:', (await t('#hazard')).slice(0, 250));
  console.log('SATELLITE:', (await t('#satellite')).slice(0, 520));
  console.log('OUTLOOK:', (await p.$$eval('.card', c => (c.find(x => x.innerText.includes('SEASON OUTLOOK')) || { innerText: 'MISSING' }).innerText.replace(/\s+/g, ' ').slice(0, 160))));
  await p.screenshot({ path: process.argv[2], fullPage: true });
  await p.goto('http://localhost:8765/investor.html'); await p.click('#load'); await p.waitForSelector('.kv', { timeout: 60000 });
  console.log('INVESTOR layers:', (await p.$$eval('.card', c => (c.find(x => x.innerText.includes('NASA DATA LAYERS')) || { innerText: 'MISSING' }).innerText.replace(/\s+/g, ' ').slice(0, 120))));
  console.log('errors:', errs); await b.close();
})();
