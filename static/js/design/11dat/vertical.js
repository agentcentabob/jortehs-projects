import api from '../../api.js';
import * as common from './board-common.js';

const ROWS_PER_PLATFORM = 3;

class VerticalBoard {
    constructor() {
        this.stopId = null;
        this.stopName = null;
        this.refreshInterval = null;
        this.searchTimeout = null;
        this.allDepartures = [];
        this.init();
    }

    init() {
        this.stopInput = document.getElementById('stopInput');
        this.loadBtn = document.getElementById('loadBtn');
        this.refreshBtn = document.getElementById('refreshBtn');
        this.suggestionsEl = document.getElementById('suggestions');
        this.statusEl = document.getElementById('status');
        this.stationInfoEl = document.getElementById('stationInfo');
        this.stationNameEl = document.getElementById('stationName');
        this.stationIdEl = document.getElementById('stationId');
        this.boardTicker = document.getElementById('boardTicker');

        this.platform1HeaderTime = document.getElementById('platform1HeaderTime');
        this.platform1HeaderTitle = document.getElementById('platform1HeaderTitle');
        this.platform1NextStop = document.getElementById('platform1NextStop');
        this.platform1List = document.getElementById('platform1List');

        this.platform2HeaderTime = document.getElementById('platform2HeaderTime');
        this.platform2HeaderTitle = document.getElementById('platform2HeaderTitle');
        this.platform2NextStop = document.getElementById('platform2NextStop');
        this.platform2List = document.getElementById('platform2List');

        this.loadBtn.addEventListener('click', () => common.loadDepartures(this));
        this.refreshBtn.addEventListener('click', () => common.refresh(this));

        common.setupStationSearch(this);

        this.updateHeaderTime();
        setInterval(() => this.updateHeaderTime(), 1000);

        // kiosk deployments load via ?stop_id=
        const params = new URLSearchParams(window.location.search);
        const urlStopId = params.get('stop_id');
        if (urlStopId) {
            this.stopInput.value = urlStopId;
            common.loadDepartures(this);
        }
    }

    updateHeaderTime() {
        const now = new Date();
        const timeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (this.platform1HeaderTime) this.platform1HeaderTime.textContent = timeString;
        if (this.platform2HeaderTime) this.platform2HeaderTime.textContent = timeString;
    }

    async fetchAndDisplay() {
        this.showStatus('Loading departures...', 'loading');

        try {
            this.allDepartures = await common.fetchMetroDepartures(this.stopId);

            this.renderBoard();
            this.displayStationInfo();

            const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            this.showStatus(`Last updated: ${timeStr}`, '');
        } catch (error) {
            console.error('Error:', error);
            this.showStatus('Error loading departures. Check console for details.', 'error');
            this.clearPlatformHeaders();
            this.showNoDepartures(this.platform1List, 'Error loading departures. Please check your API key and stop ID.');
            this.showNoDepartures(this.platform2List, 'Error loading departures. Please check your API key and stop ID.');
        }
    }

    displayStationInfo() {
        common.displayStationInfo(this);
    }

