#!/usr/bin/env bash
#
# Publish rebuilt anomaly stores to the apps bucket.
#
# Each rebuild goes to its own versioned prefix rather than over the one the
# app is reading. Overwriting in place has two problems: a chunk the new build
# no longer writes stays behind and is then decoded under the new array's dtype
# (the int16 -> float32 change in CANa left 29 such chunks), and CloudFront
# serves a mix of old and new pieces until its cache turns over, which the
# upload key cannot force. A new prefix has neither problem, and switching the
# app over is one line in .env, as is switching back.
#
# The version tag should match DATA_VERSION in src/dataVersion.js, which is
# what makes browsers drop their cached copies of the old data.
#
# Credentials come from the usual AWS environment, so set AWS_PROFILE if the
# key for this bucket is not the default one.
#
# Usage: ./uploadToS3.sh <zarrs_root> <version> [--apply]
#        AWS_PROFILE=geoglows ./uploadToS3.sh ~/data/groundwater/zarrs v3
#        AWS_PROFILE=geoglows ./uploadToS3.sh ~/data/groundwater/zarrs v3 --apply

set -euo pipefail

zarrs_root=${1:-}
version=${2:-}
apply=${3:-}

if [ -z "$zarrs_root" ] || [ -z "$version" ]; then
    echo "Usage: $0 <zarrs_root> <version> [--apply]"
    exit 1
fi
if [ ! -d "$zarrs_root" ]; then
    echo "Error: $zarrs_root does not exist or is not a directory"
    exit 1
fi

dryrun="--dryrun"
if [ "$apply" = "--apply" ]; then
    dryrun=""
    echo "Uploading for real."
else
    echo "Dry run. Pass --apply as the third argument to upload."
fi

shopt -s nullglob
stores=("${zarrs_root}"/*.zarr)
if [ ${#stores[@]} -eq 0 ]; then
    echo "Error: no .zarr stores under $zarrs_root"
    exit 1
fi

for store in "${stores[@]}"; do
    name=$(basename "$store" .zarr)
    dest="s3://apps-geoglows-static/ggg/${name}-${version}.zarr/"
    echo "=== ${name}.zarr -> ${dest}"
    aws s3 sync "${store}/" "$dest" $dryrun --only-show-errors
done

echo "Done. Point VITE_ZARR_URL_* in .env at the new prefixes and bump DATA_VERSION to match."
