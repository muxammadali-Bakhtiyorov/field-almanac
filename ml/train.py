#!/usr/bin/env python3
"""Train the planting-suitability model on NASA POWER daily data.

    python ml/train.py                 # uses data/raw/nasa_*.csv if present, else demo_*.csv
    python ml/train.py --holdout iowa_us,nakuru_ke

What it does
  1. Loads daily T2M, T2M_MIN, T2M_MAX, PRECTOTCORR, GWETROOT per location.
  2. For every location x day x crop builds features that are available at
     planting time: day-of-year, climatology of the coming weeks (computed from
     OTHER years only -> no leakage), recent anomalies, and the crop's traits.
  3. Labels each row by simulating what actually happened after sowing in that
     year (frost, cold/hot germination, dry soil, flowering heat) -> "good outcome".
  4. Trains an MLP (exported to the website) and a gradient-boosting baseline.
     Evaluates on held-out YEARS and held-out LOCATIONS.
  5. Writes web/model.json + web/model.js.

IMPORTANT: labels come from agronomic thresholds in crops.py (a crop-model proxy),
not from measured yields. If you have yield / planting-date records, replace
`outcome_score()` with them -- the rest of the pipeline stays the same.
"""
import argparse, glob, json, os, sys, time
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import accuracy_score, brier_score_loss, roc_auc_score
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crops import CROPS  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
N = 365
FEATURES = ["doy_sin", "doy_cos", "c_T14", "c_T30", "c_P21", "c_SW21", "c_fe", "c_fl", "c_hf", "c_Tv",
            "t_now", "t_anom", "sw_now", "sw_anom", "p14_anom",
            "tmin_plant", "tmax_plant", "tmax", "frost_tol", "moist", "season", "flower_day", "winter"]
GOOD = 0.75           # outcome score needed to count as a "good" planting date


# ----------------------------------------------------------------- data loading
def load_location(path):
    df = pd.read_csv(path, parse_dates=["date"]).sort_values("date")
    cols = ["T2M", "T2M_MIN", "T2M_MAX", "PRECTOTCORR", "GWETROOT"]
    for c in cols:
        df[c] = pd.to_numeric(df[c], errors="coerce").where(lambda s: s > -900)
    df = df[~((df.date.dt.month == 2) & (df.date.dt.day == 29))]       # fixed 365-day years
    df["year"] = df.date.dt.year
    ok = [y for y, g in df.groupby("year") if len(g) >= 360]
    if not ok:
        return None
    runs, cur = [], [ok[0]]
    for y in ok[1:]:
        (cur.append(y) if y == cur[-1] + 1 else (runs.append(cur), cur := [y]))
    runs.append(cur)
    years = max(runs, key=len)                                         # longest contiguous run
    parts = []
    for y in years:
        idx = pd.date_range(f"{y}-01-01", f"{y}-12-31")
        idx = idx[~((idx.month == 2) & (idx.day == 29))]
        g = df[df.year == y].set_index("date").reindex(idx)[cols]
        parts.append(g.interpolate(limit_direction="both"))
    full = pd.concat(parts)
    return {k: full[c].to_numpy(float) for k, c in
            zip(["T", "Tn", "Tx", "P", "SW"], ["T2M", "T2M_MIN", "T2M_MAX", "PRECTOTCORR", "GWETROOT"])}, len(years)


# ----------------------------------------------------------------- window stats
def win(x, a, b, kind):
    """Statistic over the window [i+a, i+b) for every index i; NaN where it does not fit."""
    n = len(x)
    c = np.concatenate([[0.0], np.cumsum(np.nan_to_num(x))])
    i = np.arange(n)
    ok = (i + a >= 0) & (i + b <= n)
    out = np.full(n, np.nan)
    s = c[i[ok] + b] - c[i[ok] + a]
    if kind == "sum":
        out[ok] = s
    elif kind == "any":
        out[ok] = (s > 0).astype(float)
    else:                         # mean / fraction of event days
        out[ok] = s / (b - a)
    return out


def loo_clim(stat, years):
    """Leave-one-year-out climatology of a per-day statistic (same-day-of-year mean of other years)."""
    A = stat.reshape(years, N)
    valid = ~np.isnan(A)
    cnt, tot = valid.sum(0), np.nansum(A, 0)
    own = np.nan_to_num(A)
    denom = cnt[None, :] - valid
    with np.errstate(invalid="ignore", divide="ignore"):
        C = (tot[None, :] - own) / np.where(denom > 0, denom, np.nan)
    return C.reshape(-1)


