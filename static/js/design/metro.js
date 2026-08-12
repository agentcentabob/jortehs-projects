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

        // Start updating the header time
        this.updateHeaderTime();
        setInterval(() => this.updateHeaderTime(), 1000);
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
        const timeString = `${hours}:${minutes}`;

        if (this.headerTimeEl) {
            this.headerTimeEl.textContent = `Time now: ${timeString}`;
        }
    }

    formatTime(date) {
        return date.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' });
    }

    async handleSearch(e) {
        const query = e.target.value.trim();

        // Only search when at least 4 characters are entered
        if (query.length < 4) {
            this.suggestionsEl.style.display = 'none';
            return;
        }

        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(async () => {
            try {
                const stops = await api.searchStops(query);
                // Limit to first 6 matches
                const limitedStops = stops.slice(0, 6);
                this.displaySuggestions(limitedStops);
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

        // If the box still shows exactly what a suggestion click set, keep that
        // resolved id/name. Otherwise resolve whatever was typed - name or stop ID -
        // to a real stop via search, so either kind of input ends up with a real id.
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
        const departuresToRender = this.allDepartures.slice(0, 4); // Limit to 4 departures
        if (departuresToRender.length === 0) {
            this.departuresEl.innerHTML = '<p class="no-departures">No departures</p>';
            return;
        }

        this.departuresEl.innerHTML = '';

        departuresToRender.forEach(dep => {
            const minsUntil = this.getMinutesUntil(dep.departureTime);
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

            // Determine time colour based on delay
            let timeClass = 'ontime';
            if (dep.delay > 0) {
                timeClass = dep.delay >= 3 ? 'major' : 'minor';
            }

            const row = document.createElement('div');
            row.className = 'departure-row';

            // Destination column
            const destEl = document.createElement('div');
            destEl.className = 'dest';

            // Service name (destination) - display as-is from API like in second.js
            const serviceNameEl = document.createElement('div');
            serviceNameEl.className = 'service-name';
            serviceNameEl.textContent = this.escapeHtml(dep.destination) || 'Unknown';
            destEl.appendChild(serviceNameEl);

            // Service status line - no live disruption feed wired up yet, so this is
            // a placeholder for now (real stopping-pattern/status data isn't present
            // in the TfNSW response for metro services)
            const statusEl = document.createElement('div');
            statusEl.className = 'service-status';
            this.setScrollingText(statusEl, 'Good service');
            destEl.appendChild(statusEl);

            // Route number (only in all-modes view)
            if (!this.showOnlyMetro && dep.line) {
                const routeNumberEl = document.createElement('div');
                routeNumberEl.className = 'route-number';
                routeNumberEl.textContent = this.getShortLineName(dep.line);
                routeNumberEl.style.color = api.getLineColor(dep.line, dep.mode);
                destEl.appendChild(routeNumberEl);
            }

            // Stopping pattern
            if (dep.stopping_pattern) {
                const stoppingPatternEl = document.createElement('div');
                stoppingPatternEl.className = 'destination-via';
                stoppingPatternEl.textContent = this.escapeHtml(dep.stopping_pattern);
                destEl.appendChild(stoppingPatternEl);
            }

            // Mode (only in all-modes view)
            if (!this.showOnlyMetro && dep.mode) {
                const modeEl = document.createElement('div');
                modeEl.className = 'mode';
                modeEl.textContent = this.escapeHtml(dep.mode);
                destEl.appendChild(modeEl);
            }

            row.appendChild(destEl);

            // Occupancy column
            const occupancyEl = document.createElement('div');
            occupancyEl.className = 'occupancy';
            occupancyEl.innerHTML = this.renderOccupancyIcons(api.getOccupancyLevel(dep.occupancy));
            row.appendChild(occupancyEl);

            // Time column
            const timeEl = document.createElement('div');
            timeEl.className = `time ${timeClass}`;
            timeEl.innerHTML = `<div class="mins ${blinkClass}">${timeDisplay}</div>`;
            row.appendChild(timeEl);

            this.departuresEl.appendChild(row);
        });
    }

    // Sets text normally, or wraps it for a scrolling marquee once it's long
    // enough that it wouldn't fit (currently unused by the "Good service"
    // placeholder, but ready for real longer status messages later)
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

    renderOccupancyIcons(level) {
        let html = '<div class="occupancy-icons" aria-label="crowding level">';
        for (let i = 1; i <= 3; i++) {
            const filled = level >= i;
            html += `<svg viewBox="0 0 24 32" class="${filled ? 'occ-fill' : 'occ-empty'}"><circle cx="12" cy="7" r="6"/><path d="M2 30 C2 18 6 14 12 14 C18 14 22 18 22 30 Z"/></svg>`;
        }
        html += '</div>';
        return html;
    }

    // Helper methods (copied from original api.js)
    getMinutesUntil(datetime) {
        // Handle null, undefined, or empty string
        if (!datetime) {
            return null;
        }

        const now = new Date();
        const departure = new Date(datetime);

        // Check if the date is valid
        if (isNaN(departure.getTime())) {
            return null;
        }

        return Math.round((departure - now) / 60000);
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