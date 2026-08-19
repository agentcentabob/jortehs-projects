from flask import Flask, render_template, jsonify, request, Response
import requests
from datetime import datetime
import time
import pytz
import os
from dotenv import load_dotenv
from google.transit import gtfs_realtime_pb2


load_dotenv()

app = Flask(__name__)

API_KEY = os.getenv('TFNSW_API_KEY')
API_BASE_URL = 'https://api.transport.nsw.gov.au/v1/tp'

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

    try:
        response = requests.get(
            f'{API_BASE_URL}/departure_mon',
            params=params,
            headers=headers
        )
        response.raise_for_status()
        return jsonify(response.json())

    except requests.exceptions.RequestException as e:
        return jsonify({'error': str(e)}), 500


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
            headers=headers
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
            'routeId': v.trip.route_id if v.HasField('trip') else None,
            'tripId': v.trip.trip_id if v.HasField('trip') else None,
            # used to follow one train from a platform to its next stop
            'vehicleId': v.vehicle.id if v.HasField('vehicle') else None,
            # human-readable trip description, e.g. "17:14 Central Station to
            # Leppington Station". The only place the feed names a destination.
            'label': v.vehicle.label if v.HasField('vehicle') else None,
            'lat': v.position.latitude if v.HasField('position') else None,
            'lon': v.position.longitude if v.HasField('position') else None,
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
    for feed_name in requested:
        try:
            vehicles.extend(fetch_feed(feed_name))
        except requests.exceptions.RequestException as e:
            # one dead feed shouldn't blank the whole board
            errors[feed_name] = str(e)

    return jsonify({'vehicles': vehicles, 'errors': errors})


@app.route('/api/map-tile', methods=['GET'])
def map_tile():
    """proxies a single OpenStreetMap raster tile, cached in memory"""
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
