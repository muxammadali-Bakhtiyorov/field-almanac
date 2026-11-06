"""Crop characteristics used by both the ML pipeline and the website.

Agronomic thresholds are textbook-level approximations (FAO / extension-service
ranges). Replace or tune them for your region -- everything downstream
(labels, model, website) is regenerated from this table by train.py.

Fields
  tmin_plant / tmax_plant : mean air temperature range (C) for sowing & emergence
  tmax                    : daily max temperature (C) above which flowering is stressed
  frost_tol               : daily min temperature (C) below which frost damage occurs
  moist                   : minimum root-zone soil wetness (NASA GWETROOT, 0-1)
  season                  : days from sowing to maturity
  flower_day              : days after sowing when the heat-sensitive flowering stage starts
  water_mm / income       : seasonal water use (mm) / illustrative income index (0-1)
  soil_fit                : suitability by soil texture (0-1)
"""

CROPS = {
    "winter_wheat": dict(label="Winter wheat", family="Poaceae", legume=False, root="medium",
        n_demand="high", tmin_plant=3, tmax_plant=18, tmax=32, frost_tol=-15, moist=0.30,
        season=240, flower_day=196, water_mm=450, income=0.50,
        soil_fit=dict(sandy=0.6, loam=1.0, clay=0.8)),
    "canola": dict(label="Winter canola", family="Brassicaceae", legume=False, root="deep",
        n_demand="high", tmin_plant=3, tmax_plant=20, tmax=28, frost_tol=-12, moist=0.35,
        season=250, flower_day=195, water_mm=450, income=0.60,
        soil_fit=dict(sandy=0.5, loam=1.0, clay=0.8)),
    "maize": dict(label="Maize", family="Poaceae", legume=False, root="deep",
        n_demand="high", tmin_plant=10, tmax_plant=30, tmax=35, frost_tol=-1, moist=0.40,
        season=130, flower_day=72, water_mm=600, income=0.60,
        soil_fit=dict(sandy=0.5, loam=1.0, clay=0.7)),
    "cotton": dict(label="Cotton", family="Malvaceae", legume=False, root="deep",
        n_demand="high", tmin_plant=15, tmax_plant=35, tmax=38, frost_tol=0, moist=0.35,
        season=170, flower_day=85, water_mm=700, income=0.80,
        soil_fit=dict(sandy=0.5, loam=1.0, clay=0.8)),
    "potato": dict(label="Potato", family="Solanaceae", legume=False, root="shallow",
        n_demand="high", tmin_plant=7, tmax_plant=22, tmax=30, frost_tol=-1, moist=0.45,
        season=110, flower_day=55, water_mm=500, income=0.80,
        soil_fit=dict(sandy=0.9, loam=1.0, clay=0.4)),
    "tomato": dict(label="Tomato", family="Solanaceae", legume=False, root="medium",
        n_demand="high", tmin_plant=14, tmax_plant=35, tmax=35, frost_tol=0, moist=0.45,
        season=120, flower_day=60, water_mm=550, income=0.90,
        soil_fit=dict(sandy=0.7, loam=1.0, clay=0.6)),
    "soybean": dict(label="Soybean", family="Fabaceae", legume=True, root="medium",
        n_demand="low", tmin_plant=12, tmax_plant=32, tmax=35, frost_tol=0, moist=0.40,
        season=120, flower_day=66, water_mm=500, income=0.60,
        soil_fit=dict(sandy=0.5, loam=1.0, clay=0.9)),
    "chickpea": dict(label="Chickpea", family="Fabaceae", legume=True, root="deep",
        n_demand="low", tmin_plant=5, tmax_plant=25, tmax=33, frost_tol=-6, moist=0.30,
        season=110, flower_day=66, water_mm=300, income=0.55,
        soil_fit=dict(sandy=0.8, loam=1.0, clay=0.6)),
    "sunflower": dict(label="Sunflower", family="Asteraceae", legume=False, root="deep",
        n_demand="medium", tmin_plant=8, tmax_plant=30, tmax=35, frost_tol=-3, moist=0.30,
        season=120, flower_day=66, water_mm=400, income=0.55,
        soil_fit=dict(sandy=0.7, loam=1.0, clay=0.8)),
    "watermelon": dict(label="Watermelon", family="Cucurbitaceae", legume=False, root="medium",
        n_demand="medium", tmin_plant=16, tmax_plant=35, tmax=38, frost_tol=0, moist=0.40,
        season=95, flower_day=40, water_mm=450, income=0.70,
        soil_fit=dict(sandy=1.0, loam=0.9, clay=0.5)),
}

CROP_KEYS = list(CROPS.keys())

# Winter crops need a cold spell (vernalization) 45-120 days after sowing to flower.
for _k, _c in CROPS.items():
    _c["winter"] = _k in ("winter_wheat", "canola")

# Season-simulation & economics parameters (approximate, editable; used by the website's
# survival/yield simulation and the investor workspace -- NOT by the suitability ML model).
#   tbase/gdd : base temperature (C) and thermal time (C-days) from sowing to maturity
#   ypot      : attainable yield, t/ha, in a good season with good management
#   price     : placeholder farm-gate price, USD/t  (users should enter their local price)
#   plants_ha, seed_cost_ha, other_cost_ha : plants per hectare, seed/seedling cost and all other costs, USD/ha
_ECON = {
 #                 tbase  gdd   ypot  price  plants_ha  seed_ha other_ha
 "winter_wheat": (0,   2000,  6.5,  240,  3500000,   120,  450),
 "canola":       (0,   2100,  3.5,  480,   500000,    60,  550),
 "maize":        (10,  1500, 10.0,  210,    70000,   150,  700),
 "cotton":       (15,  1400,  4.0,  520,   100000,    80, 1100),
 "potato":       (5,   1300, 40.0,  180,    40000,  1500, 2000),
 "tomato":       (10,  1400, 80.0,  160,    30000,  2400, 4500),
 "soybean":      (10,  1500,  3.5,  450,   400000,   110,  400),
 "chickpea":     (5,   1400,  2.2,  700,   400000,   120,  300),
 "sunflower":    (6,   1750,  3.2,  450,    60000,   100,  400),
 "watermelon":   (12,  1100, 45.0,  160,     6000,  1500, 2500),
}
for _k, (_tb, _g, _y, _p, _pl, _sd, _ot) in _ECON.items():
    CROPS[_k].update(tbase=_tb, gdd=_g, ypot=_y, price=_p, plants_ha=_pl, seed_cost_ha=_sd, other_cost_ha=_ot)
