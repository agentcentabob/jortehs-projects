import api from '../../api.js';

const form = document.getElementById('lookupForm');
const input = document.getElementById('queryInput');
const results = document.getElementById('results');
const examplesEl = document.getElementById('examples');
const fleetGrid = document.getElementById('fleetGrid');

// per-operator brand colour, falls back to sydney trains orange
const OPERATOR_COLOURS = {
    'Sydney Trains': '--sydneytrains',
    'NSW TrainLink': '--nswtl'
};

const PLACEHOLDER = `
    <section class="tile tile-placeholder">
        Enter a carriage number to find its set, or a set number to see what runs in it.
    </section>`;

let fleets = [];

function esc(text) {
    return api.escapeHtml(text == null ? '' : String(text));
}

// ------------------------------------------------------------------ rendering

function setAccent(operator) {
    const cssVar = OPERATOR_COLOURS[operator] || '--sydneytrains';
    results.style.setProperty('--accent', `var(${cssVar})`);
}

function field(label, value) {
    if (!value && value !== 0) return '';
    return `
        <div class="answer-cell">
            <span class="field-label">${esc(label)}</span>
            <strong>${esc(value)}</strong>
        </div>`;
}

function answerTile(data) {
    const { set, fleet, carriage, formation } = data;
    const carsText = `${set.cars} car${set.cars === 1 ? '' : 's'}`;

    // no single carriage to describe when matched by set number
    let details = '';

    if (carriage) {
        // position left out where the formation isn't in running order (see OSCAR)
        details = field('Carriage', carriage.number)
            + field('Type', carriage.type)
            + (carriage.position ? field('Position in set', `Car ${carriage.position} of ${set.cars}`) : '')
            + field('Set length', carsText);
    }

    return `
        <section class="tile tile-answer">
            <h2 class="tile-title">${carriage ? 'Set number' : 'Set'}</h2>
            <div class="answer-set">${esc(set.number)}</div>
            <div class="answer-fleet">${esc(fleet.name)}</div>
            <div class="answer-sub">${esc(fleet.service)} · ${esc(carsText)}${formation.complete ? '' : ' · partial formation'}</div>
            ${details ? `<div class="answer-carriage">${details}</div>` : ''}
        </section>`;
}

function fleetTile(fleet) {
    // "K set" is already the class name, so "K set (K sets)" reads as a stutter
    const className = /set$/i.test(fleet.name)
        ? `${fleet.name}s`
        : `${fleet.name} (${fleet.code} sets)`;

    const facts = [
        ['Class', className],
        ['Built by', fleet.builder],
        ['Entered service', fleet.introduced],
        ['Operator', fleet.operator],
        ['Used on', fleet.service],
        ['Cars per set', `${fleet.cars}, ${fleet.deck}`]
    ];
    const rows = facts
        .filter(([, value]) => value)
        .map(([label, value]) => `
            <div class="fleet-fact">
                <span class="field-label">${esc(label)}</span>
                <strong>${esc(value)}</strong>
            </div>`)
        .join('');

    return `
        <section class="tile tile-fleet">
            <h2 class="tile-title">The fleet</h2>
            <div class="fleet-facts">${rows}</div>
        </section>`;
}

function formationTile(data) {
    const { formation, set } = data;
    if (!formation.cars.length) return '';

    const cars = formation.cars.map((car) => `
        <div class="car${car.isMatch ? ' car-match' : ''}">
            ${formation.ordered ? `<span class="car-position">Car ${car.position}</span>` : ''}
            <span class="car-number">${esc(car.number)}</span>
            <span class="car-type">${esc(car.type)}</span>
        </div>`).join('');

    const source = formation.source === 'table'
        ? `Listed in the ${esc(data.fleet.name)} composition table, in running order.`
        : `Worked out from the numbering rule rather than a roster, so it shows what the rule says set ${esc(set.number)} is made of.`;

    return `
        <section class="tile tile-formation">
            <h2 class="tile-title">Set ${esc(set.number)} formation</h2>
            <div class="formation-strip">${cars}</div>
            <p class="formation-source">${source}</p>
            ${formation.note ? `<p class="formation-note">${esc(formation.note)}</p>` : ''}
        </section>`;
}

function workingTile(data) {
    const steps = data.derivation.steps
        .map((step) => `<li>${esc(step)}</li>`)
        .join('');
    const heading = data.derivation.method === 'table'
        ? 'How it was looked up'
        : 'How the set number was worked out';

    return `
        <section class="tile tile-working">
            <h2 class="tile-title">${heading}</h2>
            <ol class="working-steps">${steps}</ol>
        </section>`;
}

function errorTile(data) {
    return `
        <section class="tile tile-error">
            <strong>${esc(data.query || '')} didn't match anything</strong>
            ${esc(capitalise(data.reason))}.
        </section>`;
}

