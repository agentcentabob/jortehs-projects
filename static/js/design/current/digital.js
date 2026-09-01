import api from '../../api.js';

class DigitalBoard {
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
        this.filterBtn = document.getElementById('filterBtn');
        this.filterPanel = document.getElementById('filterPanel');
        this.modeCheckboxes = Array.from(document.querySelectorAll('.mode-checkbox'));
        this.departuresEl = document.getElementById('departures');
        this.emptyStateEl = document.getElementById('emptyState');
        this.statusEl = document.getElementById('status');
        this.suggestionsEl = document.getElementById('suggestions');
        this.stationInfoEl = document.getElementById('stationInfo');
        this.stationNameEl = document.getElementById('stationName');
        this.stationIdEl = document.getElementById('stationId');

        this.loadBtn.addEventListener('click', () => this.loadDepartures());
        this.refreshBtn.addEventListener('click', () => this.refresh());

        this.filterBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.filterPanel.classList.toggle('open');
        });
        this.modeCheckboxes.forEach(cb => {
            cb.addEventListener('change', () => this.renderDepartures());
        });

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
            if (!this.filterPanel.contains(e.target) && e.target !== this.filterBtn) {
                this.filterPanel.classList.remove('open');
            }
        });

        const savedStopId = localStorage.getItem('lastStopId');
        if (savedStopId) {
            this.stopInput.value = savedStopId;
        }
    }

    async handleSearch(e) {
        const query = e.target.value.trim();

        if (query.length < 4) {
            this.suggestionsEl.style.display = 'none';
            return;
        }

        // debounce search
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(async () => {
            try {
                const stops = await api.searchStops(query);
                // caches so loadDepartures() can reuse this search, not re-hit /api/stops
                this.lastSearchQuery = query;
                this.lastSearchResults = stops;
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
                // reuses the suggestions search if it matches, rather than re-fetching
                const stops = this.lastSearchQuery === inputValue && this.lastSearchResults
                    ? this.lastSearchResults
                    : await api.searchStops(inputValue);
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
            this.allDepartures = departures;

            if (departures.length === 0) {
                this.departuresEl.innerHTML = '<p class="no-departures">No departures found. Check the filters, stop id or selected date.</p>';
                this.showStatus('No departures found', 'error');
                this.displayStationInfo();
                return;
            }

            this.renderDepartures();
            this.displayStationInfo();
            const now = new Date().toLocaleTimeString('en-GB', {
                hour12: false,
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

    // departures matching the checked filter modes
    getFilteredDepartures() {
        const selected = new Set(
            this.modeCheckboxes.filter(cb => cb.checked).map(cb => cb.value)
        );
        return this.allDepartures.filter(dep => selected.has(api.getModeCategory(dep)));
    }

    // platform label prefixed by mode (stand/wharf/stop), plain for train/metro
    getPlatformLabel(dep) {
        const shortPlatform = api.getShortPlatform(dep.platform);
        if (!shortPlatform) return '-';
        const mode = api.getModeCategory(dep);
        if (mode === 'bus') return `stand ${shortPlatform}`;
        if (mode === 'ferry') return `wharf ${shortPlatform}`;
        if (mode === 'lightrail') return `stop ${shortPlatform}`;
        return shortPlatform;
    }

    renderDepartures(departuresToRender = this.getFilteredDepartures()) {
        try {
            if (departuresToRender.length === 0) {
                this.departuresEl.innerHTML = '<p class="no-departures">No departures match the current filters.</p>';
                return;
            }
            this.departuresEl.innerHTML = '';

            departuresToRender.forEach(dep => {
                const row = document.createElement('div');
                row.className = 'departure-row';

                const time = this.formatTime(dep.departureTime);
                const shortLine = this.getShortLineName(dep.line);
                const lineColor = api.getLineColor(dep.line);
                const lineStyle = `background-color: ${lineColor}; color: ${this.getContrastedTextColor(lineColor)}; border-radius:4px; padding:2px 6px;`;
                const platformLabel = this.getPlatformLabel(dep);

                row.innerHTML = `
                    <div class="col-time">${time}</div>
                    <div class="col-line" style="${lineStyle}">${api.escapeHtml(shortLine)}</div>
                    <div class="col-destination">
                        <div class="destination-main">${api.escapeHtml(dep.destination)}</div>
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

    formatTime(datetime) {
        const date = new Date(datetime);
        return date.toLocaleTimeString('en-AU', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    // relative luminance formula - picks readable text colour for a given background
    getContrastedTextColor(hexColor) {
        const r = parseInt(hexColor.slice(1, 3), 16);
        const g = parseInt(hexColor.slice(3, 5), 16);
        const b = parseInt(hexColor.slice(5, 7), 16);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

    getShortLineName(lineName) {
        if (!lineName) return 'Unknown';
        const short = lineName.trim().toUpperCase();

        // standalone line code (t1, m1, l2, f3...) - word boundary so this
        // doesn't match a letter buried inside a word, e.g. the t in "metro"
        const match = short.match(/\b([TFLM])(\d+)\b/);
        if (match) return match[1] + match[2];

        if (short.includes('METRO')) return 'Metro';
        if (short.includes('BUS')) return short.split(' ')[0];
        if (short.includes('TRAIN')) return 'Train';

        return short.substring(0, 4);
    }

    showStatus(message, type) {
        this.statusEl.textContent = message;
        this.statusEl.className = `status ${type}`;
    }
}

// initialise the board
new DigitalBoard();