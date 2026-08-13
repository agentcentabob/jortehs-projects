// Sydney Metro M1 North West & Bankstown Line station order, Tallawong end to
// Bankstown end (via the CBD). Not sourced from the API - TfNSW's departure_mon
// response has no stopping-pattern/next-stop/onward-calls field for metro
// services, so this is hardcoded from the line's public station list. Flag any
// wrong name/order to get it corrected - names are matched against
// dep.destination's short form.
export const M1_LINE_ORDER = [
    'Tallawong', 'Rouse Hill', 'Kellyville', 'Bella Vista', 'Norwest',
    'Hills Showground', 'Castle Hill', 'Cherrybrook', 'Epping',
    'Macquarie University', 'Macquarie Park', 'North Ryde', 'Chatswood',
    'Crows Nest', 'Victoria Cross', 'Barangaroo', 'Martin Place', 'Gadigal',
    'Central', 'Waterloo', 'Sydenham', 'Marrickville', 'Dulwich Hill',
    'Hurlstone Park', 'Canterbury', 'Campsie', 'Belmore', 'Lakemba',
    'Wiley Park', 'Punchbowl', 'Bankstown'
];

// Strips the display-name noise ("Station", ", Suburb") down to the plain
// station name so it can be matched against M1_LINE_ORDER.
export function normalizeStationName(name) {
    if (!name) return '';
    return name.split(',')[0].replace(/\s+Station$/i, '').trim();
}

export function getM1StationIndex(name) {
    const normalized = normalizeStationName(name).toLowerCase();
    return M1_LINE_ORDER.findIndex(s => s.toLowerCase() === normalized);
}

// True if `name` is one of the M1 line's stations. Used to reject non-metro
// stations (real TfNSW stops that just aren't on this line) at load time.
// This is deliberately scoped to "is it on the M1" only - a broader "is this
// any real TfNSW stop ID at all" check is a planned site-wide feature, not this.
export function isM1Station(name) {
    return getM1StationIndex(name) !== -1;
}

// True when travelling from `currentStation` to `destination` passes through
// Gadigal (the City stations) - false if either station is unrecognised, or if
// the board's own station is Gadigal itself (no "via" needed there).
export function isViaCity(currentStation, destination) {
    const currentIdx = getM1StationIndex(currentStation);
    const destIdx = getM1StationIndex(destination);
    const gadigalIdx = getM1StationIndex('Gadigal');
    if (currentIdx === -1 || destIdx === -1) return false;
    if (currentIdx < destIdx) return gadigalIdx > currentIdx && gadigalIdx <= destIdx;
    if (currentIdx > destIdx) return gadigalIdx < currentIdx && gadigalIdx >= destIdx;
    return false;
}

// Builds the stopping-pattern text: real data (if TfNSW ever provides it)
// always wins, otherwise falls back to the hardcoded "All stops[ via City]".
export function getStoppingPatternText(currentStation, destination, realStoppingPattern) {
    if (realStoppingPattern) return realStoppingPattern;
    return isViaCity(currentStation, destination) ? 'All stops via City' : 'All stops';
}

// The immediate next station in the direction of `destination`, from
// `currentStation`. Null if either station isn't recognised.
export function getNextStop(currentStation, destination) {
    const currentIdx = getM1StationIndex(currentStation);
    const destIdx = getM1StationIndex(destination);
    if (currentIdx === -1 || destIdx === -1) return null;
    if (currentIdx < destIdx) return M1_LINE_ORDER[currentIdx + 1] ?? null;
    if (currentIdx > destIdx) return M1_LINE_ORDER[currentIdx - 1] ?? null;
    return null;
}
