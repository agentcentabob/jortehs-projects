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

// heavy rail has no INCOMING_AT, so "arriving" there falls back to the countdown
const ARRIVING_SECONDS = 90;

const DEFAULT_PLATFORM = 'p16';

// phases where the vehicle is standing at the platform, so the countdown to the
// next departure is really this vehicle's own departure
const AT_PLATFORM_PHASES = ['opening', 'arrived', 'closing'];

// colour used to mark this platform's vehicle on the map, per phase
const PHASE_MAP_COLOUR = {
    idle: '#FFFF00',
    arriving: '#FF1717',
    opening: '#0096FF',
    arrived: '#35DC4F',
    closing: '#FFE000',
    departing: '#FF6A00'
};

const DEMO_STATES = ['idle', 'arriving', 'opening', 'arrived', 'closing', 'departing'];

/* map ------------------------------------------------------------------ */

const CENTRAL = { lat: -33.8832, lon: 151.2070 };
const MAP_W = 700;
const MAP_H = 780;
const MAP_SPAN_M = 2000;    // metres covered top to bottom
const TILE_SIZE = 256;
const SVG_NS = 'http://www.w3.org/2000/svg';

// pick the tile zoom whose native resolution is closest to the window we want, so
// tiles are drawn near 1:1 rather than scaled up and blurred
const METRES_PER_PIXEL = MAP_SPAN_M / MAP_H;
const TILE_ZOOM = Math.round(Math.log2(
    156543.03392 * Math.cos(CENTRAL.lat * Math.PI / 180) / METRES_PER_PIXEL
));

const strip = document.getElementById('tactileStrip');
const platformSelect = document.getElementById('platformSelect');
const infoPlatform = document.getElementById('infoPlatform');
const infoService = document.getElementById('infoService');
const infoStatus = document.getElementById('infoStatus');
const infoLights = document.getElementById('infoLights');
const demoButtons = document.querySelectorAll('.key-demo-btn');
const trainMap = document.getElementById('trainMap');
const mapIntro = document.getElementById('mapIntro');

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
let mapTrainsGroup = null;
let mapPlatformGroup = null;

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

// what the vehicle itself is doing
function trainStatusText(p) {
    switch (p) {
        case 'idle': return `No ${noun()} at the platform`;
        case 'arriving': return `${nounCapitalised()} arriving at the platform`;
        case 'opening':
        case 'arrived':
        case 'closing': return `${nounCapitalised()} stopped at the platform`;
        case 'departing': return `${nounCapitalised()} departing, en route to next stop`;
        default: return '';
    }
}

