// import api from '../api.js';
// We'll keep the import but change how we use it
import api from '../api.js';

class DepartureBoard {
    constructor() {
        this.stopId = null;
        this.refreshInterval = null;
        this.init();
    }

    init() {
        // get DOM elements
        this.stopInput = document.getElementById('stopInput');
        this.loadBtn = document.getElementById('loadBtn');
        this.refreshBtn = document.getElementById('refreshBtn');
        this.departuresEl = document.getElementById('departures');
        this.emptyStateEl = document.getElementById('emptyState');
        this.statusEl = document.getElementById('status');

        // set up event listeners
        this.loadBtn.addEventListener('click', () => this.loadDepartures());
        this.refreshBtn.addEventListener('click', () => this.refresh());

        // allow enter key to load
        this.stopInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.loadDepartures();
            }
        });

        // load from localStorage if available
        const savedStopId = localStorage.getItem('lastStopId');
        if (savedStopId) {
            this.stopInput.value = savedStopId;
        }
    }

    async loadDepartures() {
        const stopId = this.stopInput.value.trim();

        if (!stopId) {
            this.showStatus('Please enter a stop ID', 'error');
            return;
        }

        this.stopId = stopId;
        localStorage.setItem('lastStopId', stopId);

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

            if (departures.length === 0) {
                this.departuresEl.innerHTML = '';
                this.emptyStateEl.style.display = 'block';
                this.emptyStateEl.innerHTML = '<p>No departures found for this stop</p>';
                this.showStatus('No departures found', 'error');
                return;
            }

            this.renderDepartures(departures);
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

    renderDepartures(departures) {
        this.departuresEl.innerHTML = '';

        departures.forEach(dep => {
            const row = document.createElement('div');
            row.className = 'departure-row';

            // Time formatting
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

            row.innerHTML = `
                <div class="col-time">${time}</div>
                <div class="col-line">${this.escapeHtml(dep.line)}</div>
                <div class="col-destination">${this.escapeHtml(dep.destination)}</div>
                <div class="col-platform">${dep.platform || '-'}</div>
                <div class="col-status ${statusClass}">${statusText}</div>
            `;

            this.departuresEl.appendChild(row));
        });
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

    getMinutesUntil(datetime) {
        const now = new Date();
        const departure = new Date(datetime);
        const diff = Math.round((departure - now) / 60000);
        return diff;
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