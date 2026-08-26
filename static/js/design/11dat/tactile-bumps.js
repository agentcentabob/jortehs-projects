// Digital Tactile Bumps - platform-edge indicators driven by live vehicle positions.
// Hardcoded to Central Station; the platform picker chooses which platform's data
// drives the animation. Platform/stop-id data lives in centralPlatforms.js.

import api from '../../api.js';

const POLL_MS = 12000;      // vehicle feeds refresh every ~10-30s upstream
const TICK_MS = 250;        // re-derive the phase often enough for the fixed timings to land

// The dwell hangs off the one real event these feeds give us: the train coming to
// a stand, worked out by watching its position between polls. Everything after
// that is a fixed timer, because no TfNSW API reports door state at all.
//
const ARRIVING_AT_PLATFORM_MS = 10000;  // keeps flashing 10s after it pulls in
const OPENING_MS = 10000;            // doors-opening flash runs ~10s
const DOORS_OPEN_MIN_MS = 60000;     // doors stay open at least 60s after opening
const CLOSE_BEFORE_DEPARTURE_MS = 30000; // ...or until :30 of the minute before departure
const CLOSING_MS = 5000;             // doors take ~5s to finish closing
// departing normally ends when the vehicle is seen at its next stop; this only
// catches the case where it drops out of the feed entirely
const DEPARTING_MAX_MS = 120000;
// shorter cap for when the vehicle vanishes from the feed altogether
const DEPARTING_LOST_MS = 45000;

// A vehicle only counts as being at, or heading for, this platform if its position
// is recent. Without this a train that reported a Central berth hours ago kept the
// platform showing a train that had long gone.
const PRESENCE_MAX_AGE_S = 120;

// Anything older than this is dropped completely - it tells us nothing about where
// the vehicle is now, so it shouldn't sit on the map either.
const MAP_MAX_AGE_S = 180;

// how long the berth can go unreported before the dwell is treated as finished
const PLATFORM_ABSENCE_GRACE_MS = 20000;

// how far a vehicle must move between polls before we trust a derived heading
const MIN_MOVE_FOR_BEARING_M = 25;

const DEFAULT_PLATFORM = 'p16';

// phases where the vehicle is standing at the platform, so the countdown to the
// next departure is really this vehicle's own departure
const AT_PLATFORM_PHASES = ['opening', 'arrived', 'closing'];

const DEMO_STATES = ['idle', 'arriving', 'opening', 'arrived', 'closing', 'departing'];

/* map setup ------------------------------------------------------------ */

const CENTRAL = { lat: -33.8832, lon: 151.2070 };
const TILE_SIZE = 256;
const SVG_NS = 'http://www.w3.org/2000/svg';

// every feed, so the map shows all modes rather than just the selected platform's
const ALL_FEEDS = [
    'sydneytrains', 'metro', 'lightrail_innerwest', 'lightrail_cbdse', 'nswtrains'
];

// two views of the same data: a wide one covering the area around Central, and a
// closer one on the station itself
const MAIN_VIEW = { spanM: 2000, width: 900, height: 620, scaleBarM: 250 };
const INSET_VIEW = { spanM: 600, width: 450, height: 620, scaleBarM: 100 };

const strip = document.getElementById('tactileStrip');
const platformSelect = document.getElementById('platformSelect');
const infoService = document.getElementById('infoService');
const infoTime = document.getElementById('infoTime');
const infoCountdown = document.getElementById('infoCountdown');
const infoStatus = document.getElementById('infoStatus');
const infoLights = document.getElementById('infoLights');
const infoLoc = document.getElementById('infoLoc');
const infoServiceNote = document.getElementById('infoServiceNote');
const demoButtons = document.querySelectorAll('.key-demo-btn');
const mapIntro = document.getElementById('mapIntro');
const refreshButton = document.getElementById('refreshBtn');

let platform = null;
let departures = [];
let vehicles = [];
let feedErrors = {};
let lastError = null;

let phase = 'idle';
// when the platform berth became occupied - the whole sequence hangs off this
let arrivedAt = null;
// last tick a vehicle was actually seen in the berth
let lastSeenAtPlatform = null;
// latched once per dwell so a changing departures list can't move it
let doorsCloseAt = null;
let departingSince = null;
// the vehicle the lights are currently about
let relevantVehicleKey = null;
// this dwell's own departure, so the panel doesn't jump to the next service
let dwellDeparture = null;

