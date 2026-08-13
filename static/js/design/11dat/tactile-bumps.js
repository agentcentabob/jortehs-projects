// Digital Tactile Bumps - animation-only proof of concept.
// Cycles the tactile strip through the phases sketched out for this board.
// Not wired up to the departures API yet - see CLAUDE.md.

const PHASES = [
    { state: 'idle', label: 'Before train has arrived', duration: 4000 },
    { state: 'arriving', label: 'Train arriving — doors closing', duration: 3000 },
    { state: 'opening', label: 'Doors opening', duration: 1500 },
    { state: 'arrived', label: 'Train arrived — doors open', duration: 3000 },
];

const strip = document.getElementById('tactileStrip');
const statusLabel = document.getElementById('statusLabel');
const phaseButtons = document.querySelectorAll('.phase-btn');
const playPauseBtn = document.getElementById('playPauseBtn');
const restartBtn = document.getElementById('restartBtn');

let phaseIndex = 0;
let playing = true;
let timerId = null;

function applyPhase(index) {
    phaseIndex = index;
    const phase = PHASES[index];

    strip.className = `tactile-strip state-${phase.state}`;
    statusLabel.textContent = phase.label;

    phaseButtons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.state === phase.state);
    });
}

function clearTimer() {
    if (timerId) {
        clearTimeout(timerId);
        timerId = null;
    }
}

function scheduleNext() {
    clearTimer();
    if (!playing) return;

    const phase = PHASES[phaseIndex];
    timerId = setTimeout(() => {
        const next = (phaseIndex + 1) % PHASES.length;
        applyPhase(next);
        scheduleNext();
    }, phase.duration);
}

function goToState(state) {
    const index = PHASES.findIndex((p) => p.state === state);
    if (index === -1) return;
    applyPhase(index);
    scheduleNext();
}

phaseButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
        playing = true;
        playPauseBtn.textContent = 'Pause';
        goToState(btn.dataset.state);
    });
});

playPauseBtn.addEventListener('click', () => {
    playing = !playing;
    playPauseBtn.textContent = playing ? 'Pause' : 'Play';
    if (playing) {
        scheduleNext();
    } else {
        clearTimer();
    }
});

restartBtn.addEventListener('click', () => {
    playing = true;
    playPauseBtn.textContent = 'Pause';
    applyPhase(0);
    scheduleNext();
});

applyPhase(0);
scheduleNext();