function capitalise(text) {
    const value = String(text || '');
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function render(data) {
    if (!data.found) {
        results.style.removeProperty('--accent');
        results.innerHTML = errorTile(data);
        return;
    }
    setAccent(data.fleet.operator);
    results.innerHTML = answerTile(data)
        + fleetTile(data.fleet)
        + formationTile(data)
        + workingTile(data);
}

// ------------------------------------------------------------------ lookup

async function lookup(query, { focus = false } = {}) {
    const trimmed = (query || '').trim();
    if (!trimmed) {
        results.innerHTML = PLACEHOLDER;
        return;
    }

    input.value = trimmed;
    // linkable without adding a history entry per keystroke
    const url = new URL(window.location.href);
    url.searchParams.set('q', trimmed);
    window.history.replaceState({}, '', url);

    try {
        render(await api.checkSet(trimmed));
    } catch (error) {
        console.error('Set lookup failed:', error);
        results.innerHTML = `
            <section class="tile tile-error">
                <strong>Couldn't reach the checker</strong>
                ${esc(error.message)}.
            </section>`;
    }

    if (focus) input.focus();
}

form.addEventListener('submit', (event) => {
    event.preventDefault();
    lookup(input.value);
});

// ------------------------------------------------------------------ reference

function renderExamples() {
    // one carriage per fleet, plus a couple of set numbers, both directions covered.
    // 4/6 car Mariyung share a name, so those two chips need the car count
    const nameCounts = {};
    fleets.forEach((fleet) => { nameCounts[fleet.name] = (nameCounts[fleet.name] || 0) + 1; });

    const chips = fleets
        .filter((fleet) => fleet.examples && fleet.examples.length)
        .map((fleet) => ({
            value: fleet.examples[0],
            label: nameCounts[fleet.name] > 1
                ? `${fleet.name} ${fleet.cars} car`
                : `${fleet.name} carriage`
        }));

    chips.push({ value: 'K72', label: 'K set number' });
    chips.push({ value: 'A12', label: 'Waratah set number' });

    examplesEl.innerHTML = chips.map((chip) => `
        <button type="button" class="example-btn" data-query="${esc(chip.value)}">
            ${esc(chip.value)}<span class="example-fleet">${esc(chip.label)}</span>
        </button>`).join('');
}

function fleetCard(fleet) {
    const meta = [];
    if (fleet.builder) meta.push(`Built by ${esc(fleet.builder)}`);
    if (fleet.introduced) meta.push(`in service from ${esc(fleet.introduced)}`);

    const numbering = fleet.lookup === 'table'
        ? `${fleet.setsKnown} sets and ${fleet.carriagesKnown} carriages in the composition table.`
        : `Any carriage starting ${(fleet.prefixes || []).map((p) => `<code>${esc(p)}</code>`).join(' ')}.`;

    const browse = fleet.lookup === 'table' && fleet.sets.length
        ? `<details class="fleet-sets">
               <summary>Browse all ${fleet.setsKnown} sets</summary>
               <div class="fleet-sets-list">
                   ${fleet.sets.map((s) => `<button type="button" class="set-chip" data-query="${esc(s)}">${esc(s)}</button>`).join('')}
               </div>
           </details>`
        : '';

    return `
        <article class="fleet-card">
            <div class="fleet-card-head">
                <span class="fleet-card-name">${esc(fleet.name)}</span>
                <span class="fleet-card-code">${esc(fleet.code)} · ${fleet.cars} car</span>
            </div>
            <p class="fleet-card-meta">
                ${meta.join(', ')}${meta.length ? '. ' : ''}${esc(fleet.operator)}, ${esc(fleet.service.toLowerCase())}.
            </p>
            <p class="fleet-card-meta">${numbering}</p>
            ${browse}
        </article>`;
}

function renderFleets() {
    fleetGrid.innerHTML = fleets.map(fleetCard).join('');
}

// every chip on the page does the same thing, so one listener covers the lot -
// including the set chips inside the collapsed browse lists
document.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-query]');
    if (!chip) return;
    lookup(chip.dataset.query, { focus: true });
});

// ------------------------------------------------------------------ start

async function init() {
    results.innerHTML = PLACEHOLDER;
    try {
        fleets = await api.getSetCheckerFleets();
        renderExamples();
        renderFleets();
    } catch (error) {
        console.error('Could not load the fleet reference:', error);
        fleetGrid.innerHTML = '<p class="fleet-card-meta">The fleet reference could not be loaded.</p>';
    }

    // ?q= makes a result linkable, and doubles as the way the examples share state
    const initial = new URLSearchParams(window.location.search).get('q');
    if (initial) lookup(initial);
}

init();
