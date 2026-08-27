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


load_dotenv()

app = Flask(__name__)

API_KEY = os.getenv('TFNSW_API_KEY')
API_BASE_URL = 'https://api.transport.nsw.gov.au/v1/tp'

# every outbound call gets one - without it a hung upstream connection blocks the
# request forever, which showed up as the board freezing on "Loading information"
REQUEST_TIMEOUT = 20

# gtfs-realtime vehicle position feeds, keyed by the short name the frontend uses.
# note the mixed versions: v2 superseded v1 for sydneytrains/metro/innerwest only
# (v1 404s for those), while cbdandsoutheast and nswtrains still live on v1.
VEHICLE_FEEDS = {
    'sydneytrains': 'https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/sydneytrains',
    'metro': 'https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/metro',
    'lightrail_innerwest': 'https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/lightrail/innerwest',
    'lightrail_cbdse': 'https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/lightrail/cbdandsoutheast',
    'nswtrains': 'https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/nswtrains',
}

# gtfs-realtime VehicleStopStatus enum
VEHICLE_STOP_STATUS = {0: 'INCOMING_AT', 1: 'STOPPED_AT', 2: 'IN_TRANSIT_TO'}

# feeds refresh every ~10-30s upstream, so a short cache stops platform switching
# and polling from making redundant calls
_feed_cache = {}
FEED_CACHE_SECONDS = 5

# OSM map tiles are proxied through here rather than fetched by the browser, so the
# project keeps its "everything goes through the Flask backend" shape and no CDN or
# JS mapping library is needed. OSM's tile usage policy requires an identifying
# User-Agent and discourages heavy traffic, hence the cache.
OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
OSM_USER_AGENT = 'virtualdpb-tfnsw/1.0 (student project; local use)'
_tile_cache = {}
TILE_CACHE_MAX = 500

# per-trip upcoming stops - names platform-level stop ids, the only published way
# to know a service's arrival platform ahead of time. changes slowly, cached longer
# than the position feeds. same mixed v1/v2 split as VEHICLE_FEEDS, and nswtrains
# has no trip update feed at all.
TRIP_UPDATE_FEEDS = {
    'sydneytrains': 'https://api.transport.nsw.gov.au/v2/gtfs/realtime/sydneytrains',
    'metro': 'https://api.transport.nsw.gov.au/v2/gtfs/realtime/metro',
    'lightrail_innerwest': 'https://api.transport.nsw.gov.au/v2/gtfs/realtime/lightrail/innerwest',
    'lightrail_cbdse': 'https://api.transport.nsw.gov.au/v1/gtfs/realtime/lightrail/cbdandsoutheast',
}
_trip_update_cache = {}
TRIP_UPDATE_CACHE_SECONDS = 20

# stop id -> name, resolved through the trip planner. Only metro and light rail
# need this: their feeds name a numeric stop id and nothing else, where heavy rail
# spells the station out in its signal berth string. A lookup takes about 3s, so
# they are resolved in the background and the cache is never expired - stop names
# don't change while the server is up.
_stop_name_cache = {}
_stop_name_pending = set()
_stop_name_lock = threading.Lock()
_stop_name_pool = ThreadPoolExecutor(max_workers=6)
STOP_NAME_MAX_IDS = 60      # per request
STOP_NAME_MAX_PENDING = 40  # in flight at once, so one bad batch can't flood TfNSW


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

    # get current date and time in sydney timezone
    sydney_tz = pytz.timezone('Australia/Sydney')
    now = datetime.now(sydney_tz)
    itd_date = now.strftime('%Y%m%d')
    itd_time = now.strftime('%H%M')

    # build tfnsw api request
    params = {
        'outputFormat': 'rapidJSON',
        'coordOutputFormat': 'EPSG:4326',
        'mode': 'direct',
        'type_dm': 'stop',
        'name_dm': stop_id,
        'depArrMacro': 'dep',
        'itdDate': itd_date,
        'itdTime': itd_time,
        'TfNSWTR': 'true'
    }

    headers = {
        'Authorization': f'apikey {API_KEY}'
    }

    # TfNSW returns the odd 5xx for no obvious reason. One quick retry turns most
    # of those into a normal response instead of a visible error on the board.
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
    """search for stops by name or stop id"""
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

        # stop_finder matches streets/POIs/suburbs too - keep actual stops only,
        # ranked by TfNSW's own match confidence
        stops = [
            {'id': loc.get('id'), 'name': loc.get('name'), 'matchQuality': loc.get('matchQuality', 0)}
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
    """fetches and decodes one gtfs-realtime vehicle position feed into plain dicts"""
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
            # numeric gtfs stop id on metro/lightrail/nswtrains, but a signal berth
            # string like "Sydney.Central 17 Loc" on sydneytrains - see CLAUDE.md
            'stopId': v.stop_id if v.HasField('stop_id') else None,
            # only populated on metro/lightrail/nswtrains, never on sydneytrains
            'status': VEHICLE_STOP_STATUS.get(v.current_status) if v.HasField('current_status') else None,
            # position within the trip, matched against a trip update's stop_sequence.
            # lags the GPS by a stop fairly often, so treat it as a floor rather than
            # the last word on where the vehicle has got to
            'stopSequence': v.current_stop_sequence if v.HasField('current_stop_sequence') else None,
            'routeId': v.trip.route_id if v.HasField('trip') else None,
            'tripId': v.trip.trip_id if v.HasField('trip') else None,
            # used to follow one train from a platform to its next stop
            'vehicleId': v.vehicle.id if v.HasField('vehicle') else None,
            # human-readable trip description, e.g. "17:14 Central Station to
            # Leppington Station". The only place the feed names a destination.
            'label': v.vehicle.label if v.HasField('vehicle') else None,
            'lat': v.position.latitude if v.HasField('position') else None,
            'lon': v.position.longitude if v.HasField('position') else None,
            # direction of travel in degrees. metro and light rail always send this,
            # sydneytrains never does.
            'bearing': v.position.bearing if v.HasField('position') and v.position.HasField('bearing') else None,
            'timestamp': v.timestamp if v.HasField('timestamp') else None,
        })

    _feed_cache[feed_name] = {'at': time.time(), 'vehicles': vehicles}
    return vehicles


