// master api module - all tfnsw requests go through the flask backend

import * as m1Line from './m1Line.js';

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

    // parses a raw tfnsw stopEvents response into a flat departure list
    parseDeparturesRaw(data) {
        const departures = [];

        if (!data.stopEvents) {
            return departures;
        }

        data.stopEvents.forEach(event => {
            const departure = {
                line: event.transportation?.number || 'Unknown',
                destination: event.transportation?.destination?.name || 'Unknown',
                departureTime: event.departureTimePlanned || event.departureTimeEstimated,
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

    // 3-icon crowding indicator markup, filled up to level (0-3)
    renderOccupancyIcons(level) {
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