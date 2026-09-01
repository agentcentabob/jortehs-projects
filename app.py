from flask import Flask, render_template, jsonify, request, Response
import requests
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
import threading
import time
import pytz
import os
from dotenv import load_dotenv
from google.transit import gtfs_realtime_pb2

from logic import setchecker


load_dotenv()

app = Flask(__name__)

API_KEY = os.getenv('TFNSW_API_KEY')
API_BASE_URL = 'https://api.transport.nsw.gov.au/v1/tp'

# without this a hung upstream connection blocks the request forever
REQUEST_TIMEOUT = 20

# v2 replaced v1 for sydneytrains/metro/innerwest only (v1 404s for those);
# cbdandsoutheast and nswtrains still live on v1
GTFS_V1 = 'https://api.transport.nsw.gov.au/v1/gtfs'
GTFS_V2 = 'https://api.transport.nsw.gov.au/v2/gtfs'

VEHICLE_FEEDS = {
    'sydneytrains': f'{GTFS_V2}/vehiclepos/sydneytrains',
    'metro': f'{GTFS_V2}/vehiclepos/metro',
    'lightrail_innerwest': f'{GTFS_V2}/vehiclepos/lightrail/innerwest',
    'lightrail_cbdse': f'{GTFS_V1}/vehiclepos/lightrail/cbdandsoutheast',
    'nswtrains': f'{GTFS_V1}/vehiclepos/nswtrains',
}

# gtfs-realtime VehicleStopStatus enum
VEHICLE_STOP_STATUS = {0: 'INCOMING_AT', 1: 'STOPPED_AT', 2: 'IN_TRANSIT_TO'}

# feeds refresh every ~10-30s upstream, so a short cache stops platform
# switching and polling from making redundant calls
_feed_cache = {}
FEED_CACHE_SECONDS = 5

# proxied so the browser never talks to OSM directly - no CDN or mapping
# library needed. OSM requires an identifying User-Agent and discourages
# heavy traffic, hence the cache
OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
OSM_USER_AGENT = 'virtualdpb-tfnsw/1.0 (student project; local use)'
_tile_cache = {}
TILE_CACHE_MAX = 500

# names platform-level stop ids - the only published way to know a
# service's arrival platform ahead of time. same v1/v2 split as
# VEHICLE_FEEDS; nswtrains has none
TRIP_UPDATE_FEEDS = {
    'sydneytrains': f'{GTFS_V2}/realtime/sydneytrains',
    'metro': f'{GTFS_V2}/realtime/metro',
    'lightrail_innerwest': f'{GTFS_V2}/realtime/lightrail/innerwest',
    'lightrail_cbdse': f'{GTFS_V1}/realtime/lightrail/cbdandsoutheast',
}
_trip_update_cache = {}
TRIP_UPDATE_CACHE_SECONDS = 20

# stop id -> name. only metro/light rail need this (heavy rail spells the
# station out in its berth string). a lookup takes ~3s, so resolved in the
# background; cache never expires - names don't change
_stop_name_cache = {}
_stop_name_pending = set()
_stop_name_lock = threading.Lock()
_stop_name_pool = ThreadPoolExecutor(max_workers=6)
STOP_NAME_MAX_IDS = 60  # per request
# in flight at once, so one bad batch can't flood TfNSW
STOP_NAME_MAX_PENDING = 40


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/design/<path:board_name>")
def board(board_name):
    return render_template(f"design/{board_name}.html")


