"""10 priority DMV gauges for the hourly flood warning prototype.

Mix of urban (Anacostia, Rock Creek, Watts Branch), suburban (Difficult Run,
Goose Creek), and rural/mainstem (Potomac at Little Falls + Point of Rocks,
Catoctin). Drainage areas span 3 sq mi (Watts Branch) to 11,500 sq mi
(Potomac at Little Falls) — gives the CNN a broad range to learn from.
"""

SITES = [
    {
        'id': '01646500', 'name': 'Potomac at Little Falls', 'short': 'Potomac DC',
        'lat': 38.9498, 'lon': -77.1276,
        'drainage_sqmi': 11560,
        'kind': 'mainstem',
        'notes': 'The headline DC-region gauge. Drains 11,500 sq mi.',
    },
    {
        'id': '01638500', 'name': 'Potomac at Point of Rocks', 'short': 'Potomac POR',
        'lat': 39.2736, 'lon': -77.5431,
        'drainage_sqmi': 9651,
        'kind': 'mainstem',
        'notes': 'Upstream Potomac, ~50 mi above DC.',
    },
    {
        'id': '01648000', 'name': 'Rock Creek at Sherrill Dr', 'short': 'Rock Creek',
        'lat': 38.9725, 'lon': -77.04,
        'drainage_sqmi': 62.2,
        'kind': 'urban',
        'notes': 'Rock Creek through NW DC — flashy urban watershed.',
    },
    {
        'id': '01651760', 'name': 'Anacostia at Kenilworth', 'short': 'Anacostia',
        'lat': 38.9092, 'lon': -76.9553,
        'drainage_sqmi': 134,
        'kind': 'urban',
        'notes': 'Anacostia mainstem at NE DC.',
    },
    {
        'id': '01649500', 'name': 'NE Branch Anacostia at Riverdale', 'short': 'NE Anacostia',
        'lat': 38.9603, 'lon': -76.926,
        'drainage_sqmi': 72.8,
        'kind': 'urban',
        'notes': 'Major Anacostia tributary, suburban PG County.',
    },
    {
        'id': '01650500', 'name': 'NW Branch Anacostia nr Colesville', 'short': 'NW Anacostia',
        'lat': 39.0655, 'lon': -77.0294,
        'drainage_sqmi': 21.1,
        'kind': 'urban',
        'notes': 'NW Branch Anacostia in MoCo.',
    },
    {
        'id': '01651800', 'name': 'Watts Branch at DC', 'short': 'Watts Branch',
        'lat': 38.9013, 'lon': -76.9433,
        'drainage_sqmi': 3.59,
        'kind': 'urban',
        'notes': 'Small urban tributary in SE DC — flash flood prone.',
    },
    {
        'id': '01646000', 'name': 'Difficult Run nr Great Falls', 'short': 'Difficult Run',
        'lat': 38.9759, 'lon': -77.2458,
        'drainage_sqmi': 57.9,
        'kind': 'suburban',
        'notes': 'NoVa suburban watershed, flashy on storms.',
    },
    {
        'id': '01644000', 'name': 'Goose Creek nr Leesburg', 'short': 'Goose Creek',
        'lat': 39.0196, 'lon': -77.5775,
        'drainage_sqmi': 332,
        'kind': 'suburban',
        'notes': 'Loudoun County, drains into Potomac.',
    },
    {
        'id': '01637500', 'name': 'Catoctin Creek nr Middletown', 'short': 'Catoctin',
        'lat': 39.4273, 'lon': -77.5562,
        'drainage_sqmi': 66.9,
        'kind': 'rural',
        'notes': 'Frederick County, MD farmland.',
    },
]

BY_ID = {s['id']: s for s in SITES}
