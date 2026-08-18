// Digital Tactile Bumps - platform-edge indicators driven by live vehicle positions.
// Hardcoded to Central Station; the platform picker chooses which platform's data
// drives the animation. Platform/stop-id data lives in centralPlatforms.js.

import api from '../../api.js';

const POLL_MS = 12000;      // vehicle feeds refresh every ~10-30s upstream
const TICK_MS = 1000;       // recompute the countdown between polls
const OPENING_MS = 1800;    // how long the transient "doors opening" flash plays
const ARRIVING_SECONDS = 90; // countdown threshold when position data can't tell us

const DEFAULT_PLATFORM = 'p16';

const PHASE_LABELS = {
    idle: 'Before train has arrived',
    arriving: 'Train arriving — doors closing',
    opening: 'Doors opening',
    arrived: 'Train arrived — doors open'
};

const DEMO_CYCLE = [
    { state: 'idle', duration: 4000 },
    { state: 'arriving', duration: 3000 },
    { state: 'opening', duration: 1500 },
    { state: 'arrived', duration: 3000 }
];

const strip = document.getElementById('tactileStrip');
const platformSelect = document.getElementById('platformSelect');
const infoPlatform = document.getElementById('infoPlatform');
const infoService = document.getElementById('infoService');
const infoStatus = document.getElementById('infoStatus');
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
let openingUntil = 0;

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

function secondsUntilNextDeparture() {
    const next = departures[0];
    if (!next) return null;
    const time = new Date(departureTimeOf(next));
    if (isNaN(time.getTime())) return null;
    return Math.round((time - new Date()) / 1000);
}

// works out which phase the platform is in from live data.
// the feeds disagree on what they report, so this reads them in order of confidence:
// an explicit STOPPED_AT/INCOMING_AT beats a bare sydneytrains berth occupancy,
// which in turn beats falling back to the timetable countdown
function derivePhase() {
    const matched = vehicles.filter(v => api.vehicleMatchesPlatform(v, platform));

    if (matched.some(v => v.status === 'STOPPED_AT')) return 'arrived';
    if (matched.some(v => v.status === 'INCOMING_AT')) return 'arriving';
    // sydneytrains sends no status at all - a berth match means the train is physically there
    if (matched.some(v => !v.status)) return 'arrived';

    const seconds = secondsUntilNextDeparture();
    if (seconds !== null && seconds <= ARRIVING_SECONDS && seconds > -60) return 'arriving';
    return 'idle';
}

function applyPhase(next) {
    // entering "arrived" plays the doors-opening flash first
    if (next === 'arrived' && phase !== 'arrived' && phase !== 'opening') {
        openingUntil = Date.now() + OPENING_MS;
    }
    if (next === 'arrived' && Date.now() < openingUntil) {
        next = 'opening';
    }

    phase = next;
    strip.className = `tactile-strip state-${next}`;
    phaseButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.state === next));
}

function formatCountdown(seconds) {
    if (seconds === null) return null;
    if (seconds < 0) return 'departing';
    if (seconds < 60) return 'less than a minute';

    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} min`;

    // quiet regional platforms can be many hours from their next service
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function render() {
    infoPlatform.textContent = platform ? platform.label : '—';

    const next = departures[0];
    infoService.textContent = next ? `${next.line} to ${next.destination}` : 'No scheduled services';

    if (!liveMode) {
        infoStatus.textContent = `Demo mode — ${PHASE_LABELS[phase]}`;
        infoStatus.className = 'info-status demo';
        return;
    }

    if (lastError) {
        infoStatus.textContent = `Live data unavailable — ${lastError}`;
        infoStatus.className = 'info-status error';
        return;
    }

    const countdown = formatCountdown(secondsUntilNextDeparture());
    infoStatus.textContent = countdown
        ? `${PHASE_LABELS[phase]} · next service in ${countdown}`
        : PHASE_LABELS[phase];
    infoStatus.className = 'info-status';
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
            .filter(d => departureTimeOf(d))
            .sort((a, b) => new Date(departureTimeOf(a)) - new Date(departureTimeOf(b)));
        vehicles = positions;
        lastError = null;
    } catch (error) {
        lastError = error.message;
    }
    tick();
}

function tick() {
    if (liveMode) {
        let next = derivePhase();
        // hold the opening flash until it has run its course
        if (Date.now() < openingUntil && (next === 'arrived' || phase === 'opening')) {
            next = 'opening';
        }
        applyPhase(next);
    }
    render();
}

function startLive() {
    stopDemoCycle();
    liveMode = true;
    poll();
    if (!pollTimer) pollTimer = setInterval(poll, POLL_MS);
    if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
}

function stopDemoCycle() {
    if (demoCycleTimer) {
        clearTimeout(demoCycleTimer);
        demoCycleTimer = null;
    }
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
    openingUntil = 0;
    render();
    poll();
}

platformSelect.addEventListener('change', () => selectPlatform(platformSelect.value));

demoToggle.addEventListener('click', () => {
    const showing = !demoControls.hidden;
    demoControls.hidden = showing;
    demoToggle.setAttribute('aria-expanded', String(!showing));
    demoToggle.textContent = showing ? 'Show demo controls' : 'Hide demo controls';
});

phaseButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        stopDemoCycle();
        liveMode = false;
        openingUntil = 0;
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