@app.route('/api/departures', methods=['GET'])
def get_departures():
    stop_id = request.args.get('stop_id')
    if not stop_id:
        return jsonify({'error': 'stop_id is required'}), 400

    sydney_tz = pytz.timezone('Australia/Sydney')
    now = datetime.now(sydney_tz)
    itd_date = now.strftime('%Y%m%d')
    itd_time = now.strftime('%H%M')

    params = {
        'outputFormat': 'rapidJSON',
        'coordOutputFormat': 'EPSG:4326',
        'mode': 'direct',
        'type_dm': 'stop',
        'name_dm': stop_id,
        'depArrMacro': 'dep',
        'itdDate': itd_date,
        'itdTime': itd_time,
        'TfNSWTR': 'true',
        # default window (40 events) is shared across every mode at the stop,
        # chronologically - at a big multi-modal interchange like Central the
        # buses alone fill it, leaving as few as 3 metro events after
        # client-side filtering. 150 reliably leaves 10+ metro events even
        # there; verified against live data, no evidence of a server-side cap
        'limit': 150
    }

    headers = {
        'Authorization': f'apikey {API_KEY}'
    }

    # tfnsw returns the odd 5xx for no reason - one retry turns most of
    # them into a normal response
    last_error = None
    for attempt in range(2):
        try:
            response = requests.get(
                f'{API_BASE_URL}/departure_mon',
                params=params,
                headers=headers,
                timeout=REQUEST_TIMEOUT
            )
            response.raise_for_status()
            return jsonify(response.json())
        except requests.exceptions.RequestException as e:
            last_error = e
            if attempt == 0:
                time.sleep(0.4)

    return jsonify({'error': str(last_error)}), 502


@app.route('/api/stops', methods=['GET'])
def get_stops():
    # search for stops by name or stop id
    search_query = request.args.get('q', '').strip()
    if not search_query:
        return jsonify({'stops': []})

    params = {
        'outputFormat': 'rapidJSON',
        'coordOutputFormat': 'EPSG:4326',
        'type_sf': 'any',
        'name_sf': search_query,
        'TfNSWSF': 'true'
    }

    headers = {
        'Authorization': f'apikey {API_KEY}'
    }

    try:
        response = requests.get(
            f'{API_BASE_URL}/stop_finder',
            params=params,
            headers=headers,
            timeout=REQUEST_TIMEOUT
        )
        response.raise_for_status()
        data = response.json()

        # stop_finder matches streets/POIs/suburbs too - stops only
        stops = [
            {
                'id': loc.get('id'),
                'name': loc.get('name'),
                'matchQuality': loc.get('matchQuality', 0)
            }
            for loc in data.get('locations', [])
            if loc.get('type') == 'stop' and loc.get('id') and loc.get('name')
        ]
        stops.sort(key=lambda s: s['matchQuality'], reverse=True)

        seen = set()
        deduped = []
        for stop in stops:
            if stop['id'] not in seen:
                seen.add(stop['id'])
                deduped.append({'id': stop['id'], 'name': stop['name']})

        return jsonify({'stops': deduped[:15]})

    except requests.exceptions.RequestException as e:
        return jsonify({'error': str(e)}), 500


def fetch_feed(feed_name):
    # decodes one gtfs-realtime vehicle position feed into plain dicts
    cached = _feed_cache.get(feed_name)
    if cached and time.time() - cached['at'] < FEED_CACHE_SECONDS:
        return cached['vehicles']

    response = requests.get(
        VEHICLE_FEEDS[feed_name],
        headers={'Authorization': f'apikey {API_KEY}'},
        timeout=20
    )
    response.raise_for_status()

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(response.content)

    vehicles = []
    for entity in feed.entity:
        if not entity.HasField('vehicle'):
            continue
        v = entity.vehicle
        vehicles.append({
            'feed': feed_name,
            # numeric stop id on metro/lightrail/nswtrains, signal berth string
            # ("Sydney.Central 17 Loc") on sydneytrains - see CLAUDE.md
            'stopId': v.stop_id if v.HasField('stop_id') else None,
            'status': (
                VEHICLE_STOP_STATUS.get(v.current_status)
                if v.HasField('current_status') else None
            ),
            # lags the gps by a stop fairly often - a floor, not the last word
            'stopSequence': (
                v.current_stop_sequence
                if v.HasField('current_stop_sequence') else None
            ),
            'routeId': v.trip.route_id if v.HasField('trip') else None,
            'tripId': v.trip.trip_id if v.HasField('trip') else None,
            'vehicleId': v.vehicle.id if v.HasField('vehicle') else None,
            # e.g. "17:14 Central Station to Leppington Station" - the
            # only place the feed names a destination
            'label': v.vehicle.label if v.HasField('vehicle') else None,
            'lat': v.position.latitude if v.HasField('position') else None,
            'lon': v.position.longitude if v.HasField('position') else None,
            # sent by metro and light rail, never by sydneytrains
            'bearing': (
                v.position.bearing
                if v.HasField('position')
                and v.position.HasField('bearing') else None
            ),
            'timestamp': v.timestamp if v.HasField('timestamp') else None,
        })

    _feed_cache[feed_name] = {'at': time.time(), 'vehicles': vehicles}
    return vehicles


