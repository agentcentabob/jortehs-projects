import api from '../api.js';

class MetroDepartureBoard {
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

        // Start updating the header time
        this.updateHeaderTime();
        setInterval(() => this.updateHeaderTime(), 1000);
    }

    updateHeaderTime() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        if (this.headerTimeEl) {
            this.headerTimeEl.textContent = `time: ${hours}:${minutes}`;
        }
    }

    async handleSearch(e) {
        const query = e.target.value.trim();

        if (query.length < 2) {
            this.suggestionsEl.style.display = 'none';
            return;
        }

        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(async () => {
            try {
                const stops = await api.searchStops(query);
                this.displaySuggestions(stops);
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
            item.innerHTML = `<span class="stop-name">${this.escapeHtml(stop.name)}</span><span class="stop-id">${stop.id}</span>`;
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

        this.stopId = null;
        this.stopName = null;

        if (!this.stopId) {
            this.stopId = inputValue;
            this.stopName = inputValue;
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
            this.allDepartures = departures;

            if (departures.length === 0) {
                this.departuresEl.innerHTML = '<p class="no-departures">No departures found. Check the stop id or selected date.</p>';
                this.showStatus('No departures found', 'error');
                this.displayStationInfo();
                return;
            }

            this.renderDepartures();
            this.displayStationInfo();
            const now = new Date().toLocaleTimeString('en-AU', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            this.showStatus(`Last updated: ${now}`, '');

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

    renderDepartures(departuresToRender = this.allDepartures) {
        if (departuresToRender.length === 0) {
            this.departuresEl.innerHTML = '<p class="no-departures">No departures found. Check the stop id or selected date.</p>';
            return;
        }

        this.departuresEl.innerHTML = '';

        departuresToRender.forEach(dep => {
            const row = document.createElement('div');
            row.className = 'departure-row';

            const minsUntil = this.getMinutesUntil(dep.departureTime);

            let timeDisplay = '';
            if (minsUntil <= 2) {
                timeDisplay = '<span class="time-mins">NOW</span>';
            } else {
                timeDisplay = `<span class="time-mins">${minsUntil} min</span>`;
            }

            if (dep.delay > 0) {
                let delayClass = 'delay-minor';
                if (dep.delay >= 3) {
                    delayClass = 'delay-major';
                }
                timeDisplay += ` <span class="time-delay ${delayClass}">[+${dep.delay}]</span>`;
            } else if (minsUntil > 2) {
                timeDisplay += ` <span class="time-delay delay-ontime">[on time]</span>`;
            }

            const shortLine = this.getShortLineName(dep.line);
            const lineColor = api.getLineColor(dep.line, dep.mode);
            const lineStyle = `background-color: ${lineColor}; color: ${this.getContrastedTextColor(lineColor)}; border-radius:4px; padding:2px 6px;`;

            const shortPlatform = this.getShortPlatform(dep.platform);
            const platformLabel = shortPlatform || '-';

            const fleetInfo = dep.fleetType ? ` ${dep.fleetType}` : '';
            const stoppingInfo = dep.stoppingPattern ? ` ${dep.stoppingPattern}` : '';

            row.innerHTML = `
                <div class="col-time">${timeDisplay}</div>
                <div class="col-line" style="${lineStyle}">${this.escapeHtml(shortLine)}</div>
                <div class="col-destination">
                    <div class="destination-main">${this.escapeHtml(dep.destination)}</div>
                </div>
                <div class="col-platform">${platformLabel}</div>
            `;

            this.departuresEl.appendChild(row);
        });
    }

    // Helper methods (copied from original api.js)
    getMinutesUntil(datetime) {
        const now = new Date();
        const departure = new Date(datetime);
        const diff = Math.round((departure - now) / 60000);
        return diff;
    }

    getShortLineName(lineName) {
        if (!lineName) return 'Unknown';

        // remove spaces and convert to uppercase
        let short = lineName.trim().toUpperCase();

        // extract just the line identifier (T1, F2, L3, etc)
        const match = short.match(/([TFL])(\d+|[A-Z]+)/);
        if (match) {
            return match[1] + match[2];
        }

        // try other patterns
        if (short.includes('METRO')) return 'Metro';
        if (short.includes('BUS')) return short.split(' ')[0];
        if (short.includes('TRAIN')) return 'Train';

        // Return first 4 characters if nothing else matches
        return short.substring(0, 4);
    }

    getShortPlatform(platformString) {
        if (!platformString) return '-';

        const str = platformString.trim().toUpperCase();

        // For bus stops like "Stop A", "Stop B"
        const busMatch = str.match(/STOP\s*([A-Z])/);
        if (busMatch) return busMatch[1];

        // For platforms like "Platform 1", "Platform 2"
        const platformMatch = str.match(/PLATFORM\s*(\d+)/);
        if (platformMatch) return platformMatch[1];

        // For numbered formats
        const numMatch = str.match(/\d+/);
        if (numMatch) return numMatch[0];

        // For letter formats
        const letterMatch = str.match(/[A-Z]/);
        if (letterMatch) return letterMatch[0];

        return platformString;
    }

    getContrastedTextColor(hexColor) {
        const r = parseInt(hexColor.slice(1, 3), 16);
        const g = parseInt(hexColor.slice(3, 5), 16);
        const b = parseInt(hexColor.slice(5, 7), 16);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

    showStatus(message, type) {
        this.statusEl.textContent = message;
        this.statusEl.className = `status ${type}`;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

new MetroDepartureBoard();