let liveMode = true;
let isLoading = false;
let hasLoaded = false;
let mainMap = null;
let insetMap = null;

// last known position per vehicle, used to work out a heading for feeds that
// don't send one (sydneytrains never does)
const lastSeenPositions = new Map();

let pollTimer = null;
let tickTimer = null;

function buildPlatformOptions() {
    api.getCentralPlatformGroups().forEach(group => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group.name;
        group.platforms.forEach(p => {
            const option = document.createElement('option');
            option.value = p.id;
            option.textContent = p.label;
            // platforms TfNSW publishes nothing for are shown but not selectable
            if (p.unpublished) {
                option.disabled = true;
                option.title = 'This platform exists, but Transport for NSW does not '
                    + 'publish a stop ID, departures or vehicle positions for it';
            }
            optgroup.appendChild(option);
        });
        platformSelect.appendChild(optgroup);
    });
    platformSelect.value = DEFAULT_PLATFORM;
}

/* wording -------------------------------------------------------------- */

// "train" / "metro" / "light rail" depending on the selected platform, so the
// board never calls a tram a train. general copy uses "vehicle" instead.
function noun() {
    return platform ? platform.noun : 'vehicle';
}

function nounCapitalised() {
    const n = noun();
    return n.charAt(0).toUpperCase() + n.slice(1);
}

// where the vehicle is, plus what the doors are doing once it's stopped. The
// countdown lives with the next service and the light pattern has its own row.
function vehicleStatusText(p) {
    switch (p) {
        case 'idle': return `No ${noun()} at the platform`;
        case 'arriving': return `${nounCapitalised()} arriving`;
        case 'opening': return `${nounCapitalised()} on platform: doors opening`;
        case 'arrived': return `${nounCapitalised()} on platform: doors open`;
        case 'closing': return `${nounCapitalised()} on platform: doors closing`;
        case 'departing': return `${nounCapitalised()} departing`;
        default: return '';
    }
}

// just the pattern - what it means is already spelled out by the status above
function indicatorText(p) {
    switch (p) {
        case 'idle': return 'Steady yellow';
        case 'arriving': return 'Flashing red / orange';
        case 'opening': return 'Flashing green / blue';
        case 'arrived': return 'Steady green';
        case 'closing': return 'Flashing red / yellow';
        case 'departing': return 'Steady red';
        default: return '';
    }
}

/* live data ------------------------------------------------------------ */

// effective departure time - realtime estimate where there is one
function departureTimeOf(dep) {
    return dep.departureTimeEstimated || dep.departureTimePlanned || dep.departureTime;
}

function nextDepartureAt() {
    const next = departures[0];
    if (!next) return null;
    const time = new Date(departureTimeOf(next));
    return isNaN(time.getTime()) ? null : time.getTime();
}

function secondsUntilNextDeparture() {
    const at = nextDepartureAt();
    return at === null ? null : Math.round((at - Date.now()) / 1000);
}

function vehicleKey(vehicle) {
    return vehicle.vehicleId || vehicle.tripId || null;
}

// rough metres between two points. Good enough over a few hundred metres - no need
// for proper great-circle maths at this scale.
function metresBetween(lat1, lon1, lat2, lon2) {
    return Math.hypot((lat1 - lat2) * 111000, (lon1 - lon2) * 92500);
}

function positionAge(vehicle) {
    if (!vehicle.timestamp) return Infinity;
    return (Date.now() / 1000) - vehicle.timestamp;
}

// vehicles recent enough to draw on the map
function liveVehicles() {
    return vehicles.filter(v => positionAge(v) <= MAP_MAX_AGE_S);
}

