// platform-edge indicators driven by live vehicle positions. hardcoded to
// central station - picker selects platform only. platform data: centralPlatforms.js

import api from '../../api.js';

const POLL_MS = 12000;      // vehicle feeds refresh every ~10-30s upstream
const TICK_MS = 250;        // re-derive phase often enough for the fixed timings to land

// the dwell hangs off the one real event the feeds give us - train coming to a
// stand, watched between polls. everything after is a fixed timer: no tfnsw api
// reports door state
const CLOSING_MS = 5000;             // doors take ~5s to close
const DEPARTING_MAX_MS = 120000;     // safety cap: vehicle still in feed but never left
const DEPARTING_LOST_MS = 45000;     // shorter cap: vehicle vanished from feed
// anything takes a few seconds to physically clear a platform, and positions run
// about a minute stale on top of that, so the feed saying "gone" the instant the
// doors shut isn't evidence it has. Without this the departing lights could show
// for two seconds and be missed entirely.
const DEPARTING_MIN_MS = 6000;

// The dwell has to be modelled per mode. A train sits at Central for a minute or
// more, a metro turns round in about 45 seconds and a tram in less, so a single
// 60s doors-open floor held metro and light rail doors open long after the real
// ones had shut.
//
// The two distances only apply where there are no signal berths to read instead.
// Heavy rail has them and they are a far better signal, so it uses null for both:
// approachingM would otherwise light "arriving" for any train that happens to be
// near Central, and clearOfPlatformM is what tells metro and light rail the vehicle
// has actually gone - without it "departing" ran the full safety cap every time.
// doorsOpenMax caps the whole thing. The scheduled departure can't be confirmed as
// belonging to the vehicle actually standing there (run numbers change at Central),
// so a tram with doors open and a timetabled departure five minutes off would
// otherwise sit on "doors open" for the whole five minutes.
// Metro's dwell was measured off the live feed rather than guessed: two trains at
// Central both reported STOPPED_AT across 24-25s, so the whole sequence is built to
// land at about 30s. Heavy rail keeps the original, longer model.
const MODE_TIMINGS = {
    'train':      { arrivingHold: 10000, opening: 10000, doorsOpenMin: 60000, doorsOpenMax: 180000, closeBefore: 30000, approachingM: null, clearOfPlatformM: null },
    'metro':      { arrivingHold: 4000,  opening: 6000,  doorsOpenMin: 15000, doorsOpenMax: 45000,  closeBefore: 12000, approachingM: 300,  clearOfPlatformM: 200 },
    'light rail': { arrivingHold: 3000,  opening: 5000,  doorsOpenMin: 12000, doorsOpenMax: 40000,  closeBefore: 10000, approachingM: 150,  clearOfPlatformM: 100 }
};

// feed entries linger long after a train's gone (one was 4.8h stale) - ignore
// anything older than this everywhere: lights, map, loc readout
const MAX_POSITION_AGE_S = 120;

const PLATFORM_ABSENCE_GRACE_MS = 20000; // berth can go unreported this long before dwell ends
const MIN_MOVE_FOR_BEARING_M = 25;       // min movement between polls to trust a derived heading
const AT_PLATFORM_M = 75;                // close enough to call it "at" when the feed won't say so
// Looser check for when the trip's timing is the signal rather than the feed's
// status. A compromise: a metro measured 118m from the platform coordinate while
// demonstrably stopped at it, so this has to clear that, but every metre added is a
// metre where a late train could be called "arrived" while still rolling in.
const AT_PLATFORM_BY_TIME_M = 200;

const DEFAULT_PLATFORM = 'p16';

// phases where the vehicle is at the platform - countdown is this vehicle's own departure
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

// same list minus nswtrains, which publishes no trip update feed
const TRIP_FEEDS = ['sydneytrains', 'metro', 'lightrail_innerwest', 'lightrail_cbdse'];

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
const infoVehicle = document.getElementById('infoVehicle');
const infoDistance = document.getElementById('infoDistance');
const infoServiceNote = document.getElementById('infoServiceNote');
const demoButtons = document.querySelectorAll('.key-demo-btn');
const mapIntro = document.getElementById('mapIntro');
const refreshButton = document.getElementById('refreshBtn');

