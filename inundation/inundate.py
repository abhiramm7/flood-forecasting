"""Stage → inundation polygon. Threshold the HAND raster at the forecast
stage, polygonize, simplify, write GeoJSON to web/inundation/<lid>_<stage>.geojson.

The geo workflow:
  1. Load HAND raster (one-time precompute)
  2. mask = (HAND ≤ stage_m) & (HAND ≥ 0)
  3. rasterio.features.shapes(mask) → polygons in raster CRS
  4. Reproject polygons to EPSG:4326 (web Mercator-friendly for Leaflet)
  5. Simplify with shapely (0.5 m tolerance ≈ visually identical, smaller file)
  6. Write GeoJSON FeatureCollection with stage + gauge metadata

At ~10 m resolution for DC bbox, a major-flood polygon is on the order
of 100 KB GeoJSON. Action-stage polygons are tens of KB.
"""
from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT_WEB = REPO / 'web' / 'inundation'   # GeoJSON ends up here
OUT_WEB.mkdir(parents=True, exist_ok=True)

# Convert feet → meters once at the boundary so the polygon code uses
# raster-native units (the DEM and HAND are both in meters).
FT_TO_M = 0.3048


def inundate(hand_path: Path, stage_ft: float, lid: str,
              gauge_meta: dict | None = None) -> Path:
    """One forecast stage → one GeoJSON polygon.

    Args:
        hand_path: path to the precomputed HAND raster
        stage_ft: forecast or threshold stage above the local stream (NWS
                   AHPS units are feet). HAND ≤ this stage = inundated.
        lid: NWPS gauge id, used in the output filename
        gauge_meta: optional extra metadata baked into the GeoJSON props
    """
    import rasterio
    from rasterio import features
    import numpy as np
    from shapely.geometry import shape, mapping
    from shapely.ops import transform as shape_transform
    import pyproj

    stage_m = stage_ft * FT_TO_M

    with rasterio.open(hand_path) as ds:
        hand = ds.read(1)
        transform = ds.transform
        crs = ds.crs

    mask = (hand >= 0) & (hand <= stage_m)
    mask_u8 = mask.astype('uint8')

    geoms = []
    for geom, val in features.shapes(mask_u8, mask=mask, transform=transform):
        if val == 1:
            geoms.append(shape(geom))

    if not geoms:
        print(f'  no inundated pixels at stage {stage_ft} ft')
        return None

    # Merge component polygons + simplify in source CRS. Tolerance of one
    # raster cell (~30m) keeps a "stair-step pixel" look from leaking into
    # the GeoJSON; we drop micro-polygons under 0.01 km² to cut file size.
    from shapely.ops import unary_union
    merged = unary_union(geoms)
    if hasattr(merged, 'geoms'):
        merged = type(merged)([g for g in merged.geoms if g.area > 10_000])
    merged = merged.simplify(60.0, preserve_topology=True)

    # Reproject to WGS84 lat/lon for Leaflet
    project = pyproj.Transformer.from_crs(crs, 'EPSG:4326', always_xy=True).transform
    merged_wgs = shape_transform(project, merged)

    feature = {
        'type': 'Feature',
        'geometry': mapping(merged_wgs),
        'properties': {
            'lid': lid,
            'stage_ft': stage_ft,
            **(gauge_meta or {}),
        },
    }
    fc = {'type': 'FeatureCollection', 'features': [feature]}
    out_path = OUT_WEB / f'{lid}_{stage_ft:g}ft.geojson'
    out_path.write_text(json.dumps(fc, separators=(',', ':')))
    print(f'  wrote {out_path.name} ({out_path.stat().st_size // 1024} KB)')
    return out_path


if __name__ == '__main__':
    import sys
    HAND_DEFAULT = REPO / 'inundation-data' / 'aoi_dem_hand.tif'
    hand_path = Path(sys.argv[1]) if len(sys.argv) > 1 else HAND_DEFAULT
    lid = sys.argv[2] if len(sys.argv) > 2 else 'TEST'
    stage = float(sys.argv[3]) if len(sys.argv) > 3 else 10.0
    inundate(hand_path, stage, lid)
