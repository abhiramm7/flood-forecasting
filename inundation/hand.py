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

# Cells with at least N upstream cells become "streams". 4000 cells at
# 10 m resolution ≈ 0.4 km² drainage; reasonable for headwater channels.
STREAM_THRESHOLD = 4000


def compute_hand(dem_path: Path) -> Path:
    """Returns the path to the HAND GeoTIFF."""
    import whitebox
    wbt = whitebox.WhiteboxTools()
    wbt.set_working_dir(str(OUT_DIR))
    wbt.set_verbose_mode(True)

    filled = OUT_DIR / 'dc_dem_filled.tif'
    fdir = OUT_DIR / 'dc_d8_dir.tif'
    facc = OUT_DIR / 'dc_d8_acc.tif'
    streams = OUT_DIR / 'dc_streams.tif'
    hand = OUT_DIR / 'dc_hand.tif'

    print('1/4 fill depressions')
    wbt.fill_depressions(str(dem_path), str(filled))
    print('2/4 D8 flow direction')
    wbt.d8_pointer(str(filled), str(fdir))
    print('3/4 flow accumulation + stream threshold')
    wbt.d8_flow_accumulation(str(filled), str(facc), out_type='cells')
    wbt.extract_streams(str(facc), str(streams), threshold=STREAM_THRESHOLD)
    print('4/4 elevation above stream (the HAND raster)')
    wbt.elevation_above_stream(str(filled), str(streams), str(hand))
    print(f'  wrote {hand}')
    return hand


if __name__ == '__main__':
    import sys
    dem = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT_DIR / 'dc_dem.tif'
    compute_hand(dem)