let platform = null;
let departures = [];
let vehicles = [];
let feedErrors = {};
// tripId -> upcoming stops, only for saying which Central platform a train is
// heading for - never drives the lights
let tripUpdates = {};
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
// true when that row was matched to the vehicle rather than assumed from the top
// of the list - which is what lets the "not confirmed" caveat come off
let dwellDepartureMatched = false;
// set when the platform is picked, so a train already sitting there isn't shown
// arriving all over again
let freshSelection = false;
// true when the dwell was already under way before we started watching
let joinedMidDwell = false;
// The vehicle that just finished a dwell here. For a while after pulling out it can
// still name this platform as its stop while sitting inside the approach radius -
// seen 83m out and still reporting Central - which otherwise reads as a fresh
// arrival seconds after it left. Keyed to the vehicle, so a following service is
// unaffected.
let justDepartedKey = null;
let justDepartedAt = null;
const REARRIVAL_BLOCK_MS = 90000;

let liveMode = true;
let isLoading = false;
let hasLoaded = false;
let mainMap = null;
let insetMap = null;

// last known position per vehicle, used to work out a heading for feeds that
// don't send one (sydneytrains never does)
const lastSeenPositions = new Map();

// stop id -> name, filled in as the backend resolves them. metro and light rail
// report a bare number where heavy rail spells the station out in its berth string
const stopNames = new Map();
const STOP_NAME_RETRY_MS = 2500;
let stopNameRetry = null;

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