// metro and light rail send a heading; sydneytrains never does, so for those we
// compare against where the vehicle was last poll and work it out ourselves
function headingFor(vehicle) {
    if (typeof vehicle.bearing === 'number') return vehicle.bearing;

    const key = vehicleKey(vehicle);
    const previous = key ? lastSeenPositions.get(key) : null;
    if (!previous || typeof vehicle.lat !== 'number') return null;

    const moved = metresBetween(vehicle.lat, vehicle.lon, previous.lat, previous.lon);
    if (moved < MIN_MOVE_FOR_BEARING_M) return previous.heading ?? null;

    const north = vehicle.lat - previous.lat;
    const east = (vehicle.lon - previous.lon) * Math.cos(CENTRAL.lat * Math.PI / 180);
    return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

// keeps the last position per vehicle so the next poll can derive a heading
function rememberPositions() {
    const seen = new Set();

    vehicles.forEach(v => {
        const key = vehicleKey(v);
        if (!key || typeof v.lat !== 'number') return;
        seen.add(key);

        const previous = lastSeenPositions.get(key);
        if (!previous) {
            lastSeenPositions.set(key, {
                lat: v.lat, lon: v.lon, timestamp: v.timestamp, heading: headingFor(v)
            });
            return;
        }

        // a repeated position with the same timestamp is the same old reading, so
        // there is nothing new to learn from it
        if (v.timestamp && previous.timestamp && v.timestamp === previous.timestamp) return;

        const moved = metresBetween(v.lat, v.lon, previous.lat, previous.lon);
        lastSeenPositions.set(key, {
            lat: v.lat,
            lon: v.lon,
            timestamp: v.timestamp,
            heading: moved < MIN_MOVE_FOR_BEARING_M ? previous.heading : headingFor(v)
        });
    });

    // drop anything no longer in the feed, or this grows for as long as the page
    // is left open
    lastSeenPositions.forEach((_, key) => {
        if (!seen.has(key)) lastSeenPositions.delete(key);
    });
}

// the vehicle the whole board is talking about - see findRelevantVehicle
function primaryVehicle() {
    return findRelevantVehicle().vehicle;
}

function resetDwell() {
    arrivedAt = null;
    doorsCloseAt = null;
    departingSince = null;
    lastSeenAtPlatform = null;
    relevantVehicleKey = null;
    dwellDeparture = null;
}

// The one vehicle this platform's lights are about, and where it is relative to
// the platform. Everything downstream - phase, map highlight, the Loc readout -
// uses this, so they can never disagree.
function findRelevantVehicle() {
    const fresh = vehicles.filter(v => positionAge(v) <= PRESENCE_MAX_AGE_S);
    const mine = fresh.filter(v => api.vehicleMatchesPlatform(v, platform));

    // sitting in the platform berth. heavy rail sends no status, so a berth match
    // on its own means it is here.
    const atPlatform = mine.find(v => v.status === 'STOPPED_AT' || !v.status);
    if (atPlatform) return { vehicle: atPlatform, where: 'platform' };

    // metro and light rail say outright when they are pulling in
    const incoming = mine.find(v => v.status === 'INCOMING_AT');
    if (incoming) return { vehicle: incoming, where: 'approach' };

    // heavy rail: sitting in the berth immediately before this platform
    if (platform.berthNumber !== null) {
        const runIn = fresh.find(v =>
            api.isApproachingPlatform(v.stopId, platform.berthNumber));
        if (runIn) return { vehicle: runIn, where: 'approach' };
    }

    // still following the one that just pulled out
    if (relevantVehicleKey) {
        const leaving = vehicles.find(v => vehicleKey(v) === relevantVehicleKey);
        if (leaving && positionAge(leaving) <= PRESENCE_MAX_AGE_S) {
            return { vehicle: leaving, where: 'leaving' };
        }
    }
    return { vehicle: null, where: 'none' };
}

// The sequence, start to finish:
//   run-in berth            -> arriving
//   reaches the platform    -> arriving for another 10s
//   then                    -> doors opening (10s)
//   then                    -> doors open, until 30s before departure or 60s
//   then                    -> doors closing (5s), then departing
//   clear of Central        -> idle
function derivePhase() {
    const now = Date.now();
    const { vehicle, where } = findRelevantVehicle();
    if (vehicle) relevantVehicleKey = vehicleKey(vehicle);

    if (where === 'platform') {
        lastSeenAtPlatform = now;
        if (arrivedAt === null) {
            arrivedAt = now;
            doorsCloseAt = null;
            departingSince = null;
            // this train's own departure, so the panel doesn't jump mid-dwell
            dwellDeparture = departures[0] || null;
        }
    }

    // ride out a single missed poll rather than flickering back to idle
    const inDwell = arrivedAt !== null
        && now - lastSeenAtPlatform < PLATFORM_ABSENCE_GRACE_MS;

    if (inDwell) {
        const since = now - arrivedAt;
        if (since < ARRIVING_AT_PLATFORM_MS) return 'arriving';
        if (since < ARRIVING_AT_PLATFORM_MS + OPENING_MS) return 'opening';

        // worked out once and kept. Recalculating it each tick meant a delayed
        // train's departure dropped off the list and the doors sprang back open.
        if (doorsCloseAt === null) {
            const doorsOpenedAt = arrivedAt + ARRIVING_AT_PLATFORM_MS + OPENING_MS;
            const departureAt = nextDepartureAt();
            doorsCloseAt = Math.max(
                doorsOpenedAt + DOORS_OPEN_MIN_MS,
                departureAt === null ? 0 : departureAt - CLOSE_BEFORE_DEPARTURE_MS
            );
        }

        if (now < doorsCloseAt) return 'arrived';
        if (now < doorsCloseAt + CLOSING_MS) return 'closing';
        if (departingSince === null) departingSince = now;
        return 'departing';
    }

    // it has pulled out of the platform berth
    if (arrivedAt !== null) {
        arrivedAt = null;
        doorsCloseAt = null;
        if (departingSince === null) departingSince = now;
    }

    if (departingSince !== null) {
        const elapsed = now - departingSince;
        // A stale position kept reporting a berth the train had long left, which
        // held the departing indicator on well after it had gone.
        const fresh = vehicle && positionAge(vehicle) <= PRESENCE_MAX_AGE_S;
        const stillAtCentral = fresh
            && (platform.berthNumber === null || api.isInCentralStationArea(vehicle.stopId));

        if (stillAtCentral && elapsed < DEPARTING_MAX_MS) return 'departing';
        // no fresh fix - hold briefly rather than snapping straight to idle
        if (!fresh && elapsed < DEPARTING_LOST_MS) return 'departing';
        resetDwell();
    }

    if (where === 'approach') return 'arriving';
    return 'idle';
}

function applyPhase(next) {
    if (next === phase) return;
    phase = next;
    strip.className = `tactile-strip state-${next}`;
    syncDemoButtons();
}

// the control matching the current phase is always marked, live or forced - it is
// the board's "you are here". muted styling is what signals it is being followed
// rather than pressed.
function syncDemoButtons() {
    demoButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.state === phase);
        btn.classList.toggle('forced', !liveMode && btn.dataset.state === phase);
    });
}

