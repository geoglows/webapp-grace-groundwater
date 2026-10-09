# Instructions

This code expects you to have already downloaded GLDAS and GRACE MASCON data from NASA. It should be in the following structure:

```text
/path/to/root/
├── GRCTellus.JPL.200204_202604.GLO.RL06.3M.MSCNv04CRI.nc  (name expected to vary but should match GRCTellus*.nc)
└── gldas  (follows the exact structure of the GLDAS data in the S3 storage buckets)
    ├── GLDAS_NOAH025_M.2.1
    │   └── YYYY
    │       └── GLDAS_NOAH025_M.AYYYYMM.2.1.nc4
    ├── GLDAS_VIC10_M.2.1
    │   └── YYYY
    │       └── GLDAS_VIC10_M.AYYYYMM.2.1.nc4
    └── GLDAS_CLSM10_M.2.1
        └── YYYY
            └── GLDAS_CLSM10_M.AYYYYMM.2.1.nc4
```

You can generate the list of URLs to download from the gesdisc pages or by expanding these patterns

```python
urls = []
for model in ["NOAH025", "VIC10", "CLSM10"]:
    for year in range(2002, 2027):
        for month in range(1, 13):
            urls.append(f"https://data.gesdisc.earthdata.nasa.gov/data/GLDAS/GLDAS_{model}_M.2.1/{year}/GLDAS_{model}_M.A{year}{month:02}.021.nc4")

```

One option to download all this data is to obtain an s3 auth token from NASA at:

https://data.gesdisc.earthdata.nasa.gov/s3credentials for GLDAS datasets
https://archive.podaac.earthdata.nasa.gov/s3credentials for GRACE MASCON datasets

Put the accessKeyId, secretAccessKey, and sessionToken into ~/.aws/credentials under the profile names "gesdisc" and
"podaac" respectively. so they look like this:

[gesdisc]
aws_access_key_id = <accessKeyId>
aws_secret_access_key = <secretAccessKey>
aws_session_token = <sessionToken>

Then log on to an ec2 instance in us-west-2 and download them all using s5cmd:

s5cmd --profile gesdisc sync "s3://gesdisc-cumulus-prod-protected/GLDAS/GLDAS_*_M.2.1/*/GLDAS*.nc4" /path/to/root/gldas/
s5cmd --profile podaac sync "s3://podaac-ops-cumulus-protected/GRCTellus.JPL.200204_202604.GLO.RL06.3M.MSCNv04CRI.nc" /path/to/root/

https://archive.podaac.earthdata.nasa.gov/podaac-ops-cumulus-protected/TELLUS_GRAC-GRFO_MASCON_CRI_GRID_RL06.3_V4/GRCTellus.JPL.200204_202604.GLO.RL06.3M.MSCNv04CRI.nc
https://podaac.jpl.nasa.gov/dataset/TELLUS_GRAC-GRFO_MASCON_CRI_GRID_RL06.3_V4#