// what the platform edge is showing. named specifically for the current phase so
// the shared red/orange flash never reads as "arriving or departing"
function indicatorStatusText(p) {
    switch (p) {
        case 'idle': return `Steady yellow (no ${noun()} at the platform)`;
        case 'arriving': return `Flashing red / orange (${noun()} arriving)`;
        case 'opening': return 'Flashing green / blue (doors opening)';
        case 'arrived': return 'Steady green (doors open)';
        case 'closing': return 'Flashing red / yellow (doors closing)';
        case 'departing': return `Flashing red / orange (${noun()} departing)`;
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

// several vehicles can legitimately report the same stop id at once (common on
// light rail, where one tram is STOPPED_AT while the next is INCOMING_AT). only
// one of them is "the vehicle at this platform", so pick deliberately rather than
// highlighting every match.
function primaryVehicle() {
    if (trackedVehicleKey) {
        const tracked = vehicles.find(v => vehicleKey(v) === trackedVehicleKey);
        if (tracked) return tracked;
    }
    const matched = vehicles.filter(v => api.vehicleMatchesPlatform(v, platform));
    return matched.find(v => v.status === 'STOPPED_AT' || !v.status)
        || matched.find(v => v.status === 'INCOMING_AT')
        || null;
}

// true if a vehicle is physically at this platform right now.
// STOPPED_AT is explicit; a sydneytrains berth match has no status at all but
// means the train is occupying that platform's berth (see CLAUDE.md)
function findTrainAtPlatform(matched) {
    return matched.find(v => v.status === 'STOPPED_AT' || !v.status) || null;
}

// has the vehicle we were following turned up at another station yet?
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
        if (reachedAtPlatform && departingSince === null) departingSince = now;
    }

    if (departingSince !== null) {
        if (trackedTrainReachedNextStop() || now - departingSince > DEPARTING_MAX_MS) {
            clearTracking();
        } else {
            return 'departing';
        }
    }

    // metro and light rail report this directly; heavy rail never does
    if (matched.some(v => v.status === 'INCOMING_AT')) return 'arriving';

    const seconds = secondsUntilNextDeparture();
    if (seconds !== null && seconds <= ARRIVING_SECONDS && seconds > -60) return 'arriving';
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

// while the vehicle is standing at the platform the next departure is its own, so
// the countdown reads as it departing rather than a separate service
function countdownPhrase() {
    const seconds = secondsUntilNextDeparture();
    if (seconds === null) return null;

    const atPlatform = AT_PLATFORM_PHASES.includes(phase);
    if (seconds < 0) return atPlatform ? 'departing now' : 'service departing';

    const prefix = atPlatform ? 'departing in' : 'next service in';
    if (seconds < 60) return `${prefix} less than a minute`;

    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${prefix} ${minutes} min`;

    // quiet regional platforms can be many hours from their next service
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `${prefix} ${remainder ? `${hours} hr ${remainder} min` : `${hours} hr`}`;
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

    if (!next) {
        infoService.textContent = 'No scheduled services';
        return;
    }

    const color = api.getLineColor(next.lineShort || next.line);
    const badge = document.createElement('span');
    badge.className = 'line-badge';
    badge.textContent = next.lineShort || next.line;
    badge.style.background = color;
    badge.style.color = readableTextOn(color);

    // the line name usually repeats the short code ("T1 North Shore & Western
    // Line") - drop it so the badge isn't duplicated in the text
    let name = next.line;
    if (next.lineShort && name.startsWith(next.lineShort)) {
        name = name.slice(next.lineShort.length).trim();
    }

    infoService.appendChild(badge);
    infoService.appendChild(document.createTextNode(
        `${name}${name ? ' ' : ''}to ${next.destination}`
    ));
}

/* map rendering -------------------------------------------------------- */

// standard web mercator, matching the tile scheme OSM uses
function lonToWorldX(lon) {
    return ((lon + 180) / 360) * TILE_SIZE * Math.pow(2, TILE_ZOOM);
}

function latToWorldY(lat) {
    const s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_SIZE * Math.pow(2, TILE_ZOOM);
}

const METRES_PER_WORLD_PX =
    156543.03392 * Math.cos(CENTRAL.lat * Math.PI / 180) / Math.pow(2, TILE_ZOOM);
const MAP_SCALE = MAP_H / (MAP_SPAN_M / METRES_PER_WORLD_PX);

const CENTRE_WORLD_X = lonToWorldX(CENTRAL.lon);
const CENTRE_WORLD_Y = latToWorldY(CENTRAL.lat);

function projectToMap(lat, lon) {
    return {
        x: (lonToWorldX(lon) - CENTRE_WORLD_X) * MAP_SCALE + MAP_W / 2,
        y: (latToWorldY(lat) - CENTRE_WORLD_Y) * MAP_SCALE + MAP_H / 2
    };
}

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

// the map is always centred on Central, so the tile layer is built once
function buildMapBase() {
    trainMap.setAttribute('viewBox', `0 0 ${MAP_W} ${MAP_H}`);
    trainMap.textContent = '';

    trainMap.appendChild(svgEl('rect', {
        x: 0, y: 0, width: MAP_W, height: MAP_H, fill: '#0d1220'
    }));

    const tiles = svgEl('g', { opacity: 0.9 });
    const halfW = (MAP_W / 2) / MAP_SCALE;
    const halfH = (MAP_H / 2) / MAP_SCALE;
    const tileSpan = TILE_SIZE * MAP_SCALE;

    const minTileX = Math.floor((CENTRE_WORLD_X - halfW) / TILE_SIZE);
    const maxTileX = Math.floor((CENTRE_WORLD_X + halfW) / TILE_SIZE);
    const minTileY = Math.floor((CENTRE_WORLD_Y - halfH) / TILE_SIZE);
    const maxTileY = Math.floor((CENTRE_WORLD_Y + halfH) / TILE_SIZE);

    for (let tx = minTileX; tx <= maxTileX; tx++) {
        for (let ty = minTileY; ty <= maxTileY; ty++) {
            const image = svgEl('image', {
                x: (tx * TILE_SIZE - CENTRE_WORLD_X) * MAP_SCALE + MAP_W / 2,
                y: (ty * TILE_SIZE - CENTRE_WORLD_Y) * MAP_SCALE + MAP_H / 2,
                width: tileSpan + 0.5,
                height: tileSpan + 0.5
            });
            image.setAttribute('href', `/api/map-tile?z=${TILE_ZOOM}&x=${tx}&y=${ty}`);
            tiles.appendChild(image);
        }
    }
    trainMap.appendChild(tiles);

    // knock the tile colours back so the markers stay legible on top
    trainMap.appendChild(svgEl('rect', {
        x: 0, y: 0, width: MAP_W, height: MAP_H, fill: '#0b1020', opacity: 0.3
    }));

    // Central is a large precinct, so outline its extent instead of pinning a
    // single point in the middle of it
    const b = api.getCentralStationBounds();
    const nw = projectToMap(b.maxLat, b.minLon);
    const se = projectToMap(b.minLat, b.maxLon);
    const pad = 10;
    trainMap.appendChild(svgEl('rect', {
        x: nw.x - pad, y: nw.y - pad,
        width: (se.x - nw.x) + pad * 2, height: (se.y - nw.y) + pad * 2,
        rx: 8, fill: '#ffffff', 'fill-opacity': 0.07,
        stroke: '#ffffff', 'stroke-width': 1.5, 'stroke-dasharray': '6 4'
    }));
    trainMap.appendChild(svgText('Central Station', {
        x: nw.x - pad, y: nw.y - pad - 8, fill: '#ffffff',
        'font-size': 14, 'font-weight': 600
    }));

    const scaleBarM = 250;
    const scaleBarPx = scaleBarM / METRES_PER_PIXEL;
    trainMap.appendChild(svgEl('line', {
        x1: 20, y1: MAP_H - 22, x2: 20 + scaleBarPx, y2: MAP_H - 22,
        stroke: '#ffffff', 'stroke-width': 3
    }));
    trainMap.appendChild(svgText(`${scaleBarM} m`, {
        x: 20, y: MAP_H - 30, fill: '#ffffff', 'font-size': 12
    }));

    mapPlatformGroup = svgEl('g', {});
    trainMap.appendChild(mapPlatformGroup);
    mapTrainsGroup = svgEl('g', {});
    trainMap.appendChild(mapTrainsGroup);
}

// marks only the selected platform - at this zoom all 27 sit within ~50px, so
// labelling every one of them would be unreadable
function renderSelectedPlatform() {
    if (!mapPlatformGroup) return;
    mapPlatformGroup.textContent = '';
    if (!platform || !platform.coord) return;

    const p = projectToMap(platform.coord[0], platform.coord[1]);
    mapPlatformGroup.appendChild(svgEl('line', {
        x1: p.x, y1: p.y, x2: p.x + 26, y2: p.y - 26,
        stroke: '#ffffff', 'stroke-width': 1.2, opacity: 0.8
    }));
    mapPlatformGroup.appendChild(svgEl('circle', {
        cx: p.x, cy: p.y, r: 4.5, fill: '#ffffff',
        stroke: '#0b1020', 'stroke-width': 1.5
    }));
    const label = svgText(platform.label, {
        x: p.x + 29, y: p.y - 24, fill: '#ffffff',
        'font-size': 13, 'font-weight': 600
    });
    mapPlatformGroup.appendChild(label);
}

function renderMapTrains() {
    if (!mapTrainsGroup) return;
    mapTrainsGroup.textContent = '';

    const primary = primaryVehicle();
    const primaryKey = primary ? vehicleKey(primary) : null;
    let inView = 0;
    let primaryInView = false;

    vehicles.forEach(v => {
        if (typeof v.lat !== 'number' || typeof v.lon !== 'number') return;
        const p = projectToMap(v.lat, v.lon);
        if (p.x < -30 || p.x > MAP_W + 30 || p.y < -30 || p.y > MAP_H + 30) return;
        inView++;

        const isPrimary = primaryKey !== null && vehicleKey(v) === primaryKey;
        const code = api.getLineCodeFromRouteId(v.routeId, v.label);
        const lineColour = code ? api.getLineColor(code) : '#5d6b85';

        if (isPrimary) {
            primaryInView = true;
            const phaseColour = PHASE_MAP_COLOUR[phase] || '#FFFFFF';
            mapTrainsGroup.appendChild(svgEl('circle', {
                cx: p.x, cy: p.y, r: 26, fill: phaseColour, opacity: 0.2
            }));
            mapTrainsGroup.appendChild(svgEl('circle', {
                cx: p.x, cy: p.y, r: 15, fill: lineColour,
                stroke: phaseColour, 'stroke-width': 3.5
            }));
            mapTrainsGroup.appendChild(svgText(code || '?', {
                x: p.x, y: p.y + 5, fill: readableTextOn(lineColour),
                'font-size': 13, 'font-weight': 700, 'text-anchor': 'middle'
            }));
            return;
        }

        // same marker size either way, so unlabelled services don't read as less
        // important - they just have no line code to show
        mapTrainsGroup.appendChild(svgEl('circle', {
            cx: p.x, cy: p.y, r: 11, fill: lineColour,
            stroke: '#0b1020', 'stroke-width': 1.5, opacity: 0.9
        }));
        mapTrainsGroup.appendChild(svgText(code || '•', {
            x: p.x, y: p.y + (code ? 4 : 5), fill: readableTextOn(lineColour),
            'font-size': code ? 10 : 15, 'font-weight': 700,
            'text-anchor': 'middle', opacity: 0.95
        }));
    });

    const note = primaryInView
        ? `This platform's ${noun()} is ringed in the indicator colour.`
        : `No ${noun()} from this platform is in view right now.`;
    mapIntro.textContent =
        `${inView} vehicle${inView === 1 ? '' : 's'} from this platform's feed within view. ${note}`;
}

/* render --------------------------------------------------------------- */

function render() {
    infoPlatform.textContent = platform ? platform.label : '...';
    renderService();

    infoLights.textContent = indicatorStatusText(phase);

    if (platform && platform.unpublished) {
        infoService.textContent = 'Not published by Transport for NSW';
        infoStatus.textContent =
            'This platform exists, but TfNSW publishes no departures or vehicle positions for it';
        infoStatus.className = 'error';
        renderMapTrains();
        return;
    }

    if (!liveMode) {
        infoStatus.textContent = `${trainStatusText(phase)} (demo mode)`;
        infoStatus.className = 'demo';
    } else if (lastError) {
        infoStatus.textContent = `Live data unavailable: ${lastError}`;
        infoStatus.className = 'error';
    } else {
        const countdown = countdownPhrase();
        infoStatus.textContent = countdown
            ? `${trainStatusText(phase)}, ${countdown}`
            : trainStatusText(phase);
        infoStatus.className = '';
    }

    renderMapTrains();
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

    try {
        const [rawDepartures, positions] = await Promise.all([
            api.getDeparturesRaw(platform.stopId),
            api.getVehiclePositions(platform.feeds)
        ]);

        // the stop id is already platform-specific, so everything returned belongs here
        departures = api.parseDeparturesRaw(rawDepartures)
            .filter(d => !d.isCancelled && departureTimeOf(d))
            .sort((a, b) => new Date(departureTimeOf(a)) - new Date(departureTimeOf(b)));
        vehicles = positions;
        lastError = null;
    } catch (error) {
        lastError = error.message;
    }
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
    vehicles = [];
    lastError = null;
    clearTracking();
    renderSelectedPlatform();
    render();
    poll();
}

/* events --------------------------------------------------------------- */

platformSelect.addEventListener('change', () => selectPlatform(platformSelect.value));

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
buildMapBase();
selectPlatform(platformSelect.value);
startLive();
