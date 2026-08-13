// import api from '../api.js';
import api from '../api.js';

class DepartureBoard {
    constructor() {
        this.stopId = null;
        this.stopName = null;
        this.refreshInterval = null;
        this.searchTimeout = null;
        this.allDepartures = []; // store all fetched departures
        this.init();
    }

    init() {
        // get DOM elements
        this.stopInput = document.getElementById('stopInput');
        this.loadBtn = document.getElementById('loadBtn');
        this.refreshBtn = document.getElementById('refreshBtn');
        this.modeFilterEl = document.getElementById('modeFilter');
        this.departuresEl = document.getElementById('departures');
        this.emptyStateEl = document.getElementById('emptyState');
        this.statusEl = document.getElementById('status');
        this.suggestionsEl = document.getElementById('suggestions');
        this.stationInfoEl = document.getElementById('stationInfo');
        this.stationNameEl = document.getElementById('stationName');
        this.stationIdEl = document.getElementById('stationId');

        // set up event listeners
        this.loadBtn.addEventListener('click', () => this.loadDepartures());
        this.refreshBtn.addEventListener('click', () => this.refresh());
        this.modeFilterEl.addEventListener('change', () => this.renderDepartures());

        // add search functionality
        this.stopInput.addEventListener('input', (e) => this.handleSearch(e));
        this.stopInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.loadDepartures();
            }
        });

        // close suggestions when clicking outside
        document.addEventListener('click', (e) => {
            if (e.target !== this.stopInput) {
                this.suggestionsEl.style.display = 'none';
            }
        });

        // load from localStorage if available
        const savedStopId = localStorage.getItem('lastStopId');
        if (savedStopId) {
            this.stopInput.value = savedStopId;
        }
    }

    async handleSearch(e) {
        const query = e.target.value.trim();

        if (query.length < 2) {
            this.suggestionsEl.style.display = 'none';
            return;
        }

        // debounce search
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

        // Clear previous stop data
        this.stopId = null;
        this.stopName = null;

        // if stopId is not already set from search, use the input value
        if (!this.stopId) {
            this.stopId = inputValue;
            this.stopName = inputValue;
        }

        localStorage.setItem('lastStopId', this.stopId);

        await this.fetchAndDisplay();

        // set up auto-refresh every 30 seconds
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
            console.log('Fetched departures:', departures.length, departures);
            this.allDepartures = departures;

            if (departures.length === 0) {
                // Show message in departures area
                this.departuresEl.innerHTML = '<p class="no-departures">No departures found. Check the modal filter, stop id or selected date.</p>';
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

    // Return departures filtered by selected mode
    getFilteredDepartures() {
        if (!this.allDepartures) return [];
        const filter = this.modeFilterEl ? this.modeFilterEl.value : 'all';
        if (filter === 'all') return this.allDepartures;
        return this.allDepartures.filter(dep => {
            const mode = (dep.mode ?? '').toString().toLowerCase();
            return mode === filter;
        });
    }

    // Return platform label with appropriate prefix based on mode
    getPlatformLabel(dep) {
        const shortPlatform = this.getShortPlatform(dep.platform);
        if (!shortPlatform) return '-';
        const mode = (dep.mode ?? '').toString().toLowerCase();
        if (mode === 'bus') {
            return `stand ${shortPlatform}`;
        } else if (mode === 'ferry') {
            return `wharf ${shortPlatform}`;
        } else if (mode === 'lightrail') {
            return `stop ${shortPlatform}`;
        }
        // for other modes (train, metro, etc.) just return the platform/shortPlatform
        return shortPlatform;
    }

    renderDepartures(departuresToRender = this.getFilteredDepartures()) {
        try {
            console.log('Rendering departures:', departuresToRender.length);
            if (departuresToRender.length === 0) {
                this.departuresEl.innerHTML = '<p class="no-departures">No departures found. Check the modal filter, stop id or selected date.</p>';
                return;
            }
            this.departuresEl.innerHTML = '';

            departuresToRender.forEach(dep => {
                const row = document.createElement('div');
                row.className = 'departure-row';

                const time = this.formatTime(dep.departureTime);
                const minsUntil = this.getMinutesUntil(dep.departureTime);

                let statusText = 'On time';
                let statusClass = 'status-ontime';

                if (minsUntil <= 2) {
                    statusText = 'NOW';
                    statusClass = 'status-soon';
                } else if (dep.delay > 0) {
                    statusText = `+${dep.delay} min`;
                    statusClass = 'status-delayed';
                } else if (minsUntil <= 5) {
                    statusText = `${minsUntil} min`;
                    statusClass = 'status-soon';
                } else {
                    statusText = `${minsUntil} min`;
                }

                const shortLine = this.getShortLineName(dep.line);
                const lineColor = api.getLineColor(dep.line, dep.mode);
                const lineStyle = `background-color: ${lineColor}; color: ${this.getContrastedTextColor(lineColor)}; border-radius:4px; padding:2px 6px;`;

                const platformLabel = this.getPlatformLabel(dep);

                // Fleet type and stopping pattern info (italic, no bullet)
                const fleetInfo = dep.fleetType ? ` ${dep.fleetType}` : '';
                const stoppingInfo = dep.stoppingPattern ? ` ${dep.stoppingPattern}` : '';

                row.innerHTML = `
                    <div class="col-time">${time}</div>
                    <div class="col-line" style="${lineStyle}">${this.escapeHtml(shortLine)}</div>
                    <div class="col-destination">
                        <div class="destination-main">${this.escapeHtml(dep.destination)}</div>
                    </div>
                    <div class="col-platform">${platformLabel}</div>
                `;

                this.departuresEl.appendChild(row);
            });
        } catch (e) {
            console.error('Error rendering departures:', e);
            this.departuresEl.innerHTML = '<p>Error displaying departures. Please try again.</p>';
        }
    }

    // Helper methods copied from the original api.js (formatting)
    formatTime(datetime) {
        const date = new Date(datetime);
        return date.toLocaleTimeString('en-AU', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    getContrastedTextColor(hexColor) {
        // Convert hex to RGB
        const r = parseInt(hexColor.slice(1, 3), 16);
        const g = parseInt(hexColor.slice(3, 5), 16);
        const b = parseInt(hexColor.slice(5, 7), 16);

        // Calculate luminance
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

        // Return white or black based on luminance
        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

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

// initialise the board
new DepartureBoard();