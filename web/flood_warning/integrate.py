"""Merge the operational CNN gauges into the web's sites.json + manifest.json.

Idempotent — running twice is fine. Adds the 10 priority operational sites
alongside the existing CAMELS basins, computes flood thresholds from their
3-year hourly USGS history, and registers the dmv-cnn-12h model entry.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .sites import SITES, BY_ID
from .fetch import DATA_DIR, USGS_API_KEY, CFS_TO_M3S, _http_get
import json as _json

REPO = Path(__file__).resolve().parents[2]
WEB = REPO / 'web'


def site_thresholds(gauge_id: str) -> dict | None:
    """Q2/Q5/Q10 from 3 years of hourly USGS data (annual peaks via daily max)."""
    parq = DATA_DIR / gauge_id / 'hourly.parquet'
    if not parq.exists():
        return None
    df = pd.read_parquet(parq)
    daily_peaks = df['flow_m3s'].resample('D').max().dropna()
    if len(daily_peaks) < 365:
        return None
    # Per-year max for a Weibull-style return period; with only 3 years we
    # use empirical quantiles of daily peaks as a stand-in.
    th = {
        'warning':       float(daily_peaks.quantile(0.95)),
        'danger':        float(daily_peaks.quantile(0.99)),
        'extreme':       float(daily_peaks.quantile(0.999)),
        'max_observed':  float(daily_peaks.max()),
        'record_years':  int(len(daily_peaks) / 365),
    }
    return th


STATE_FIPS = {
    '01646500': 'DC', '01648000': 'DC', '01651760': 'DC', '01651800': 'DC',
    '01638500': 'MD', '01649500': 'MD', '01650500': 'MD', '01637500': 'MD',
    '01646000': 'VA', '01644000': 'VA',
}


def main():
    print('-- merging CNN sites into web/sites.json')
    sites_json = json.loads((WEB / 'sites.json').read_text())
    existing_ids = {s['id'] for s in sites_json['sites']}

    # Pull live USGS data for the new operational sites in one batched call.
    missing_ids = [s['id'] for s in SITES if s['id'] not in existing_ids]
    live_obs_by_id = {}
    if missing_ids:
        url = ('https://waterservices.usgs.gov/nwis/dv/?sites='
               + ','.join(missing_ids)
               + '&parameterCd=00060&period=P14D&format=json')
        headers = {'X-Api-Key': USGS_API_KEY} if USGS_API_KEY else {}
        try:
            data = _json.loads(_http_get(url, headers))
            for ts in data.get('value', {}).get('timeSeries', []):
                site = ts.get('sourceInfo', {}).get('siteCode', [{}])[0].get('value')
                if site not in missing_ids:
                    continue
                live_obs_by_id[site] = []
                for v in ts.get('values', [{}])[0].get('value', []):
                    try:
                        cfs = float(v['value'])
                        if cfs < 0: continue
                        live_obs_by_id[site].append({
                            'd': v['dateTime'][:10],
                            'o': round(cfs * CFS_TO_M3S, 3),
                        })
                    except (ValueError, KeyError, TypeError):
                        continue
        except Exception as e:
            print(f'   live USGS fetch failed: {e}')

    # Per-site NOAA NWPS lookup — adds official flood thresholds + NWS
    # observed/forecast stage. Runs for every CNN site, not just new ones,
    # so the data refreshes each cron tick.
    from . import noaa
    print('-- enriching sites with NOAA NWPS data')
    for s in sites_json['sites']:
        gauge = noaa.fetch_gauge(s['id'])
        if gauge:
            s['noaa'] = gauge
            cat = gauge['current'].get('category') or '—'
            stage = gauge['current'].get('stage_ft')
            print(f'   {s["id"]} lid={gauge["lid"]}  current {stage}ft  cat={cat}')

    new_sites = []
    for s in SITES:
        if s['id'] in existing_ids:
            continue
        th = site_thresholds(s['id'])
        live = live_obs_by_id.get(s['id'], [])
        # NOAA gauge record (flood thresholds + NWS current/forecast)
        gauge_noaa = noaa.fetch_gauge(s['id'])
        new_sites.append({
            'id': s['id'],
            'name': s['name'],
            'state': STATE_FIPS.get(s['id'], '?'),
            'lat': s['lat'],
            'lon': s['lon'],
            'drain_area_sqmi': s['drainage_sqmi'],
            'trained': True,
            'thresholds': th,
            'live_obs': live,
            'live_now': (live[-1] if live else None) and {'t': live[-1]['d'] + 'T12:00Z', 'o': live[-1]['o']},
            'precip_forecast_mm': [],
            'kind': s['kind'],
            'noaa': gauge_noaa,
        })
        flow_now = live[-1]['o'] if live else None
        print(f'   + {s["id"]}  {s["short"]:<16}  '
              f'{"" if flow_now is None else f"now {flow_now:.2f} m³/s"}'
              f'  {"thresholds OK" if th else "no thresholds"}')

    sites_json['sites'].extend(new_sites)
    sites_json['updated'] = pd.Timestamp.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    (WEB / 'sites.json').write_text(json.dumps(sites_json, separators=(',', ':')))
    print(f'-- {len(new_sites)} CNN sites added, '
          f'{len(sites_json["sites"])} sites total')

    # Register model in manifest
    print('-- updating models/manifest.json')
    manifest = json.loads((WEB / 'models' / 'manifest.json').read_text())
    if any(m['id'] == 'dmv-cnn-12h' for m in manifest['models']):
        print('   already present')
    else:
        manifest['models'].insert(0, {
            'id': 'dmv-cnn-12h',
            'name': 'DMV CNN — 12h flood warning (hourly)',
            'short': 'DMV-CNN 12h',
            'description': (
                'Two-branch 1D CNN trained per gauge on 3 years of hourly USGS '
                'streamflow + Open-Meteo ERA5 forcings. Input: past 24h flow + '
                'precip + temp + next 12h precip forecast. Output: 12-hour-ahead '
                'flow trajectory. CPU-friendly, ~90s training per gauge.'
            ),
            'family': 'cnn',
            'horizon_days': 0.5,
            'source': 'live-cnn',
            'trained_at': '2026-06-05',
            'metrics': {},
        })
        (WEB / 'models' / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        print('   added dmv-cnn-12h to manifest')


if __name__ == '__main__':
    main()