    // resets to the empty state - board itself stays visible, only the message changes
    resetToEmptyState() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        this.stationInfoEl.style.display = 'none';
        this.clearPlatformHeaders();
        this.showNoDepartures(this.platform1List);
        this.showNoDepartures(this.platform2List);
    }

    // station is real and on the M1, just not open yet (Bankstown extension)
    showLineOpeningSoon() {
        this.allDepartures = [];
        this.clearPlatformHeaders();
        this.showNoDepartures(this.platform1List, 'No service (line opening soon)');
        this.showNoDepartures(this.platform2List, 'No service (line opening soon)');
        this.updateTicker(true);
        this.displayStationInfo();
    }

    clearPlatformHeaders() {
        this.platform1HeaderTitle.textContent = 'Platform –';
        this.platform2HeaderTitle.textContent = 'Platform –';
        this.platform1NextStop.textContent = '';
        this.platform2NextStop.textContent = '';
    }

    renderBoard() {
        // nothing running (e.g. late night) - no departures to group platforms by,
        // so show the message directly instead of a fake shell
        if (this.allDepartures.length === 0) {
            this.clearPlatformHeaders();
            this.showNoDepartures(this.platform1List);
            this.showNoDepartures(this.platform2List);
            this.updateTicker();
            return;
        }

        const platformGroups = {};
        this.allDepartures.forEach(dep => {
            const platform = api.getShortPlatform(dep.platform) || 'Unknown';
            if (!platformGroups[platform]) platformGroups[platform] = [];
            platformGroups[platform].push(dep);
        });

        const sortedPlatforms = Object.keys(platformGroups).sort(
            (a, b) => platformGroups[b].length - platformGroups[a].length
        );

        const realPlatform1 = sortedPlatforms[0];
        this.renderRealPlatform(this.platform1HeaderTitle, this.platform1NextStop, this.platform1List, realPlatform1, platformGroups[realPlatform1]);

        if (sortedPlatforms.length >= 2) {
            const realPlatform2 = sortedPlatforms[1];
            this.renderRealPlatform(this.platform2HeaderTitle, this.platform2NextStop, this.platform2List, realPlatform2, platformGroups[realPlatform2]);
        } else {
            // only one active platform - work out what the other should say
            // instead of just repeating platform 1's data
            this.renderMissingPlatform(realPlatform1, platformGroups[realPlatform1]);
        }

        this.updateTicker();
    }

    renderRealPlatform(titleEl, nextStopEl, listEl, platformNumber, departures) {
        titleEl.textContent = `Platform ${platformNumber}`;
        this.updateNextStop(nextStopEl, departures);
        this.renderPlatformRows(listEl, departures);
    }

    renderMissingPlatform(realPlatformNumber, realDepartures) {
        const otherPlatformNumber = realPlatformNumber === '2' ? '1' : '2';
        this.platform2HeaderTitle.textContent = `Platform ${otherPlatformNumber}`;

        const sampleDestination = realDepartures[0] ? realDepartures[0].destination : null;
        const neighbor = sampleDestination ? api.getOppositeNextStop(this.stopName, sampleDestination) : null;

        if (!neighbor) {
            // genuine terminus in this direction (e.g. Tallawong) - nothing runs the other way
            this.platform2NextStop.textContent = '';
            this.showNoDepartures(this.platform2List, 'No upcoming services');
        } else if (!api.isM1StationOpen(neighbor)) {
            // the other direction leads straight into the unopened Bankstown extension
            this.platform2NextStop.textContent = `Next stop ${neighbor}`;
            this.showNoDepartures(this.platform2List, 'No service (line opening soon)');
        } else {
            // an open segment with genuinely no current data - rare, generic fallback
            this.platform2NextStop.textContent = `Next stop ${neighbor}`;
            this.showNoDepartures(this.platform2List);
        }
    }

    showNoDepartures(listEl, message = 'No information available. Select a valid Metro station.') {
        listEl.innerHTML = `<p class="no-departures">${api.escapeHtml(message)}</p>`;
    }

    // derived from the first departure's direction - a platform's queued
    // departures all run the same way (see m1-line.js)
    updateNextStop(el, departures) {
        if (!el) return;
        const dest = departures && departures[0] ? departures[0].destination : null;
        const nextStop = dest ? api.getNextStop(this.stopName, dest) : null;
        el.textContent = nextStop ? `Next stop ${nextStop}` : '';
    }

    // welcome ticker above the top platform display
    updateTicker(openingSoon = false) {
        if (!this.boardTicker) return;

        // station name only, no suburb (e.g. "Central Station, Sydney" -> "Central Station")
        const shortStationName = (this.stopName || '').split(',')[0].trim();

        let message;
        if (openingSoon) {
            message = `Welcome to ${shortStationName}. No service (line opening soon).`;
        } else {
            // line names come from the live departures, so this stays correct as tfnsw extends the line
            const lines = [...new Set(this.allDepartures.map(dep => dep.line).filter(Boolean))];
            message = lines.length > 0
                ? `Welcome to ${shortStationName}. Good service on ${lines.join(', ')}.`
                : `Welcome to ${shortStationName}.`;
        }

        this.setScrollingText(this.boardTicker, message);
    }

    // always renders a fixed number of rows, padding with placeholders so the
    // board layout never shifts when a platform is quiet
    renderPlatformRows(listEl, departures) {
        listEl.innerHTML = '';

        const rows = departures.slice(0, ROWS_PER_PLATFORM);
        for (let i = 0; i < ROWS_PER_PLATFORM; i++) {
            const row = rows[i] ? this.buildRow(rows[i]) : this.buildPlaceholderRow();
            listEl.appendChild(row);
        }
    }

    buildRow(dep) {
        const minsUntil = api.getMinutesUntil(dep.departureTime);
        let timeDisplay = '-';
        let blinkClass = '';
        if (minsUntil !== null) {
            timeDisplay = minsUntil <= 0 ? 'NOW' : `${minsUntil} min`;
            if (timeDisplay === 'NOW') blinkClass = 'blink';
        }

        let timeClass = 'ontime';
        if (dep.delay > 0) timeClass = dep.delay >= 3 ? 'major' : 'minor';

        const row = document.createElement('div');
        row.className = 'vertical-row';

        const main = document.createElement('div');
        main.className = 'row-main';

        const destLine = document.createElement('div');
        destLine.className = 'row-dest-line';

        const destEl = document.createElement('span');
        destEl.className = 'row-dest';
        destEl.textContent = api.shortStationName(dep.destination) || 'Unknown';
        destLine.appendChild(destEl);

        main.appendChild(destLine);

        // tfnsw has no real stopping-pattern data for metro - see m1-line.js
        const badgeEl = document.createElement('div');
        badgeEl.className = 'row-badge';
        badgeEl.textContent = api.getStoppingPatternText(this.stopName, dep.destination, dep.stoppingPattern);
        main.appendChild(badgeEl);

        row.appendChild(main);

        // occupancy/time are direct grid children so widths stay fixed. falls back
        // to a bare div when renderOccupancyIcons returns '', so the 3-column grid
        // keeps its structure
        const occupancyEl = document.createElement('div');
        occupancyEl.innerHTML = api.renderOccupancyIcons(api.getOccupancyLevel(dep.occupancy));
        row.appendChild(occupancyEl.firstElementChild || document.createElement('div'));

        const timeEl = document.createElement('div');
        timeEl.className = `row-time ${timeClass} ${blinkClass}`.trim();
        timeEl.textContent = timeDisplay;
        row.appendChild(timeEl);

        return row;
    }

    buildPlaceholderRow() {
        const row = document.createElement('div');
        row.className = 'vertical-row placeholder';

        const main = document.createElement('div');
        main.className = 'row-main';
        const destLine = document.createElement('div');
        destLine.className = 'row-dest-line';
        const destEl = document.createElement('span');
        destEl.className = 'row-dest';
        destEl.textContent = '—';
        destLine.appendChild(destEl);
        main.appendChild(destLine);
        const badgeEl = document.createElement('div');
        badgeEl.className = 'row-badge placeholder';
        badgeEl.textContent = '—';
        main.appendChild(badgeEl);
        row.appendChild(main);

        row.appendChild(document.createElement('div'));

        const timeEl = document.createElement('div');
        timeEl.className = 'row-time';
        timeEl.textContent = '—';
        row.appendChild(timeEl);

        return row;
    }

    // plain text, or a scrolling marquee once it's too long to fit (used by the ticker)
    setScrollingText(container, text) {
        container.textContent = '';
        container.classList.remove('scrolling');
        const span = document.createElement('span');
        span.className = 'status-text';
        span.textContent = text;
        container.appendChild(span);
        if (text.length > 40) {
            container.classList.add('scrolling');
        }
    }

    showStatus(message, type) {
        common.showStatus(this.statusEl, message, type);
    }
}

new VerticalBoard();
