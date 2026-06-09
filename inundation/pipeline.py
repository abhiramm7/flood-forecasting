"""End-to-end orchestrator: takes the live NWS forecast stages from the
NWPS API (or our local sites.json) and produces inundation polygons for
each monitored gauge.

Run pattern:
    python -m inundation.pipeline           # uses sites.json
    python -m inundation.pipeline --stages 5,10,12,14   # arbitrary stages

For each gauge, we generate polygons at four levels (action / minor /
moderate / major) plus the live NWS forecast stage. Eight gauges × five
polygons ≈ 40 GeoJSON files, < 5 MB total.

Outputs to web/inundation/, picked up by app.js as Leaflet overlays.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
HAND = REPO / 'inundation-data' / 'dc_hand.tif'
SITES = REPO / 'web' / 'sites.json'


def main():
    if not HAND.exists():
        print(f'! missing HAND raster at {HAND}')
        print('  run: python -m inundation.fetch_dem')
        print('  then: python -m inundation.hand')
        sys.exit(1)

    from .inundate import inundate

    sites = json.loads(SITES.read_text())
    for site in sites['sites']:
        noaa = site.get('noaa') or {}
        lid = noaa.get('lid')
        if not lid:
            continue
        th = noaa.get('thresholds_stage_ft') or {}
        fc_stage = (noaa.get('nws_forecast') or {}).get('stage_ft')

        stages = {k: v for k, v in th.items() if v is not None}
        if fc_stage is not None:
            stages['nws_forecast'] = fc_stage

        print(f'\n{lid} ({site["name"]})')
        for label, stage in stages.items():
            print(f'  stage {label} = {stage} ft')
            inundate(HAND, stage, f'{lid}_{label}',
                      gauge_meta={'site_id': site['id'], 'level': label})


if __name__ == '__main__':
    main()
