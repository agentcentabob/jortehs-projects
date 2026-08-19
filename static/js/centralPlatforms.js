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

// matches "Sydney.Central 17 Loc" / "Sydenham.Central 24 Loc" but deliberately not
// "CentralCoast.Gosford 2 Loc" - the berth number must directly follow "Central"
const BERTH_PATTERN = /Central (\d+) Loc$/;

export function getBerthPlatformNumber(stopId) {
    const match = BERTH_PATTERN.exec(stopId || '');
    return match ? parseInt(match[1], 10) : null;
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

// true if this vehicle is reported at a platform of some station other than Central
export function isAtAnotherStation(vehicle, platform) {
    if (!vehicle) return false;

    // metro/lightrail/nswtrains: numeric stop id plus a proximity status
    if (vehicle.status === 'STOPPED_AT' || vehicle.status === 'INCOMING_AT') {
        if (vehicle.stopId && vehicle.stopId !== platform.stopId) return true;
    }

    const station = getBerthStation(vehicle.stopId);
    return Boolean(station) && station.toLowerCase() !== 'central';
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
