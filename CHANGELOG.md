# Changelog

Notable changes to the app and to the published data. Data entries carry the
`DATA_VERSION` they correspond to, since that is what makes a browser drop its
cached copy of the old values.

## 2026-10-14 — Stores rebuilt and republished (data v3)

First rebuild of the anomaly stores since August. Published to
`grace-gldas-water-balance-{1.0,0.5}-v3.zarr`; the v2 prefixes are still in the
bucket and still readable.

**What changed in the data**

- Canopy water (`CANa`) is no longer zero everywhere. It was being rounded to
  whole centimetres while spanning about ±0.045 cm, which erased it. Now stored
  as float32 to 4 decimals.
- GLDAS anomalies are measured against a 2004-2009 baseline, matching the JPL
  mascons, instead of 2002-04 onward. This moves soil moisture, snow and canopy,
  and groundwater with them.
- GRACE is RL06.3 v4 as of 202607, replacing an earlier release. Each release
  revises the whole record, most heavily in its final months.
- The record runs through 2026-06, one month further than before. It ends where
  GLDAS ends, since groundwater needs both sides.

**How much it moves**

Groundwater shifts about 1 cm for a typical land cell (90th percentile 2 cm,
99th 12 cm). The largest shifts are on Greenland's margin and Novaya Zemlya,
where snow dominates and the groundwater figure means little; cells north of
60°N average 3.1 cm against 1.2-1.3 cm everywhere else.

Trend classifications hold, because the shift is nearly a constant per-cell
offset and a constant offset leaves a slope alone. Against the 0.5 and 2 cm/yr
thresholds, 0.24% of cells change category over the full record and 1.81% over a
5-year window, every one of them between adjacent categories.

**Pipeline changes**

- `--resolution` works. A leftover assignment had pinned every build to 1.0
  degree and written it to the 1.0 filename, so the 0.5 store could not be built.
- `main.py` reads GLDAS from the zarr stores the bucket publishes, and joins any
  newer `.nc4` months to them. A rebuild costs 1.4 GB plus the months past the
  stores' end, rather than ~860 files from NASA.
- `uploadToS3.sh` takes a version tag, defaults to a dry run, and publishes to a
  per-version prefix. Syncing over a live store leaves behind chunks the new
  build does not write, which the new metadata then decodes under the wrong
  dtype — the `CANa` int16 to float32 change orphaned 29 of them.

## 2026-10-09 — Gap filling and recharge analysis ([#12](https://github.com/geoglows/webapp-grace-groundwater/pull/12))

Seasonal gap filling as a three-way control, a Recharge Analysis page using the
water-table-fluctuation method with a seasonality check, and a year editor for
adjusting picks directly.

## 2026-10-08 — Control panel, region sets and trends ([#11](https://github.com/geoglows/webapp-grace-groundwater/pull/11))

Display settings moved from a modal into a left panel, light and dark themes,
multiple published region sets with uploaded regions kept across visits,
per-variable chart colours and grid resolutions, trend classification with a
global per-cell trend map, and cell picking on that map.
