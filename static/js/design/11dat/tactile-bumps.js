// Digital Tactile Bumps - platform-edge indicators driven by live vehicle positions.
// Hardcoded to Central Station; the platform picker chooses which platform's data
// drives the animation. Platform/stop-id data lives in centralPlatforms.js.

import api from '../../api.js';

const POLL_MS = 12000;      // vehicle feeds refresh every ~10-30s upstream
const TICK_MS = 250;        // re-derive the phase often enough for the fixed timings to land

// fixed phase durations, measured from the moment the vehicle is first seen at the
// platform. these are deliberately hardcoded rather than read from the feed - no
// TfNSW API exposes door state, so the dwell sequence is a modelled approximation.
const ARRIVING_HOLD_MS = 10000;      // "arriving" continues ~10s into the platform
const OPENING_MS = 5000;             // then the doors-opening flash runs ~5s
const DOORS_OPEN_MIN_MS = 30000;     // doors stay open at least 30s after opening
const CLOSE_BEFORE_DEPARTURE_MS = 30000; // ...or until :30 of the minute before departure
const CLOSING_MS = 5000;             // doors take ~5s to finish closing
// departing normally ends when the vehicle is seen at its next stop; this only
// catches the case where it drops out of the feed entirely
const DEPARTING_MAX_MS = 240000;

// How close a vehicle has to be for each flash. Departing is tighter than arriving
// so the lights clear soon after the vehicle pulls away. Light rail stops are much
// closer together than train stations, so it gets tighter figures again.
const FLASH_RADII = {
    'light rail': { arriving: 150, departing: 75 },
    default: { arriving: 250, departing: 100 }
};

// stop following a vehicle on the map once it's this far away, so the highlight
// can't get stuck on a train that left ages ago
const TRACKING_MAX_M = 1500;

// Plenty of entries in the feed are stale (some by hours), so a position is only
// trusted for the distance check if it was reported recently.
const MAX_POSITION_AGE_S = 120;

// Heavy rail can't say which platform an approaching train is for until it reaches
// the berth, so a short timetable countdown covers the last few seconds.
const ARRIVING_SECONDS = 30;

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
const demoButtons = document.querySelectorAll('.key-demo-btn');
const mapIntro = document.getElementById('mapIntro');
const refreshButton = document.getElementById('refreshBtn');

let platform = null;
let departures = [];
let vehicles = [];
let lastError = null;

let phase = 'idle';
// when the vehicle was first seen stopped at this platform - anchors the timings
let platformArrivalAt = null;
// identity of that vehicle, so it can be followed once it leaves the platform
let trackedVehicleKey = null;
let departingSince = null;
let reachedAtPlatform = false;

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

