import api from '../../api.js';
import * as common from './board-common.js';

class HorizontalBoard {
    constructor() {
        this.stopId = null;
        this.stopName = null;
        this.refreshInterval = null;
        this.searchTimeout = null;
        this.allDepartures = [];
        this.selectedPlatform = 'all';
        this.init();
    }

    init() {
        this.stopInput = document.getElementById('stopInput');
        this.loadBtn = document.getElementById('loadBtn');
        this.refreshBtn = document.getElementById('refreshBtn');
        this.departuresEl = document.getElementById('departures');
        this.statusEl = document.getElementById('status');
        this.suggestionsEl = document.getElementById('suggestions');
        this.stationInfoEl = document.getElementById('stationInfo');
        this.stationNameEl = document.getElementById('stationName');
        this.stationIdEl = document.getElementById('stationId');
        this.headerTimeEl = document.getElementById('headerTime');
        this.headerLeftEl = document.getElementById('headerLeft');
        this.platformToggle = document.getElementById('platformToggle');

        this.loadBtn.addEventListener('click', () => common.loadDepartures(this));
        this.refreshBtn.addEventListener('click', () => common.refresh(this));
        this.platformToggle.addEventListener('click', (e) => {
            const btn = e.target.closest('.platform-toggle-btn');
            if (!btn) return;
            this.selectedPlatform = btn.dataset.platform;
            [...this.platformToggle.children].forEach(b => b.classList.toggle('active', b === btn));
            this.renderDepartures();
        });

        common.setupStationSearch(this);

        this.updateHeaderTime();
        setInterval(() => this.updateHeaderTime(), 1000);
    }

    updateHeaderTime() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const timeString = `${hours}:${minutes}`;

        if (this.headerTimeEl) {
            this.headerTimeEl.textContent = `Time now: ${timeString}`;
        }
    }

    async fetchAndDisplay() {
        this.showStatus('Loading departures...', 'loading');

        try {
            this.allDepartures = await common.fetchMetroDepartures(this.stopId);

            if (this.headerLeftEl) {
                this.headerLeftEl.textContent = 'Next Departures';
            }

            this.updatePlatformSelector();
            this.renderDepartures();

            this.displayStationInfo();
            const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            this.showStatus(`Last updated: ${timeStr}`, '');
        } catch (error) {
            console.error('Error:', error);
            this.showStatus('Error loading departures. Check console for details.', 'error');
            this.departuresEl.innerHTML = '<p class="no-departures">Error loading departures. Please check your API key and stop ID.</p>';
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
        this.departuresEl.innerHTML = '<p class="no-departures">No information available. Select a valid Metro station.</p>';
        this.stationInfoEl.style.display = 'none';
        this.selectedPlatform = 'all';
        this.platformToggle.innerHTML = '';
        this.platformToggle.style.display = 'none';
    }

    // station is real and on the M1, just not open yet (Bankstown extension)
    showLineOpeningSoon() {
        this.allDepartures = [];
        this.platformToggle.innerHTML = '';
        this.platformToggle.style.display = 'none';
        this.departuresEl.innerHTML = '<p class="no-departures">No service (line opening soon)</p>';
        this.displayStationInfo();
    }

    // shows the platform picker only when the station has more than one
    updatePlatformSelector() {
        const platforms = [...new Set(this.allDepartures.map(dep => api.getShortPlatform(dep.platform)))]
            .filter(p => p && p !== '-')
            .sort();

        if (platforms.length <= 1) {
            this.platformToggle.innerHTML = '';
            this.platformToggle.style.display = 'none';
            this.selectedPlatform = 'all';
            return;
        }

        if (this.selectedPlatform !== 'all' && !platforms.includes(this.selectedPlatform)) {
            this.selectedPlatform = 'all';
        }

        const options = [{ value: 'all', label: 'All' }, ...platforms.map(p => ({ value: p, label: p }))];
        this.platformToggle.innerHTML = options.map(o => {
            const active = o.value === this.selectedPlatform ? ' active' : '';
            return `<button type="button" class="platform-toggle-btn${active}" data-platform="${api.escapeHtml(o.value)}">${api.escapeHtml(o.label)}</button>`;
        }).join('');
        this.platformToggle.style.display = 'flex';
    }

    renderDepartures() {
        const filteredByPlatform = this.selectedPlatform === 'all'
            ? this.allDepartures
            : this.allDepartures.filter(dep => api.getShortPlatform(dep.platform) === this.selectedPlatform);

        const departuresToRender = filteredByPlatform.slice(0, 4);
        if (departuresToRender.length === 0) {
            this.departuresEl.innerHTML = '<p class="no-departures">No information available. Select a valid Metro station.</p>';
            return;
        }

        this.departuresEl.innerHTML = '';

        departuresToRender.forEach(dep => {
            const minsUntil = api.getMinutesUntil(dep.departureTime);
            let timeDisplay;
            let blinkClass = '';
            if (minsUntil === null) {
                timeDisplay = '-';
            } else {
                timeDisplay = minsUntil <= 0 ? 'NOW' : `${minsUntil} min`;
                if (timeDisplay === 'NOW') {
                    blinkClass = 'blink';
                }
            }

            let timeClass = 'ontime';
            if (dep.delay > 0) {
                timeClass = dep.delay >= 3 ? 'major' : 'minor';
            }

            const row = document.createElement('div');
            row.className = 'departure-row';

            const destEl = document.createElement('div');
            destEl.className = 'dest';

            const nameLineEl = document.createElement('div');
            nameLineEl.className = 'name-line';

            const serviceNameEl = document.createElement('div');
            serviceNameEl.className = 'service-name';
            serviceNameEl.textContent = api.shortStationName(dep.destination) || 'Unknown';
            nameLineEl.appendChild(serviceNameEl);

            // tfnsw has no real stopping-pattern data for metro - see m1-line.js
            const stoppingPatternEl = document.createElement('div');
            stoppingPatternEl.className = 'destination-via';
            stoppingPatternEl.textContent = api.getStoppingPatternText(this.stopName, dep.destination, dep.stoppingPattern);
            nameLineEl.appendChild(stoppingPatternEl);

            destEl.appendChild(nameLineEl);
            row.appendChild(destEl);

            const occupancyEl = document.createElement('div');
            occupancyEl.className = 'occupancy';
            occupancyEl.innerHTML = api.renderOccupancyIcons(api.getOccupancyLevel(dep.occupancy));
            row.appendChild(occupancyEl);

            const timeEl = document.createElement('div');
            timeEl.className = `time ${timeClass}`;
            timeEl.innerHTML = `<div class="mins ${blinkClass}">${timeDisplay}</div>`;
            row.appendChild(timeEl);

            this.departuresEl.appendChild(row);
        });
    }

    showStatus(message, type) {
        common.showStatus(this.statusEl, message, type);
    }
}

new HorizontalBoard();
