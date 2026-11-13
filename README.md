# Field Almanac – NASA-powered planting planner

Enter or auto-detect a location -> the site pulls 20 years of NASA POWER daily data
(T2M, T2M_MIN, T2M_MAX, PRECTOTCORR, GWETROOT) -> a neural network scores every week of the
next year for planting a chosen crop, warns when it's a bad time (with reasons), and ranks
rotation options using soil, water and income priorities.

## Run it
    pip install pandas scikit-learn numpy
    python ml/fetch_nasa.py          # REAL NASA data (needs normal internet), ~12 regions, 2005-2025
    python ml/train.py               # trains MLP + gradient-boosting baseline, writes web/model.js
    node tests/test_engine.js        # JS <-> scikit-learn parity + sanity checks
    node tests/test_rainfall.js      # last-year rainfall outlook checks
    cd web && python -m http.server 8000   # open http://localhost:8000

Without `nasa_*.csv`, `train.py` uses SYNTHETIC data from `ml/make_demo_data.py` and labels it in
the model metadata and UI. Check `web/model.json` metadata after retraining to confirm the data source.

## Honest limitations
* Labels are an agronomic-threshold crop-model proxy (ml/crops.py), not measured yields.
  Replace outcome_score() in train.py with real planting-date/yield records when available.
* Soil inputs are user-selected (texture, organic matter); NASA SMAP/SoilGrids could be added.
* Weeks beyond ~2 weeks ahead rely on climatology, not a weather forecast.
* Crop thresholds are textbook approximations; tune per region/variety.

## NASA data layers (v2)
Five distinct NASA products, each used by the model and reported on the page (see web/datalayers.js):
MERRA-2 (temperature, rain, soil wetness), CERES (sunlight), GPM IMERG (satellite rain) - all via NASA POWER;
MODIS NDVI via ORNL DAAC; EONET natural-hazard events.
`web/api/nasa.js` is a Vercel function used as a CORS fallback (NASA hosts only).
Tests: `node tests/test_engine.js`, `node tests/test_layers.js`, and `tests/e2e_mock.js` (mocked NASA responses; Playwright).
Not yet verified against the live services: the IMERG parameter name (IMERG_PRECTOT) and browser CORS for ORNL/EONET.

The three-month rainfall outlook repeats each target month's NASA POWER precipitation from the same month
last year, and compares that estimate with the historical average for those months. It is a simple seasonal
estimate, not an AI model or a day-to-day weather forecast.