// One shape for every case: "<prefix> in <time>", or "now" when it's due. The
// prefix is the only thing that changes, depending on whether the vehicle being
// counted down is the one standing at the platform.
function countdownPhrase() {
    const seconds = secondsUntilNextDeparture();
    if (seconds === null) return '';

    const prefix = AT_PLATFORM_PHASES.includes(phase) ? 'departing' : 'departs';
    if (seconds <= 0) return `${prefix} now`;
    if (seconds < 60) return `${prefix} in under 1 min`;

    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${prefix} in ${minutes} min`;

    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `${prefix} in ${remainder ? `${hours} hr ${remainder} min` : `${hours} hr`}`;
}

// same delay bands the other boards use
function delayClass(delay) {
    if (!delay || delay <= 0) return 'ontime';
    return delay >= 3 ? 'major' : 'minor';
}

function formatClockTime(iso) {
    const time = new Date(iso);
    if (isNaN(time.getTime())) return '';
    return time.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// black or white text, whichever stays readable on the line's brand colour
function readableTextOn(hexColor) {
    const hex = (hexColor || '').replace('#', '');
    if (hex.length !== 6) return '#fff';
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const channel = c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    return luminance > 0.45 ? '#000' : '#fff';
}

function renderService() {
    // while a train is standing there, keep showing its departure rather than
    // letting the panel jump to the next service mid-dwell
    const next = dwellDeparture || departures[0];
    infoService.textContent = '';
    infoTime.textContent = '';
    infoTime.className = 'service-time';
    infoCountdown.textContent = '';

    infoServiceNote.textContent = '';

    if (!next) {
        if (platform && platform.unpublished) {
            infoService.textContent = 'Not published by Transport for NSW';
        } else if (!hasLoaded) {
            infoService.textContent = 'Loading information...';
        } else {
            infoService.textContent = 'No scheduled services';
        }
        return;
    }

    // whole line name goes inside the coloured box, destination on the line below
    const color = api.getLineColor(next.lineShort || next.line);
    const badge = document.createElement('span');
    badge.className = 'line-badge';
    badge.textContent = next.line;
    badge.style.background = color;
    badge.style.color = readableTextOn(color);

    const destination = document.createElement('span');
    destination.className = 'service-destination';
    destination.textContent = next.destination;

    infoService.appendChild(badge);
    infoService.appendChild(destination);

    // Run numbers change at Central, so the train standing here cannot be tied to
    // a timetabled service. Say so rather than implying we know.
    const trainPresent = AT_PLATFORM_PHASES.includes(phase) || phase === 'departing';
    infoServiceNote.textContent = trainPresent
        ? 'Scheduled departure, not confirmed as the vehicle present'
        : '';

    infoTime.textContent = formatClockTime(departureTimeOf(next));
    infoTime.className = `service-time ${delayClass(next.delay)}`;
    infoCountdown.textContent = countdownPhrase();
}

/* map ------------------------------------------------------------------ */

function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
}

function svgText(text, attrs) {
    const el = svgEl('text', attrs);
    el.textContent = text;
    return el;
}

// The feed's label reads "17:14 Central Station to Leppington Station". The time
// is when the trip left its ORIGIN, so it only tells us Central's time when the
// trip actually started at Central.
function parseTrip(label) {
    const match = /^(\d{1,2}:\d{2})\s+(.+?)\s+to\s+(.+)$/.exec((label || '').trim());
    if (!match) return null;
    const tidy = name => name.replace(/\s+Station$/i, '').trim();
    return {
        time: match[1],
        origin: tidy(match[2]),
        destination: tidy(match[3]),
        startsAtCentral: /central/i.test(match[2])
    };
}

// where the vehicle is, in words - a Central platform if we can tell, otherwise
// whichever station's berth it is sitting in
function describeLocation(vehicle) {
    const platformNumber = api.getBerthPlatformNumber(vehicle.stopId);
    if (platformNumber) return `Central platform ${platformNumber}`;

    const station = api.getBerthStation(vehicle.stopId);
    return station ? `At ${station}` : null;
}

// Two lines for the hover tooltip: the service, then the signal berth it is in.
// No times - the label's time belongs to wherever the trip started, so it is not
// Central's and was misleading.
function vehicleTooltip(vehicle, code) {
    const trip = parseTrip(vehicle.label);

    const service = trip
        ? `${code ? code + ' ' : ''}to ${trip.destination}`
        : (code || 'Service details not reported');

    // berth strings are the interesting bit; numeric stop ids mean nothing on
    // their own, so those get the friendly location instead
    const berth = vehicle.stopId || '';
    const location = / Loc$/.test(berth) ? berth : (describeLocation(vehicle) || '');

    return { service, location };
}

// middle of the platform bounding box, which sits a little south and west of the
// station's nominal coordinate
function platformsCentre() {
    const b = api.getCentralStationBounds();
    return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
}

// Builds one map view. Both maps share this - they only differ in how much ground
// they cover, and the tile zoom follows from that so tiles stay near 1:1.
function createMapView(svg, config) {
    const { spanM, width, height, scaleBarM } = config;
    // the close-up centres on the middle of the platforms rather than the station's
    // nominal point, which sits north-east of where the platforms actually are
    const centre = config.centreOnPlatforms ? platformsCentre() : CENTRAL;
    const metresPerPixel = spanM / height;
    const tileZoom = Math.round(Math.log2(
        156543.03392 * Math.cos(CENTRAL.lat * Math.PI / 180) / metresPerPixel
    ));
    const worldPx = TILE_SIZE * Math.pow(2, tileZoom);
    const metresPerWorldPx =
        156543.03392 * Math.cos(CENTRAL.lat * Math.PI / 180) / Math.pow(2, tileZoom);
    const scale = height / (spanM / metresPerWorldPx);

    const lonToWorldX = lon => ((lon + 180) / 360) * worldPx;
    const latToWorldY = lat => {
        const s = Math.sin(lat * Math.PI / 180);
        return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx;
    };

    const centreX = lonToWorldX(centre.lon);
    const centreY = latToWorldY(centre.lat);

    const project = (lat, lon) => ({
        x: (lonToWorldX(lon) - centreX) * scale + width / 2,
        y: (latToWorldY(lat) - centreY) * scale + height / 2
    });

    let platformLayer = null;
    let trainLayer = null;

    function buildBase() {
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.textContent = '';
        svg.appendChild(svgEl('rect', { x: 0, y: 0, width, height, fill: '#0d1220' }));

        const tiles = svgEl('g', { opacity: 0.9 });
        const halfW = (width / 2) / scale;
        const halfH = (height / 2) / scale;
        const tileSpan = TILE_SIZE * scale;

        for (let tx = Math.floor((centreX - halfW) / TILE_SIZE);
             tx <= Math.floor((centreX + halfW) / TILE_SIZE); tx++) {
            for (let ty = Math.floor((centreY - halfH) / TILE_SIZE);
                 ty <= Math.floor((centreY + halfH) / TILE_SIZE); ty++) {
                const image = svgEl('image', {
                    x: (tx * TILE_SIZE - centreX) * scale + width / 2,
                    y: (ty * TILE_SIZE - centreY) * scale + height / 2,
                    width: tileSpan + 0.5,
                    height: tileSpan + 0.5
                });
                image.setAttribute('href', `/api/map-tile?z=${tileZoom}&x=${tx}&y=${ty}`);
                tiles.appendChild(image);
            }
        }
        svg.appendChild(tiles);
        svg.appendChild(svgEl('rect', {
            x: 0, y: 0, width, height, fill: '#0b1020', opacity: 0.3
        }));

        // Central covers a lot of ground, so outline the whole precinct instead of
        // pinning one point in the middle of it
        const b = api.getCentralStationBounds();
        const nw = project(b.maxLat, b.minLon);
        const se = project(b.minLat, b.maxLon);
        const pad = 10;
        svg.appendChild(svgEl('rect', {
            x: nw.x - pad, y: nw.y - pad,
            width: (se.x - nw.x) + pad * 2, height: (se.y - nw.y) + pad * 2,
            rx: 8, fill: '#ffffff', 'fill-opacity': 0.07,
            stroke: '#ffffff', 'stroke-width': 1.5, 'stroke-dasharray': '6 4'
        }));
        svg.appendChild(svgText('Central Station', {
            x: nw.x - pad, y: nw.y - pad - 8, fill: '#ffffff',
            'font-size': 14, 'font-weight': 600
        }));

        const barPx = scaleBarM / metresPerPixel;
        svg.appendChild(svgEl('line', {
            x1: 18, y1: height - 20, x2: 18 + barPx, y2: height - 20,
            stroke: '#ffffff', 'stroke-width': 3
        }));
        svg.appendChild(svgText(`${scaleBarM} m`, {
            x: 18, y: height - 28, fill: '#ffffff', 'font-size': 12
        }));

        // north arrow, sitting just past the end of the scale bar
        const nx = 18 + barPx + 26;
        const ny = height - 22;
        svg.appendChild(svgEl('path', {
            d: `M ${nx} ${ny - 16} L ${nx + 5} ${ny} L ${nx} ${ny - 4} L ${nx - 5} ${ny} Z`,
            fill: '#ffffff'
        }));
        svg.appendChild(svgText('N', {
            x: nx, y: ny + 12, fill: '#ffffff', 'font-size': 11,
            'font-weight': 700, 'text-anchor': 'middle'
        }));

        platformLayer = svgEl('g', {});
        svg.appendChild(platformLayer);
        trainLayer = svgEl('g', {});
        svg.appendChild(trainLayer);
    }

    function renderPlatform() {
        if (!platformLayer) return;
        platformLayer.textContent = '';
        if (!platform || !platform.coord) return;

        const p = project(platform.coord[0], platform.coord[1]);
        platformLayer.appendChild(svgEl('line', {
            x1: p.x, y1: p.y, x2: p.x + 24, y2: p.y - 24,
            stroke: '#ffffff', 'stroke-width': 1.2, opacity: 0.8
        }));
        platformLayer.appendChild(svgEl('circle', {
            cx: p.x, cy: p.y, r: 4.5, fill: '#ffffff',
            stroke: '#0b1020', 'stroke-width': 1.5
        }));
        platformLayer.appendChild(svgText(platform.label, {
            x: p.x + 27, y: p.y - 22, fill: '#ffffff',
            'font-size': 13, 'font-weight': 600
        }));
    }

    // returns how many vehicles it drew, so the caller can describe the view
    function renderTrains() {
        if (!trainLayer) return { inView: 0, primaryInView: false };
        trainLayer.textContent = '';

        const primary = primaryVehicle();
        const primaryKey = primary ? vehicleKey(primary) : null;
        let inView = 0;
        let primaryInView = false;

        liveVehicles().forEach(v => {
            if (typeof v.lat !== 'number' || typeof v.lon !== 'number') return;
            const p = project(v.lat, v.lon);
            if (p.x < -30 || p.x > width + 30 || p.y < -30 || p.y > height + 30) return;
            inView++;

            const isPrimary = primaryKey !== null && vehicleKey(v) === primaryKey;
            const code = api.getLineCodeFromRouteId(v.routeId);
            const lineColour = code ? api.getLineColor(code) : '#5d6b85';
            const radius = isPrimary ? 15 : 11;

            // one group per vehicle so a single <title> covers the whole marker
            const marker = svgEl('g', { class: 'map-marker' });
            const tip = vehicleTooltip(v, code);
            marker.dataset.service = tip.service;
            marker.dataset.location = tip.location;
            trainLayer.appendChild(marker);

            if (isPrimary) {
                primaryInView = true;
                // glow matches the line colour so it stays recognisable, rather than
                // changing every time the indicator phase changes
                marker.appendChild(svgEl('circle', {
                    cx: p.x, cy: p.y, r: 26, fill: lineColour, opacity: 0.28
                }));
            }

            marker.appendChild(svgEl('circle', {
                cx: p.x, cy: p.y, r: radius, fill: lineColour,
                stroke: isPrimary ? '#ffffff' : '#0b1020',
                'stroke-width': isPrimary ? 3.5 : 1.5,
                opacity: isPrimary ? 1 : 0.9
            }));
            marker.appendChild(svgText(code || '•', {
                x: p.x, y: p.y + (code ? (isPrimary ? 5 : 4) : 5),
                fill: readableTextOn(lineColour),
                'font-size': code ? (isPrimary ? 13 : 10) : 15,
                'font-weight': 700, 'text-anchor': 'middle'
            }));

            // little arrow just outside the circle showing which way it's going
            const heading = headingFor(v);
            if (heading !== null) {
                const rad = (heading - 90) * Math.PI / 180;
                const ax = p.x + Math.cos(rad) * (radius + 7);
                const ay = p.y + Math.sin(rad) * (radius + 7);
                marker.appendChild(svgEl('path', {
                    d: 'M -4 -4 L 5 0 L -4 4 Z',
                    fill: lineColour, stroke: '#0b1020', 'stroke-width': 1,
                    transform: `translate(${ax.toFixed(1)} ${ay.toFixed(1)}) rotate(${(heading - 90).toFixed(1)})`
                }));
            }
        });

        return { inView, primaryInView };
    }

    return { buildBase, renderPlatform, renderTrains };
}

function renderMaps() {
    const main = mainMap ? mainMap.renderTrains() : { inView: 0, primaryInView: false };
    if (insetMap) insetMap.renderTrains();

    const note = main.primaryInView
        ? `This platform's ${noun()} is ringed in white.`
        : `No ${noun()} from this platform is in view right now.`;

    // a feed can fail on its own, which would otherwise just look like a quiet map
    const failed = Object.keys(feedErrors);
    const warning = failed.length
        ? ` ${failed.length} feed${failed.length === 1 ? '' : 's'} unavailable (${failed.join(', ')}).`
        : '';

    mapIntro.textContent =
        `${main.inView} vehicle${main.inView === 1 ? '' : 's'} within view. ${note}${warning}`;
}

