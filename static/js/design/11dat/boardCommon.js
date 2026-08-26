// Shared behaviour for the 11dat metro boards (horizontal.js, vertical.js) -
// station search, resolving input to a real station, and the Metro-only/
// line-open validation both boards need identically. Same delegation pattern
// as api.js -> m1Line.js: boards call these directly rather than duplicating
// the logic, but each board still owns its own DOM/rendering.
//
// Every function here takes the calling board instance ("board") and reads/
// writes its fields directly (board.stopId, board.stopInput, etc.) instead of
// closing over private state, since the two boards' DOM structures differ too
// much to share instances of a class.

import api from '../../api.js';

export function showStatus(statusEl, message, type) {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
}

export function displayStationInfo(board) {
    if (board.stopId && board.stopName) {
        board.stationNameEl.textContent = board.stopName;
        board.stationIdEl.textContent = `(${board.stopId})`;
        board.stationInfoEl.style.display = 'block';
    } else if (board.stopId) {
        board.stationNameEl.textContent = board.stopId;
        board.stationIdEl.textContent = '';
        board.stationInfoEl.style.display = 'block';
    }
}

// Wires the station search box: debounced api.searchStops + a suggestions
// dropdown, identical on both boards. Clicking a suggestion resolves the
// station immediately and loads it.
export function setupStationSearch(board) {
    board.stopInput.addEventListener('input', (e) => handleSearchInput(board, e));
    board.stopInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            loadDepartures(board);
        }
    });
    document.addEventListener('click', (e) => {
        if (e.target !== board.stopInput) {
            board.suggestionsEl.style.display = 'none';
        }
    });
}

function handleSearchInput(board, e) {
    const query = e.target.value.trim();
    if (query.length < 4) {
        board.suggestionsEl.style.display = 'none';
        return;
    }

    clearTimeout(board.searchTimeout);
    board.searchTimeout = setTimeout(async () => {
        try {
            const stops = await api.searchStops(query);
            displaySuggestions(board, stops.slice(0, 6));
        } catch (error) {
            console.error('Search error:', error);
        }
    }, 300);
}

function displaySuggestions(board, stops) {
    board.suggestionsEl.innerHTML = '';

    if (stops.length === 0) {
        board.suggestionsEl.style.display = 'none';
        return;
    }

    stops.forEach(stop => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.innerHTML = `<span class="stop-name">${api.escapeHtml(stop.name)}</span><span class="stop-id">${stop.id}</span>`;
        item.addEventListener('click', () => {
            board.stopInput.value = stop.name;
            board.stopId = stop.id;
            board.stopName = stop.name;
            board.suggestionsEl.style.display = 'none';
            loadDepartures(board);
        });
        board.suggestionsEl.appendChild(item);
    });

    board.suggestionsEl.style.display = 'block';
}

// Resolves whatever's typed (name or stop id) to a real station, rejects
// anything that isn't on the M1, shows the not-open-yet message for the
// unopened Bankstown extension, then hands off to the board's own
// fetchAndDisplay(). The board must implement: resetToEmptyState(),
// showLineOpeningSoon(), fetchAndDisplay().
export async function loadDepartures(board) {
    const inputValue = board.stopInput.value.trim();
    if (!inputValue) {
        showStatus(board.statusEl, 'Please enter a stop ID or search for a station', 'error');
        return;
    }

    // keep the resolved id/name if the box still shows exactly what a suggestion
    // set, otherwise resolve whatever was typed - name or stop id - via search
    if (!(board.stopId && board.stopName === inputValue)) {
        showStatus(board.statusEl, 'Looking up station...', 'loading');
        try {
            const stops = await api.searchStops(inputValue);
            if (stops.length > 0) {
                board.stopId = stops[0].id;
                board.stopName = stops[0].name;
            } else {
                board.stopId = inputValue;
                board.stopName = inputValue;
            }
        } catch (error) {
            console.error('Stop lookup error:', error);
            board.stopId = inputValue;
            board.stopName = inputValue;
        }
    }

    // both boards only show Metro (M1) departures - reject anything else here.
    // a broader "is this any real TfNSW stop ID" check is a planned site-wide
    // feature, not implemented yet
    if (!api.isM1Station(board.stopName)) {
        showStatus(board.statusEl, `"${inputValue}" is not a valid Metro station`, 'error');
        board.stopId = null;
        board.stopName = null;
        board.resetToEmptyState();
        return;
    }

    // the Bankstown extension (Marrickville-Bankstown) is a real, selectable
    // M1 station, it just isn't carrying passengers yet
    if (!api.isM1StationOpen(board.stopName)) {
        if (board.refreshInterval) {
            clearInterval(board.refreshInterval);
            board.refreshInterval = null;
        }
        showStatus(board.statusEl, `${board.stopName}: line opening soon`, '');
        board.showLineOpeningSoon();
        return;
    }

    await board.fetchAndDisplay();

    if (board.refreshInterval) {
        clearInterval(board.refreshInterval);
    }
    board.refreshInterval = setInterval(() => refresh(board), 30000);
}

export async function refresh(board) {
    if (!board.stopId) return;
    await board.fetchAndDisplay();
}

// Fetches raw departures for stopId and filters to metro-only - shared by both boards
export async function fetchMetroDepartures(stopId) {
    const rawData = await api.getDeparturesRaw(stopId);
    const departures = api.parseDeparturesRaw(rawData);
    return departures.filter(dep => dep.line && dep.line.toLowerCase().includes('metro'));
}