@app.route('/api/vehicle-positions', methods=['GET'])
def get_vehicle_positions():
    """live vehicle positions, merged across one or more comma-separated feeds"""
    requested = [f.strip() for f in request.args.get('feeds', '').split(',') if f.strip()]
    if not requested:
        return jsonify({'error': 'feeds is required', 'available': list(VEHICLE_FEEDS)}), 400

    unknown = [f for f in requested if f not in VEHICLE_FEEDS]
    if unknown:
        return jsonify({'error': f'unknown feeds: {unknown}', 'available': list(VEHICLE_FEEDS)}), 400

    vehicles = []
    errors = {}

    # fetched in parallel - going one at a time took ~3s for all five feeds, which
    # is longer than the gap between polls on the tactile bumps board
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
    """fetches and decodes one gtfs-realtime trip update feed into trip_id -> stops"""
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
            departure = stop.departure.time if stop.HasField('departure') else 0
            stops.append({
                'stopId': stop.stop_id,
                'sequence': stop.stop_sequence if stop.HasField('stop_sequence') else None,
                'time': arrival or departure or None
            })
        if update.trip.trip_id:
            trips[update.trip.trip_id] = stops

    _trip_update_cache[feed_name] = {'at': time.time(), 'trips': trips}
    return trips


@app.route('/api/trip-updates', methods=['GET'])
def get_trip_updates():
    """per-trip upcoming stops - trip_id joins directly to the vehicle positions feed"""
    requested = [f.strip() for f in request.args.get('feeds', '').split(',') if f.strip()]
    if not requested:
        requested = ['sydneytrains']

    unknown = [f for f in requested if f not in TRIP_UPDATE_FEEDS]
    if unknown:
        return jsonify({'error': f'unknown feeds: {unknown}',
                        'available': list(TRIP_UPDATE_FEEDS)}), 400

    trips = {}
    errors = {}

    # trip ids are unique across modes (each feed uses its own format), so merging
    # them into one map is safe and saves the caller having to know which is which
    with ThreadPoolExecutor(max_workers=len(requested)) as pool:
        futures = {pool.submit(fetch_trip_updates, name): name for name in requested}
        for future in futures:
            feed_name = futures[future]
            try:
                trips.update(future.result())
            except requests.exceptions.RequestException as e:
                errors[feed_name] = str(e)

    return jsonify({'trips': trips, 'errors': errors})


def resolve_stop_name(stop_id):
    """looks one stop id up through stop_finder and caches whatever comes back"""
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
        # the short form is the one worth showing; a handful of ids resolve to
        # nothing at all, and those get cached as blank so we stop asking
        _stop_name_cache[stop_id] = top.get('disassembledName') or top.get('name') or ''
    except (requests.exceptions.RequestException, ValueError):
        pass  # leave it unresolved - the next request will queue it again
    finally:
        with _stop_name_lock:
            _stop_name_pending.discard(stop_id)


@app.route('/api/stop-names', methods=['GET'])
def get_stop_names():
    """names for numeric stop ids, resolved in the background and cached forever"""
    ids = [i.strip() for i in request.args.get('ids', '').split(',') if i.strip()]
    ids = ids[:STOP_NAME_MAX_IDS]

    names = {i: _stop_name_cache[i] for i in ids if i in _stop_name_cache}

    # anything still unknown gets queued. the caller polls anyway, so the names
    # turn up a few seconds later rather than holding this response open
    with _stop_name_lock:
        room = STOP_NAME_MAX_PENDING - len(_stop_name_pending)
        queue = [i for i in ids
                 if i not in _stop_name_cache and i not in _stop_name_pending][:max(room, 0)]
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


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


if __name__ == "__main__":
    if not API_KEY:
        print("error: api key not found in variables")
        exit(1)

    print("server running on http://localhost:5001")
    app.run(debug=True, host="0.0.0.0", port=5001)