/* hover tooltip -------------------------------------------------------- */

// A plain floating div rather than an SVG <title>: the native tooltip needs a
// long hover before it appears and can't be styled.
const mapTooltip = document.createElement('div');
mapTooltip.className = 'map-tooltip';
mapTooltip.hidden = true;
document.body.appendChild(mapTooltip);

function attachTooltip(svg) {
    svg.addEventListener('mousemove', event => {
        const marker = event.target.closest('.map-marker');
        if (!marker) {
            mapTooltip.hidden = true;
            return;
        }
        mapTooltip.textContent = '';
        [['service', 'tip-service'], ['location', 'tip-location']]
            .forEach(([field, className]) => {
                const value = marker.dataset[field];
                if (!value) return;
                const line = document.createElement('div');
                line.className = className;
                line.textContent = value;
                mapTooltip.appendChild(line);
            });
        mapTooltip.hidden = false;
        mapTooltip.style.left = `${event.clientX + 14}px`;
        mapTooltip.style.top = `${event.clientY + 14}px`;
    });
    svg.addEventListener('mouseleave', () => { mapTooltip.hidden = true; });
}

/* render --------------------------------------------------------------- */

function render() {
    renderService();
    infoLights.textContent = indicatorText(phase);

    // show the berth the tracked vehicle is sitting in, so it's clear which Loc
    // the board is reacting to
    const shown = primaryVehicle();
    infoLoc.textContent = shown && shown.stopId ? shown.stopId : '';

    if (platform && platform.unpublished) {
        infoStatus.textContent = 'No data published for this platform';
        infoStatus.className = 'error';
    } else if (!hasLoaded && liveMode) {
        infoStatus.textContent = 'Loading information...';
        infoStatus.className = 'loading';
    } else if (!liveMode) {
        infoStatus.textContent = `${vehicleStatusText(phase)} (demo mode)`;
        infoStatus.className = 'demo';
    } else if (lastError) {
        infoStatus.textContent = `Live data unavailable: ${lastError}`;
        infoStatus.className = 'error';
    } else {
        infoStatus.textContent = vehicleStatusText(phase);
        infoStatus.className = '';
    }

    renderMaps();
}

