#!/usr/bin/env python3
"""Generate SYNTHETIC daily climate data in the exact same CSV format as
fetch_nasa.py produces. Used only so the pipeline runs where NASA POWER is not
reachable. It is NOT real data. train.py prefers nasa_*.csv when present.

    python ml/make_demo_data.py
"""
import json, os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# name: (Tmean, Tamp, peak_doy, diurnal_range, wet_p0, wet_p1, wet_peak_doy, mean_wet_mm)
SPEC = {
    "tashkent_uz":   (14.5, 13.0, 200, 12, 0.18, 0.12,  60, 5),
    "iowa_us":       (10.0, 15.0, 200, 10, 0.30, 0.08, 160, 7),
    "punjab_in":     (24.0,  9.0, 170, 11, 0.20, 0.25, 210, 12),
    "nile_delta_eg": (21.5,  8.0, 205, 11, 0.05, 0.04,  15, 4),
    "kansas_us":     (12.5, 14.0, 200, 13, 0.22, 0.10, 150, 7),
    "pampas_ar":     (16.5,  7.5,  15, 11, 0.25, 0.08,  60, 8),
    "nakuru_ke":     (17.0,  1.2,  60, 12, 0.25, 0.12, 110, 8),
    "murcia_es":     (18.0,  7.5, 205, 11, 0.10, 0.07, 300, 6),
    "queensland_au": (20.0,  5.5,  15, 11, 0.20, 0.10,  45, 9),
    "poltava_ua":    ( 8.0, 12.5, 200,  9, 0.30, 0.06, 170, 5),
    "henan_cn":      (15.0, 13.0, 200, 10, 0.20, 0.17, 200, 8),
    "matogrosso_br": (25.0,  2.0, 290, 11, 0.40, 0.35,  15, 11),
}


def gen(name, lat, spec, rng, y0=2005, y1=2025):
    tmean, tamp, peak, dr, p0, p1, wpeak, amt = spec
    dates = pd.date_range(f"{y0}-01-01", f"{y1}-12-31")
    n = len(dates)
    doy = dates.dayofyear.values
    yr = dates.year.values - y0
    base = tmean + tamp * np.cos(2 * np.pi * (doy - peak) / 365.25)
    sig, phi = 1.5 + 0.22 * tamp, 0.72
    e = np.zeros(n)
    for i in range(1, n):
        e[i] = phi * e[i - 1] + rng.normal(0, sig * np.sqrt(1 - phi ** 2))
    T = base + e + 0.03 * yr                      # mild warming trend
    Tmin = T - dr / 2 + rng.normal(0, 1.8, n)
    Tmax = T + dr / 2 + rng.normal(0, 1.8, n)
    p_wet = np.clip(p0 + p1 * np.cos(2 * np.pi * (doy - wpeak) / 365.25), 0.02, 0.9)
    P = np.where(rng.random(n) < p_wet, rng.gamma(0.8, amt / 0.8, n), 0.0)
    w, sw = 100.0, np.zeros(n)
    for i in range(n):                            # simple soil-water bucket
        et = (0.3 + 0.12 * max(T[i], 0)) * np.clip(w / 150, 0.2, 1.0)
        w = float(np.clip(w + P[i] - et, 0, 200))
        sw[i] = w / 200
    sun = 5 + 3.2 * np.cos(2 * np.pi * (doy - (172 if lat >= 0 else 355)) / 365.25) * (abs(lat) / 40 + 0.2)
    sun = np.clip(sun - 0.04 * P, 0.5, 12)
    return pd.DataFrame({
        "date": dates.strftime("%Y-%m-%d"), "T2M": T.round(2), "T2M_MIN": Tmin.round(2),
        "T2M_MAX": Tmax.round(2), "PRECTOTCORR": P.round(2), "GWETROOT": sw.round(3),
        "ALLSKY_SFC_SW_DWN": sun.round(2)})


def main():
    locs = json.load(open(os.path.join(HERE, "locations.json")))
    out = os.path.join(ROOT, "data", "raw")
    os.makedirs(out, exist_ok=True)
    rng = np.random.default_rng(42)
    for loc in locs:
        df = gen(loc["name"], loc["lat"], SPEC[loc["name"]], rng)
        path = os.path.join(out, f"demo_{loc['name']}.csv")
        df.to_csv(path, index=False)
        print("wrote", path, len(df), "rows")


if __name__ == "__main__":
    main()
