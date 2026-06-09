# Inundation mapping for DC

Branch-only exploration. Goal: take a DEM for the DC area and convert
forecast streamflow / stage into actual flooded-area polygons for the
Leaflet map.

## Approach

A simplified version of [NOAA-OWP/inundation-mapping][fim]. That
project's full pipeline (HAND + synthetic rating curves + Docker
toolchain) is too heavy for what we want here, but the underlying idea
adapts cleanly:

```
       DEM           NHD streams       gauge + stage forecast
        │                │                       │
        ▼                ▼                       ▼
   compute HAND  ◄── drainage network    NWM short-range (hydrotools)
        │                                        │
        └──────────► HAND raster ◄───────────────┘
                          │
                          ▼
              threshold pixels where HAND ≤ stage
                          │
                          ▼
                 polygonize → GeoJSON
                          │
                          ▼
             Leaflet inundation overlay (per gauge)
```

HAND ("Height Above Nearest Drainage") is the vertical distance from
any cell on the landscape to its nearest drainage cell. Once we have
the HAND raster, inundation for a given forecast stage S is just:

```python
inundated = (HAND <= S) & (HAND >= 0)
```

…and then vectorize. This is a coarse but defensible approximation
that real FIM systems use as their backbone. Hydraulic effects
(backwater, levees, bridges) are missed; surface area and shape are
roughly right for low-gradient watersheds like the Potomac/Anacostia.

## Data sources

- **DEM**: USGS 3DEP 1/3-arc-second (~10 m) COG tiles on
  `s3://prd-tnm/StagedProducts/Elevation/13/...`. Free, no auth. For
  DC we need tiles around `n39w078` and `n39w077`.
- **Streams**: USGS NHD high-res hydrography (HUC 02070008/10) as GeoJSON.
- **Forecasts**:
  - NOAA NWM short-range streamflow per reach
    (`hydrotools.nwm_client` or our existing `noaa.py`)
  - NWS AHPS forecast stage per gauge (already in `web/sites.json`'s
    `noaa.nws_forecast` field after the NWPS overlay landed on `main`)
- **Reference**: NOAA's published FIM library on AWS Open Data
  (`s3://noaa-nws-owp-fim-data`) for HUC-level pre-computed HAND +
  synthetic rating curves. If we go production, swap our HAND
  computation for this.

## Files in this directory

- `fetch_dem.py`  — pull USGS 3DEP COG tiles for a bbox, mosaic, reproject
- `hand.py`       — compute HAND raster from a DEM (uses WhiteboxTools)
- `inundate.py`   — stage → flooded GeoJSON polygon (for one gauge)
- `pipeline.py`   — end-to-end orchestrator: DEM → HAND → polygons
- `requirements.txt` — extra deps (rasterio, whitebox, geopandas,
                       shapely, hydrotools.nwm_client)

## Why not just use the inundation-mapping repo directly?

[NOAA-OWP/inundation-mapping][fim] is excellent but is:

- Docker-only (the dependency tree is GDAL+TauDEM+OSGeo + custom code)
- Designed around the FIM-4 dataset (~200 GB CONUS-wide)
- Aimed at HUC-level batch evaluation, not interactive web overlays

For an interactive prototype focused on 7 DC-area gauges, we can:

1. Pre-compute one HAND raster for the DC bbox (one-time, ~minutes)
2. At forecast time, just threshold the HAND raster and polygonize
3. Push the resulting GeoJSON to the static site

If/when we want real production accuracy, replace step 1 with
"download the pre-computed HAND for HUC 02070008/02070010 from the
NOAA FIM library."

[fim]: https://github.com/NOAA-OWP/inundation-mapping

## HydroTools integration

The [`hydrotools`][ht] package is a data-access toolkit — it doesn't
do inundation itself but is the cleanest way to pull the inputs:

```python
from hydrotools.nwm_client import gcp_client
df = gcp_client.NWMClient(...).get(...)
```

We already pull the same NWM short-range feed via NWPS in
`web/flood_warning/noaa.py`. For the inundation pipeline we can stick
with that single dependency. `hydrotools.nwis_client` is also useful
if we want stage-curve calibration data (USGS gauge readings paired
with field surveys), but that's a later refinement.

[ht]: https://noaa-owp.github.io/hydrotools/

## Roadmap

| Step | Status | Notes |
| --- | --- | --- |
| 1. Pull DEM tiles for DC bbox | scaffold only | `fetch_dem.py` written, not run |
| 2. Compute HAND raster | scaffold only | `hand.py`, depends on WhiteboxTools |
| 3. Stage → polygon | scaffold only | `inundate.py`, threshold + rasterio.features.shapes |
| 4. Per-gauge polygon files in `web/inundation/<lid>_<stage>.geojson` | not started | needs steps 1-3 |
| 5. Leaflet overlay layer + toggle | not started | `app.js`, swap to GeoJSON on each forecast tick |
| 6. CI: refresh polygons on each cron firing | not started | only when forecast stage changes by more than X ft |

This branch holds the scaffold. Merge to `main` once steps 1-3 produce
real polygons for at least one gauge.