async function poll() {
    if (!platform) return;

    // some platforms exist physically but TfNSW publishes no stop id for them
    if (platform.unpublished) {
        departures = [];
        vehicles = [];
        lastError = null;
        tick();
        return;
    }

    isLoading = true;
    render();

    // Settled, not all: departures and positions fail independently. A 500 on
    // departures used to throw away the vehicle positions too, which are what
    // actually drive the lights.
    const [departureResult, positionResult] = await Promise.allSettled([
        api.getDeparturesRaw(platform.stopId),
        api.getVehiclePositions(ALL_FEEDS)
    ]);

    if (positionResult.status === 'fulfilled') {
        vehicles = positionResult.value.vehicles;
        feedErrors = positionResult.value.errors;
        rememberPositions();
    }

    if (departureResult.status === 'fulfilled') {
        // the stop id is already platform-specific, so everything returned belongs
        // here. Services that have already gone are dropped, with a small grace so
        // a train still sitting at the platform keeps its own departure showing.
        const cutoff = Date.now() - 30000;
        departures = api.parseDeparturesRaw(departureResult.value)
            .filter(d => !d.isCancelled && departureTimeOf(d))
            .filter(d => new Date(departureTimeOf(d)).getTime() > cutoff)
            .sort((a, b) => new Date(departureTimeOf(a)) - new Date(departureTimeOf(b)));
    }

    // only complain if nothing at all came back; keep the last good data otherwise
    if (positionResult.status === 'rejected' && departureResult.status === 'rejected') {
        lastError = positionResult.reason?.message || 'no response';
    } else {
        lastError = null;
        hasLoaded = true;
    }

    isLoading = false;
    tick();
}

