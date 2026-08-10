import api from '../api.js';

class MetroDepartureBoard {
    constructor() {
        this.stopId = null;
        this.stopName = null;
        this.refreshInterval = null;
        this.searchTimeout = null;
        this.allDepartures = [];
        this.showOnlyMetro = true; // default to metro only
        this.showVerticalBoard = false; // flag to toggle between standard and vertical board
        this.justSelectedFromSuggestion = false; // Track if we just selected from suggestions
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
        // Vertical board elements
        this.verticalBoardContainer = document.getElementById('verticalBoardContainer');
        this.standardBoardContainer = document.getElementById('standardBoardContainer');
        this.direction1Header = document.getElementById('direction1Header');
        this.direction2Header = document.getElementById('direction2Header');
        this.direction1List = document.getElementById('direction1List');
        this.direction2List = document.getElementById('direction2List');

        this.loadBtn.addEventListener('click', () => this.loadDepartures());
        this.refreshBtn.addEventListener('click', () => this.refresh());
        this.modeToggle.addEventListener('click', () => this.toggleBoard());

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

        // Initially show standard board
        this.showStandardBoard();
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
                this.justSelectedFromSuggestion = true; // Set flag when selecting from suggestions
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
                // Clear both boards
                this.departuresEl.innerHTML = '';
                this.direction1List.innerHTML = '';
                this.direction2List.innerHTML = '';
                this.displayStationInfo();
                const now = new Date();
                const timeStr = now.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                this.showStatus(`Last updated: ${timeStr}`, '');
                return;
            }

            // Use filtered list for rendering
            this.allDepartures = filtered;

            if (this.showVerticalBoard) {
                this.renderVerticalBoard();
            } else {
                this.renderDepartures();
            }

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

            // Platform column
            const platformEl = document.createElement('div');
            platformEl.className = 'platform';
            platformEl.textContent = this.getShortPlatform(dep.platform) || '-';
            row.appendChild(platformEl);

            // Destination column
            const destEl = document.createElement('div');
            destEl.className = 'dest';

            // Service name (destination) - display as-is from API like in second.js
            const serviceNameEl = document.createElement('div');
            serviceNameEl.className = 'service-name';
            serviceNameEl.textContent = this.escapeHtml(dep.destination) || 'Unknown';
            destEl.appendChild(serviceNameEl);

            // Towards text (placed to the right of destination)
            const towardsEl = document.createElement('div');
            towardsEl.className = 'towards';
            towardsEl.textContent = '(towards)'; // Placeholder - to be implemented with direction data
            towardsEl.style.fontSize = '1.2em'; // Larger font size as requested
            towardsEl.style.marginLeft = '8px'; // Space between destination and towards
            destEl.appendChild(towardsEl);

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
            // Show occupancy value or '-' if null/undefined
            occupancyEl.textContent = dep.occupancy !== null && dep.occupancy !== undefined ? dep.occupancy : '-';
            row.appendChild(occupancyEl);

            // Time column
            const timeEl = document.createElement('div');
            timeEl.className = `time ${timeClass}`;
            timeEl.innerHTML = `<div class="mins ${blinkClass}">${timeDisplay}</div>`;
            row.appendChild(timeEl);

            this.departuresEl.appendChild(row);
        });
    }

    renderVerticalBoard() {
        // Group departures by platform
        const platformGroups = {};
        this.allDepartures.forEach(dep => {
            const platform = this.getShortPlatform(dep.platform) || 'Unknown';
            if (!platformGroups[platform]) {
                platformGroups[platform] = [];
            }
            platformGroups[platform].push(dep);
        });

        // Get platforms sorted by count (descending)
        const sortedPlatforms = Object.keys(platformGroups).sort((a, b) => {
            return platformGroups[b].length - platformGroups[a].length;
        });

        // Take top two platforms (or use the same if only one)
        let platform1 = sortedPlatforms[0] || 'Unknown';
        let platform2 = sortedPlatforms[1] || platform1; // if only one, duplicate

        // Update headers
        if (this.direction1Header) {
            this.direction1Header.textContent = `Platform ${platform1}`;
        }
        if (this.direction2Header) {
            this.direction2Header.textContent = `Platform ${platform2}`;
        }

        // Get up to 3 departures for each platform
        const direction1Departs = platformGroups[platform1] ? platformGroups[platform1].slice(0, 3) : [];
        const direction2Departs = platformGroups[platform2] ? platformGroups[platform2].slice(0, 3) : [];

        // Clear lists
        this.direction1List.innerHTML = '';
        this.direction2List.innerHTML = [];

        // Render direction 1
        direction1Departs.forEach(dep => {
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
            row.className = 'vertical-departure-row';

            // Destination
            const destEl = document.createElement('div');
            destEl.className = 'vertical-dest';
            destEl.textContent = this.escapeHtml(dep.destination) || 'Unknown';
            row.appendChild(destEl);

            // Towards text
            const towardsEl = document.createElement('div');
            towardsEl.className = 'vertical-towards';
            towardsEl.textContent = '(towards)';
            towardsEl.style.fontSize = '1.2em';
            towardsEl.style.marginLeft = '8px';
            destEl.appendChild(towardsEl);

            // Time
            const timeEl = document.createElement('div');
            timeEl.className = `vertical-time ${timeClass}`;
            timeEl.innerHTML = `<div class="mins ${blinkClass}">${timeDisplay}</div>`;
            row.appendChild(timeEl);

            this.direction1List.appendChild(row);
        });

        // Render direction 2
        direction2Departs.forEach(dep => {
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
            row.className = 'vertical-departure-row';

            // Destination
            const destEl = document.createElement('div');
            destEl.className = 'vertical-dest';
            destEl.textContent = this.escapeHtml(dep.destination) || 'Unknown';
            row.appendChild(destEl);

            // Towards text
            const towardsEl = document.createElement('div');
            towardsEl.className = 'vertical-towards';
            towardsEl.textContent = '(towards)';
            towardsEl.style.fontSize = '1.2em';
            towardsEl.style.marginLeft = '8px';
            destEl.appendChild(towardsEl);

            // Time
            const timeEl = document.createElement('div');
            timeEl.className = `vertical-time ${timeClass}`;
            timeEl.innerHTML = `<div class="mins ${blinkClass}">${timeDisplay}</div>`;
            row.appendChild(timeEl);

            this.direction2List.appendChild(row);
        });

        // If no departures for a direction, show a message
        if (direction1Departs.length === 0) {
            this.direction1List.innerHTML = '<p class="no-departures">No departures</p>';
        }
        if (direction2Departs.length === 0) {
            this.direction2List.innerHTML = '<p class="no-departures">No departures</p>';
        }
    }

    toggleBoard() {
        this.showVerticalBoard = !this.showVerticalBoard;
        if (this.showVerticalBoard) {
            this.showVerticalBoardView();
        } else {
            this.showStandardBoardView();
        }
        // Reload data with current filter
        this.fetchAndDisplay();
    }

    showStandardBoardView() {
        this.standardBoardContainer.style.display = 'block';
        this.verticalBoardContainer.style.display = 'none';
        this.modeToggle.textContent = 'Show Vertical Board';
    }

    showVerticalBoardView() {
        this.standardBoardContainer.style.display = 'none';
        this.verticalBoardContainer.style.display = 'block';
        this.modeToggle.textContent = 'Show Standard Board';
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