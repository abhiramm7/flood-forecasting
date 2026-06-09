"""Pull a bare-earth DEM for our gauge bbox via the USGS National Map
3DEP ImageServer. Way smaller than downloading the full 1° S3 tile.

  https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer

For HAND we want a *Digital Elevation Model* (bare earth), not a Digital
Surface Model — buildings in a DSM act as fake walls and break flow
routing. This script returns 1/3 arc-second (~10m) bare-earth elevation
in EPSG:5070 (CONUS Albers, equal-area, ideal for hydrologic ops).

Output: inundation-data/aoi_dem.tif (~45 MB for our 38×30 km bbox).
"""
from __future__ import annotations

import urllib.request
from pathlib import Path

# Bbox covering all 7 monitored DMV gauges + ~5 km buffer for floodplain
AOI = {
    'west':  -77.30,
    'south':  38.85,
    'east':  -76.86,
    'north':  39.12,
}
TARGET_RES_M = 30           # 30 m in EPSG:5070 — keeps the request inside
                            # the ImageServer's max-pixel limit and is plenty
                            # for HAND at city/watershed scale
OUT = Path(__file__).resolve().parents[1] / 'inundation-data' / 'aoi_dem.tif'
OUT.parent.mkdir(parents=True, exist_ok=True)

BASE = ('https://elevation.nationalmap.gov/arcgis/rest/services/'
        '3DEPElevation/ImageServer/exportImage')


def main():
    # Roughly compute pixel size from the bbox at the AOI center latitude.
    # Albers is equal-area, so meters-per-degree is well-defined enough for
    # a request-side dimension estimate.
    width_km = (AOI['east'] - AOI['west']) * 111.32 * (
        (AOI['north'] + AOI['south']) / 2 * 0.0)  # placeholder; see below
    # Simpler: hardcode dimensions that yield ~10m in Albers
    # 38-39 N, -77 to -77.3 ≈ 38 km × 30 km
    width_px = int((AOI['east'] - AOI['west']) * 111_320 *
                    0.7771 / TARGET_RES_M)         # 0.7771 = cos(38.95°)
    height_px = int((AOI['north'] - AOI['south']) * 111_320 / TARGET_RES_M)
    print(f'  request: {width_px} × {height_px} px @ ~{TARGET_RES_M} m')

    params = {
        'bbox': f'{AOI["west"]},{AOI["south"]},{AOI["east"]},{AOI["north"]}',
        'bboxSR': '4326',
        'imageSR': '5070',
        'size': f'{width_px},{height_px}',
        'format': 'tiff',
        'pixelType': 'F32',
        'noDataInterpretation': 'esriNoDataMatchAny',
        'interpolation': 'RSP_BilinearInterpolation',
        'f': 'image',
    }
    url = BASE + '?' + '&'.join(f'{k}={v}' for k, v in params.items())
    print(f'  GET {url[:130]}…')
    urllib.request.urlretrieve(url, OUT)
    size_mb = OUT.stat().st_size // (1024 * 1024)
    print(f'  wrote {OUT.name} ({size_mb} MB)')

    # Quick sanity check
    import rasterio
    with rasterio.open(OUT) as ds:
        print(f'  CRS: {ds.crs}, size: {ds.width}×{ds.height}, '
               f'res: {ds.res}, nodata: {ds.nodata}')
    return OUT


if __name__ == '__main__':
    main()