def outcome_score(cp, a_T14, a_SW21, fe, fl, hf, a_Tv):
    """Crop-model proxy: 1 = perfect, 0 = failure. Replace with real yield outcomes if you have them."""
    pen = np.clip((cp["tmin_plant"] - a_T14) / 5, 0, 1) * 0.5          # too cold to germinate
    pen += np.clip((a_T14 - cp["tmax_plant"]) / 5, 0, 1) * 0.5         # too hot to sow
    pen += 0.6 * fe + 0.5 * fl                                         # early / pre-maturity frost
    pen += np.clip((cp["moist"] - a_SW21) / 0.15, 0, 1) * 0.5          # dry root zone
    pen += np.clip(hf / 0.4, 0, 1) * 0.5                               # heat at flowering
    if cp["winter"]:                                                   # no cold spell -> no flowering
        pen += np.clip((a_Tv - 8) / 6, 0, 1) * 0.8
    return np.clip(1 - pen, 0, 1)


def build_location(arr, years, loc_idx, rng, step=2):
    T, Tn, Tx, P, SW = arr["T"], arr["Tn"], arr["Tx"], arr["P"], arr["SW"]
    n = len(T)
    doy = np.tile(np.arange(N), years)
    yidx = np.repeat(np.arange(years), N)
    s_T14, s_T30 = win(T, 0, 14, "mean"), win(T, 0, 30, "mean")
    s_P21, s_SW21 = win(P, 0, 21, "sum"), win(SW, 0, 21, "mean")
    s_Tv = win(T, 45, 120, "mean")
    cTv = loo_clim(s_Tv, years)
    cT14, cT30, cP21, cSW21 = (loo_clim(s, years) for s in (s_T14, s_T30, s_P21, s_SW21))
    b_T7, b_SW7, b_P14 = win(T, -7, 0, "mean"), win(SW, -7, 0, "mean"), win(P, -14, 0, "sum")
    cb_T7, cb_SW7, cb_P14 = (loo_clim(s, years) for s in (b_T7, b_SW7, b_P14))
    drop = rng.random(n) < 0.5            # rows trained WITHOUT recent-weather info -> long-range mode

    blocks = []
    for ck, cp in CROPS.items():
        ft, season, fd = cp["frost_tol"], cp["season"], cp["flower_day"]
        ev_f, ev_h = (Tn < ft).astype(float), (Tx > cp["tmax"]).astype(float)
        s_fe, s_fl, s_hf = win(ev_f, 0, 35, "any"), win(ev_f, season - 20, season, "any"), win(ev_h, fd, fd + 20, "mean")
        c_fe, c_fl, c_hf = (loo_clim(s, years) for s in (s_fe, s_fl, s_hf))
        score = outcome_score(cp, s_T14, s_SW21, s_fe, s_fl, s_hf, s_Tv)
        t_now = np.where(drop, cb_T7, b_T7)
        sw_now = np.where(drop, cb_SW7, b_SW7)
        cols = {
            "doy_sin": np.sin(2 * np.pi * doy / N), "doy_cos": np.cos(2 * np.pi * doy / N),
            "c_T14": cT14, "c_T30": cT30, "c_P21": cP21, "c_SW21": cSW21,
            "c_fe": c_fe, "c_fl": c_fl, "c_hf": c_hf, "c_Tv": cTv,
            "t_now": t_now, "t_anom": np.where(drop, 0, b_T7 - cb_T7),
            "sw_now": sw_now, "sw_anom": np.where(drop, 0, b_SW7 - cb_SW7),
            "p14_anom": np.where(drop, 0, b_P14 - cb_P14),
        }
        X = np.column_stack([cols[f] for f in FEATURES[:15]] +
                            [np.full(n, cp[f], float) for f in FEATURES[15:]])
        keep = (np.arange(n) % step == 0) & ~np.isnan(X).any(1) & ~np.isnan(score)
        blocks.append((X[keep].astype(np.float32), (score[keep] >= GOOD).astype(np.int8),
                       np.full(keep.sum(), loc_idx), yidx[keep], drop[keep], np.full(keep.sum(), list(CROPS).index(ck))))
    return [np.concatenate(z) for z in zip(*blocks)]


