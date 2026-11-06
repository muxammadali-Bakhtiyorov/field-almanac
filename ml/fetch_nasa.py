#!/usr/bin/env python3
"""Download NASA POWER daily data (MERRA-2 / CERES based) for training.

Run this on a machine with normal internet access:

    python ml/fetch_nasa.py                       # the 12 default regions, 2005-2025
    python ml/fetch_nasa.py --start 2000 --end 2025
    python ml/fetch_nasa.py --add my_farm,41.2,69.1   # add your own point(s)

Output: data/raw/nasa_<name>.csv  with columns
    date, T2M, T2M_MIN, T2M_MAX, PRECTOTCORR, GWETROOT, ALLSKY_SFC_SW_DWN

NASA POWER API docs: https://power.larc.nasa.gov/docs/services/api/
No API key needed. Be polite: the script sleeps between requests.
"""
import argparse, csv, json, os, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PARAMS = ["T2M", "T2M_MIN", "T2M_MAX", "PRECTOTCORR", "GWETROOT", "ALLSKY_SFC_SW_DWN"]
API = "https://power.larc.nasa.gov/api/temporal/daily/point"


def fetch_chunk(lat, lon, y0, y1, retries=4):
    q = urllib.parse.urlencode({
        "parameters": ",".join(PARAMS), "community": "AG",
        "longitude": lon, "latitude": lat,
        "start": f"{y0}0101", "end": f"{y1}1231", "format": "JSON",
    })
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(f"{API}?{q}", timeout=120) as r:
                return json.load(r)["properties"]["parameter"]
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"NASA POWER request failed for ({lat},{lon}) {y0}-{y1}: {last}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=2005)
    ap.add_argument("--end", type=int, default=2025)
    ap.add_argument("--add", action="append", default=[], help="name,lat,lon (repeatable)")
    ap.add_argument("--only-added", action="store_true", help="skip the default regions")
    a = ap.parse_args()

    locs = [] if a.only_added else json.load(open(os.path.join(HERE, "locations.json")))
    for s in a.add:
        n, la, lo = s.split(",")
        locs.append({"name": n, "label": n, "lat": float(la), "lon": float(lo)})

    out_dir = os.path.join(ROOT, "data", "raw")
    os.makedirs(out_dir, exist_ok=True)

    for loc in locs:
        rows = {}
        for y0 in range(a.start, a.end + 1, 5):
            y1 = min(y0 + 4, a.end)
            print(f"{loc['name']}: {y0}-{y1}", flush=True)
            par = fetch_chunk(loc["lat"], loc["lon"], y0, y1)
            for k in par["T2M"]:
                rows[k] = [par[p].get(k, -999) for p in PARAMS]
            time.sleep(1.0)
        path = os.path.join(out_dir, f"nasa_{loc['name']}.csv")
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date"] + PARAMS)
            for k in sorted(rows):
                w.writerow([f"{k[:4]}-{k[4:6]}-{k[6:]}"] + rows[k])
        print("wrote", path)
    print("Done. Now run:  python ml/train.py")


if __name__ == "__main__":
    sys.exit(main())
