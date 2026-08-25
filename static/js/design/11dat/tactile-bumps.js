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
// Cap on how long "arriving" can run before we give up waiting for the train to
// be seen stopping. Only a fallback - normally the position tells us.
const ARRIVING_MAX_MS = 90000;
// under this much movement between readings the vehicle counts as stopped
const STOPPED_THRESHOLD_M = 20;
const OPENING_MS = 10000;            // doors-opening flash runs ~10s
const DOORS_OPEN_MIN_MS = 60000;     // doors stay open at least 60s after opening
const CLOSE_BEFORE_DEPARTURE_MS = 30000; // ...or until :30 of the minute before departure
const CLOSING_MS = 5000;             // doors take ~5s to finish closing
// departing normally ends when the vehicle is seen at its next stop; this only
// catches the case where it drops out of the feed entirely
const DEPARTING_MAX_MS = 240000;
// shorter cap for when the vehicle vanishes from the feed altogether
const DEPARTING_LOST_MS = 45000;

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
const demoButtons = document.querySelectorAll('.key-demo-btn');
const mapIntro = document.getElementById('mapIntro');
const refreshButton = document.getElementById('refreshBtn');

let platform = null;
let departures = [];
let vehicles = [];
let feedErrors = {};
let lastError = null;

let phase = 'idle';
// when the vehicle was first seen stopped at this platform - anchors the timings
let platformArrivalAt = null;
// identity of that vehicle, so it can be followed once it leaves the platform
let trackedVehicleKey = null;
let departingSince = null;
let reachedAtPlatform = false;
// latched once per dwell so a changing departures list can't move it
let doorsCloseAt = null;
// when the vehicle actually pulled off the platform berth
let vehicleLeftAt = null;
// last tick a vehicle was actually seen in the berth
let lastAtPlatformAt = null;
// this dwell's own departure, so the panel doesn't jump to the next service while
// the train is still standing there
let dwellDeparture = null;
// how far through the dwell we are, so phases can only move forwards
let dwellStage = -1;
// when the train was seen to come to a stand at the platform
let stoppedAt = null;

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

function metresFromPlatform(vehicle) {
    if (!platform || !platform.coord || typeof vehicle.lat !== 'number') return null;
    return metresBetween(vehicle.lat, vehicle.lon, platform.coord[0], platform.coord[1]);
}

function positionAge(vehicle) {
    if (!vehicle.timestamp) return Infinity;
    return (Date.now() / 1000) - vehicle.timestamp;
}

function positionIsFresh(vehicle) {
    return positionAge(vehicle) <= MAX_POSITION_AGE_S;
}

// vehicles recent enough to draw on the map
function liveVehicles() {
    return vehicles.filter(v => positionAge(v) <= MAP_MAX_AGE_S);
}