@app.route('/api/vehicle-positions', methods=['GET'])
def get_vehicle_positions():
    # live vehicle positions, merged across one or more comma-separated feeds
    raw_feeds = request.args.get('feeds', '')
    requested = [f.strip() for f in raw_feeds.split(',') if f.strip()]
    if not requested:
        return jsonify({'error': 'feeds is required',
                        'available': list(VEHICLE_FEEDS)}), 400

    unknown = [f for f in requested if f not in VEHICLE_FEEDS]
    if unknown:
        return jsonify({'error': f'unknown feeds: {unknown}',
                        'available': list(VEHICLE_FEEDS)}), 400

    vehicles = []
    errors = {}

    # parallel - sequential took ~3s for five feeds, longer than the poll gap
    with ThreadPoolExecutor(max_workers=len(requested)) as pool:
        futures = {pool.submit(fetch_feed, name): name for name in requested}
        for future in futures:
            feed_name = futures[future]
            try:
                vehicles.extend(future.result())
            except requests.exceptions.RequestException as e:
                # one dead feed shouldn't blank the whole board
                errors[feed_name] = str(e)

    return jsonify({'vehicles': vehicles, 'errors': errors})


def fetch_trip_updates(feed_name):
    # decodes one gtfs-realtime trip update feed into trip_id -> stops
    cached = _trip_update_cache.get(feed_name)
    if cached and time.time() - cached['at'] < TRIP_UPDATE_CACHE_SECONDS:
        return cached['trips']

    response = requests.get(
        TRIP_UPDATE_FEEDS[feed_name],
        headers={'Authorization': f'apikey {API_KEY}'},
        timeout=REQUEST_TIMEOUT
    )
    response.raise_for_status()

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(response.content)

    trips = {}
    for entity in feed.entity:
        if not entity.HasField('trip_update'):
            continue
        update = entity.trip_update
        stops = []
        for stop in update.stop_time_update:
            # plenty of these carry no absolute time, only a delay
            arrival = stop.arrival.time if stop.HasField('arrival') else 0
            departure = (
                stop.departure.time if stop.HasField('departure') else 0
            )
            stops.append({
                'stopId': stop.stop_id,
                'sequence': (
                    stop.stop_sequence
                    if stop.HasField('stop_sequence') else None
                ),
                'time': arrival or departure or None
            })
        if update.trip.trip_id:
            trips[update.trip.trip_id] = stops

    _trip_update_cache[feed_name] = {'at': time.time(), 'trips': trips}
    return trips


@app.route('/api/trip-updates', methods=['GET'])
def get_trip_updates():
    # per-trip upcoming stops - trip_id joins directly to the vehicle
    # positions feed
    raw_feeds = request.args.get('feeds', '')
    requested = [f.strip() for f in raw_feeds.split(',') if f.strip()]
    if not requested:
        requested = ['sydneytrains']

    unknown = [f for f in requested if f not in TRIP_UPDATE_FEEDS]
    if unknown:
        return jsonify({'error': f'unknown feeds: {unknown}',
                        'available': list(TRIP_UPDATE_FEEDS)}), 400

    trips = {}
    errors = {}

    # trip ids are unique across modes, so merging into one map is safe
    with ThreadPoolExecutor(max_workers=len(requested)) as pool:
        futures = {
            pool.submit(fetch_trip_updates, name): name
            for name in requested
        }
        for future in futures:
            feed_name = futures[future]
            try:
                trips.update(future.result())
            except requests.exceptions.RequestException as e:
                errors[feed_name] = str(e)

    return jsonify({'trips': trips, 'errors': errors})


