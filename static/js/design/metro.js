import api from '../api.js';

class MetroDepartureBoard {
    constructor() {
        this.stopId = null;
        this.stopName = null;
        this.refreshInterval = null;
        this.searchTimeout = null;
        this.allDepartures = [];
        this.showOnlyMetro = true; // default to metro only
        this.init();
    }

    init() {
        this.stopInput = document.getElementById('stopInput');
        this.loadBtn = document.getElementById('loadBtn');
        this.refreshBtn = document.getElementById('refreshBtn');
        this.modeToggle = document.getElementById('modeToggle');
        this.departuresEl = document.getElementById('departures');
        this.emptyStateEl = document.getElementById('emptyState');
        this.statusEl = document.getElementById('status');
        this.suggestionsEl = document.getElementById('suggestions');
        this.stationInfoEl = document.getElementById('stationInfo');
        this.stationNameEl = document.getElementById('stationName');
        this.stationIdEl = document.getElementById('stationId');
        this.headerTimeEl = document.getElementById('headerTime');
        this.headerLeftEl = document.getElementById('headerLeft');
        this.headerBusyEl = document.getElementById('headerBusy');

        this.loadBtn.addEventListener('click', () => this.loadDepartures());
        this.refreshBtn.addEventListener('click', () => this.refresh());
        this.modeToggle.addEventListener('click', () => this.toggleMode());

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

        // Set initial mode class
        this.updateModeClass();
    }

    updateModeClass() {
        if (this.departuresEl) {
            if (this.showOnlyMetro) {
                this.departuresEl.classList.remove('all-modes');
                this.departuresEl.classList.add('metro-mode');
            } else {
                this.departuresEl.classList.remove('metro-mode');
                this.departuresEl.classList.add('all-modes');
            }
        }
    }

    updateHeaderTime() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        if (this.headerTimeEl) {
            this.headerTimeEl.textContent = `Time: ${hours}:${minutes}:${seconds}`;
        }
    }

    formatTime(date) {
        return date.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' });
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

            // Filter based on mode
            let filtered = departures;
            if (this.showOnlyMetro) {
                filtered = departures.filter(dep =>
                    dep.line && dep.line.toLowerCase().includes('metro')
                );
            }

            // Update header left
            if (this.headerLeftEl) {
                this.headerLeftEl.textContent = 'Next Departures';
            }

            if (filtered.length === 0) {
                this.departuresEl.innerHTML = '';
                this.displayStationInfo();
                const now = new Date();
                const timeStr = now.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                this.showStatus(`Last updated: ${timeStr}`, '');
                return;
            }

            // Use filtered list for rendering
            this.allDepartures = filtered;
            this.renderDepartures();

            this.displayStationInfo();
            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

    renderDepartures() {
        const departuresToRender = this.allDepartures;
        if (departuresToRender.length === 0) {
            this.departuresEl.innerHTML = '<p class="no-departures">No departures</p>';
            return;
        }

        this.departuresEl.innerHTML = '';

        departuresToRender.forEach(dep => {
            const row = document.createElement('div');
            row.className = 'departure-row';

            const minsUntil = this.getMinutesUntil(dep.departureTime);
            let timeDisplay = minsUntil <= 2 ? 'NOW' : `${minsUntil} min`;
            let blinkClass = timeDisplay === 'NOW' ? 'blink' : '';

            // Determine time colour based on delay
            let timeClass = 'ontime';
            if (dep.delay > 0) {
                timeClass = dep.delay >= 3 ? 'major' : 'minor';
            }

            // Build departure row HTML based on mode
            let rowHtml = '';

            // Always include platform column (will be hidden/shown via CSS)
            rowHtml += `<div class="platform">${this.escapeHtml(dep.platform ?? '')}</div>`;

            rowHtml += `
                <div class="dest">
                    <div class="service-name">${this.escapeHtml(dep.destination)}</div>
                    ${!this.showOnlyMetro ? `<div class="route-number" style="color: ${api.getLineColor(dep.line, dep.mode)};">${this.escapeHtml(dep.line)}</div>` : ''}
                    ${dep.stoppingPattern ? `<div class="destination-via">${this.escapeHtml(dep.stoppingPattern)}</div>` : ''}
                    ${!this.showOnlyMetro ? `<div class="mode">${this.escapeHtml(dep.mode)}</div>` : ''}
                </div>
                <div class="occupancy">${dep.occupancy ?? ''}</div>
                <div class="time ${timeClass}">
                    <div class="mins ${blinkClass}">${timeDisplay}</div>
                </div>
            `;

            row.innerHTML = rowHtml;

            this.departuresEl.appendChild(row);
        });
    }

    toggleMode() {
        this.showOnlyMetro = !this.showOnlyMetro;
        this.modeToggle.textContent = this.showOnlyMetro ? 'Show all modes' : 'Show metro only';
        // Reload data with new filter
        this.fetchAndDisplay();
        // Update mode class for CSS
        this.updateModeClass();
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