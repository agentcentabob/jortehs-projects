// TfNSW API interaction module
// Calls Flask backend

class TfNSWAPI {
    constructor() {
        // point to Flask backend on port 5000
        this.backendUrl = '/api';
    }

    // Get raw departures data from the backend
    async getDeparturesRaw(stopId) {
        try {
            const response = await fetch(`${this.backendUrl}/departures?stop_id=${stopId}`);
            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`);
            }
            const data = await response.json();
            return data; // raw TfNSW API response
        } catch (error) {
            console.error('Error fetching departures:', error);
            throw error;
        }
    }

    // Parse raw TfNSW departure response into standardized format
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
}

export default new TfNSWAPI();