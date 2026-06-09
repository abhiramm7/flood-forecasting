"""Pull USGS 3DEP 1/3-arc-second (~10 m) DEM tiles for the DC bounding box.

3DEP COG tiles live on AWS Open Data under
  s3://prd-tnm/StagedProducts/Elevation/13/TIFF/USGS_13_nXXwYYY_*.tif

For DC (bbox -77.3 to -76.85, 38.75 to 39.1) we need tile
  USGS_13_n39w078.tif   (covers 38°-39°N, 77°-78°W — yes, north tile
                          name = upper-right corner of 1° block)

This script downloads what's needed and merges to a single GeoTIFF in
EPSG:5070 (CONUS Albers, equal-area, good for inundation areas).

Run once. Output goes to ../inundation-data/dc_dem.tif (gitignored;
that path is outside the repo to avoid bloating it).
"""
from __future__ import annotations

import os
from pathlib import Path

# Bounding box for DC + the 7 monitored gauges. Lat/lon (WGS84).
DC_BBOX = {
    'min_lon': -77.35,
    'max_lon': -76.85,
    'min_lat': 38.75,
    'max_lat': 39.15,
}

# 1° USGS 3DEP tile naming: tile name encodes the upper-right (N, W) corner.
# For our bbox we need:
#   USGS_13_n39w078.tif  covers 38-39 N, 77-78 W   <- main one
#   USGS_13_n39w077.tif  covers 38-39 N, 76-77 W   <- thin strip on east
# Both are about 480 MB each at full resolution. For a prototype we can
# resample down to ~30 m which collapses the data to ~50 MB.

TILES = ['n39w078', 'n39w077']
OUT_DIR = Path(__file__).resolve().parents[1] / 'inundation-data'
OUT_DIR.mkdir(parents=True, exist_ok=True)


def s3_url(tile: str) -> str:
    return (f'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/'
            f'current/{tile}/USGS_13_{tile}.tif')


def download(tile: str) -> Path:
    """Stream-download one DEM tile from S3 if not cached locally."""
    import urllib.request
    dst = OUT_DIR / f'USGS_13_{tile}.tif'
    if dst.exists() and dst.stat().st_size > 1_000_000:
        print(f'  cached: {dst.name}')
        return dst
    url = s3_url(tile)
    print(f'  fetching {url}')
    urllib.request.urlretrieve(url, dst)
    print(f'  -> {dst.name} ({dst.stat().st_size // (1024*1024)} MB)')
    return dst


def merge_and_clip(tile_paths: list[Path]) -> Path:
    """Merge to one mosaic, clip to DC bbox, reproject to Albers EA."""
    import rasterio
    from rasterio.merge import merge
    from rasterio.warp import calculate_default_transform, reproject, Resampling
    out_path = OUT_DIR / 'dc_dem.tif'

    print('  merging tiles...')
    srcs = [rasterio.open(p) for p in tile_paths]
    mosaic, transform = merge(srcs, bounds=(DC_BBOX['min_lon'], DC_BBOX['min_lat'],
                                             DC_BBOX['max_lon'], DC_BBOX['max_lat']))
    meta = srcs[0].meta.copy()
    meta.update(driver='GTiff', height=mosaic.shape[1], width=mosaic.shape[2],
                transform=transform, compress='deflate')

    # Reproject to CONUS Albers (EPSG:5070) for area-accurate HAND work.
    dst_crs = 'EPSG:5070'
    transform5070, width, height = calculate_default_transform(
        meta['crs'], dst_crs, meta['width'], meta['height'],
        DC_BBOX['min_lon'], DC_BBOX['min_lat'],
        DC_BBOX['max_lon'], DC_BBOX['max_lat'])
    out_meta = meta.copy()
    out_meta.update(crs=dst_crs, transform=transform5070,
                     width=width, height=height)
    with rasterio.open(out_path, 'w', **out_meta) as dst:
        reproject(
            source=mosaic[0], destination=rasterio.band(dst, 1),
            src_transform=transform, src_crs=meta['crs'],
            dst_transform=transform5070, dst_crs=dst_crs,
            resampling=Resampling.bilinear)
    print(f'  wrote {out_path}')
    for s in srcs:
        s.close()
    return out_path


def main():
    print(f'DC bbox: {DC_BBOX}')
    tile_paths = [download(t) for t in TILES]
    return merge_and_clip(tile_paths)


if __name__ == '__main__':
    main()
