# DMV Flood Watch

Live flow forecast for 10 USGS gauges around DC. Refreshes every 2 hours.

Live: [abhiramm7.github.io/flood-forecasting](https://abhiramm7.github.io/flood-forecasting/)

A tiny 1D CNN per gauge, trained on three years of hourly USGS streamflow paired with Open-Meteo ERA5 forcings. A GitHub Actions cron runs the inference and pushes new predictions to the static site every two hours. Total compute is about 7 minutes per refresh on a free runner.

## How the UI works

One static HTML file backed by two JSON files (`sites.json` and `models/dmv-cnn-12h/preds.json`). No backend, no database, no auth.

On screen:

- A Leaflet map on the left with a dark Carto basemap and a NEXRAD composite reflectivity overlay from Iowa State Mesonet. Each gauge is a colored dot; green when the gauge is in normal range, yellow/orange/red as the current or forecast flow approaches Q2/Q5/Q10 return-period peaks.
- A gauge feed on the right, sorted by severity. Each row has the current flow, the 12h forecast peak, and a "warning in ~Xh" tag when the model is predicting a Q2 crossing within the horizon.
- A bottom chart for whichever gauge you click. Seven days of USGS observations in green, the model's 1h-ahead nowcast for the same week as a dashed orange line, then the forward 12h forecast as a solid orange line. Hourly precip bars from NOAA QPF run along the bottom on a secondary axis.
- A hero banner up top that reads "All Clear" most of the time and turns yellow/orange/red if any monitored gauge is forecast above threshold.

## The model

`web/flood_warning/model.py`. Two-branch 1D CNN: a 3-channel past stream (flow, precip, temperature for the last 24 hours), and a 1-channel future stream (forecast precip for the next 12 hours). Each goes through a few Conv1D layers, gets flattened, concatenated, and projected to a 12-step output.

```
past   (3 ch x 24h)  ->  Conv1D x 3  ->  flatten
future (1 ch x 12h)  ->  Conv1D x 2  ->  flatten
                         concat -> FC -> 12-step forecast
```

Tiny network. About 50k parameters, trains per gauge in 90 seconds on CPU.

Held-out test NSE (3 years hourly, last 15% as test):

| Gauge | Drainage (mi²) | Test NSE | 12h-ahead NSE |
| --- | ---: | ---: | ---: |
| Potomac at Little Falls (DC) | 11,560 | 0.977 | 0.945 |
| Potomac at Point of Rocks (MD) | 9,651 | 0.965 | 0.921 |
| Goose Creek nr Leesburg (VA) | 332 | 0.700 | 0.601 |
| Anacostia at Kenilworth (DC) | 134 | 0.694 | 0.653 |
| Catoctin Creek (MD) | 67 | 0.648 | 0.547 |
| NE Branch Anacostia (MD) | 73 | 0.436 | 0.175 |
| Rock Creek at Sherrill Dr (DC) | 62 | 0.414 | 0.144 |
| Difficult Run (VA) | 58 | 0.352 | 0.115 |
| NW Branch Anacostia (MD) | 21 | 0.211 | 0.061 |
| Watts Branch (DC) | 3.6 | 0.123 | 0.024 |

The big mainstem gauges are basically solved at hourly resolution. The small urban catchments at the bottom of the table are bad and there's no real way around it: Watts Branch is 3.6 mi² of pavement, it responds to rain in minutes, an hourly model is the wrong tool. Either bump to 15-minute cadence or feed it NEXRAD precip instead of point ERA5.

## The cron

`.github/workflows/dmv-flood-watch.yml` runs every 2 hours. For each gauge it:

1. Pulls 8 days of hourly USGS observed flow and Open-Meteo data.
2. Runs the CNN over the last 7 days at hourly stride, so the UI can show how the model has been tracking lately.
3. Generates a 12-hour forecast from the most recent observation.
4. Writes `web/models/dmv-cnn-12h/preds.json` and `web/sites.json`, auto-commits, and redeploys the static site.

About 7 minutes wall clock per run. The whole thing is one GitHub Actions job and one secret (`USGS_API_KEY`).

## Repo layout

```
web/                              # static site (GitHub Pages source)
├── index.html
├── app.js
├── sites.json
├── models/
│   ├── manifest.json
│   └── dmv-cnn-12h/preds.json
└── flood_warning/
    ├── sites.py                  # the 10 gauges + lat/lon
    ├── fetch.py                  # USGS NWIS + Open-Meteo
    ├── dataset.py                # windowing + scaler
    ├── model.py                  # the CNN
    ├── train.py
    ├── predict.py                # live inference + 7-day backtest
    ├── integrate.py              # merges into sites.json
    ├── checkpoints/              # 10 trained .pt files
    └── requirements-ci.txt

.github/workflows/dmv-flood-watch.yml
```

## Running it locally

Python 3.12. Get a USGS API key from [waterdata.usgs.gov](https://waterdata.usgs.gov) and put it in `.env.local` as `USGS_API_KEY=...`.

```bash
uv venv --python 3.12 .venv
.venv/bin/pip install -r web/flood_warning/requirements-ci.txt
```

To retrain everything from scratch:

```bash
.venv/bin/python -m web.flood_warning.fetch         # 3 years of hourly data, ~5 min
for gid in 01646500 01638500 01648000 01651760 01649500 01650500 01651800 01646000 01644000 01637500; do
  .venv/bin/python -m web.flood_warning.train "$gid"
done                                                # ~15 min total
```

To run one inference cycle locally:

```bash
.venv/bin/python -m web.flood_warning.predict
.venv/bin/python -m web.flood_warning.integrate
cd web && python3 -m http.server 8765               # open http://localhost:8765
```

## Adding a gauge

Add a row to `web/flood_warning/sites.py` with `id`, `name`, `lat`, `lon`, `drainage_sqmi`, `kind`. Then fetch, train, and the next cron picks it up.

## Caveats

This is a prototype. Don't use it to decide whether to drive through floodwater. The official source for that is [NWS AHPS](https://water.weather.gov/ahps/) and [NOAA NWPS](https://water.noaa.gov/).

## License

[Apache 2.0](./LICENSE).
