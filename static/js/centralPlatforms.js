// central station platform list, plus the rules for matching a live vehicle to a
// platform. the stop ids, platform codes and coordinates here were read off
// departure_mon against the real station - see CLAUDE.md for how they were derived.

// heavy rail platforms 1-25 are contiguous: stop id = PLATFORM_ID_BASE + number.
// metro (26/27) breaks the pattern and light rail sits on unrelated ids entirely.
const PLATFORM_ID_BASE = 2000320;

// long-distance regional services also use platforms 1-15, and they live in the
// nswtrains feed rather than sydneytrains
const HEAVY_RAIL_FEEDS = ['sydneytrains', 'nswtrains'];

// platform 15 is not a physical platform at Central and is deliberately absent
const MISSING_PLATFORMS = [15];

// [lat, lon] per platform, from departure_mon's location.coord.
// platform 3 had no departures during the sweep, so it is interpolated from its
// neighbours - close enough for a map pin, but not measured.
const PLATFORM_COORDS = {
    p1: [-33.883165, 151.205523],
    p2: [-33.883224, 151.205634],
    p3: [-33.883271, 151.205723],
    p4: [-33.883317, 151.205812],
    p5: [-33.883360, 151.205879],
    p6: [-33.883418, 151.206011],
    p7: [-33.883452, 151.206067],
    p8: [-33.883512, 151.206178],
    p9: [-33.883554, 151.206245],
    p10: [-33.883623, 151.206356],
    p11: [-33.883665, 151.206434],
    p12: [-33.883716, 151.206534],
    p13: [-33.883758, 151.206611],
    p14: [-33.883808, 151.206733],
    p16: [-33.883967, 151.206838],
    p17: [-33.884001, 151.206893],
    p18: [-33.884052, 151.206982],
    p19: [-33.884094, 151.207060],
    p20: [-33.884137, 151.207127],
    p21: [-33.884179, 151.207215],
    p22: [-33.884222, 151.207282],
    p23: [-33.884264, 151.207360],
    p24: [-33.885155, 151.206874],
    p25: [-33.885307, 151.206882],
    p26: [-33.884117, 151.206381],
    p27: [-33.884142, 151.206436],
    gc: [-33.882422, 151.206686],
    lr1: [-33.884226, 151.207671],
    lr2: [-33.884193, 151.207605],
    // extrapolated along the Chalmers St alignment - TfNSW publishes no coordinate
    // for this platform (see the lr3 entry below)
    lr3: [-33.884160, 151.207539]
};

function heavyRailPlatform(number) {
    const id = `p${number}`;
    return {
        id,
        label: `Platform ${number}`,
        stopId: String(PLATFORM_ID_BASE + number),
        feeds: HEAVY_RAIL_FEEDS,
        // sydneytrains reports signal berths, not stop ids - see matchesPlatform
        berthNumber: number,
        // what to call the vehicle in user-facing text on this platform
        noun: 'train',
        coord: PLATFORM_COORDS[id],
        group: 'Sydney Trains'
    };
}

export const CENTRAL_PLATFORMS = [
    ...Array.from({ length: 25 }, (_, i) => i + 1)
        .filter(n => !MISSING_PLATFORMS.includes(n))
        .map(heavyRailPlatform),
    {
        id: 'p26',
        label: 'Platform 26',
        stopId: '2000466',
        feeds: ['metro'],
        berthNumber: null,
        noun: 'metro',
        coord: PLATFORM_COORDS.p26,
        group: 'Sydney Metro'
    },
    {
        id: 'p27',
        label: 'Platform 27',
        stopId: '2000467',
        feeds: ['metro'],
        berthNumber: null,
        noun: 'metro',
        coord: PLATFORM_COORDS.p27,
        group: 'Sydney Metro'
    },
    {
        id: 'gc',
        label: 'Grand Concourse: Platform 1',
        stopId: '2000257',
        feeds: ['lightrail_innerwest'],
        berthNumber: null,
        noun: 'light rail',
        coord: PLATFORM_COORDS.gc,
        group: 'Light Rail'
    },
    {
        id: 'lr1',
        label: 'Chalmers Street: Platform 1',
        stopId: '2000447',
        feeds: ['lightrail_cbdse'],
        berthNumber: null,
        noun: 'light rail',
        coord: PLATFORM_COORDS.lr1,
        group: 'Light Rail'
    },
    {
        id: 'lr2',
        label: 'Chalmers Street: Platform 2',
        stopId: '2000448',
        feeds: ['lightrail_cbdse'],
        berthNumber: null,
        noun: 'light rail',
        coord: PLATFORM_COORDS.lr2,
        group: 'Light Rail'
    },
    {
        // physically present, but TfNSW publishes no stop id for it: neither
        // departure_mon nor the cbdandsoutheast vehicle feed ever reference a third
        // Chalmers Street platform. Listed so the board matches the real station,
        // and flagged via unpublished so the UI can say why it has no data.
        id: 'lr3',
        label: 'Chalmers Street: Platform 3',
        stopId: null,
        unpublished: true,
        feeds: ['lightrail_cbdse'],
        berthNumber: null,
        noun: 'light rail',
        coord: PLATFORM_COORDS.lr3,
        group: 'Light Rail'
    }
];

// reverse of the stop-id table - which platform a stop id belongs to, for reading trip updates
export function getPlatformByStopId(stopId) {
    if (!stopId) return null;
    return CENTRAL_PLATFORMS.find(p => p.stopId === String(stopId)) || null;
}

