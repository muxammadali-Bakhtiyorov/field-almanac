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
    cd web && python -m http.server 8000   # open http://localhost:8000

Without nasa_*.csv, train.py uses SYNTHETIC data from ml/make_demo_data.py (clearly labelled
in the model metadata and UI). The shipped model.js was trained on that synthetic data -
RETRAIN on real data before trusting any output.

## Honest limitations
* Labels are an agronomic-threshold crop-model proxy (ml/crops.py), not measured yields.
  Replace outcome_score() in train.py with real planting-date/yield records when available.
* Soil inputs are user-selected (texture, organic matter); NASA SMAP/SoilGrids could be added.
* Weeks beyond ~2 weeks ahead rely on climatology, not a weather forecast.
* Crop thresholds are textbook approximations; tune per region/variety.
