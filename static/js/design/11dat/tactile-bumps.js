// Digital Tactile Bumps - platform-edge indicators driven by live vehicle positions.
// Hardcoded to Central Station; the platform picker chooses which platform's data
// drives the animation. Platform/stop-id data lives in centralPlatforms.js.

import api from '../../api.js';

const POLL_MS = 12000;      // vehicle feeds refresh every ~10-30s upstream
const TICK_MS = 250;        // re-derive the phase often enough for the fixed timings to land

// fixed phase durations, measured from the moment the train is first seen at the
// platform. these are deliberately hardcoded rather than read from the feed - no
// TfNSW API exposes door state, so the dwell sequence is a modelled approximation.
const ARRIVING_HOLD_MS = 10000;      // "arriving" continues ~10s into the platform
const OPENING_MS = 5000;             // then the doors-opening flash runs ~5s
const DOORS_OPEN_MIN_MS = 30000;     // doors stay open at least 30s after opening
const CLOSE_BEFORE_DEPARTURE_MS = 30000; // ...or until :30 of the minute before departure

// heavy rail has no INCOMING_AT, so "arriving" there falls back to the countdown
const ARRIVING_SECONDS = 90;

const DEFAULT_PLATFORM = 'p16';

// what the train is doing
const PHASE_LABELS = {
    idle: 'No train at platform',
    arriving: 'Train arriving',
    opening: 'Doors opening',
    arrived: 'Doors open',
    closing: 'Doors closing'
};

// what the platform edge is showing - kept separate so the board states the
// train's status and the indicator pattern as two distinct things
const LIGHT_LABELS = {
    idle: 'Steady yellow',
    arriving: 'Flashing red / orange',
    opening: 'Flashing green / blue',
    arrived: 'Steady green',
    closing: 'Flashing red / orange'
};

const DEMO_CYCLE = [
    { state: 'idle', duration: 4000 },
    { state: 'arriving', duration: 3500 },
    { state: 'opening', duration: 2500 },
    { state: 'arrived', duration: 3500 },
    { state: 'closing', duration: 3000 }
];

const strip = document.getElementById('tactileStrip');
const platformSelect = document.getElementById('platformSelect');
const infoPlatform = document.getElementById('infoPlatform');
const infoService = document.getElementById('infoService');
const infoStatus = document.getElementById('infoStatus');
const infoLights = document.getElementById('infoLights');
const demoToggle = document.getElementById('demoToggle');
const demoControls = document.getElementById('demoControls');
const resumeLiveBtn = document.getElementById('resumeLiveBtn');
const cycleBtn = document.getElementById('cycleBtn');
const phaseButtons = document.querySelectorAll('.phase-btn[data-state]');

let platform = null;
let departures = [];
let vehicles = [];
let lastError = null;

let phase = 'idle';
// when the train was first seen stopped at this platform - anchors every fixed timing
let platformArrivalAt = null;

let liveMode = true;
let demoCycleIndex = 0;
let demoCycleTimer = null;

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

// true if a train is physically at this platform right now.
// STOPPED_AT is explicit; a sydneytrains berth match has no status at all but
// means the train is occupying that platform's berth (see CLAUDE.md)
function trainIsAtPlatform(matched) {
    return matched.some(v => v.status === 'STOPPED_AT' || !v.status);
}

// works out which phase the platform is in. once a train is detected at the
// platform every subsequent transition runs off the fixed timings above rather
// than the feed, because no API reports door state.
function derivePhase() {
    const matched = vehicles.filter(v => api.vehicleMatchesPlatform(v, platform));
    const now = Date.now();

    if (trainIsAtPlatform(matched)) {
        if (platformArrivalAt === null) platformArrivalAt = now;
    } else {
        platformArrivalAt = null;
    }

    if (platformArrivalAt !== null) {
        const since = now - platformArrivalAt;
        if (since < ARRIVING_HOLD_MS) return 'arriving';
        if (since < ARRIVING_HOLD_MS + OPENING_MS) return 'opening';

        // doors are open - close them 30s later, or 30s before the scheduled
        // departure, whichever is later (an early train waits for its timetable)
        const doorsOpenedAt = platformArrivalAt + ARRIVING_HOLD_MS + OPENING_MS;
        let closeAt = doorsOpenedAt + DOORS_OPEN_MIN_MS;

        const departureAt = nextDepartureAt();
        if (departureAt !== null) {
            closeAt = Math.max(closeAt, departureAt - CLOSE_BEFORE_DEPARTURE_MS);
        }
        return now >= closeAt ? 'closing' : 'arrived';
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
    phaseButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.state === next));
}

// full phrase rather than a bare figure, so the "departing" case reads properly
function formatCountdown(seconds) {
    if (seconds === null) return null;
    if (seconds < 0) return 'service departing';
    if (seconds < 60) return 'next service in less than a minute';

    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `next service in ${minutes} min`;

    // quiet regional platforms can be many hours from their next service
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    const time = remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
    return `next service in ${time}`;
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

function render() {
    infoPlatform.textContent = platform ? platform.label : '—';
    renderService();

    // the indicator pattern is reported regardless of where the phase came from
    infoLights.textContent = LIGHT_LABELS[phase];

    if (!liveMode) {
        infoStatus.textContent = `${PHASE_LABELS[phase]} (demo mode)`;
        infoStatus.className = 'demo';
        return;
    }

    if (lastError) {
        infoStatus.textContent = `Live data unavailable — ${lastError}`;
        infoStatus.className = 'error';
        return;
    }

    const countdown = formatCountdown(secondsUntilNextDeparture());
    infoStatus.textContent = countdown
        ? `${PHASE_LABELS[phase]} · ${countdown}`
        : PHASE_LABELS[phase];
    infoStatus.className = '';
}

async function poll() {
    if (!platform) return;
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

function stopDemoCycle() {
    if (demoCycleTimer) {
        clearTimeout(demoCycleTimer);
        demoCycleTimer = null;
    }
}

function startLive() {
    stopDemoCycle();
    liveMode = true;
    platformArrivalAt = null;
    poll();
    if (!pollTimer) pollTimer = setInterval(poll, POLL_MS);
    if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
}

function runDemoCycle() {
    const step = DEMO_CYCLE[demoCycleIndex];
    applyPhase(step.state);
    render();
    demoCycleTimer = setTimeout(() => {
        demoCycleIndex = (demoCycleIndex + 1) % DEMO_CYCLE.length;
        runDemoCycle();
    }, step.duration);
}

function selectPlatform(id) {
    platform = api.getCentralPlatform(id);
    departures = [];
    vehicles = [];
    lastError = null;
    platformArrivalAt = null;
    render();
    poll();
}

platformSelect.addEventListener('change', () => selectPlatform(platformSelect.value));

const demoToggleText = demoToggle.querySelector('.demo-toggle-text');

demoToggle.addEventListener('click', () => {
    const showing = !demoControls.hidden;
    demoControls.hidden = showing;
    demoToggle.setAttribute('aria-expanded', String(!showing));
    demoToggleText.textContent = showing ? 'Demo controls' : 'Hide demo controls';
});

phaseButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        stopDemoCycle();
        liveMode = false;
        applyPhase(btn.dataset.state);
        render();
    });
});

cycleBtn.addEventListener('click', () => {
    stopDemoCycle();
    liveMode = false;
    demoCycleIndex = 0;
    runDemoCycle();
});

resumeLiveBtn.addEventListener('click', startLive);

buildPlatformOptions();
selectPlatform(platformSelect.value);
startLive();