// vehicles recent enough to say something about this platform right now
function vehiclesAtThisPlatform() {
    return vehicles.filter(v =>
        positionAge(v) <= PRESENCE_MAX_AGE_S && api.vehicleMatchesPlatform(v, platform));
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

// Tracks each vehicle's position between polls. This gives two things: a heading
// for feeds that don't send one, and whether the vehicle is actually moving, which
// is the only real "it has stopped" signal these feeds offer.
function rememberPositions() {
    const seen = new Set();

    vehicles.forEach(v => {
        const key = vehicleKey(v);
        if (!key || typeof v.lat !== 'number') return;
        seen.add(key);

        const previous = lastSeenPositions.get(key);
        if (!previous) {
            lastSeenPositions.set(key, {
                lat: v.lat, lon: v.lon, timestamp: v.timestamp,
                heading: headingFor(v), stopped: null, stoppedAt: null
            });
            return;
        }

        // A repeated position with the same timestamp is the same old reading, not
        // evidence the vehicle is standing still. Only judge movement when the feed
        // has actually reported something new.
        if (v.timestamp && previous.timestamp && v.timestamp === previous.timestamp) return;

        const moved = metresBetween(v.lat, v.lon, previous.lat, previous.lon);
        const stopped = moved < STOPPED_THRESHOLD_M;

        lastSeenPositions.set(key, {
            lat: v.lat,
            lon: v.lon,
            timestamp: v.timestamp,
            heading: moved < MIN_MOVE_FOR_BEARING_M ? previous.heading : headingFor(v),
            stopped,
            // when it first came to a stand, which is what the dwell hangs off
            stoppedAt: stopped ? (previous.stoppedAt ?? Date.now()) : null
        });
    });

    // drop anything that's no longer in the feed, otherwise this grows for as long
    // as the page is left open
    lastSeenPositions.forEach((_, key) => {
        if (!seen.has(key)) lastSeenPositions.delete(key);
    });
}

// when this vehicle came to a stand, or null if it is moving or not yet judged
function stoppedSince(vehicle) {
    const key = vehicleKey(vehicle);
    const tracked = key ? lastSeenPositions.get(key) : null;
    return tracked && tracked.stopped ? tracked.stoppedAt : null;
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
        const stillNear = tracked
            && positionAge(tracked) <= MAP_MAX_AGE_S
            && (distance === null || distance <= TRACKING_MAX_M)
            && !api.vehicleIsAtAnotherStation(tracked, platform);
        if (stillNear) return tracked;
    }
    const matched = vehiclesAtThisPlatform();
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
    doorsCloseAt = null;
    vehicleLeftAt = null;
    lastAtPlatformAt = null;
    dwellDeparture = null;
    dwellStage = -1;
    stoppedAt = null;
}

