import api from '../../api.js';

class HorizontalBoard {
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
        this.departuresEl = document.getElementById('departures');
        this.emptyStateEl = document.getElementById('emptyState');
        this.statusEl = document.getElementById('status');
        this.suggestionsEl = document.getElementById('suggestions');
        this.stationInfoEl = document.getElementById('stationInfo');
        this.stationNameEl = document.getElementById('stationName');
        this.stationIdEl = document.getElementById('stationId');
        this.headerTimeEl = document.getElementById('headerTime');
        this.headerLeftEl = document.getElementById('headerLeft');

        this.loadBtn.addEventListener('click', () => this.loadDepartures());
        this.refreshBtn.addEventListener('click', () => this.refresh());

        this.stopInput.addEventListener('input', (e) => this.handleSearch(e));
        this.stopInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.loadDepartures();
            }
        });

        document.addEventListener('click', (e) => {
            if (e.target !== this.stopInput) {
                this.suggestionsEl.style.display = 'none';
            }
        });

        const savedStopId = localStorage.getItem('lastStopId');
        if (savedStopId) {
            this.stopInput.value = savedStopId;
        }

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

    async handleSearch(e) {
        const query = e.target.value.trim();

        if (query.length < 4) {
            this.suggestionsEl.style.display = 'none';
            return;
        }

        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(async () => {
            try {
                const stops = await api.searchStops(query);
                this.displaySuggestions(stops.slice(0, 6));
            } catch (error) {
                console.error('Search error:', error);
            }
        }, 300);
    }

    displaySuggestions(stops) {
        this.suggestionsEl.innerHTML = '';

        if (stops.length === 0) {
            this.suggestionsEl.style.display = 'none';
            return;
        }

        stops.forEach(stop => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.innerHTML = `<span class="stop-name">${api.escapeHtml(stop.name)}</span><span class="stop-id">${stop.id}</span>`;
            item.addEventListener('click', () => {
                this.stopInput.value = stop.name;
                this.stopId = stop.id;
                this.stopName = stop.name;
                this.suggestionsEl.style.display = 'none';
                this.loadDepartures();
            });
            this.suggestionsEl.appendChild(item);
        });

        this.suggestionsEl.style.display = 'block';
    }

    async loadDepartures() {
        const inputValue = this.stopInput.value.trim();

        if (!inputValue) {
            this.showStatus('Please enter a stop ID or search for a station', 'error');
            return;
        }

        // keep the resolved id/name if the box still shows exactly what a suggestion
        // set, otherwise resolve whatever was typed - name or stop id - via search
        if (!(this.stopId && this.stopName === inputValue)) {
            this.showStatus('Looking up station...', 'loading');
            try {
                const stops = await api.searchStops(inputValue);
                if (stops.length > 0) {
                    this.stopId = stops[0].id;
                    this.stopName = stops[0].name;
                } else {
                    this.stopId = inputValue;
                    this.stopName = inputValue;
                }
            } catch (error) {
                console.error('Stop lookup error:', error);
                this.stopId = inputValue;
                this.stopName = inputValue;
            }
        }

        // this board only shows metro (m1) departures - reject anything else here
        if (!api.isM1Station(this.stopName)) {
            this.showStatus(`"${inputValue}" is not a valid Metro station`, 'error');
            this.stopId = null;
            this.stopName = null;
            this.resetToEmptyState();
            return;
        }

        localStorage.setItem('lastStopId', this.stopId);

        await this.fetchAndDisplay();

        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        this.refreshInterval = setInterval(() => this.refresh(), 30000);
    }

    async refresh() {
        if (!this.stopId) return;
        await this.fetchAndDisplay();
    }

    async fetchAndDisplay() {
        this.showStatus('Loading departures...', 'loading');
        this.emptyStateEl.style.display = 'none';

        try {
            const rawData = await api.getDeparturesRaw(this.stopId);
            const departures = api.parseDeparturesRaw(rawData);

            // this board only ever shows metro departures
            const filtered = departures.filter(dep =>
                dep.line && dep.line.toLowerCase().includes('metro')
            );

            if (this.headerLeftEl) {
                this.headerLeftEl.textContent = 'Next Departures';
            }

            if (filtered.length === 0) {
                this.departuresEl.innerHTML = '';
            } else {
                this.allDepartures = filtered;
                this.renderDepartures();
            }

            this.displayStationInfo();
            const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            this.showStatus(`Last updated: ${timeStr}`, '');
        } catch (error) {
            console.error('Error:', error);
            this.showStatus('Error loading departures. Check console for details.', 'error');
            this.emptyStateEl.style.display = 'block';
            this.emptyStateEl.innerHTML = '<p>Error loading departures. Please check your API key and stop ID.</p>';
        }
    }

    displayStationInfo() {
        if (this.stopId && this.stopName) {
            this.stationNameEl.textContent = this.stopName;
            this.stationIdEl.textContent = `(${this.stopId})`;
            this.stationInfoEl.style.display = 'block';
        } else if (this.stopId) {
            this.stationNameEl.textContent = this.stopId;
            this.stationIdEl.textContent = '';
            this.stationInfoEl.style.display = 'block';
        }
    }

    // reverts the board to its initial empty state - used when a station turns out not to be metro
    resetToEmptyState() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        this.departuresEl.innerHTML = '';
        this.stationInfoEl.style.display = 'none';
        this.emptyStateEl.style.display = 'block';
        this.emptyStateEl.innerHTML = '<p>Enter a stop ID or search for a station and click "Load Departures" to begin</p>';
    }

    renderDepartures() {
        const departuresToRender = this.allDepartures.slice(0, 4);
        if (departuresToRender.length === 0) {
            this.departuresEl.innerHTML = '<p class="no-departures">No departures</p>';
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

            // destination and stopping pattern share a line
            const nameLineEl = document.createElement('div');
            nameLineEl.className = 'name-line';

            const serviceNameEl = document.createElement('div');
            serviceNameEl.className = 'service-name';
            serviceNameEl.textContent = api.escapeHtml(dep.destination) || 'Unknown';
            nameLineEl.appendChild(serviceNameEl);

            // tfnsw doesn't provide real stopping-pattern data for metro - see m1Line.js
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
        this.statusEl.textContent = message;
        this.statusEl.className = `status ${type}`;
    }
}

new HorizontalBoard();
