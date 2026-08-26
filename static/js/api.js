// master api module - all tfnsw requests go through the flask backend

import * as m1Line from './m1Line.js';
import * as centralPlatforms from './centralPlatforms.js';

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

    // live gtfs-realtime vehicle positions, merged across the named feeds
    // (see VEHICLE_FEEDS in app.py for valid names).
    // returns { vehicles, errors } - a single feed can fail while the rest succeed,
    // so callers should check errors rather than assume a short list means quiet.
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

    // parses a raw tfnsw stopEvents response into a flat departure list
    parseDeparturesRaw(data) {
        const departures = [];

        if (!data.stopEvents) {
            return departures;
        }

        data.stopEvents.forEach(event => {
            const departure = {
                line: event.transportation?.number || 'Unknown',
                // short code ("T1", "M1", "BMT") for compact line badges
                lineShort: event.transportation?.disassembledName || '',
                destination: event.transportation?.destination?.name || 'Unknown',
                // cancelled services are still returned by departure_mon, flagged two
                // ways - both are checked because neither appears on its own reliably
                isCancelled: event.isCancelled === true
                    || (Array.isArray(event.realtimeStatus) && event.realtimeStatus.includes('TRIP_CANCELLED')),
                departureTime: event.departureTimePlanned || event.departureTimeEstimated,
                // both exposed separately so callers that need the realtime figure
                // (rather than the timetabled one) can prefer estimated
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

    // maps tfnsw's occupancy string (e.g. "many_seats") to a 1-3 crowding level, 0 if unknown
    getOccupancyLevel(occupancy) {
        if (!occupancy) return 0;
        const key = String(occupancy).toUpperCase();
        if (key.includes('FULL') || key.includes('CRUSH') || key.includes('NOT_ACCEPTING') || key.includes('NOT_BOARDABLE')) return 3;
        if (key.includes('FEW') || key.includes('STANDING')) return 2;
        if (key.includes('MANY') || key.includes('EMPTY')) return 1;
        return 0;
    }

    // m1 line topology lives in m1Line.js - delegated here so design files keep calling api.<method>
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

    // short display form of a station name ("Tallawong Station, Tallawong" ->
    // "Tallawong") - TfNSW's destination field isn't consistently short, e.g. a
    // terminus's return-direction destination can come back in the full form
    shortStationName(name) {
        return m1Line.normalizeStationName(name);
    }

    // central station platform data lives in centralPlatforms.js - delegated here
    // for the same reason as m1Line above
    getCentralPlatform(id) {
        return centralPlatforms.getPlatform(id);
    }

    getCentralPlatformGroups() {
        return centralPlatforms.getPlatformGroups();
    }

    vehicleMatchesPlatform(vehicle, platform) {
        return centralPlatforms.matchesPlatform(vehicle, platform);
    }

    vehicleIsAtAnotherStation(vehicle, platform) {
        return centralPlatforms.isAtAnotherStation(vehicle, platform);
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

    // Sydney Trains route ids are internal sector codes, not line codes. TfNSW
    // doesn't publish what each sector means, so this was worked out by checking
    // where each sector's trains actually go: APS only ever runs to Campbelltown,
    // Macarthur and Revesby, which is T8. Same idea for the rest. It matches
    // reality today but nothing guarantees it stays that way.
    // CTY (Brisbane/Canberra/Perth) and RTTA (non-timetabled) have no line and are
    // left unlabelled on purpose.
    static SECTOR_LINES = {
        APS: 'T8', ESI: 'T4', NSN: 'T1', NTH: 'T9', WST: 'T1',
        CMB: 'T5', OLY: 'T7', IWL: 'T2',
        BMT: 'BMT', CCN: 'CCN', SCO: 'SCO', SHL: 'SHL', HUN: 'HUN'
    };

    // metro and light rail put the line straight in the route id (SMNW_M1, 1001_L2,
    // IWLR-191). Heavy rail needs the sector lookup above.
    getLineCodeFromRouteId(routeId) {
        const id = String(routeId || '').toUpperCase();
        if (!id) return null;
        if (id.includes('IWLR')) return 'L1';

        // split on separators - "1001_L2" has no word boundary before the L
        const tokens = id.split(/[^A-Z0-9]+/).filter(Boolean);
        const explicit = tokens.find(t =>
            /^T[1-9]$/.test(t) || /^M[1-9]$/.test(t) || /^L[1-4]$/.test(t));
        if (explicit) return explicit;

        const sector = tokens.find(t => t in TfNSWAPI.SECTOR_LINES);
        return sector ? TfNSWAPI.SECTOR_LINES[sector] : null;
    }

    // categorizes a departure into one of six modes, for the multi-select filter.
    // product.class alone is ambiguous (suburban/intercity trains share class 1),
    // so this reads product name first and only falls back to the line prefix
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

    // 3-icon crowding indicator markup, filled up to level (0-3). Empty string
    // when there's no occupancy data at all (level 0), rather than 3 outline
    // icons that imply "empty train" when it really means "unknown"
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
            // M1 must be listed explicitly - the short code alone doesn't contain
            // "metro", so it would otherwise fall through to the default colour
            M1: '--metro',
            // intercity lines are branded as the suburban line they share track with
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