def metrics(model, X, y):
    if len(y) == 0 or y.min() == y.max():
        return None
    p = model.predict_proba(X)[:, 1]
    return {"auc": round(float(roc_auc_score(y, p)), 4), "accuracy": round(float(accuracy_score(y, p > 0.5)), 4),
            "brier": round(float(brier_score_loss(y, p)), 4), "n": int(len(y)), "base_rate": round(float(y.mean()), 3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdout", default="", help="comma-separated location names kept out of training")
    ap.add_argument("--test-years", type=int, default=5)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)

    raw = os.path.join(ROOT, "data", "raw")
    files = sorted(glob.glob(os.path.join(raw, "nasa_*.csv")))
    source = "NASA POWER"
    if not files:
        files, source = sorted(glob.glob(os.path.join(raw, "demo_*.csv"))), "synthetic demo data (NOT NASA)"
    if not files:
        sys.exit("No data in data/raw. Run ml/fetch_nasa.py (real) or ml/make_demo_data.py (synthetic).")
    print(f"Data source: {source}  ({len(files)} locations)")

    names, parts, nyears = [], [], []
    for f in files:
        name = os.path.basename(f).split("_", 1)[1][:-4]
        loaded = load_location(f)
        if loaded is None:
            print("  skipping", name, "(no complete years)")
            continue
        arr, ny = loaded
        names.append(name)
        nyears.append(ny)
        parts.append(build_location(arr, ny, len(names) - 1, rng))
        print(f"  {name}: {ny} years")

    hold = [h for h in a.holdout.split(",") if h in names] or list(rng.choice(names, size=min(2, max(1, len(names) // 6)), replace=False))
    print("Held-out locations:", hold)
    X, y, loc, yr, drop, crop = (np.concatenate(z) for z in zip(*parts))
    ny_arr = np.array(nyears)[loc]
    is_hold = np.isin(loc, [names.index(h) for h in hold])
    is_test_year = yr >= ny_arr - a.test_years
    train = ~is_hold & ~is_test_year
    temporal = ~is_hold & is_test_year
    spatial = is_hold
    print(f"Rows: train {train.sum():,}  temporal-test {temporal.sum():,}  spatial-test {spatial.sum():,}")

    sc = StandardScaler().fit(X[train])
    scale = np.where(sc.scale_ < 1e-9, 1.0, sc.scale_)
    Z = (X - sc.mean_) / scale

    t0 = time.time()
    mlp = MLPClassifier(hidden_layer_sizes=(48, 24), activation="relu", early_stopping=True,
                        validation_fraction=0.1, max_iter=80, n_iter_no_change=6, random_state=a.seed)
    mlp.fit(Z[train], y[train])
    print(f"MLP trained in {time.time() - t0:.0f}s ({mlp.n_iter_} epochs)")
    hgb = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.1, random_state=a.seed).fit(X[train], y[train])

    class Wrap:  # lets metrics() treat the MLP + scaler as one model
        def __init__(s, m, f): s.m, s.f = m, f
        def predict_proba(s, X_): return s.m.predict_proba(s.f(X_))
    mlp_w = Wrap(mlp, lambda X_: (X_ - sc.mean_) / scale)

    report = {}
    for mname, model in [("mlp", mlp_w), ("gradient_boosting", hgb)]:
        report[mname] = {}
        for sname, m in [("held_out_years", temporal), ("held_out_locations", spatial)]:
            for mode, dm in [("with_recent_weather", ~drop), ("long_range", drop)]:
                report[mname][f"{sname}/{mode}"] = metrics(model, X[m & dm], y[m & dm])
    print(json.dumps(report, indent=1))

    # ---- export for the website
    rnd = lambda arr_: np.round(np.asarray(arr_, float), 5).tolist()  # noqa: E731
    layers = [{"W": rnd(W), "b": rnd(b)} for W, b in zip(mlp.coefs_, mlp.intercepts_)]
    locs = json.load(open(os.path.join(HERE, "locations.json")))
    crops_export = {k: v for k, v in CROPS.items()}
    model = {"meta": {"data_source": source, "trained_on_locations": names, "held_out_locations": hold,
                      "good_outcome_threshold": GOOD, "trained_at": time.strftime("%Y-%m-%d"),
                      "label_note": "Labels are an agronomic-threshold crop-model proxy, not measured yields."},
             "features": FEATURES, "scaler": {"mean": rnd(sc.mean_), "scale": rnd(scale)},
             "layers": layers, "metrics": report["mlp"], "baseline_metrics": report["gradient_boosting"],
             "crops": crops_export, "locations": locs}
    web = os.path.join(ROOT, "web")
    os.makedirs(web, exist_ok=True)
    with open(os.path.join(web, "model.json"), "w") as f:
        json.dump(model, f, separators=(",", ":"))
    with open(os.path.join(web, "model.js"), "w") as f:
        f.write("window.FARM_MODEL=" + json.dumps(model, separators=(",", ":")) + ";\n")

    # parity vectors so the JS forward pass can be checked against scikit-learn
    pick = rng.choice(len(X), 25, replace=False)
    json.dump([{"x": X[i].astype(float).tolist(), "p": float(mlp_w.predict_proba(X[i:i + 1])[0, 1])} for i in pick],
              open(os.path.join(ROOT, "data", "parity_vectors.json"), "w"))
    print("Wrote web/model.json, web/model.js")


if __name__ == "__main__":
    main()
