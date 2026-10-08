"""
Handwritten by Dr Riley Hales copyright 2026
Water Balance Anomalies using GRACE MASCONs and GLDAS LSMs

The purpose of this script is to compute GWSa using GRACE MASCON measurements and a cocktail of 3 GLDAS products
based on NOAH, VIC, CLSM models. TWSa has temporal gaps when GRACE or GRACE-FO were not making measurements.
Computed GWSa therefore has gaps. Those gaps can be filled by various methods which are not implemented in this script.

Assuming that the surface water storage fluction is small relative to the magnitudes of the others:

TWSa = GWSa + SWEa + CANa + SMa
GWSa = TWSa - SWEa - CANa - SMa

TWSa = total water storage anomaly (GRACE)
GWSa = groundwater storage anomaly (Calculated)
SWEa = snow water equivalent anomaly (GLDAS)
CANa = canopy water storage anomaly (GLDAS)
SMa = soil moisture anomaly (GLDAS)

GRACE MASCON: 0.5 degree, total water storage anomaly -> liquid water equivalent in cm
GLDAS NOAH: 0.25 degree, snow water equivalent, canopy water storage, soil moisture -> liquid water equivalent in mm
GLDAS VIC: 1.0 degree, snow water equivalent, canopy water storage, soil moisture -> liquid water equivalent in mm
GLDAS CLSM: 1.0 degree, snow water equivalent, canopy water storage, soil moisture -> liquid water equivalent in mm

Every input is put on the target resolution (--resolution, 0.5 or 1.0 degree) before anything is combined:
The 0.25 degree GLDAS NOAH cells are aggregated by averaging each block of cells into one target cell.
The 1.0 degree GLDAS VIC and CLSM cells are resampled without interpolation onto the target cell by turning each
1.0 degree cell into several target cells that all carry the same value as the original 1.0 degree cell.
The 0.5 degree GRACE cells are aggregated by averaging, like NOAH, whenever the target is coarser than 0.5 degree.

To run this script, you need to provide the GLDAS and GRACE data inputs. Consult the README for commentary on
preparing the inputs
"""

import argparse
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import xarray as xr
from natsort import natsorted
from zarr.codecs import ZstdCodec

# The native resolution of the GRACE MASCON grid. Unlike the GLDAS products,
# which carry theirs on the dataclasses below and are resampled by
# prepare_dataset, GRACE is read straight from its NetCDF, so the one place that
# knows its resolution is here.
GRACE_RESOLUTION = 0.5


@dataclass(frozen=True, slots=True)
class Gldas:
    files: list[Path]
    model = "GLDAS"
    resolution: float | int = 1
    soil_moisture_variables: list[str] = None
    snow_water_variables = ["SWE_inst", ]
    canopy_variables = ["CanopInt_inst", ]
    lat_variable = "lat"
    lon_variable = "lon"
    time_variable = "time"

    def prepare_dataset(self, resolution, lats=None, lons=None) -> xr.Dataset:
        """
        Prepare GLDAS dataset for GWSa calculation
        """
        print(f"[{self.model}] Preparing dataset from {len(self.files)} files")
        ds = xr.open_mfdataset(self.files, combine='by_coords')
        ds = ds[self.snow_water_variables + self.canopy_variables + self.soil_moisture_variables]
        print(f"[{self.model}] Loading data into memory")
        ds.load()

        if self.resolution == resolution:
            print(f"[{self.model}] Resolution already matches target resolution of {resolution} degree")
        elif self.resolution < resolution:  # finer than target -> aggregate blocks of cells by averaging
            assert resolution / self.resolution % 1 == 0, f"Target resolution is not an integer multiple of source"
            factor = int(round(resolution / self.resolution))
            print(f"[{self.model}] Coarsening from {self.resolution} to {resolution} degree (factor {factor})")
            ds = ds.coarsen({self.lat_variable: factor, self.lon_variable: factor}, boundary='trim').mean()
        else:  # coarser than target -> "downscale" 1 cell into multiple with the same value covering the same space
            assert lats is not None and lons is not None, f"Must provide the lat/lon coordinates to match"
            assert self.resolution / resolution % 1 == 0, f"Target resolution is not an integer multiple of source"
            print(f"[{self.model}] \"Downscaling\" from {self.resolution} to {resolution} degree")
            ds = ds.reindex({self.lat_variable: lats, self.lon_variable: lons}, method='nearest')

        print(f"[{self.model}] Computing anomalies against 200204-200912 baseline")
        # GLDAS variables are kg/m2 or mm so divide by 10 to get cm to match GRACE
        # skipna=False prevents turning nans to zero
        ds['SWE'] = ds[self.snow_water_variables].to_dataarray(dim='variable').sum(dim='variable', skipna=False) / 10
        ds['CAN'] = ds[self.canopy_variables].to_dataarray(dim='variable').sum(dim='variable', skipna=False) / 10
        ds['SM'] = ds[self.soil_moisture_variables].to_dataarray(dim='variable').sum(dim='variable', skipna=False) / 10
        ds['SWE_baseline'] = ds['SWE'].sel(time=slice('2002-04-01', '2009-12-31')).mean(dim='time')
        ds['CAN_baseline'] = ds['CAN'].sel(time=slice('2002-04-01', '2009-12-31')).mean(dim='time')
        ds['SM_baseline'] = ds['SM'].sel(time=slice('2002-04-01', '2009-12-31')).mean(dim='time')
        ds['SWEa'] = ds['SWE'] - ds['SWE_baseline']
        ds['CANa'] = ds['CAN'] - ds['CAN_baseline']
        ds['SMa'] = ds['SM'] - ds['SM_baseline']

        # drop everything except for calculated states, anomalies, and the variables used to calculate them
        return ds.drop_vars(['SWE_baseline', 'CAN_baseline', 'SM_baseline', 'SWE', 'CAN', 'SM'])


