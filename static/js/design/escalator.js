import api from '../api.js';

const ROWS_PER_PLATFORM = 3;

class EscalatorBoard {
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
        this.emptyStateEl = document.getElementById('emptyState');
        this.escalatorBoardEl = document.getElementById('escalatorBoard');
        this.stationInfoEl = document.getElementById('stationInfo');
        this.stationNameEl = document.getElementById('stationName');
        this.stationIdEl = document.getElementById('stationId');

        this.platform1HeaderTime = document.getElementById('platform1HeaderTime');
        this.platform1HeaderTitle = document.getElementById('platform1HeaderTitle');
        this.platform1List = document.getElementById('platform1List');

        this.platform2HeaderTime = document.getElementById('platform2HeaderTime');
        this.platform2HeaderTitle = document.getElementById('platform2HeaderTitle');
        this.platform2List = document.getElementById('platform2List');

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

        this.updateHeaderTime();
        setInterval(() => this.updateHeaderTime(), 1000);

        // Kiosk deployments load via ?stop_id=, dev/testing can still use the search bar
        const params = new URLSearchParams(window.location.search);
        const urlStopId = params.get('stop_id');
        if (urlStopId) {
            this.stopInput.value = urlStopId;
            this.loadDepartures();
        } else {
            const savedStopId = localStorage.getItem('lastStopId');
            if (savedStopId) {
                this.stopInput.value = savedStopId;
            }
        }
    }

    updateHeaderTime() {
        const now = new Date();
        const timeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (this.platform1HeaderTime) this.platform1HeaderTime.textContent = timeString;
        if (this.platform2HeaderTime) this.platform2HeaderTime.textContent = timeString;
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
        this.escalatorBoardEl.style.display = 'flex';

        try {
            const rawData = await api.getDeparturesRaw(this.stopId);
            const departures = api.parseDeparturesRaw(rawData);
            this.allDepartures = departures.filter(dep =>
                dep.line && dep.line.toLowerCase().includes('metro')
            );

            this.renderBoard();
            this.displayStationInfo();

            const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            this.showStatus(`Last updated: ${timeStr}`, '');
        } catch (error) {
            console.error('Error:', error);
            this.showStatus('Error loading departures. Check console for details.', 'error');
            this.escalatorBoardEl.style.display = 'none';
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

    renderBoard() {
        // Group departures by platform, show the two busiest
        const platformGroups = {};
        this.allDepartures.forEach(dep => {
            const platform = this.getShortPlatform(dep.platform) || 'Unknown';
            if (!platformGroups[platform]) platformGroups[platform] = [];
            platformGroups[platform].push(dep);
        });

        const sortedPlatforms = Object.keys(platformGroups).sort(
            (a, b) => platformGroups[b].length - platformGroups[a].length
        );

        const platform1 = sortedPlatforms[0] || 'Unknown';
        const platform2 = sortedPlatforms[1] || platform1;

        this.platform1HeaderTitle.textContent = `Platform ${platform1}`;
        this.platform2HeaderTitle.textContent = `Platform ${platform2}`;

        this.renderPlatformRows(this.platform1List, platformGroups[platform1] || []);
        this.renderPlatformRows(this.platform2List, platformGroups[platform2] || []);
    }

    // Always renders exactly ROWS_PER_PLATFORM rows, padding with blank
    // placeholders so the board layout never shifts when a platform is quiet
    renderPlatformRows(listEl, departures) {
        listEl.innerHTML = '';

        const rows = departures.slice(0, ROWS_PER_PLATFORM);
        for (let i = 0; i < ROWS_PER_PLATFORM; i++) {
            const row = rows[i] ? this.buildRow(rows[i]) : this.buildPlaceholderRow();
            listEl.appendChild(row);
        }
    }

    buildRow(dep) {
        const minsUntil = this.getMinutesUntil(dep.departureTime);
        let timeDisplay = '-';
        let blinkClass = '';
        if (minsUntil !== null) {
            timeDisplay = minsUntil <= 0 ? 'NOW' : `${minsUntil} min`;
            if (timeDisplay === 'NOW') blinkClass = 'blink';
        }

        let timeClass = 'ontime';
        if (dep.delay > 0) timeClass = dep.delay >= 3 ? 'major' : 'minor';

        const row = document.createElement('div');
        row.className = 'escalator-row';

        const main = document.createElement('div');
        main.className = 'row-main';

        const destLine = document.createElement('div');
        destLine.className = 'row-dest-line';

        const destEl = document.createElement('span');
        destEl.className = 'row-dest';
        destEl.textContent = dep.destination || 'Unknown';
        destLine.appendChild(destEl);

        if (dep.stoppingPattern) {
            const badgeEl = document.createElement('span');
            badgeEl.className = 'row-badge';
            badgeEl.textContent = dep.stoppingPattern;
            destLine.appendChild(badgeEl);
        }

        main.appendChild(destLine);

        // Service status line - no live disruption feed wired up yet, so this is
        // a placeholder for now (real stopping-pattern/status data isn't present
        // in the TfNSW response for metro services)
        const statusEl = document.createElement('div');
        statusEl.className = 'row-status';
        this.setScrollingText(statusEl, 'Good service');
        main.appendChild(statusEl);

        row.appendChild(main);

        // Occupancy and time are direct grid children (not nested in a flex wrapper)
        // so their widths stay fixed regardless of how wide the time text is
        const occupancyEl = document.createElement('div');
        occupancyEl.innerHTML = this.renderOccupancyIcons(api.getOccupancyLevel(dep.occupancy));
        row.appendChild(occupancyEl.firstElementChild);

        const timeEl = document.createElement('div');
        timeEl.className = `row-time ${timeClass} ${blinkClass}`.trim();
        timeEl.textContent = timeDisplay;
        row.appendChild(timeEl);

        return row;
    }

    buildPlaceholderRow() {
        const row = document.createElement('div');
        row.className = 'escalator-row placeholder';

        const main = document.createElement('div');
        main.className = 'row-main';
        const destLine = document.createElement('div');
        destLine.className = 'row-dest-line';
        const destEl = document.createElement('span');
        destEl.className = 'row-dest';
        destEl.textContent = '—';
        destLine.appendChild(destEl);
        main.appendChild(destLine);
        const statusEl = document.createElement('div');
        statusEl.className = 'row-status';
        main.appendChild(statusEl);
        row.appendChild(main);

        const occupancyEl = document.createElement('div');
        occupancyEl.innerHTML = this.renderOccupancyIcons(0);
        row.appendChild(occupancyEl.firstElementChild);

        const timeEl = document.createElement('div');
        timeEl.className = 'row-time';
        timeEl.textContent = '—';
        row.appendChild(timeEl);

        return row;
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

    getMinutesUntil(datetime) {
        if (!datetime) return null;
        const departure = new Date(datetime);
        if (isNaN(departure.getTime())) return null;
        return Math.round((departure - new Date()) / 60000);
    }

    getShortPlatform(platformString) {
        if (!platformString) return '-';
        const str = platformString.trim().toUpperCase();

        const busMatch = str.match(/STOP\s*([A-Z])/);
        if (busMatch) return busMatch[1];

        const platformMatch = str.match(/PLATFORM\s*(\d+)/);
        if (platformMatch) return platformMatch[1];

        const numMatch = str.match(/\d+/);
        if (numMatch) return numMatch[0];

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

new EscalatorBoard();
