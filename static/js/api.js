// master api module - all tfnsw requests go through the flask backend

import * as m1Line from './m1-line.js';
import * as centralPlatforms from './central-platforms.js';

class TfNSWAPI {
    constructor() {
        this.backendUrl = '/api';
    }

    async getDeparturesRaw(stopId) {
        try {
            const response = await fetch(`${this.backendUrl}/departures?stop_id=${stopId}`);
            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error('Error fetching departures:', error);
            throw error;
        }
    }

    async searchStops(query) {
        try {
            const response = await fetch(`${this.backendUrl}/stops?q=${encodeURIComponent(query)}`);
            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`);
            }
            const data = await response.json();
            return Array.isArray(data.stops) ? data.stops : [];
        } catch (error) {
            console.error('Error searching stops:', error);
            throw error;
        }
    }

    // merges vehicle positions across feeds. returns { vehicles, errors } - check
    // errors, a short list doesn't mean a quiet feed
    async getVehiclePositions(feeds) {
        const list = Array.isArray(feeds) ? feeds : [feeds];
        try {
            const response = await fetch(`${this.backendUrl}/vehicle-positions?feeds=${encodeURIComponent(list.join(','))}`);
            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`);
            }
            const data = await response.json();
            return {
                vehicles: Array.isArray(data.vehicles) ? data.vehicles : [],
                errors: data.errors || {}
            };
        } catch (error) {
            console.error('Error fetching vehicle positions:', error);
            throw error;
        }
    }

    // upcoming stops per trip - trip_id joins to getVehiclePositions()
    async getTripUpdates(feeds) {
        const list = Array.isArray(feeds) ? feeds : (feeds ? [feeds] : []);
        const query = list.length ? `?feeds=${encodeURIComponent(list.join(','))}` : '';
        try {
            const response = await fetch(`${this.backendUrl}/trip-updates${query}`);
            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`);
            }
            const data = await response.json();
            return data.trips || {};
        } catch (error) {
            console.error('Error fetching trip updates:', error);
            throw error;
        }
    }

    // names for numeric stop ids - backend resolves slowly in the background, so
    // expect a partial map first, the rest on a later ask
    async getStopNames(ids) {
        if (!ids || !ids.length) return { names: {}, pending: 0 };
        try {
            const response = await fetch(`${this.backendUrl}/stop-names?ids=${encodeURIComponent(ids.join(','))}`);
            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`);
            }
            const data = await response.json();
            // pending = still being resolved, worth asking again soon
            return { names: data.names || {}, pending: data.pending || 0 };
        } catch (error) {
            console.error('Error fetching stop names:', error);
            return { names: {}, pending: 0 };
        }
    }

    // carriage <-> set number - answered from the setchecker package, not tfnsw.
    // a miss comes back as a normal {found: false, reason} answer, not an error
    async checkSet(query) {
        const response = await fetch(`${this.backendUrl}/set-checker?q=${encodeURIComponent(query)}`);
        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }
        return await response.json();
    }

    async getSetCheckerFleets() {
        const response = await fetch(`${this.backendUrl}/set-checker/fleets`);
        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }
        const data = await response.json();
        return Array.isArray(data.classes) ? data.classes : [];
    }

    // parses a raw tfnsw stopEvents response into a flat departure list
    parseDeparturesRaw(data) {
        const departures = [];

        if (!data.stopEvents) {
            return departures;
        }

        data.stopEvents.forEach(event => {
            const departure = {
                line: event.transportation?.number || 'Unknown',
                // short code ("T1", "M1", "BMT") for compact badges
                lineShort: event.transportation?.disassembledName || '',
                destination: event.transportation?.destination?.name || 'Unknown',
                // checks both cancellation flags - neither is reliable alone
                isCancelled: event.isCancelled === true
                    || (Array.isArray(event.realtimeStatus) && event.realtimeStatus.includes('TRIP_CANCELLED')),
                departureTime: event.departureTimePlanned || event.departureTimeEstimated,
                // kept separate so callers can prefer the realtime figure
                departureTimePlanned: event.departureTimePlanned || null,
                departureTimeEstimated: event.departureTimeEstimated || null,
                platform: event.location?.properties?.platform,
                realtime: event.isRealtimeControlled,
                delay: event.departureTimeEstimated && event.departureTimePlanned
                    ? this.calculateDelay(event.departureTimePlanned, event.departureTimeEstimated)
                    : 0,
                mode: event.transportation?.product?.class || 'Unknown',
                productName: event.transportation?.product?.name || '',
                stoppingPattern: event.stop?.properties?.stopType || '',
                occupancy: event.location?.properties?.occupancy ?? null
            };
            departures.push(departure);
        });

        return departures;
    }

    calculateDelay(planned, estimated) {
        const plannedTime = new Date(planned);
        const estimatedTime = new Date(estimated);
        return Math.round((estimatedTime - plannedTime) / 60000);
    }

    // converts tfnsw's occupancy string to a 1-3 crowding level, 0 if unknown
    getOccupancyLevel(occupancy) {
        if (!occupancy) return 0;
        const key = String(occupancy).toUpperCase();
        if (key.includes('FULL') || key.includes('CRUSH') || key.includes('NOT_ACCEPTING') || key.includes('NOT_BOARDABLE')) return 3;
        if (key.includes('FEW') || key.includes('STANDING')) return 2;
        if (key.includes('MANY') || key.includes('EMPTY')) return 1;
        return 0;
    }

    getStoppingPatternText(currentStation, destination, realStoppingPattern) {
        return m1Line.getStoppingPatternText(currentStation, destination, realStoppingPattern);
    }

    getNextStop(currentStation, destination) {
        return m1Line.getNextStop(currentStation, destination);
    }

    isM1Station(name) {
        return m1Line.isM1Station(name);
    }

    isM1StationOpen(name) {
        return m1Line.isM1StationOpen(name);
    }

    getOppositeNextStop(station, destination) {
        return m1Line.getOppositeNextStop(station, destination);
    }

    // shortens "Tallawong Station, Tallawong" -> "Tallawong" - tfnsw's destination
    // field isn't always short
    shortStationName(name) {
        return m1Line.normalizeStationName(name);
    }

    // delegates to central-platforms.js
    getCentralPlatform(id) {
        return centralPlatforms.getPlatform(id);
    }

    getCentralPlatformGroups() {
        return centralPlatforms.getPlatformGroups();
    }

    vehicleMatchesPlatform(vehicle, platform) {
        return centralPlatforms.matchesPlatform(vehicle, platform);
    }

    getCentralPlatformByStopId(stopId) {
        return centralPlatforms.getPlatformByStopId(stopId);
    }

    getCentralStationBounds() {
        return centralPlatforms.getStationBounds();
    }

    getBerthPlatformNumber(stopId) {
        return centralPlatforms.getBerthPlatformNumber(stopId);
    }

    getBerthStation(stopId) {
        return centralPlatforms.getBerthStation(stopId);
    }

    isInCentralStationArea(stopId) {
        return centralPlatforms.isInCentralStationArea(stopId);
    }

    isApproachingPlatform(stopId, platformNumber) {
        return centralPlatforms.isApproachingPlatform(stopId, platformNumber);
    }

    // sydney trains route ids are internal sector codes, not line codes - not
    // published by tfnsw, worked out from each sector's real destinations
    // (APS only ever runs Campbelltown/Macarthur/Revesby = T8). CTY/RTTA stay unlabelled
    static SECTOR_LINES = {
        APS: 'T8', ESI: 'T4', NSN: 'T1', NTH: 'T9', WST: 'T1',
        CMB: 'T5', OLY: 'T7', IWL: 'T2',
        BMT: 'BMT', CCN: 'CCN', SCO: 'SCO', SHL: 'SHL', HUN: 'HUN'
    };

    // metro/light rail put the line straight in the route id (SMNW_M1, 1001_L2);
    // heavy rail needs the sector lookup above
    getLineCodeFromRouteId(routeId) {
        const id = String(routeId || '').toUpperCase();
        if (!id) return null;
        if (id.includes('IWLR')) return 'L1';

        // splits on separators - "1001_L2" has no word boundary before the L
        const tokens = id.split(/[^A-Z0-9]+/).filter(Boolean);
        const explicit = tokens.find(t =>
            /^T[1-9]$/.test(t) || /^M[1-9]$/.test(t) || /^L[1-4]$/.test(t));
        if (explicit) return explicit;

        const sector = tokens.find(t => t in TfNSWAPI.SECTOR_LINES);
        return sector ? TfNSWAPI.SECTOR_LINES[sector] : null;
    }

    // sorts a departure into one of six modes for the filter. product.class is
    // ambiguous (suburban/intercity trains share class 1) - reads product name
    // first, falls back to the line prefix
    getModeCategory(dep) {
        const productName = (dep.productName || '').toLowerCase();
        const line = (dep.line || '').toLowerCase();

        if (productName.includes('metro') || line.includes('metro')) return 'metro';
        if (productName.includes('light rail')) return 'lightrail';
        if (productName.includes('bus')) return 'bus';
        if (productName.includes('ferr')) return 'ferry';
        if (productName.includes('intercity') || productName.includes('regional') || productName.includes('coach')) return 'nswtl';
        if (productName.includes('sydney trains')) return 'sydneytrains';

        if (/^m\d/.test(line)) return 'metro';
        if (/^l\d/.test(line) || line.includes('nlr')) return 'lightrail';
        if (/^f\d/.test(line) || line.includes('stockton')) return 'ferry';
        if (/^t\d/.test(line)) return 'sydneytrains';
        if (line.includes('hunter') || line.includes('regional') || line.includes('coach')) return 'nswtl';
        return 'bus';
    }

    // meaningful part of a platform string ("Platform 1" -> "1", "Stop A" -> "A")
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

    // minutes until datetime, null if missing/invalid
    getMinutesUntil(datetime) {
        if (!datetime) return null;
        const departure = new Date(datetime);
        if (isNaN(departure.getTime())) return null;
        return Math.round((departure - new Date()) / 60000);
    }

    // builds 3-icon crowding markup, filled to level. empty string at 0 - not 3
    // outline icons, which would read as "empty train" instead of "unknown"
    renderOccupancyIcons(level) {
        if (!level) return '';
        let html = '<div class="occupancy-icons" aria-label="crowding level">';
        for (let i = 1; i <= 3; i++) {
            const filled = level >= i;
            html += `<svg viewBox="0 0 24 32" class="${filled ? 'occ-fill' : 'occ-empty'}"><circle cx="12" cy="7" r="6"/><path d="M2 30 C2 18 6 14 12 14 C18 14 22 18 22 30 Z"/></svg>`;
        }
        html += '</div>';
        return html;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // resolves a line name to its brand colour css var from styles.css - exact match, then substring
    getLineColor(lineName) {
        const varMap = {
            T1: '--t1', T2: '--t2', T3: '--t3', T4: '--t4', T5: '--t5',
            T6: '--t6', T7: '--t7', T8: '--t8', T9: '--t9',
            Hunter: '--hunter', Regional: '--regional', Coaches: '--coaches',
            F1: '--f1', F2: '--f2', F3: '--f3', F4: '--f4', F5: '--f5',
            F6: '--f6', F7: '--f7', F8: '--f8', F9: '--f9', Stockton: '--stockton',
            L1: '--l1', L2: '--l2', L3: '--l3', L4: '--l4', NLR: '--nlr',
            // needed explicitly - "M1" doesn't contain "metro", so it'd miss the default
            M1: '--metro',
            // intercity lines branded as the suburban line they share track with
            BMT: '--t1', CCN: '--t9', SCO: '--t4', SHL: '--t8',
            Metro: '--metro', SydneyTrains: '--sydneytrains', NSWTL: '--nswtl',
            Bus: '--bus', LightRail: '--lightrail', Ferry: '--ferry'
        };
        const lowerCaseMap = new Map(Object.entries(varMap).map(([k, v]) => [k.toLowerCase(), v]));
        const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || null;

        const key = (lineName || '').toLowerCase();
        if (lowerCaseMap.has(key)) {
            const value = cssVar(lowerCaseMap.get(key));
            if (value) return value;
        }
        for (const [mapKey, cssVarName] of lowerCaseMap) {
            if (key.includes(mapKey) || mapKey.includes(key)) {
                const value = cssVar(cssVarName);
                if (value) return value;
            }
        }

        return cssVar('--orange') || '#a0a0a0';
    }
}

export default new TfNSWAPI();