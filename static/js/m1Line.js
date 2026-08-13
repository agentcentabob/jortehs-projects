// sydney metro m1 line station order, tallawong to bankstown via the cbd.
// not from the api - departure_mon has no stopping-pattern/next-stop data for
// metro, so this is hardcoded from the public station list
export const M1_LINE_ORDER = [
    'Tallawong', 'Rouse Hill', 'Kellyville', 'Bella Vista', 'Norwest',
    'Hills Showground', 'Castle Hill', 'Cherrybrook', 'Epping',
    'Macquarie University', 'Macquarie Park', 'North Ryde', 'Chatswood',
    'Crows Nest', 'Victoria Cross', 'Barangaroo', 'Martin Place', 'Gadigal',
    'Central', 'Waterloo', 'Sydenham', 'Marrickville', 'Dulwich Hill',
    'Hurlstone Park', 'Canterbury', 'Campsie', 'Belmore', 'Lakemba',
    'Wiley Park', 'Punchbowl', 'Bankstown'
];

// strips "station"/", suburb" from a display name so it matches m1_line_order
export function normalizeStationName(name) {
    if (!name) return '';
    return name.split(',')[0].replace(/\s+Station$/i, '').trim();
}

export function getM1StationIndex(name) {
    const normalized = normalizeStationName(name).toLowerCase();
    return M1_LINE_ORDER.findIndex(s => s.toLowerCase() === normalized);
}

// true if name is an m1 station - used to reject real but non-metro stops at load time
export function isM1Station(name) {
    return getM1StationIndex(name) !== -1;
}

// true if the trip from currentStation to destination passes through gadigal (the city stations)
export function isViaCity(currentStation, destination) {
    const currentIdx = getM1StationIndex(currentStation);
    const destIdx = getM1StationIndex(destination);
    const gadigalIdx = getM1StationIndex('Gadigal');
    if (currentIdx === -1 || destIdx === -1) return false;
    if (currentIdx < destIdx) return gadigalIdx > currentIdx && gadigalIdx <= destIdx;
    if (currentIdx > destIdx) return gadigalIdx < currentIdx && gadigalIdx >= destIdx;
    return false;
}

// real stopping-pattern data wins if tfnsw ever provides it, otherwise "all stops[ via city]"
export function getStoppingPatternText(currentStation, destination, realStoppingPattern) {
    if (realStoppingPattern) return realStoppingPattern;
    return isViaCity(currentStation, destination) ? 'All stops via City' : 'All stops';
}

// next station in the direction of destination, from currentStation
export function getNextStop(currentStation, destination) {
    const currentIdx = getM1StationIndex(currentStation);
    const destIdx = getM1StationIndex(destination);
    if (currentIdx === -1 || destIdx === -1) return null;
    if (currentIdx < destIdx) return M1_LINE_ORDER[currentIdx + 1] ?? null;
    if (currentIdx > destIdx) return M1_LINE_ORDER[currentIdx - 1] ?? null;
    return null;
}
