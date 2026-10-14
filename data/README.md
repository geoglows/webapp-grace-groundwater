# Instructions

`main.py` needs GLDAS land-surface model output and a GRACE MASCON file, and
writes the anomaly stores the app reads. There are two ways to get the GLDAS
side. The bucket is the cheap one; NASA is the complete one.

## GLDAS from the apps bucket (1.4 GB)

`s3://apps-geoglows-static/ggg/` holds the three GLDAS models as zarr stores
carrying the same raw variables as the NASA files. Sync them into
`gldas_zarrs/` under your data root:

```bash
for m in GLDAS_NOAH025_M.2.1 GLDAS_VIC10_M.2.1 GLDAS_CLSM10_M.2.1; do
  aws --profile geoglows s3 sync \
    "s3://apps-geoglows-static/ggg/$m.zarr/" "/path/to/root/gldas_zarrs/$m.zarr/"
done
```

`aws s3 sync` rather than `s5cmd` because the NOAH store is 58,000 objects and
s5cmd exhausts its thread limit partway through, leaving temp files behind.

These stores trail the NASA archive by a few months. Download the months past
their end as `.nc4` into `gldas/` as below, and `main.py` joins the two,
preferring the store where they overlap.

## GLDAS from NASA

```text
/path/to/root/
├── GRCTellus.JPL.*.nc        (matched as GRCTellus*.nc, newest wins)
├── gldas_zarrs/              (optional, from the bucket)
│   └── GLDAS_*_M.2.1.zarr
└── gldas/                    (whatever months the stores do not cover)
    ├── GLDAS_NOAH025_M.2.1/YYYY/GLDAS_NOAH025_M.AYYYYMM.021.nc4
    ├── GLDAS_VIC10_M.2.1/YYYY/GLDAS_VIC10_M.AYYYYMM.021.nc4
    └── GLDAS_CLSM10_M.2.1/YYYY/GLDAS_CLSM10_M.AYYYYMM.021.nc4
```

Ask CMR which months exist rather than guessing the end of the record:

```bash
curl -s "https://cmr.earthdata.nasa.gov/search/granules.umm_json?short_name=GLDAS_NOAH025_M&version=2.1&page_size=1&sort_key=-start_date"
```

For a handful of files, an Earthdata bearer token over HTTPS is enough. Generate
one from the Generate Token tab on your profile at https://urs.earthdata.nasa.gov,
then:

```bash
curl -L -H "Authorization: Bearer $TOKEN" \
  -o GLDAS_NOAH025_M.A202606.021.nc4 \
  "https://data.gesdisc.earthdata.nasa.gov/data/GLDAS/GLDAS_NOAH025_M.2.1/2026/GLDAS_NOAH025_M.A202606.021.nc4"
```

A 403 carrying `"EULA Acceptance Failure"` means the account has not authorized
that archive. The response body carries the `resolution_url` to approve; GES
DISC and PODAAC are approved separately, so the GRACE file downloading is no
guarantee the GLDAS ones will.

Every month's URL follows one pattern, so the full list expands from it:

```python
urls = []
for model in ["NOAH025", "VIC10", "CLSM10"]:
    for year in range(2000, 2027):
        for month in range(1, 13):
            urls.append(f"https://data.gesdisc.earthdata.nasa.gov/data/GLDAS/GLDAS_{model}_M.2.1/{year}/GLDAS_{model}_M.A{year}{month:02}.021.nc4")
```

For the whole record, get an S3 token from
https://data.gesdisc.earthdata.nasa.gov/s3credentials (GLDAS) or
https://archive.podaac.earthdata.nasa.gov/s3credentials (GRACE), put each under
a profile in `~/.aws/credentials`, and run `s5cmd` from an EC2 instance in
us-west-2 — NASA's direct S3 access only works from that region:

```bash
s5cmd --profile gesdisc sync "s3://gesdisc-cumulus-prod-protected/GLDAS/GLDAS_*_M.2.1/*/GLDAS*.nc4" /path/to/root/gldas/
s5cmd --profile podaac sync "s3://podaac-ops-cumulus-protected/GRCTellus.JPL.*.nc" /path/to/root/
```

## GRACE MASCON

Not in the apps bucket, so it comes from PODAAC either way. It is ~44 MB, so
the token-over-HTTPS route above is usually simplest. The current filename
changes with each release, which CMR will tell you:

```bash
curl -s "https://cmr.earthdata.nasa.gov/search/granules.umm_json?short_name=TELLUS_GRAC-GRFO_MASCON_CRI_GRID_RL06.3_V4&page_size=1&sort_key=-start_date"
```

Each release revises the whole record, most heavily in its final months, so a
rebuild against a newer release shifts TWSa slightly nearly everywhere.

https://podaac.jpl.nasa.gov/dataset/TELLUS_GRAC-GRFO_MASCON_CRI_GRID_RL06.3_V4

## Building and publishing

```bash
uv sync -p 3.14   # 3.15 has no numpy wheels yet and the source build fails
uv run python main.py --root /path/to/root --resolution 1.0
uv run python main.py --root /path/to/root --resolution 0.5
```

Output lands in `<root>/zarrs/`. The record ends wherever GLDAS does, since
GWSa needs both sides; GRACE months past that are dropped.

Then publish, bump `DATA_VERSION` in `src/dataVersion.js` to match the version
tag, and point `VITE_ZARR_URL_*` in `.env` at the new prefixes:

```bash
AWS_PROFILE=geoglows ./uploadToS3.sh /path/to/root/zarrs v3           # dry run
AWS_PROFILE=geoglows ./uploadToS3.sh /path/to/root/zarrs v3 --apply
```

See the comment at the top of `uploadToS3.sh` for why each rebuild goes to its
own prefix instead of over the one the app is reading.