// works out which phase the platform is in. once a vehicle is detected at the
// platform every subsequent transition runs off the fixed timings above rather
// than the feed, because no API reports door state.
function derivePhase() {
    const matched = vehiclesAtThisPlatform();
    const now = Date.now();
    const atPlatform = findTrainAtPlatform(matched);

    if (atPlatform) lastAtPlatformAt = now;

    // One missed poll shouldn't end the dwell. Entries drop in and out as their
    // timestamps age past the freshness cut, which made the board flick to
    // "departed" and then straight back to departing again.
    const stillInDwell = platformArrivalAt !== null
        && lastAtPlatformAt !== null
        && now - lastAtPlatformAt < PLATFORM_ABSENCE_GRACE_MS;

    if (atPlatform || stillInDwell) {
        if (platformArrivalAt === null) {
            platformArrivalAt = now;
            doorsCloseAt = null;
            departingSince = null;
            vehicleLeftAt = null;
            reachedAtPlatform = false;
            dwellStage = -1;
            stoppedAt = null;
        }
        // Follow whatever is in the berth now. Run numbers change at Central, so
        // both vehicleId and tripId can change for the same physical train - the
        // id is not a reliable "is this still the same train" signal here.
        if (atPlatform) trackedVehicleKey = vehicleKey(atPlatform);

        // The dwell hangs off the train coming to a stand, not off when we first
        // noticed it. A signal berth reads as occupied while the train is still
        // rolling in, so "first seen" fires well before it has actually arrived.
        if (stoppedAt === null && atPlatform) stoppedAt = stoppedSince(atPlatform);

        // still moving inside the berth, or we haven't had two readings yet
        if (stoppedAt === null) {
            // safety net: if movement never resolves, don't flash arriving forever
            if (now - platformArrivalAt < ARRIVING_MAX_MS) return advanceDwell('arriving');
            stoppedAt = now;
        }

        const since = now - stoppedAt;
        if (since < OPENING_MS) return advanceDwell('opening');

        reachedAtPlatform = true;

        // Work the closing time out once and keep it. It used to be recalculated
        // every tick from whatever was top of the departures list, so when a
        // delayed service dropped off the list the closing time jumped to the next
        // train's and the doors sprang back open.
        if (doorsCloseAt === null) {
            const doorsOpenedAt = stoppedAt + OPENING_MS;
            // hold this train's own departure for the rest of the dwell
            dwellDeparture = departures[0] || null;
            const departureAt = nextDepartureAt();
            doorsCloseAt = Math.max(
                doorsOpenedAt + DOORS_OPEN_MIN_MS,
                departureAt === null ? 0 : departureAt - CLOSE_BEFORE_DEPARTURE_MS
            );
        }

        if (now < doorsCloseAt) return advanceDwell('arrived');
        if (now < doorsCloseAt + CLOSING_MS) return advanceDwell('closing');

        // doors have finished closing - departing starts here, even though the
        // vehicle is often still physically at the platform
        if (departingSince === null) departingSince = now;
        return advanceDwell('departing');
    }

    // it has left the platform berth
    if (platformArrivalAt !== null) {
        platformArrivalAt = null;
        doorsCloseAt = null;
        vehicleLeftAt = now;
        if (reachedAtPlatform && departingSince === null) {
            departingSince = now;
        } else if (departingSince === null) {
            // passed through without ever boarding, nothing to follow
            clearTracking();
        }
    }

    if (departingSince !== null) {
        const tracked = trackedVehicleKey
            ? vehicles.find(v => vehicleKey(v) === trackedVehicleKey)
            : null;
        let finished;

        if (tracked) {
            // Berth based rather than a distance: departing runs until the train
            // has pulled out of Central's platform and throat berths entirely.
            const stillAtStation = platform.berthNumber !== null
                ? api.isInCentralStationArea(tracked.stopId)
                : tracked.stopId === platform.stopId;

            finished = (!stillAtStation && positionIsFresh(tracked))
                || api.vehicleIsAtAnotherStation(tracked, platform)
                || now - departingSince > DEPARTING_MAX_MS;
        } else {
            // Dropped out of the feed. Time this from when it actually left the
            // platform, not from when departing began, or a train that sat there
            // past its departure time snaps straight to idle the moment it moves.
            finished = now - (vehicleLeftAt ?? departingSince) > DEPARTING_LOST_MS;
        }

        if (finished) clearTracking(); else return advanceDwell('departing');
    }

    // metro and light rail report this directly; heavy rail never does
    const incoming = matched.find(v => v.status === 'INCOMING_AT');
    if (incoming && isWithin(incoming, radii.arriving)) return 'arriving';

    // No timetable fallback here. It used to flag "arriving" in the last 30s before
    // a scheduled departure, which on a delayed service lit the platform up with no
    // train anywhere near it, then dropped back to idle when nothing turned up.
    return 'idle';
}

const DWELL_ORDER = ['arriving', 'opening', 'arrived', 'closing', 'departing'];

// a dwell only ever moves forwards, so a phase can't come back once it has passed
function advanceDwell(candidate) {
    const index = DWELL_ORDER.indexOf(candidate);
    if (index > dwellStage) dwellStage = index;
    return DWELL_ORDER[dwellStage];
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

    try {
        // every feed, not just this platform's, so the map shows all modes
        const [rawDepartures, positions] = await Promise.all([
            api.getDeparturesRaw(platform.stopId),
            api.getVehiclePositions(ALL_FEEDS)
        ]);

        // the stop id is already platform-specific, so everything returned belongs
        // here. Services that have already gone are dropped, with a small grace so
        // a train still sitting at the platform keeps its own departure showing.
        const cutoff = Date.now() - 30000;
        departures = api.parseDeparturesRaw(rawDepartures)
            .filter(d => !d.isCancelled && departureTimeOf(d))
            .filter(d => new Date(departureTimeOf(d)).getTime() > cutoff)
            .sort((a, b) => new Date(departureTimeOf(a)) - new Date(departureTimeOf(b)));
        vehicles = positions.vehicles;
        feedErrors = positions.errors;
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
attachTooltip(document.getElementById('trainMap'));
attachTooltip(document.getElementById('trainMapInset'));
mainMap.buildBase();
insetMap.buildBase();
selectPlatform(platformSelect.value);
startLive();
