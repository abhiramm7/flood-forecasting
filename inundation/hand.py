"""Compute the HAND (Height Above Nearest Drainage) raster from a DEM.

HAND has been the standard inundation-mapping backbone since
Rennó et al. 2008. For every cell in the landscape, HAND = (its
elevation) − (elevation of the nearest cell in the stream network).
A cell is "inundated" at stage S if HAND(cell) ≤ S.

Implementation uses WhiteboxTools (free, MIT, pure Rust). The four
steps below are the standard TauDEM/WBT recipe:

  1. Fill depressions (so flow has somewhere to go)
  2. D8 flow direction
  3. Flow accumulation → threshold → stream raster
  4. ElevationAboveStream (the HAND product itself)

Computed once. Result is a single-band GeoTIFF in the same CRS as the
input DEM, with the same resolution. For DC bbox at 10 m it's
~50 MB. Cached under `../inundation-data/dc_hand.tif`.
"""
from __future__ import annotations

from pathlib import Path

OUT_DIR = Path(__file__).resolve().parents[1] / 'inundation-data'

# Cells with at least N upstream cells become "streams". 500 cells at
# 30 m resolution ≈ 0.45 km² drainage; reasonable for headwater channels
# in this AOI without flooding the network with every drainage swale.
STREAM_THRESHOLD = 500


def compute_hand(dem_path: Path) -> Path:
    """Returns the path to the HAND GeoTIFF. WBT requires the input DEM
    to live in the working directory and filenames passed as relative."""
    import shutil
    import whitebox

    # WBT is finicky: with a working directory set, all paths must be
    # relative to that directory. Copy the input DEM into our work dir
    # if it isn't already there, then talk to WBT in relative terms.
    dem_path = Path(dem_path)
    if dem_path.parent.resolve() != OUT_DIR.resolve():
        target = OUT_DIR / dem_path.name
        if not target.exists():
            shutil.copy(dem_path, target)
        dem_path = target

    wbt = whitebox.WhiteboxTools()
    wbt.set_working_dir(str(OUT_DIR))
    wbt.set_verbose_mode(True)
    wbt.set_compress_rasters(True)

    stem = dem_path.stem
    filled = f'{stem}_filled.tif'
    fdir = f'{stem}_d8_dir.tif'
    facc = f'{stem}_d8_acc.tif'
    streams = f'{stem}_streams.tif'
    hand = f'{stem}_hand.tif'

    print('1/4 fill depressions')
    wbt.fill_depressions(dem_path.name, filled)
    print('2/4 D8 flow direction')
    wbt.d8_pointer(filled, fdir)
    print('3/4 flow accumulation + stream threshold')
    wbt.d8_flow_accumulation(filled, facc, out_type='cells')
    wbt.extract_streams(facc, streams, threshold=STREAM_THRESHOLD)
    print('4/4 elevation above stream (the HAND raster)')
    wbt.elevation_above_stream(filled, streams, hand)
    hand_path = OUT_DIR / hand
    print(f'  wrote {hand_path}')
    return hand_path


if __name__ == '__main__':
    import sys
    dem = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT_DIR / 'dc_dem.tif'
    compute_hand(dem)