@dataclass(frozen=True, slots=True)
class GldasNoah(Gldas):
    model = "NOAH"
    resolution: float | int = 0.25
    soil_moisture_variables: list[str] = field(default_factory=lambda: [
        "SoilMoi0_10cm_inst", "SoilMoi10_40cm_inst", "SoilMoi40_100cm_inst", "SoilMoi100_200cm_inst"
    ])


@dataclass(frozen=True, slots=True)
class GldasVic(Gldas):
    model = "VIC"
    soil_moisture_variables: list[str] = field(default_factory=lambda: [
        "SoilMoi0_30cm_inst", "SoilMoi_depth2_inst", "SoilMoi_depth3_inst"
    ])


@dataclass(frozen=True, slots=True)
class GldasClsm(Gldas):
    model = "CLSM"
    soil_moisture_variables: list[str] = field(default_factory=lambda: ["SoilMoist_P_inst", ])


if __name__ == "__main__":
    # accept the root path as an argument to the script with --root
    parser = argparse.ArgumentParser(description="Compute GWSa from GRACE MASCON and GLDAS LSMs")
    parser.add_argument('--root', type=str, required=True, help='Path to a data directory containing GRACE and GLDAS')
    parser.add_argument('--resolution', type=float, default=0.5, help='Target resolution for output, either 0.5 or 1.0 degree')
    args = parser.parse_args()

    root = Path(args.root)
    output_directory = root / 'zarrs'
    output_directory.mkdir(parents=True, exist_ok=True)
    grace_mascon = list(natsorted(root.glob('GRCTellus*.nc'))).pop(-1)
    print(f"Using GRACE MASCON file: {grace_mascon}")

    target_resolution = args.resolution
    target_resolution = 1.0
    assert target_resolution in (0.5, 1.0), f"Target resolution must be either 0.5 or 1.0 degree"

    output_dataset = output_directory / f'grace-gldas-water-balance-{target_resolution}.zarr'

    print("Globbing GLDAS input files")
    gldas_noah_files = natsorted((root / 'gldas' / 'GLDAS_NOAH025_M.2.1').glob('*/GLDAS*.nc4'))
    gldas_vic_files = natsorted((root / 'gldas' / 'GLDAS_VIC10_M.2.1').glob('*/GLDAS*.nc4'))
    gldas_clsm_files = natsorted((root / 'gldas' / 'GLDAS_CLSM10_M.2.1').glob('*/GLDAS*.nc4'))
    print(f"Found files -> NOAH: {len(gldas_noah_files)}, VIC: {len(gldas_vic_files)}, CLSM: {len(gldas_clsm_files)}")

    print("Opening GRACE MASCON dataset")
    grace = (
        xr
        .open_dataset(root / grace_mascon)
        .rename({'lwe_thickness': 'TWSa', 'uncertainty': 'TWSa_unc'})
        [['TWSa', 'TWSa_unc']]
    )
    # GRACE lons are 0..360 and need to match -180..180 GLDAS
    # GRACE time stamps are in the middle of the month and GLDAS are on the first
    # a couple of months have two GRACE measurements which we average to get a single value per month timeseries
    grace = (
        grace
        .assign_coords(lon=(grace.lon + 180) % 360 - 180).sortby('lon')
        .assign_coords(time=grace['time'].to_index().to_period('M').to_timestamp())
        .groupby('time')
        .mean()
    )

    if target_resolution != GRACE_RESOLUTION:
        assert target_resolution / GRACE_RESOLUTION % 1 == 0, "Target resolution is not an integer multiple of GRACE's"
        grace_factor = int(round(target_resolution / GRACE_RESOLUTION))
        print(f"[GRACE] Coarsening from {GRACE_RESOLUTION} to {target_resolution} degree (factor {grace_factor})")
        grace = grace.coarsen({'lat': grace_factor, 'lon': grace_factor}, boundary='trim').mean()

    # NOAH 0.25 coarsened to 0.5 is the objective since GRACE doesn't cover all latitudes covered by a GLDAS product
    gldas_noah = (
        GldasNoah(files=gldas_noah_files)
        .prepare_dataset(resolution=target_resolution)
    )
    gldas_vic = (
        GldasVic(files=gldas_vic_files)
        .prepare_dataset(resolution=target_resolution, lats=gldas_noah['lat'], lons=gldas_noah['lon'])
    )
    gldas_clsm = (
        GldasClsm(files=gldas_clsm_files)
        .prepare_dataset(resolution=target_resolution, lats=gldas_noah['lat'], lons=gldas_noah['lon'])
    )

    assert np.isin(gldas_noah['lat'].values, grace['lat'].values).any(), \
        "GRACE and GLDAS share no latitude values — TWSa and GWSa would be written entirely as fill"
    assert np.isin(gldas_noah['lon'].values, grace['lon'].values).any(), \
        "GRACE and GLDAS share no longitude values — TWSa and GWSa would be written entirely as fill"

    print("Computing ensemble mean and standard deviation across the 3 GLDAS products")
    avg_swe = np.mean([gldas_noah['SWEa'], gldas_vic['SWEa'], gldas_clsm['SWEa']], axis=0)
    avg_can = np.mean([gldas_noah['CANa'], gldas_vic['CANa'], gldas_clsm['CANa']], axis=0)
    avg_sm = np.mean([gldas_noah['SMa'], gldas_vic['SMa'], gldas_clsm['SMa']], axis=0)
    std_swe = np.std([gldas_noah['SWEa'], gldas_vic['SWEa'], gldas_clsm['SWEa']], axis=0)
    std_can = np.std([gldas_noah['CANa'], gldas_vic['CANa'], gldas_clsm['CANa']], axis=0)
    std_sm = np.std([gldas_noah['SMa'], gldas_vic['SMa'], gldas_clsm['SMa']], axis=0)

    # order of operations is important to make sure grids are aligned and merged in the least complicated ways
    # first final gldas, left merge GRACE, then calculate the GWSa as TWSa - SWEa - CANa - SMa
    ds = (
        xr
        .Dataset(
            {
                'SWEa': (['time', 'lat', 'lon'], avg_swe),
                'CANa': (['time', 'lat', 'lon'], avg_can),
                'SMa': (['time', 'lat', 'lon'], avg_sm),
                'SWEa_unc': (['time', 'lat', 'lon'], std_swe),
                'CANa_unc': (['time', 'lat', 'lon'], std_can),
                'SMa_unc': (['time', 'lat', 'lon'], std_sm),
            },
            coords={
                'time': gldas_noah['time'],
                'lat': gldas_noah['lat'],
                'lon': gldas_noah['lon'],
            }
        )
        .merge(grace, join='left')
        .sel(time=slice(grace['time'].min(), grace['time'].max()))  # force only showing GRACE TWSa time ranges
    )

    # TWSa is only valid over land but has values over oceans which can be masked by looking where GLDAS has values
    land = ds['SWEa'].notnull() & ds['CANa'].notnull() & ds['SMa'].notnull()
    ds['TWSa'] = ds['TWSa'].where(land)
    ds['TWSa_unc'] = ds['TWSa_unc'].where(land)

    print("Merging GLDAS + GRACE and computing GWSa = TWSa - SWEa - CANa - SMa")
    ds['GWSa'] = ds['TWSa'] - ds['SWEa'] - ds['CANa'] - ds['SMa']
    ds['GWSa_unc'] = np.sqrt(ds['TWSa_unc'] ** 2 + ds['SWEa_unc'] ** 2 + ds['CANa_unc'] ** 2 + ds['SMa_unc'] ** 2)

    # Round to reduce precision since uncertainty is >> measurement precision.
    ds['TWSa'] = ds['TWSa'].round(0)
    ds['GWSa'] = ds['GWSa'].round(0)
    ds['SWEa'] = ds['SWEa'].round(0)
    ds['SMa'] = ds['SMa'].round(0)
    # CANa is the exception, and rounding it to whole cm made it identically
    # zero everywhere. GLDAS CanopInt_inst spans 0 to 0.5 kg/m2 (NASA's own
    # documented range), which this pipeline divides by 10 into 0 to 0.05 cm, so
    # the whole variable is smaller than one rounding step and an anomaly is a
    # fraction of that. Its model spread, CANa_unc, sits at 0.001 to 0.03 cm and
    # survived only because it was rounded to 4 decimals. CANa gets the same
    # treatment, and float32 with it: the int16 dtype below stores whole cm.
    ds['CANa'] = ds['CANa'].round(4)
    ds['TWSa_unc'] = ds['TWSa_unc'].round(4)
    ds['GWSa_unc'] = ds['GWSa_unc'].round(4)
    ds['SWEa_unc'] = ds['SWEa_unc'].round(4)
    ds['CANa_unc'] = ds['CANa_unc'].round(4)
    ds['SMa_unc'] = ds['SMa_unc'].round(4)

    print(f"Writing output dataset to {output_dataset}")
    ds['TWSa'].attrs = {'long_name': 'Total Water Storage Anomaly', 'units': 'cm', 'standard_name': 'TWSa'}
    ds['GWSa'].attrs = {'long_name': 'Groundwater Storage Anomaly', 'units': 'cm', 'standard_name': 'GWSa'}
    ds['SWEa'].attrs = {'long_name': 'Snow Water Equivalent Anomaly', 'units': 'cm', 'standard_name': 'SWEa'}
    ds['SMa'].attrs = {'long_name': 'Soil Moisture Anomaly', 'units': 'cm', 'standard_name': 'SMa'}
    ds['CANa'].attrs = {'long_name': 'Canopy Water Storage Anomaly', 'units': 'cm', 'standard_name': 'CANa'}
    ds['TWSa_unc'].attrs = {'long_name': 'TWSa uncertainty', 'units': 'cm'}
    ds['GWSa_unc'].attrs = {'long_name': 'GWSa uncertainty', 'units': 'cm'}
    ds['SWEa_unc'].attrs = {'long_name': 'SWEa uncertainty', 'units': 'cm'}
    ds['SMa_unc'].attrs = {'long_name': 'SMa uncertainty', 'units': 'cm'}
    ds['CANa_unc'].attrs = {'long_name': 'CANa uncertainty', 'units': 'cm'}
    ds['lat'].attrs = {'long_name': 'latitude', 'units': 'degrees_north', 'standard_name': 'latitude', 'axis': 'Y'}
    ds['lon'].attrs = {'long_name': 'longitude', 'units': 'degrees_east', 'standard_name': 'longitude', 'axis': 'X'}
    ds['time'].attrs = {'long_name': 'time', 'standard_name': 'time', 'axis': 'T'}
    ds.attrs = {
        'title': 'GRACE MASCON + GLDAS Water Balance Anomalies',
        'description': 'Derived Groundwater storage anomaly (GWSa) computed from GRACE MASCON Total Water Storage '
                       'anomaly (TWSa) and GLDAS Snow Water Equivalent anomaly (SWEa), Canopy Water Storage anomaly '
                       '(CANa), and Soil Moisture anomaly (SMa).',
        'source': 'GRACE MASCON RL06.3 + GLDAS 2.1 NOAH, VIC, CLSM',
        'sources': [
            'https://disc.gsfc.nasa.gov/datasets/GLDAS_VIC10_M_2.1/summary',
            'https://disc.gsfc.nasa.gov/datasets/GLDAS_CLSM10_M_2.1/summary',
            'https://disc.gsfc.nasa.gov/datasets/GLDAS_NOAH025_M_2.1/summary',
            'https://grace.jpl.nasa.gov/data/get-data/jpl-global-mascons/',
        ],
    }

    (
        ds
        .chunk({
            'time': ds.time.shape[0],
            'lat': 50,
            'lon': 50
        })
        .to_zarr(
            output_dataset,
            mode='w',
            consolidated=True,  # when creating, xarray warns to use false. When reading, it is mad if you didn't
            compute=True,
            zarr_format=3,
            encoding={
                'TWSa': {'compressors': ZstdCodec(level=9), 'dtype': 'int16', '_FillValue': -9999},
                'GWSa': {'compressors': ZstdCodec(level=9), 'dtype': 'int16', '_FillValue': -9999},
                'SWEa': {'compressors': ZstdCodec(level=9), 'dtype': 'int16', '_FillValue': -9999},
                'CANa': {'compressors': ZstdCodec(level=9), 'dtype': 'float32'},
                'SMa': {'compressors': ZstdCodec(level=9), 'dtype': 'int16', '_FillValue': -9999},
                'TWSa_unc': {'compressors': ZstdCodec(level=9), 'dtype': 'float32'},
                'GWSa_unc': {'compressors': ZstdCodec(level=9), 'dtype': 'float32'},
                'SWEa_unc': {'compressors': ZstdCodec(level=9), 'dtype': 'float32'},
                'CANa_unc': {'compressors': ZstdCodec(level=9), 'dtype': 'float32'},
                'SMa_unc': {'compressors': ZstdCodec(level=9), 'dtype': 'float32'},
                'time': {'dtype': 'int32', 'units': 'days since 2002-01-01', 'calendar': 'proleptic_gregorian'},
            },
        )
    )
    print("Done")
