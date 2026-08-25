import api from '../../api.js';

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

        // kiosk deployments load via ?stop_id=, dev/testing can still use the search bar
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

        try {
            const rawData = await api.getDeparturesRaw(this.stopId);
            const departures = api.parseDeparturesRaw(rawData);
            // this board only ever shows metro departures
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
            this.platform1HeaderTitle.textContent = 'Platform –';
            this.platform2HeaderTitle.textContent = 'Platform –';
            this.platform1NextStop.textContent = '';
            this.platform2NextStop.textContent = '';
            this.showNoDepartures(this.platform1List, 'Error loading departures. Please check your API key and stop ID.');
            this.showNoDepartures(this.platform2List, 'Error loading departures. Please check your API key and stop ID.');
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

    // reverts the board to its initial empty state - used when a station turns out not to be metro.
    // the board itself always stays visible (outline included) - only the message inside changes
    resetToEmptyState() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        this.stationInfoEl.style.display = 'none';
        this.platform1HeaderTitle.textContent = 'Platform –';
        this.platform2HeaderTitle.textContent = 'Platform –';
        this.platform1NextStop.textContent = '';
        this.platform2NextStop.textContent = '';
        this.showNoDepartures(this.platform1List);
        this.showNoDepartures(this.platform2List);
    }

    renderBoard() {
        // group departures by platform, show the two busiest
        // a valid station can still have nothing running right now (e.g. late
        // night) - platforms can't be labelled with no departures to group by, so
        // show the message in the departures area itself rather than a fake shell
        if (this.allDepartures.length === 0) {
            this.platform1HeaderTitle.textContent = 'Platform –';
            this.platform2HeaderTitle.textContent = 'Platform –';
            this.platform1NextStop.textContent = '';
            this.platform2NextStop.textContent = '';
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

        const platform1 = sortedPlatforms[0] || 'Unknown';
        const platform2 = sortedPlatforms[1] || platform1;

        this.platform1HeaderTitle.textContent = `Platform ${platform1}`;
        this.platform2HeaderTitle.textContent = `Platform ${platform2}`;

        this.updateNextStop(this.platform1NextStop, platformGroups[platform1]);
        this.updateNextStop(this.platform2NextStop, platformGroups[platform2]);

        this.renderPlatformRows(this.platform1List, platformGroups[platform1] || []);
        this.renderPlatformRows(this.platform2List, platformGroups[platform2] || []);

        this.updateTicker();
    }

    showNoDepartures(listEl, message = 'No information available. Select a valid Metro station.') {
        listEl.innerHTML = `<p class="no-departures">${api.escapeHtml(message)}</p>`;
    }

    // next stop for a platform - derived from its first departure's direction,
    // since a platform's queued departures all run the same way (see m1Line.js)
    updateNextStop(el, departures) {
        if (!el) return;
        const dest = departures && departures[0] ? departures[0].destination : null;
        const nextStop = dest ? api.getNextStop(this.stopName, dest) : null;
        el.textContent = nextStop ? `Next stop ${nextStop}` : '';
    }

    // welcome ticker above the top platform display
    updateTicker() {
        if (!this.boardTicker) return;

        // station name only, no suburb (e.g. "Central Station, Sydney" -> "Central Station")
        const shortStationName = (this.stopName || '').split(',')[0].trim();

        // line names come from the live departures, so this stays correct as tfnsw extends the line
        const lines = [...new Set(this.allDepartures.map(dep => dep.line).filter(Boolean))];
        const message = lines.length > 0
            ? `Welcome to ${shortStationName}. Good service on ${lines.join(', ')}.`
            : `Welcome to ${shortStationName}.`;

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

        // tfnsw doesn't provide real stopping-pattern data for metro - see m1Line.js
        const badgeEl = document.createElement('div');
        badgeEl.className = 'row-badge';
        badgeEl.textContent = api.getStoppingPatternText(this.stopName, dep.destination, dep.stoppingPattern);
        main.appendChild(badgeEl);

        row.appendChild(main);

        // occupancy/time are direct grid children so their widths stay fixed
        // regardless of how wide the time text is
        const occupancyEl = document.createElement('div');
        occupancyEl.innerHTML = api.renderOccupancyIcons(api.getOccupancyLevel(dep.occupancy));
        row.appendChild(occupancyEl.firstElementChild);

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

        const occupancyEl = document.createElement('div');
        occupancyEl.innerHTML = api.renderOccupancyIcons(0);
        row.appendChild(occupancyEl.firstElementChild);

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
        this.statusEl.textContent = message;
        this.statusEl.className = `status ${type}`;
    }
}

new VerticalBoard();