// where the vehicle is, and nothing else - the countdown lives with the next
// service and the light pattern has its own row
function vehicleStatusText(p) {
    switch (p) {
        case 'idle': return `No ${noun()} at the platform`;
        case 'arriving': return `${nounCapitalised()} arriving`;
        case 'opening':
        case 'arrived':
        case 'closing': return `${nounCapitalised()} on platform`;
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
        case 'departing': return 'Flashing red / orange';
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

function metresFromPlatform(vehicle) {
    if (!platform || !platform.coord || typeof vehicle.lat !== 'number') return null;
    return metresBetween(vehicle.lat, vehicle.lon, platform.coord[0], platform.coord[1]);
}

function positionIsFresh(vehicle) {
    if (!vehicle.timestamp) return false;
    return (Date.now() / 1000) - vehicle.timestamp <= MAX_POSITION_AGE_S;
}

// Near enough to flash. If the position is too old to trust we fall back to
// believing the feed's own status, rather than flashing on a stale fix.
function isWithin(vehicle, radiusM) {
    if (!positionIsFresh(vehicle)) return true;
    const metres = metresFromPlatform(vehicle);
    return metres === null || metres <= radiusM;
}

function flashRadii() {
    return FLASH_RADII[noun()] || FLASH_RADII.default;
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

// remember positions so the next poll can derive a heading from the movement
function rememberPositions() {
    vehicles.forEach(v => {
        const key = vehicleKey(v);
        if (!key || typeof v.lat !== 'number') return;

        const previous = lastSeenPositions.get(key);
        const moved = previous
            ? metresBetween(v.lat, v.lon, previous.lat, previous.lon)
            : Infinity;

        // hold the old heading while a vehicle is sitting still
        if (previous && moved < MIN_MOVE_FOR_BEARING_M) return;
        lastSeenPositions.set(key, { lat: v.lat, lon: v.lon, heading: headingFor(v) });
    });
}

// several vehicles can legitimately report the same stop id at once (common on
// light rail, where one tram is STOPPED_AT while the next is INCOMING_AT). only
// one of them is "the vehicle at this platform", so pick deliberately rather than
// highlighting every match.
function primaryVehicle() {
    if (trackedVehicleKey) {
        const tracked = vehicles.find(v => vehicleKey(v) === trackedVehicleKey);
        // let go once it's well away, otherwise the highlight sticks to a vehicle
        // that left the station a long time ago
        const distance = tracked ? metresFromPlatform(tracked) : null;
        if (tracked && (distance === null || distance <= TRACKING_MAX_M)) return tracked;
    }
    const matched = vehicles.filter(v => api.vehicleMatchesPlatform(v, platform));
    // IN_TRANSIT_TO is included so the map can highlight a vehicle as soon as the
    // feed says it's heading here, even if that's still a kilometre away
    return matched.find(v => v.status === 'STOPPED_AT' || !v.status)
        || matched.find(v => v.status === 'INCOMING_AT')
        || matched.find(v => v.status === 'IN_TRANSIT_TO')
        || null;
}

function findTrainAtPlatform(matched) {
    return matched.find(v => v.status === 'STOPPED_AT' || !v.status) || null;
}

function trackedTrainReachedNextStop() {
    if (!trackedVehicleKey) return false;
    const tracked = vehicles.find(v => vehicleKey(v) === trackedVehicleKey);
    // gone from the feed entirely - can't confirm, DEPARTING_MAX_MS handles it
    if (!tracked) return false;
    return api.vehicleIsAtAnotherStation(tracked, platform);
}

function clearTracking() {
    platformArrivalAt = null;
    trackedVehicleKey = null;
    departingSince = null;
    reachedAtPlatform = false;
}

// works out which phase the platform is in. once a vehicle is detected at the
// platform every subsequent transition runs off the fixed timings above rather
// than the feed, because no API reports door state.
function derivePhase() {
    const matched = vehicles.filter(v => api.vehicleMatchesPlatform(v, platform));
    const now = Date.now();
    const atPlatform = findTrainAtPlatform(matched);

    if (atPlatform) {
        if (platformArrivalAt === null) {
            platformArrivalAt = now;
            trackedVehicleKey = vehicleKey(atPlatform);
            departingSince = null;
            reachedAtPlatform = false;
        }

        const since = now - platformArrivalAt;
        if (since < ARRIVING_HOLD_MS) return 'arriving';
        if (since < ARRIVING_HOLD_MS + OPENING_MS) return 'opening';

        reachedAtPlatform = true;

        // doors are open - close them 30s later, or 30s before the scheduled
        // departure, whichever is later (an early vehicle waits for its timetable)
        const doorsOpenedAt = platformArrivalAt + ARRIVING_HOLD_MS + OPENING_MS;
        let closeAt = doorsOpenedAt + DOORS_OPEN_MIN_MS;

        const departureAt = nextDepartureAt();
        if (departureAt !== null) {
            closeAt = Math.max(closeAt, departureAt - CLOSE_BEFORE_DEPARTURE_MS);
        }

        if (now < closeAt) return 'arrived';
        if (now < closeAt + CLOSING_MS) return 'closing';

        // doors have finished closing - departing starts here, even though the
        // vehicle is often still physically at the platform
        if (departingSince === null) departingSince = now;
        return 'departing';
    }

    // it has left the platform berth. if it got as far as boarding, treat it as
    // departing until it turns up at its next stop
    if (platformArrivalAt !== null) {
        platformArrivalAt = null;
        if (reachedAtPlatform && departingSince === null) {
            departingSince = now;
        } else if (departingSince === null) {
            // it passed through without ever boarding, so there is nothing to
            // follow - without this the highlight stayed stuck on it
            clearTracking();
        }
    }

    const radii = flashRadii();

    if (departingSince !== null) {
        const tracked = vehicles.find(v => vehicleKey(v) === trackedVehicleKey);
        // stop flashing once it's pulled clear of the platform, rather than waiting
        // the whole way to the next stop
        const clearOfPlatform = tracked && positionIsFresh(tracked)
            && (metresFromPlatform(tracked) || 0) > radii.departing;

        if (clearOfPlatform || !tracked || trackedTrainReachedNextStop()
            || now - departingSince > DEPARTING_MAX_MS) {
            clearTracking();
        } else {
            return 'departing';
        }
    }

    // metro and light rail report this directly; heavy rail never does
    const incoming = matched.find(v => v.status === 'INCOMING_AT');
    if (incoming && isWithin(incoming, radii.arriving)) return 'arriving';

    // only a departure still in the future counts as arriving - allowing a negative
    // window here made a service that had already gone read as "arriving"
    const seconds = secondsUntilNextDeparture();
    if (seconds !== null && seconds > 0 && seconds <= ARRIVING_SECONDS) return 'arriving';
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

function countdownPhrase() {
    const seconds = secondsUntilNextDeparture();
    if (seconds === null) return '';

    const atPlatform = AT_PLATFORM_PHASES.includes(phase);
    if (seconds < 0) return atPlatform ? 'departing now' : 'departed';

    const prefix = atPlatform ? 'departs in' : 'in';
    if (seconds < 60) return `${prefix} less than a minute`;

    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${prefix} ${minutes} min`;

    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `${prefix} ${remainder ? `${hours} hr ${remainder} min` : `${hours} hr`}`;
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
    const next = departures[0];
    infoService.textContent = '';
    infoTime.textContent = '';
    infoTime.className = 'service-time';
    infoCountdown.textContent = '';

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

        vehicles.forEach(v => {
            if (typeof v.lat !== 'number' || typeof v.lon !== 'number') return;
            const p = project(v.lat, v.lon);
            if (p.x < -30 || p.x > width + 30 || p.y < -30 || p.y > height + 30) return;
            inView++;

            const isPrimary = primaryKey !== null && vehicleKey(v) === primaryKey;
            const code = api.getLineCodeFromRouteId(v.routeId);
            const lineColour = code ? api.getLineColor(code) : '#5d6b85';
            const radius = isPrimary ? 15 : 11;

            if (isPrimary) {
                primaryInView = true;
                // glow matches the line colour so it stays recognisable, rather than
                // changing every time the indicator phase changes
                trainLayer.appendChild(svgEl('circle', {
                    cx: p.x, cy: p.y, r: 26, fill: lineColour, opacity: 0.28
                }));
            }

            trainLayer.appendChild(svgEl('circle', {
                cx: p.x, cy: p.y, r: radius, fill: lineColour,
                stroke: isPrimary ? '#ffffff' : '#0b1020',
                'stroke-width': isPrimary ? 3.5 : 1.5,
                opacity: isPrimary ? 1 : 0.9
            }));
            trainLayer.appendChild(svgText(code || '•', {
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
                trainLayer.appendChild(svgEl('path', {
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
    mapIntro.textContent =
        `${main.inView} vehicle${main.inView === 1 ? '' : 's'} from this platform's feed within view. ${note}`;
}

/* render --------------------------------------------------------------- */

function render() {
    renderService();
    infoLights.textContent = indicatorText(phase);

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

    try {
        // every feed, not just this platform's, so the map shows all modes
        const [rawDepartures, positions] = await Promise.all([
            api.getDeparturesRaw(platform.stopId),
            api.getVehiclePositions(ALL_FEEDS)
        ]);

        // the stop id is already platform-specific, so everything returned belongs here
        departures = api.parseDeparturesRaw(rawDepartures)
            .filter(d => !d.isCancelled && departureTimeOf(d))
            .sort((a, b) => new Date(departureTimeOf(a)) - new Date(departureTimeOf(b)));
        vehicles = positions;
        rememberPositions();
        lastError = null;
        hasLoaded = true;
    } catch (error) {
        lastError = error.message;
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
    clearTracking();
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
    clearTracking();
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
mainMap.buildBase();
insetMap.buildBase();
selectPlatform(platformSelect.value);
startLive();