// dwell lengths and distances for the selected platform's mode
function timings() {
    return MODE_TIMINGS[noun()] || MODE_TIMINGS.train;
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

// the departure the board is actually showing. While a vehicle is standing at the
// platform that's its own departure, not whatever is now top of the list - the
// countdown has to agree with the time printed beside it
function shownDeparture() {
    return dwellDeparture || departures[0] || null;
}

function nextDepartureAt() {
    const next = shownDeparture();
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

function metresFromPlatform(vehicle, target) {
    if (!target || !target.coord || typeof vehicle.lat !== 'number') return null;
    return metresBetween(vehicle.lat, vehicle.lon, target.coord[0], target.coord[1]);
}

// rough metres between two points - good enough at this scale, no need for great-circle maths
function metresBetween(lat1, lon1, lat2, lon2) {
    return Math.hypot((lat1 - lat2) * 111000, (lon1 - lon2) * 92500);
}

function positionAge(vehicle) {
    if (!vehicle.timestamp) return Infinity;
    return (Date.now() / 1000) - vehicle.timestamp;
}

// vehicles recent enough to draw on the map
function liveVehicles() {
    return vehicles.filter(v => positionAge(v) <= MAX_POSITION_AGE_S);
}

// metro and light rail send a heading; sydneytrains never does, so for those we
// compare against where the vehicle was last poll and work it out ourselves
// compass bearing from one point to another, 0 = north
function bearingBetween(lat1, lon1, lat2, lon2) {
    const north = lat2 - lat1;
    const east = (lon2 - lon1) * Math.cos(CENTRAL.lat * Math.PI / 180);
    return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

function headingFor(vehicle) {
    if (typeof vehicle.bearing === 'number') return vehicle.bearing;

    const key = vehicleKey(vehicle);
    const previous = key ? lastSeenPositions.get(key) : null;

    if (previous && typeof vehicle.lat === 'number') {
        const moved = metresBetween(vehicle.lat, vehicle.lon, previous.lat, previous.lon);
        if (moved >= MIN_MOVE_FOR_BEARING_M) {
            return bearingBetween(previous.lat, previous.lon, vehicle.lat, vehicle.lon);
        }
        if (previous.heading !== null && previous.heading !== undefined) {
            return previous.heading;
        }
    }

    // Nothing to compare against yet. sydneytrains sends no bearing, so its arrows
    // would otherwise stay blank until a second poll has been and gone - point it
    // at the platform its trip says it is heading for instead.
    const next = upcomingCentralStop(vehicle);
    if (next && next.platform.coord && typeof vehicle.lat === 'number') {
        return bearingBetween(
            vehicle.lat, vehicle.lon, next.platform.coord[0], next.platform.coord[1]
        );
    }
    return null;
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

        // same timestamp = same old reading, nothing new to learn
        if (v.timestamp && previous.timestamp && v.timestamp === previous.timestamp) return;

        const moved = metresBetween(v.lat, v.lon, previous.lat, previous.lon);
        lastSeenPositions.set(key, {
            lat: v.lat,
            lon: v.lon,
            timestamp: v.timestamp,
            heading: moved < MIN_MOVE_FOR_BEARING_M ? previous.heading : headingFor(v)
        });
    });

    // drop anything no longer in the feed, or this leaks for as long as the page is open
    lastSeenPositions.forEach((_, key) => {
        if (!seen.has(key)) lastSeenPositions.delete(key);
    });
}

// the vehicle the whole board is talking about - see findRelevantVehicle
function primaryVehicle() {
    return findRelevantVehicle().vehicle;
}

// Close enough that a metro or tram counts as arriving. Heavy rail uses its run-in
// berth instead, which says the same thing far more reliably. The radii are set to
// light up roughly 30 seconds out: a metro covers 430m in about 50s, and warning a
// full minute ahead is the sort of thing people learn to ignore.
function withinApproach(vehicle) {
    const limit = timings().approachingM;
    if (!limit) return false;
    const away = metresFromPlatform(vehicle, platform);
    return away !== null && away <= limit;
}

// has it pulled clear? a berth answers this for heavy rail; for metro and light
// rail there are no berths, so it comes down to distance
function clearOfPlatform(vehicle) {
    const limit = timings().clearOfPlatformM;
    if (!limit) return false;
    const away = metresFromPlatform(vehicle, platform);
    return away !== null && away > limit;
}

function resetDwell() {
    arrivedAt = null;
    doorsCloseAt = null;
    departingSince = null;
    lastSeenAtPlatform = null;
    relevantVehicleKey = null;
    dwellDeparture = null;
    dwellDepartureMatched = false;
    joinedMidDwell = false;
}

// the one vehicle this platform's lights are about, and where it is - phase, map
// highlight and the loc readout all use this so they can't disagree
function findRelevantVehicle() {
    const settling = justDepartedKey !== null
        && Date.now() - justDepartedAt < REARRIVAL_BLOCK_MS;
    const fresh = liveVehicles()
        .filter(v => !(settling && vehicleKey(v) === justDepartedKey));
    const mine = fresh.filter(v => api.vehicleMatchesPlatform(v, platform));

    // in the berth - heavy rail sends no status, so a berth match alone means it's
    // here. isStandingAt covers the Chalmers Street feed, which never says STOPPED_AT
    const atPlatform = mine.find(v => isStandingAt(v, platform) || !v.status);
    if (atPlatform) return { vehicle: atPlatform, where: 'platform' };

    // metro and light rail say outright when pulling in, where they say it at all
    const incoming = mine.find(v => v.status === 'INCOMING_AT');
    if (incoming) return { vehicle: incoming, where: 'approach' };

    // heavy rail: sitting in the run-in berth just before this platform
    if (platform.berthNumber !== null) {
        const runIn = fresh.find(v =>
            api.isApproachingPlatform(v.stopId, platform.berthNumber));
        if (runIn) return { vehicle: runIn, where: 'approach' };
    }

    // Everything above rests on the vehicle's own stop id, and for metro and light
    // rail that names the station it last left right up until it stops here - a
    // metro 11m from platform 26 still reported Waterloo. So a stop-id match only
    // fires once it has already arrived, which is why the lights never showed one
    // approaching. The trip update names the booked platform correctly from 400m+
    // out, so that is what approach detection actually runs on.
    const booked = bookedForPlatform(fresh);
    const nearing = booked.filter(withinApproach);
    if (nearing.length) return { vehicle: closestToPlatform(nearing), where: 'approach' };

    // still following the one that just left
    if (relevantVehicleKey) {
        const leaving = vehicles.find(v => vehicleKey(v) === relevantVehicleKey);
        if (leaving && positionAge(leaving) <= MAX_POSITION_AGE_S) {
            return { vehicle: leaving, where: 'leaving' };
        }
    }

    // nothing here or close by, but the trip updates may still name the next one
    // booked in. Too far off to light anything up - this only gives the panel
    // something to say, so the vehicle details aren't blank until it pulls in.
    if (booked.length) return { vehicle: closestToPlatform(booked), where: 'inbound' };

    return { vehicle: null, where: 'none' };
}

// vehicles the trip updates say are booked into this platform
function bookedForPlatform(list) {
    return list.filter(v => {
        const next = upcomingCentralStop(v);
        return next && next.platform.id === platform.id;
    });
}

function closestToPlatform(list) {
    return list.reduce((best, v) => {
        const away = metresFromPlatform(v, platform);
        if (away === null) return best;
        const bestAway = best === null ? Infinity : metresFromPlatform(best, platform);
        return away < bestAway ? v : best;
    }, null) || list[0];
}

// sequence: run-in berth -> arriving -> (at platform) arriving 10s more -> doors
// opening 10s -> doors open until 30s before departure or 60s, whichever later ->
// doors closing 5s -> departing -> clear of Central -> idle
function derivePhase() {
    const now = Date.now();
    const { vehicle, where } = findRelevantVehicle();
    // an inbound vehicle is only being named for the panel, not followed
    if (vehicle && where !== 'inbound') relevantVehicleKey = vehicleKey(vehicle);

    // only meaningful once there's actually data to judge
    const justSelected = freshSelection && vehicles.length > 0;
    if (vehicles.length > 0) freshSelection = false;

    if (where === 'platform') {
        lastSeenAtPlatform = now;
        if (arrivedAt === null) {
            // already standing there when picked - we never saw it arrive, so
            // start at doors-open rather than fake-watching it pull in
            joinedMidDwell = justSelected;
            arrivedAt = justSelected
                ? now - (timings().arrivingHold + timings().opening)
                : now;
            doorsCloseAt = null;
            departingSince = null;

            // pick this vehicle's own row out of the departure list where we can
            const matched = departureForVehicle(vehicle);
            dwellDeparture = matched || departures[0] || null;
            dwellDepartureMatched = Boolean(matched);
        }
    }

    // ride out a single missed poll rather than flickering back to idle
    const inDwell = arrivedAt !== null
        && now - lastSeenAtPlatform < PLATFORM_ABSENCE_GRACE_MS;

    if (inDwell) {
        const since = now - arrivedAt;
        if (since < timings().arrivingHold) return 'arriving';
        if (since < timings().arrivingHold + timings().opening) return 'opening';

        // worked out once and kept - recomputing each tick let a delayed train's
        // departure drop off the list and the doors spring back open
        if (doorsCloseAt === null) {
            const doorsOpenedAt = arrivedAt + timings().arrivingHold + timings().opening;
            const departureAt = nextDepartureAt();
            const timetabled = departureAt === null
                ? 0
                : departureAt - timings().closeBefore;

            // the floor assumes we watched it pull in. joining mid-dwell means we
            // don't know how long it's been sitting there, so use the timetable
            // instead - otherwise a near-departure train gets its doors held open
            const target = joinedMidDwell && timetabled > 0
                ? timetabled
                : Math.max(doorsOpenedAt + timings().doorsOpenMin, timetabled);

            doorsCloseAt = Math.min(target, doorsOpenedAt + timings().doorsOpenMax);
        }

        if (now < doorsCloseAt) return 'arrived';
        if (now < doorsCloseAt + CLOSING_MS) return 'closing';
        if (departingSince === null) departingSince = now;
        return 'departing';
    }

    // pulled out of the platform berth
    if (arrivedAt !== null) {
        arrivedAt = null;
        doorsCloseAt = null;
        if (departingSince === null) departingSince = now;
    }

    if (departingSince !== null) {
        const elapsed = now - departingSince;
        if (elapsed < DEPARTING_MIN_MS) return 'departing';

        // a stale position can keep reporting a berth long after the train left
        const fresh = vehicle && positionAge(vehicle) <= MAX_POSITION_AGE_S;
        const stillAtCentral = fresh && (platform.berthNumber !== null
            ? api.isInCentralStationArea(vehicle.stopId)
            : !clearOfPlatform(vehicle));

        if (stillAtCentral && elapsed < DEPARTING_MAX_MS) return 'departing';
        // no fresh fix - hold briefly rather than snapping straight to idle
        if (!fresh && elapsed < DEPARTING_LOST_MS) return 'departing';

        // remember it before resetDwell forgets, so it can't immediately read as
        // arriving all over again
        justDepartedKey = relevantVehicleKey;
        justDepartedAt = now;
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

// the control matching the current phase is always marked, live or forced - the
// board's "you are here". muted styling signals "being followed", not "pressed"
function syncDemoButtons() {
    demoButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.state === phase);
        btn.classList.toggle('forced', !liveMode && btn.dataset.state === phase);
    });
}

