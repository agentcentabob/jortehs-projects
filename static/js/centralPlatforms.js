// central station platform list, plus the rules for matching a live vehicle to a
// platform. the stop ids and platform codes here were read off departure_mon
// against the real station - see CLAUDE.md for how they were derived.

// heavy rail platforms 1-25 are contiguous: stop id = PLATFORM_ID_BASE + number.
// metro (26/27) breaks the pattern and light rail sits on unrelated ids entirely.
const PLATFORM_ID_BASE = 2000320;

// long-distance regional services also use platforms 1-15, and they live in the
// nswtrains feed rather than sydneytrains
const HEAVY_RAIL_FEEDS = ['sydneytrains', 'nswtrains'];

function heavyRailPlatform(number) {
    return {
        id: `p${number}`,
        label: `Platform ${number}`,
        stopId: String(PLATFORM_ID_BASE + number),
        feeds: HEAVY_RAIL_FEEDS,
        // sydneytrains reports signal berths, not stop ids - see matchesPlatform
        berthNumber: number,
        group: 'Sydney Trains: suburban and intercity'
    };
}

export const CENTRAL_PLATFORMS = [
    ...Array.from({ length: 25 }, (_, i) => heavyRailPlatform(i + 1)),
    {
        id: 'p26',
        label: 'Platform 26',
        stopId: '2000466',
        feeds: ['metro'],
        berthNumber: null,
        group: 'Sydney Metro'
    },
    {
        id: 'p27',
        label: 'Platform 27',
        stopId: '2000467',
        feeds: ['metro'],
        berthNumber: null,
        group: 'Sydney Metro'
    },
    {
        id: 'gc',
        label: 'Grand Concourse (L1)',
        stopId: '2000257',
        feeds: ['lightrail_innerwest'],
        berthNumber: null,
        group: 'Light Rail'
    },
    {
        id: 'lr1',
        label: 'Chalmers Street LR1 (L2/L3)',
        stopId: '2000447',
        feeds: ['lightrail_cbdse'],
        berthNumber: null,
        group: 'Light Rail'
    },
    {
        id: 'lr2',
        label: 'Chalmers Street LR2 (L2/L3)',
        stopId: '2000448',
        feeds: ['lightrail_cbdse'],
        berthNumber: null,
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

// matches "Sydney.Central 17 Loc" / "Sydenham.Central 24 Loc" but deliberately not
// "CentralCoast.Gosford 2 Loc" - the berth number must directly follow "Central"
const BERTH_PATTERN = /Central (\d+) Loc$/;

export function getBerthPlatformNumber(stopId) {
    const match = BERTH_PATTERN.exec(stopId || '');
    return match ? parseInt(match[1], 10) : null;
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