export function getPlatform(id) {
    return CENTRAL_PLATFORMS.find(p => p.id === id) || null;
}

// dropdown groups, in the order they should appear
export function getPlatformGroups() {
    const groups = [];
    CENTRAL_PLATFORMS.forEach(platform => {
        let group = groups.find(g => g.name === platform.group);
        if (!group) {
            group = { name: platform.group, platforms: [] };
            groups.push(group);
        }
        group.platforms.push(platform);
    });
    return groups;
}

// bounding box of every platform, used to outline the station precinct on the map
// rather than dropping one misleading pin on a station this large
export function getStationBounds() {
    const coords = CENTRAL_PLATFORMS.map(p => p.coord).filter(Boolean);
    return {
        minLat: Math.min(...coords.map(c => c[0])),
        maxLat: Math.max(...coords.map(c => c[0])),
        minLon: Math.min(...coords.map(c => c[1])),
        maxLon: Math.max(...coords.map(c => c[1]))
    };
}

// Central's terminal platforms (1-15) are officially called Sydney Terminal, so the
// feed names their berths "Sydney 12 Loc" rather than "Central 12 Loc". Platforms
// 16-27 use "Central 17 Loc". Both are the same station, so we have to accept both
// names or platforms 1-15 never register a train at all.
// The station name has to sit right after the dot. Without that anchor
// "NorthSydney.North Sydney 2 Loc" ends in "Sydney 2 Loc" and gets read as
// Central platform 2, which put North Sydney's trains on this board.
const BERTH_PATTERN = /(?:^|\.)(Central|Sydney) (\d+) Loc$/;
const SYDNEY_TERMINAL_MAX_PLATFORM = 15;

export function getBerthPlatformNumber(stopId) {
    const match = BERTH_PATTERN.exec(stopId || '');
    if (!match) return null;

    const number = parseInt(match[2], 10);
    // "Sydney" only ever means the terminal platforms, so a high number under that
    // name isn't one of ours
    if (match[1] === 'Sydney' && number > SYDNEY_TERMINAL_MAX_PLATFORM) return null;
    return number;
}

// sydneytrains berths that sit at a platform are named "<Area>.<Station> <n> Loc"
// (e.g. "Sydney.Redfern 6 Loc", "Sefton.Regents Park 2 Loc"). The area prefix is
// NOT the station - the station is the part after the dot. Berths between stations
// look like "Sydney.SY522 Entry Loc" and deliberately do not match.
const BERTH_STATION_PATTERN = /([A-Za-z][A-Za-z ]*) (\d+) Loc$/;

export function getBerthStation(stopId) {
    const match = BERTH_STATION_PATTERN.exec(stopId || '');
    return match ? match[1].trim() : null;
}

// Signal berths in the throat immediately outside Central's platforms, all within
// about 200 m of the station. Collected by sampling the live feed and sorting by
// distance, so it may not be exhaustive - an unlisted berth just means the board
// treats a departing train as clear of the station slightly early.
const CENTRAL_APPROACH_BERTHS = new Set([
    'SY354', 'SY357', 'SY362', 'SY363', 'SY365', 'SY366', 'SY367', 'SY370',
    'SY371', 'SY372', 'SY373', 'SY374', 'SY379', 'SY389', 'SY395'
]);

// The berth a train passes through immediately before it enters each platform,
// read off the RailSafe signalling diagrams for Central. Platforms 19, 22 and 23
// were also seen doing exactly this in the live feed, which is a useful check on
// the rest. Platforms 1-15 aren't listed: their berths are the platform roads
// themselves, so there is no separate run-in signal to key off.
const PLATFORM_APPROACH_BERTHS = {
    16: ['SY380'],   // northbound
    17: ['SY382'],   // northbound
    18: ['SY372'],   // southbound
    19: ['SY374'],   // southbound
    20: ['SY388'],   // northbound - can also reach 21, but rarely
    21: ['SY390'],   // northbound
    22: ['SY373'],   // southbound
    23: ['SY379'],   // southbound
    24: ['SY712'],   // Eastern Suburbs
    25: ['ES0.06']   // Eastern Suburbs
};

// true if this berth is the known run-in to the given platform
export function isApproachingPlatform(stopId, platformNumber) {
    const berths = PLATFORM_APPROACH_BERTHS[platformNumber];
    if (!berths) return false;
    const id = String(stopId || '');
    return berths.some(code => id.includes(`${code} Loc`));
}

// a berth can name more than one code, e.g. "Sydney.CO271/SY366 Loc"
function berthCodes(stopId) {
    return String(stopId || '').match(/[A-Z]{2}\d+/g) || [];
}

// true if this berth is a Central platform or one of the throat berths beside it
export function isInCentralStationArea(stopId) {
    if (getBerthPlatformNumber(stopId) !== null) return true;
    return berthCodes(stopId).some(code => CENTRAL_APPROACH_BERTHS.has(code));
}

// true if this vehicle is sitting at (or arriving into) the given platform.
// two strategies, because the feeds disagree on how they report position:
//   - metro/lightrail/nswtrains give a numeric stop id matching our platform stop id
//   - sydneytrains gives a signal berth string and no stop id we can match directly
export function matchesPlatform(vehicle, platform) {
    if (!vehicle || !platform) return false;
    if (vehicle.stopId && vehicle.stopId === platform.stopId) return true;
    if (platform.berthNumber === null) return false;
    return getBerthPlatformNumber(vehicle.stopId) === platform.berthNumber;
}