// "<prefix> in <time>", or "now" when due - prefix depends on whether the vehicle
// being counted down is the one standing at the platform
function countdownPhrase() {
    const seconds = secondsUntilNextDeparture();
    if (seconds === null) return '';

    // "departing" claims this timetabled service is the vehicle standing here, so
    // only say it when the trip data actually confirms that. Otherwise it reads as
    // a countdown for a metro that is plainly about to pull out - "departing in
    // 9 min" while the doors are closing in front of you.
    const prefix = AT_PLATFORM_PHASES.includes(phase) && serviceIsConfirmed(shownDeparture())
        ? 'departing'
        : 'departs';
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

// The timetable can't be tied to the vehicle present in general - run numbers change
// at Central. But when the feed tells us which line the vehicle is running and where
// it terminates, that picks its own row out of the departure list, which is what
// stops an L2 to Randwick being captioned over an L3 sitting at the platform.
function departureForVehicle(vehicle) {
    if (!vehicle || !departures.length) return null;

    const code = api.getLineCodeFromRouteId(vehicle.routeId);
    const trip = parseTrip(vehicle.label);
    const destination = trip ? trip.destination : tripTerminus(vehicle);
    if (!code && !destination) return null;

    const sameLine = dep => !code
        || `${dep.lineShort || ''} ${dep.line || ''}`.split(/[^A-Za-z0-9]+/).includes(code);
    const sameDestination = dep => !destination
        || api.shortStationName(dep.destination).toLowerCase() === destination.toLowerCase();

    // both together is a real match; line alone is still better than the top of the
    // list, but not enough to call the service confirmed
    return departures.find(d => sameLine(d) && sameDestination(d)) || null;
}

// Trip updates give a vehicle's remaining stops, some with a time. If the vehicle at
// this platform is due here at the time we're showing, that's a real confirmation
// rather than an assumption - and the caveat underneath can go.
function serviceIsConfirmed(next) {
    if (dwellDepartureMatched) return true;
    if (!next || !platform) return false;
    const vehicle = primaryVehicle();
    const stops = vehicle && vehicle.tripId ? tripUpdates[vehicle.tripId] : null;
    if (!stops) return false;

    const here = stops.find(s => s.stopId === platform.stopId);
    if (!here || !here.time) return false;

    const scheduled = new Date(departureTimeOf(next)).getTime();
    return Math.abs(here.time * 1000 - scheduled) <= 120000;
}

function renderService() {
    // keep showing this train's own departure while it's standing there, rather
    // than jumping to the next service mid-dwell
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

    // run numbers change at Central - can't tie the train here to a timetabled
    // service, so say so rather than implying we know
    const trainPresent = AT_PLATFORM_PHASES.includes(phase) || phase === 'departing';
    infoServiceNote.textContent = trainPresent
        && !serviceIsConfirmed(next)
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

// label reads "17:14 Central Station to Leppington Station" - the time is the
// trip's ORIGIN departure, only meaningful when the trip started at Central
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

// "Platform 18" -> "platform 18", so it reads properly mid-sentence. Light rail
// labels ("Chalmers Street: Platform 1") get the same treatment.
function platformPhrase(target) {
    return target.label.replace(/Platform /, 'platform ');
}

// a stop's name, once the backend has resolved it. tidied down to the plain form:
// "Macquarie Park Station" -> "Macquarie Park", "Marion Light Rail" -> "Marion"
function stopName(stopId) {
    const name = stopNames.get(String(stopId || ''));
    if (!name) return null;
    return api.shortStationName(name).replace(/\s+Light Rail$/i, '').trim();
}

// true when the vehicle is standing at this platform rather than heading for it.
// heavy rail berths are the platform road itself, so a berth match means it's
// there. the other feeds give a stop id that means "next stop" just as often as
// "here", so those need something more.
function isStandingAt(vehicle, target) {
    if (!vehicle || !target) return false;
    if (target.berthNumber !== null) {
        return api.getBerthPlatformNumber(vehicle.stopId) === target.berthNumber;
    }
    // the feed is being explicit that it hasn't arrived, so take its word for it
    if (vehicle.status === 'INCOMING_AT') return false;

    if (vehicle.stopId === target.stopId) {
        if (vehicle.status === 'STOPPED_AT') return true;

        // Chalmers Street's feed never says STOPPED_AT - a tram sitting at the
        // platform still reads IN_TRANSIT_TO, so status alone would never place one
        // there. Sampled over a minute, trams actually at the stop sat 4-63m from
        // the platform coordinate while approaching ones were 89m or more out.
        const away = metresFromPlatform(vehicle, target);
        if (away !== null && away <= AT_PLATFORM_M) return true;
    }

    // Metro's stop id can still name the station it last left while it stands here,
    // so the two tests above can both miss it and the lights sit on "arriving" well
    // after it pulled in. Its trip says when it was due at this platform, which is
    // the signal that survives that lag. Distance only sanity-checks it, loosely:
    // Central's metro platforms are underground, and a train measured 118m from the
    // platform coordinate while demonstrably stopped at it.
    const booked = tripStopsAhead(vehicle).find(s => s.stopId === target.stopId);
    if (!booked || !booked.time || booked.time * 1000 > Date.now()) return false;

    const distance = metresFromPlatform(vehicle, target);
    return distance !== null && distance <= AT_PLATFORM_BY_TIME_M;
}

// A trip update lists the whole trip, start to finish, not just what's ahead - and
// the vehicle's own stop sequence lags, so a tram already at Haymarket can still
// report Chinatown, the stop behind it. Walk forward from where the feed says it
// is, past anything long overdue.
//
// The grace matters more than it looks, and the two feeds need very different
// numbers.
//
// Light rail set the original figure. A tram standing at a stop has that stop due
// seconds ago, so skipping every overdue stop walks straight past the one it is
// sitting at - checked against 11 trams that agreed only 3 times, worse than not
// correcting at all. Dwelling trams were under 75s overdue and within 150m, while
// genuinely missed stops ran 100s+ overdue and several hundred metres away. At 90s
// the same check agreed 10 times out of 11.
//
// Metro is far staler and needs the opposite. Tracking vehicles one at a time, the
// feed claimed a metro was "heading to" a stop it had already been watched standing
// at on 608 occasions - a median of 93s after the fact, once by seven minutes. 90s
// corrects only 76% of those, 45s corrects 97%, and since a metro dwells for 24-25s
// that still clears a train sitting at a stop without cutting it off.
const STOP_PASSED_GRACE_S = { metro: 45, default: 90 };

function stopPassedGrace(vehicle) {
    return STOP_PASSED_GRACE_S[vehicle.feed] || STOP_PASSED_GRACE_S.default;
}

function tripStopsAhead(vehicle) {
    const stops = vehicle.tripId ? tripUpdates[vehicle.tripId] : null;
    if (!stops || !stops.length) return [];

    const from = vehicle.stopSequence;
    const ahead = typeof from === 'number'
        ? stops.filter(s => typeof s.sequence !== 'number' || s.sequence >= from)
        : stops.slice();

    // times are sparse, and a late service can have every one of them in the past -
    // then there's nothing to correct with, so stay where the feed put it
    const cutoff = Date.now() / 1000 - stopPassedGrace(vehicle);
    const firstDue = ahead.findIndex(s => s.time && s.time > cutoff);
    return firstDue > 0 ? ahead.slice(firstDue) : ahead;
}

// which Central platform this vehicle is standing at, if any
function standingAtCentralPlatform(vehicle) {
    const number = api.getBerthPlatformNumber(vehicle.stopId);
    if (number !== null) return api.getCentralPlatform(`p${number}`);

    const byStop = api.getCentralPlatformByStopId(vehicle.stopId);
    return byStop && isStandingAt(vehicle, byStop) ? byStop : null;
}

// where the vehicle is, in words - a Central platform if known, else whichever station's berth
function describeLocation(vehicle) {
    const platformNumber = api.getBerthPlatformNumber(vehicle.stopId);
    if (platformNumber) return `Central platform ${platformNumber}`;

    const station = api.getBerthStation(vehicle.stopId);
    if (station) return `At ${station}`;

    // metro and light rail: a numeric stop id and nothing else. The same field
    // means "where it is" when stopped and "where it's going" when it isn't, so
    // the status has to come along with the name.
    if (vehicle.status === 'STOPPED_AT') {
        const at = stopName(vehicle.stopId);
        return at ? `At ${at}` : null;
    }
    if (vehicle.status === 'INCOMING_AT') {
        const into = stopName(vehicle.stopId);
        return into ? `Arriving at ${into}` : null;
    }

    // in transit is where the lagging stop id bites, so let the trip's own times
    // pick the stop and only fall back to the feed's when they can't
    const ahead = tripStopsAhead(vehicle)[0];
    const name = stopName(ahead ? ahead.stopId : vehicle.stopId) || stopName(vehicle.stopId);
    return name ? `Next stop ${name}` : null;
}

// heavy rail berth strings are worth showing raw - the loc name is the useful bit.
// anything else only has a stop id, which means nothing on its own.
function locationLine(vehicle) {
    const berth = vehicle.stopId || '';
    return / Loc$/.test(berth) ? berth : (describeLocation(vehicle) || '');
}

// where a service finishes up. metro and light rail put the vehicle set number in
// their label ("RS019", "X37-X38") and name no destination anywhere else, so the
// last stop on the trip is the only way to say where one is going.
function tripTerminus(vehicle) {
    const stops = vehicle.tripId ? tripUpdates[vehicle.tripId] : null;
    if (!stops || !stops.length) return null;
    return stopName(stops[stops.length - 1].stopId);
}

// first Central platform still ahead of this vehicle. has to work off the stops
// ahead rather than the whole trip, or a service that called at Central an hour ago
// still reads as heading there
function upcomingCentralStop(vehicle) {
    for (const stop of tripStopsAhead(vehicle)) {
        const platformHere = api.getCentralPlatformByStopId(stop.stopId);
        if (platformHere) return { platform: platformHere, time: stop.time };
    }
    return null;
}

// Distance is always available, a time only sometimes - many stop updates carry a
// delay rather than an absolute time. So lead with the metres and add the time in
// brackets when the feed gives one.
// minutes until a trip's stop, where the feed gives an absolute time for it
function arrivalMinutes(stop) {
    if (!stop.time) return null;
    const mins = Math.round((stop.time * 1000 - Date.now()) / 60000);
    if (mins < 0) return null;
    return mins === 0 ? 'now' : `${mins} min`;
}

function approachLine(vehicle) {
    // already there - a distance would only read as misleadingly precise
    const here = standingAtCentralPlatform(vehicle);
    if (here) return `At ${platformPhrase(here)}`;

    const next = upcomingCentralStop(vehicle);
    if (!next) return '';

    const label = platformPhrase(next.platform);
    const away = metresFromPlatform(vehicle, next.platform);
    const distance = away === null ? null : `${Math.round(away)}m from ${label}`;
    const minutes = arrivalMinutes(next);

    if (distance && minutes) return `${distance} (${minutes})`;
    if (distance) return distance;
    return minutes ? `Arriving at ${label} (${minutes})` : `Arriving at ${label}`;
}

// same thing for the info bar, without naming the platform - the picker directly
// above already says which one
function platformDistanceLine(vehicle) {
    if (standingAtCentralPlatform(vehicle)) return 'At the platform';

    const next = upcomingCentralStop(vehicle);
    if (!next) return '';

    const away = metresFromPlatform(vehicle, next.platform);
    const minutes = arrivalMinutes(next);
    if (away === null) return minutes ? `Arriving (${minutes})` : '';

    const distance = `${Math.round(away)}m from platform`;
    return minutes ? `${distance} (${minutes})` : distance;
}

// which Central platform this vehicle is at or booked into
function centralPlatformFor(vehicle) {
    const here = standingAtCentralPlatform(vehicle);
    if (here) return here;
    const next = upcomingCentralStop(vehicle);
    return next ? next.platform : null;
}

// tooltip: service, where it's heading, then the signal berth. no times - the
// label's time belongs to wherever the trip started, not Central, so it'd mislead
function vehicleTooltip(vehicle, code) {
    const trip = parseTrip(vehicle.label);
    const destination = trip ? trip.destination : tripTerminus(vehicle);

    const service = destination
        ? `${code ? code + ' ' : ''}to ${destination}`
        : (code || 'Service details not reported');

    return { service, approach: approachLine(vehicle), location: locationLine(vehicle) };
}

// middle of the platform bounding box - sits a little south/west of the station's nominal coord
function platformsCentre() {
    const b = api.getCentralStationBounds();
    return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
}

// builds one map view. both maps share this, differing only in ground covered -
// tile zoom follows from that so tiles stay near 1:1
function createMapView(svg, config) {
    const { spanM, width, height, scaleBarM } = config;
    // close-up centres on the platforms, not the station's nominal point (north-east of them)
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

        // Central covers a lot of ground - outline the precinct rather than pin one point
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

    // returns how many vehicles were drawn, for the caller to describe the view
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
            marker.dataset.approach = tip.approach;
            marker.dataset.location = tip.location;
            trainLayer.appendChild(marker);

            if (isPrimary) {
                primaryInView = true;
                // glow matches the line colour, not the indicator phase, so it stays recognisable
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

            // small direction arrow just outside the circle
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

    // a failed feed would otherwise just look like a quiet map
    const failed = Object.keys(feedErrors);
    const warning = failed.length
        ? ` ${failed.length} feed${failed.length === 1 ? '' : 's'} unavailable (${failed.join(', ')}).`
        : '';

    mapIntro.textContent =
        `${main.inView} vehicle${main.inView === 1 ? '' : 's'} within view. ${note}${warning}`;
}

/* hover tooltip -------------------------------------------------------- */

// plain floating div, not an svg <title> - the native tooltip is slow to appear and can't be styled
const mapTooltip = document.createElement('div');
mapTooltip.className = 'map-tooltip';
mapTooltip.hidden = true;
document.body.appendChild(mapTooltip);

// [text, className] pairs, blanks skipped
function fillTooltip(lines) {
    mapTooltip.textContent = '';
    lines.forEach(([text, className]) => {
        if (!text) return;
        const line = document.createElement('div');
        line.className = className;
        line.textContent = text;
        mapTooltip.appendChild(line);
    });
    return mapTooltip.childElementCount > 0;
}

function attachTooltip(svg) {
    svg.addEventListener('mousemove', event => {
        const marker = event.target.closest('.map-marker');
        if (!marker) {
            mapTooltip.hidden = true;
            return;
        }
        fillTooltip([
            [marker.dataset.service, 'tip-service'],
            [marker.dataset.approach, 'tip-approach'],
            [marker.dataset.location, 'tip-location']
        ]);
        mapTooltip.hidden = false;
        mapTooltip.style.left = `${event.clientX + 14}px`;
        mapTooltip.style.top = `${event.clientY + 14}px`;
    });
    svg.addEventListener('mouseleave', () => { mapTooltip.hidden = true; });
}

// the info bar's distance readout expands to the full breakdown on hover. Also on
// keyboard focus - it carries detail nothing else on the page shows, so it can't be
// mouse-only
function attachDetailTooltip(el) {
    const show = () => {
        const shown = fillTooltip([
            [el.dataset.platform, 'tip-service'],
            [el.dataset.location, 'tip-approach'],
            [el.dataset.route, 'tip-location']
        ]);
        if (!shown) return;
        const box = el.getBoundingClientRect();
        mapTooltip.hidden = false;
        mapTooltip.style.left = `${box.left}px`;
        mapTooltip.style.top = `${box.bottom + 8}px`;
    };
    const hide = () => { mapTooltip.hidden = true; };

    el.addEventListener('mouseenter', show);
    el.addEventListener('focus', show);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('blur', hide);
}

/* render --------------------------------------------------------------- */

function render() {
    renderService();
    infoLights.textContent = indicatorText(phase);

    // the same three lines the map hover gives, for the vehicle the lights are
    // about: which service it is, where it's heading, and where it is right now
    const shown = primaryVehicle();
    infoVehicle.textContent = shown
        ? vehicleTooltip(shown, api.getLineCodeFromRouteId(shown.routeId)).service
        : '';

    // just the distance on the face of it; the rest is a hover away
    infoDistance.textContent = shown ? platformDistanceLine(shown) : '';
    const target = shown ? centralPlatformFor(shown) : null;
    // no "Central" prefix - the whole board is Central
    infoDistance.dataset.platform = target ? target.label : '';
    infoDistance.dataset.location = shown ? locationLine(shown) : '';
    // the raw route id, not the tidied line code - run numbers and route codes change
    // through Central, so seeing the real one is the point
    infoDistance.dataset.route = shown && shown.routeId ? `Route ${shown.routeId}` : '';
    infoDistance.classList.toggle('has-detail', Boolean(shown && infoDistance.textContent));

    if (platform && platform.unpublished) {
        infoStatus.textContent = 'No data published for this platform';
        infoStatus.className = 'error';
    // only "loading" with genuinely nothing to go on - the feed is shared between
    // platforms, so the lights often already know the state
    } else if (!hasLoaded && liveMode && vehicles.length === 0) {
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

    // settled, not all: departures and positions fail independently, and positions
    // drive the lights - all would let a departures 500 discard those too
    const [departureResult, positionResult, tripResult] = await Promise.allSettled([
        api.getDeparturesRaw(platform.stopId),
        api.getVehiclePositions(ALL_FEEDS),
        api.getTripUpdates(TRIP_FEEDS)
    ]);

    // purely additive - if this fails the board carries on as before
    if (tripResult.status === 'fulfilled') tripUpdates = tripResult.value;

    if (positionResult.status === 'fulfilled') {
        vehicles = positionResult.value.vehicles;
        feedErrors = positionResult.value.errors;
        rememberPositions();
    }

    if (departureResult.status === 'fulfilled') {
        // stop id is already platform-specific. drop already-gone services, with a
        // small grace so a train still at the platform keeps its own departure showing
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
    fetchStopNames();
}

// names for the stops metro and light rail report by number. Deliberately not
// awaited: the first lookup of a stop takes a few seconds upstream, so the board
// draws straight away and picks the names up on a later poll.
function fetchStopNames() {
    const wanted = new Set();

    liveVehicles().forEach(v => {
        // heavy rail berth strings already name their station
        if (v.stopId && /^\d+$/.test(v.stopId)) wanted.add(v.stopId);

        // the trip's next stop can differ from the feed's, and its last is the destination
        const ahead = tripStopsAhead(v);
        if (ahead.length) wanted.add(String(ahead[0].stopId));

        const stops = v.tripId ? tripUpdates[v.tripId] : null;
        if (stops && stops.length) wanted.add(String(stops[stops.length - 1].stopId));
    });

    const missing = [...wanted].filter(id => id && !stopNames.has(id));
    if (!missing.length) return;

    api.getStopNames(missing).then(({ names, pending }) => {
        const before = stopNames.size;
        Object.entries(names).forEach(([id, name]) => stopNames.set(id, name));
        if (stopNames.size !== before) render();

        // names the backend is still looking up land within a few seconds, so come
        // back for them rather than leaving light rail showing only its line code
        // until the next poll a dozen seconds away
        if (pending > 0 && stopNameRetry === null) {
            stopNameRetry = setTimeout(() => {
                stopNameRetry = null;
                fetchStopNames();
            }, STOP_NAME_RETRY_MS);
        }
    });
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
    justDepartedKey = null;
    justDepartedAt = null;
    resetDwell();
    freshSelection = true;
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
attachDetailTooltip(infoDistance);
mainMap.buildBase();
insetMap.buildBase();
selectPlatform(platformSelect.value);
startLive();