def resolve_stop_name(stop_id):
    # looks one stop id up through stop_finder and caches what comes back
    try:
        response = requests.get(
            f'{API_BASE_URL}/stop_finder',
            params={
                'outputFormat': 'rapidJSON',
                'type_sf': 'any',
                'name_sf': stop_id,
                'TfNSWSF': 'true'
            },
            headers={'Authorization': f'apikey {API_KEY}'},
            timeout=REQUEST_TIMEOUT
        )
        response.raise_for_status()
        locations = response.json().get('locations') or []
        top = locations[0] if locations else {}
        # blank for unresolvable ids, so they're cached too rather than
        # retried forever
        _stop_name_cache[stop_id] = (
            top.get('disassembledName') or top.get('name') or ''
        )
    except (requests.exceptions.RequestException, ValueError):
        # leave it unresolved - the next request will queue it again
        pass
    finally:
        with _stop_name_lock:
            _stop_name_pending.discard(stop_id)


@app.route('/api/stop-names', methods=['GET'])
def get_stop_names():
    # names for numeric stop ids, resolved in the background, cached forever
    raw_ids = request.args.get('ids', '')
    ids = [i.strip() for i in raw_ids.split(',') if i.strip()]
    ids = ids[:STOP_NAME_MAX_IDS]

    names = {i: _stop_name_cache[i] for i in ids if i in _stop_name_cache}

    # unknown ids get queued, not resolved here - the caller polls again
    # for the names
    with _stop_name_lock:
        room = STOP_NAME_MAX_PENDING - len(_stop_name_pending)
        fresh = [i for i in ids
                 if i not in _stop_name_cache
                 and i not in _stop_name_pending]
        queue = fresh[:max(room, 0)]
        _stop_name_pending.update(queue)

    for stop_id in queue:
        _stop_name_pool.submit(resolve_stop_name, stop_id)

    return jsonify({'names': names, 'pending': len(queue)})


@app.route('/api/map-tile', methods=['GET'])
def map_tile():
    # proxies a single OpenStreetMap raster tile, cached in memory
    try:
        z = int(request.args.get('z', ''))
        x = int(request.args.get('x', ''))
        y = int(request.args.get('y', ''))
    except ValueError:
        return jsonify({'error': 'z, x and y must be integers'}), 400

    if not 0 <= z <= 19:
        return jsonify({'error': 'z out of range'}), 400

    span = 2 ** z
    if not (0 <= x < span and 0 <= y < span):
        return jsonify({'error': 'tile coordinates out of range'}), 400

    key = (z, x, y)
    if key not in _tile_cache:
        try:
            response = requests.get(
                OSM_TILE_URL.format(z=z, x=x, y=y),
                headers={'User-Agent': OSM_USER_AGENT},
                timeout=15
            )
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            return jsonify({'error': str(e)}), 502

        # crude but bounded - tiles are small and the viewport rarely moves
        if len(_tile_cache) >= TILE_CACHE_MAX:
            _tile_cache.clear()
        _tile_cache[key] = response.content

    return Response(
        _tile_cache[key],
        mimetype='image/png',
        headers={'Cache-Control': 'public, max-age=86400'}
    )


@app.route('/api/set-checker', methods=['GET'])
def set_checker():
    # carriage number <-> set number - no upstream call, tables and rules only
    query = request.args.get('q', '')
    if not query.strip():
        return jsonify({'error': 'q is required'}), 400
    return jsonify(setchecker.lookup(query))


@app.route('/api/set-checker/fleets', methods=['GET'])
def set_checker_fleets():
    # everything the checker covers, for the reference panel on the page
    return jsonify(setchecker.catalogue())


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


if __name__ == "__main__":
    if not API_KEY:
        print("error: api key not found in variables")
        exit(1)

    print("server running on http://localhost:5001")
    app.run(debug=True, host="0.0.0.0", port=5001)
