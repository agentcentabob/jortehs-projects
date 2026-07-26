// TfNSW API interaction module
// Calls Flask backend

class TfNSWAPI {
    constructor() {
        // point to Flask backend on port 5000
        this.backendUrl = '/api';
    }

    // Get departures from a stop
    async getDepartures(stopId, options = {}) {
        try {
            const response = await fetch(`${this.backendUrl}/departures?stop_id=${stopId}`);

            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`);
            }

            const data = await response.json();
            return this.parseDepartureData(data);
        } catch (error) {
            console.error('Error fetching departures:', error);
            throw error;
        }
    }

    // Parse the TfNSW departure response
    parseDepartureData(data) {
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
                fleetType: event.transportation?.product?.name || '',
                stoppingPattern: event.stop?.properties?.stopType || ''
            };
            departures.push(departure);
        });

        return departures;
    }

    // Calculate delay in minutes
    calculateDelay(planned, estimated) {
        const plannedTime = new Date(planned);
        const estimatedTime = new Date(estimated);
        return Math.round((estimatedTime - plannedTime) / 60000);
    }

    // Get current date in YYYYMMDD format
    getCurrentDate() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}${month}${day}`;
    }

    // Get current time in HHMM format
    getCurrentTime() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        return `${hours}${minutes}`;
    }

    // Search for stops by name
    async searchStops(query) {
        try {
            const response = await fetch(`${this.backendUrl}/stops?q=${encodeURIComponent(query)}`);

            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`);
            }

            const data = await response.json();
            return data.stops || [];
        } catch (error) {
            console.error('Error searching stops:', error);
            throw error;
        }
    }

    // Map line names to their colors from styles.css
    getLineColor(lineName) {
        const varMap = {
            // Rail lines
            'T1': '--t1',
            'T2': '--t2',
            'T3': '--t3',
            'T4': '--t4',
            'T5': '--t5',
            'T6': '--t6',
            'T7': '--t7',
            'T8': '--t8',
            'T9': '--t9',
            'Hunter': '--hunter',
            'Regional': '--regional',
            'Coaches': '--coaches',
            // Ferry lines
            'F1': '--f1',
            'F2': '--f2',
            'F3': '--f3',
            'F4': '--f4',
            'F5': '--f5',
            'F6': '--f6',
            'F7': '--f7',
            'F8': '--f8',
            'F9': '--f9',
            'Stockton': '--stockton',
            // Light Rail lines
            'L1': '--l1',
            'L2': '--l2',
            'L3': '--l3',
            'L4': '--l4',
            'NLR': '--nlr',
            // Meta
            'Metro': '--metro',
            'SydneyTrains': '--sydneytrains',
            'NSWTL': '--nswtl',
            'Bus': '--bus',
            'LightRail': '--lightrail',
            'Ferry': '--ferry'
        };

        // first try exact match
        const varName = varMap[lineName];
        if (varName) {
            const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
            if (value) return value;
        }

        // try partial matches
        for (const [key, vname] of Object.entries(varMap)) {
            if (lineName.includes(key) || key.includes(lineName)) {
                const value = getComputedStyle(document.documentElement).getPropertyValue(vname).trim();
                if (value) return value;
            }
        }

        // fallback to default orange
        return getComputedStyle(document.documentElement).getPropertyValue('--orange').trim() || '#a0a0a0';
    }

    // format time for display
    formatTime(datetime) {
        const date = new Date(datetime);
        return date.toLocaleTimeString('en-AU', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    // get minutes until departure
    getMinutesUntil(datetime) {
        const now = new Date();
        const departure = new Date(datetime);
        const diff = Math.round((departure - now) / 60000);
        return diff;
    }

    // extract short line name (T4, F1, L2, etc)
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

    // Extract short platform/stop identifier
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
}

export default new TfNSWAPI();