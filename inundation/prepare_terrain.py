"""DC LiDAR DSM → web-ready 3D terrain tiles for MapLibre GL JS.

Pipeline (all in one script so it's reproducible):
  1. Open the OpenDataDC LiDAR DSM (1.8 GB, 1 m, EPSG:26985, surface model
     including buildings/trees — the building tops are a feature, not a
     bug, for the 3D view).
  2. Reproject to EPSG:3857 (Web Mercator) at ~3 m resolution. Cuts the
     raster from ~460 M pixels to ~50 M and turns it into something we
     can slice into 256-px tiles.
  3. Generate terrain-RGB PNG tiles for zoom levels 10 through 15.
     Encoding follows Mapbox's standard:
       elevation_m = -10000 + ((R*65536 + G*256 + B) * 0.1)
     MapLibre's `raster-dem` source decodes this natively.
  4. Write tiles to `web/inundation/terrain/{z}/{x}/{y}.png` so they
     can be served by GitHub Pages alongside the rest of the site.

Output: ~1500 PNG tiles totaling ~30 MB.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.windows import from_bounds
import mercantile
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
WORK_DIR = REPO / 'inundation-data'
WORK_DIR.mkdir(parents=True, exist_ok=True)
# Default: render the bare-earth USGS 3DEP DEM (what HAND was computed on)
# so the 3D terrain matches the hydrology. Pass --dsm to use the LiDAR DSM
# instead (includes buildings, more dramatic but mismatches HAND).
DEM_SRC = WORK_DIR / 'aoi_dem.tif'
DSM_SRC = Path('/Users/pluto/Downloads/OpenDataDC_LiDAR_DSM_2020/DSM.tif')
TERRAIN_TIF = WORK_DIR / 'aoi_terrain_3857.tif'
TILE_DIR = REPO / 'web' / 'inundation' / 'terrain'

ZOOM_MIN, ZOOM_MAX = 10, 13   # DEM is ~30 m; beyond z=13 we're just
                              # upsampling pixels with no extra detail.
TILE_SIZE = 256
TARGET_RES_M = 3.0     # downsample resolution in meters (Web Mercator)


def reproject_and_downsample(source: Path | None = None):
    """Reproject + resample the source raster to Web Mercator at TARGET_RES_M."""
    source = source or DEM_SRC
    if TERRAIN_TIF.exists() and TERRAIN_TIF.stat().st_size > 100_000:
        print(f'  cached: {TERRAIN_TIF} ({TERRAIN_TIF.stat().st_size//(1024*1024)} MB)')
        return TERRAIN_TIF

    print(f'  reprojecting {source.name} → EPSG:3857 @ {TARGET_RES_M} m')
    with rasterio.open(source) as src:
        dst_crs = 'EPSG:3857'
        # Compute the destination transform/size sized at our target resolution
        transform, width, height = calculate_default_transform(
            src.crs, dst_crs, src.width, src.height, *src.bounds,
            resolution=(TARGET_RES_M, TARGET_RES_M),
        )
        profile = src.profile.copy()
        profile.update(
            crs=dst_crs, transform=transform, width=width, height=height,
            compress='deflate', predictor=3,
        )
        with rasterio.open(TERRAIN_TIF, 'w', **profile) as dst:
            reproject(
                source=rasterio.band(src, 1),
                destination=rasterio.band(dst, 1),
                src_transform=src.transform, src_crs=src.crs,
                dst_transform=transform, dst_crs=dst_crs,
                resampling=Resampling.bilinear,
            )
    print(f'  wrote {TERRAIN_TIF} ({TERRAIN_TIF.stat().st_size//(1024*1024)} MB, '
           f'{width}×{height})')
    return TERRAIN_TIF


def elevation_to_rgb(elev_m: np.ndarray, nodata: float | None) -> np.ndarray:
    """Mapbox terrain-RGB encoding: height_m = -10000 + value * 0.1.
    Returns (H, W, 3) uint8 array. Invalid pixels get sea-level encoding
    (0 m → R=39,G=16,G=0 approximately) so MapLibre doesn't render a hole.
    """
    e = elev_m.astype(np.float32)
    if nodata is not None:
        e = np.where(e == nodata, 0.0, e)
    e = np.where(np.isfinite(e), e, 0.0)
    v = ((e + 10000.0) / 0.1).clip(0, 256 * 256 * 256 - 1).astype(np.uint32)
    rgb = np.zeros((*e.shape, 3), dtype=np.uint8)
    rgb[..., 0] = (v >> 16) & 0xff
    rgb[..., 1] = (v >> 8) & 0xff
    rgb[..., 2] = v & 0xff
    return rgb


def tile_bounds_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Return (left, bottom, right, top) in EPSG:3857 meters for a slippy tile."""
    b = mercantile.xy_bounds(x, y, z)
    return b.left, b.bottom, b.right, b.top


def render_tile(ds, z: int, x: int, y: int) -> bool:
    """Sample the reprojected DSM at the tile's bbox; write PNG. Returns
    True if any valid pixels exist for that tile (so we can skip empties).
    """
    left, bottom, right, top = tile_bounds_3857(z, x, y)
    try:
        window = from_bounds(left, bottom, right, top, ds.transform)
    except Exception:
        return False

    elev = ds.read(
        1, window=window, out_shape=(TILE_SIZE, TILE_SIZE),
        boundless=True, fill_value=ds.nodata or -9999,
        resampling=Resampling.bilinear,
    )
    nd = ds.nodata
    if nd is not None and np.all(elev == nd):
        return False    # tile is entirely outside DC bbox
    # Tile origin is top-left; rasterio gives north-up so OK.
    rgb = elevation_to_rgb(elev, nd)
    out = TILE_DIR / str(z) / str(x) / f'{y}.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb, 'RGB').save(out, optimize=True)
    return True


def render_pyramid(geotiff: Path):
    """Walk zoom levels, render every tile that intersects DC."""
    # DSM bounds in lat/lon roughly cover DC. Use the file's own bounds.
    with rasterio.open(geotiff) as ds:
        # Reproject the raster bounds back to lat/lon for mercantile.tiles()
        from rasterio.warp import transform_bounds
        west, south, east, north = transform_bounds(
            ds.crs, 'EPSG:4326', *ds.bounds, densify_pts=21,
        )
        print(f'  DC bbox lat/lon: {south:.4f}..{north:.4f}, {west:.4f}..{east:.4f}')

        total_written = 0
        for z in range(ZOOM_MIN, ZOOM_MAX + 1):
            tiles = list(mercantile.tiles(west, south, east, north, z))
            wrote = 0
            for t in tiles:
                if render_tile(ds, t.z, t.x, t.y):
                    wrote += 1
            total_written += wrote
            print(f'  z={z}: {wrote}/{len(tiles)} tiles')
        print(f'  total tiles written: {total_written}')


if __name__ == '__main__':
    import sys
    use_dsm = '--dsm' in sys.argv
    source = DSM_SRC if use_dsm else DEM_SRC
    if not source.exists():
        raise SystemExit(f'source not found at {source}')
    if TILE_DIR.exists():
        print(f'wiping existing tiles: {TILE_DIR}')
        import shutil
        shutil.rmtree(TILE_DIR)
    TILE_DIR.mkdir(parents=True)
    if TERRAIN_TIF.exists():
        TERRAIN_TIF.unlink()
    print(f'1/2 reproject + downsample {"DSM" if use_dsm else "DEM"}')
    geotiff = reproject_and_downsample(source)
    print('2/2 render terrain-RGB tile pyramid')
    render_pyramid(geotiff)
    print(f'done. terrain tiles at {TILE_DIR}')