function tick() {
    if (liveMode) applyPhase(derivePhase());
    render();
}

function startLive() {
    liveMode = true;
    resetDwell();
    syncDemoButtons();
    poll();
    if (!pollTimer) pollTimer = setInterval(poll, POLL_MS);
    if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
}

function selectPlatform(id) {
    platform = api.getCentralPlatform(id);
    departures = [];
    hasLoaded = false;
    lastError = null;
    resetDwell();
    if (mainMap) mainMap.renderPlatform();
    if (insetMap) insetMap.renderPlatform();
    render();
    poll();
}

/* events --------------------------------------------------------------- */

platformSelect.addEventListener('change', () => selectPlatform(platformSelect.value));

// manual pull, for when you don't want to wait out the poll interval
refreshButton.addEventListener('click', () => {
    if (isLoading) return;
    refreshButton.classList.add('spinning');
    poll().finally(() => refreshButton.classList.remove('spinning'));
});

demoButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        if (!DEMO_STATES.includes(btn.dataset.state)) return;

        // pressing the phase that is already being forced releases back to live
        if (!liveMode && btn.dataset.state === phase) {
            startLive();
            return;
        }

        liveMode = false;
        applyPhase(btn.dataset.state);
        syncDemoButtons();
        render();
    });
});

buildPlatformOptions();
mainMap = createMapView(document.getElementById('trainMap'), MAIN_VIEW);
insetMap = createMapView(document.getElementById('trainMapInset'),
    { ...INSET_VIEW, centreOnPlatforms: true });
attachTooltip(document.getElementById('trainMap'));
attachTooltip(document.getElementById('trainMapInset'));
mainMap.buildBase();
insetMap.buildBase();
selectPlatform(platformSelect.value);
startLive();
