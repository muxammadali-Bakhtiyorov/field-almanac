// Run: node tests/test_rainfall.js
const assert = require('assert');
const E = require('../web/engine.js');
const years = Array.from({ length: 20 }, (_, i) => 2000 + i);
const data = {
  Y: years.length,
  years,
  flat: {
    P: new Float64Array(years.length * E.N).fill(1),
    T: new Float64Array(years.length * E.N).fill(20),
    SW: new Float64Array(years.length * E.N).fill(0.3),
  },
  months: [
    { year: 2019, month: 2, days: 28, p: 56 },
    { year: 2019, month: 3, days: 31, p: 70 },
    { year: 2019, month: 4, days: 30, p: 84 },
  ],
  obs: { lastDate: new Date(2020, 0, 15) },
};
const forecast = E.rainfallOutlook(data);
assert.deepStrictEqual(forecast.months.map(m => m.name), ['Feb', 'Mar', 'Apr']);
assert.deepStrictEqual(forecast.months.map(m => m.rainfall), [56, 70, 84]);
assert.strictEqual(forecast.total, 210);
assert.strictEqual(forecast.normalTotal, 89);
assert.strictEqual(forecast.method, 'same calendar month last year');
assert.throws(() => E.rainfallOutlook({ ...data, months: [] }), /same month last year/);
console.log('PASS last-year rainfall outlook and missing-month handling');
