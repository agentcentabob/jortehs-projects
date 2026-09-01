"""Turns an NSW train carriage number into the set it runs in, and back again.

Ported from the standalone script in agentcentabob/transport-shenanigans, with the
answer widened from three lines of text to something a page can show working for:
which car of the set it is, how the set number was arrived at, and the rest of the
formation where that is knowable.

Two changes to the original logic, both cases where a special case swallowed
carriages that the general rule already handled correctly - see _oscar_set_index.
"""

from . import compositions as comps
from .fleet import RULE_FLEETS, TABLE_FLEETS

TABLE_LOOKUPS = {
    'T': (comps.T_CARRIAGE_TO_SET, comps.T_SET_COMPOSITIONS),
    'M': (comps.M_CARRIAGE_TO_SET, comps.M_SET_COMPOSITIONS),
    'K': (comps.K_CARRIAGE_TO_SET, comps.K_SET_COMPOSITIONS),
}

# longest prefix first, so DND83 is tested before anything shorter could claim it
RULE_PREFIXES = sorted(
    (
        (car['prefix'], code, car)
        for code, fleet in RULE_FLEETS.items()
        for car in fleet['formation']
    ),
    key=lambda item: len(item[0]),
    reverse=True,
)


def normalise(text):
    """what someone types on a page vs what's painted on the carriage"""
    return ''.join(str(text or '').split()).replace('-', '').replace('.', '').upper()


# ---------------------------------------------------------------- set numbering

def _oscar_set_index(carriage):
    """OSCAR set number from a carriage number, with the arithmetic spelled out.

    Returns (set index, working) or (None, reason). Each prefix counts differently,
    which is why this can't be folded into the last-two-digits rule the other
    rule-based fleets use.

    Two special cases from the original script are gone. Both were written as
    prefix tests broad enough to swallow whole runs of valid carriages - ONL599x
    caught H40-H48 and called them all H49, ON594x caught H40-H48 and returned
    nothing at all - and in both cases the general rule below already lands on H49
    on its own (ONL5999 -> 99 - 50, ON5949 -> 49).
    """
    if carriage.startswith('OD69'):
        num = _int_or_none(carriage[4:])
        if num is None:
            return None, 'the digits after OD69 are not a number'
        # each set has two OD69 driving trailers, one at each end, numbered
        # consecutively - so both parities land on the same set
        if num in (21, 22):
            return 49, 'H49 is the odd one out: its driving trailers are OD6921 and OD6922.'
        if 1 <= num <= 20:
            return (num + 1) // 2, (
                f'H1-H10 carry OD69(2n-1) at one end and OD69(2n) at the other, '
                f'so OD69{num:02d} is n = {(num + 1) // 2}.'
            )
        if 23 <= num <= 98:
            return (num - 1) // 2, (
                f'H11-H48 carry OD69(2n+1) at one end and OD69(2n+2) at the other, '
                f'so OD69{num:02d} is n = {(num - 1) // 2}.'
            )
        return None, f'OD69{carriage[4:]} falls outside every OSCAR driving trailer range'

    # the 59 series motors run on H1-H49, the 58 series on H50-H55. Without those
    # bounds ON5951 answers "H51", a set that doesn't carry ON59 cars at all.
    if carriage.startswith('ONL59'):
        num = _int_or_none(carriage[5:])
        if num is None:
            return None, 'the digits after ONL59 are not a number'
        return _bounded(num - 50, 1, 49, 'ONL59', f'ONL59 motors are numbered n + 50, so n = {num} - 50 = {num - 50}.')

    if carriage.startswith('ONL58'):
        num = _int_or_none(carriage[5:])
        if num is None:
            return None, 'the digits after ONL58 are not a number'
        return _bounded(num - 21, 50, 55, 'ONL58', f'ONL58 motors are numbered n + 21, so n = {num} - 21 = {num - 21}.')

    if carriage.startswith('ON59'):
        num = _int_or_none(carriage[4:])
        if num is None:
            return None, 'the digits after ON59 are not a number'
        return _bounded(num, 1, 49, 'ON59', f'ON59 motors carry the set number directly, so n = {num}.')

    if carriage.startswith('ON58'):
        num = _int_or_none(carriage[4:])
        if num is None:
            return None, 'the digits after ON58 are not a number'
        return _bounded(num + 29, 50, 55, 'ON58', f'ON58 motors are numbered n - 29, so n = {num} + 29 = {num + 29}.')

    return None, 'not an OSCAR carriage prefix'


def _oscar_formation(n):
    """(prefix, carriage number) for each of an OSCAR set's four cars, in car order.

    A driving trailer at each end with the two motors between them. H49 is written
    out because it sits outside the OD69 run - its trailers are the pair skipped
    between H10 and H11.
    """
    if 1 <= n <= 10:
        trailers = (2 * n - 1, 2 * n)
    elif n == 49:
        trailers = (21, 22)
    elif 11 <= n <= 48:
        trailers = (2 * n + 1, 2 * n + 2)
    elif 50 <= n <= 55:
        return [
            ('OD69', f'OD69{2 * n - 57:02d}'),
            ('ONL58', f'ONL58{n + 21:02d}'),
            ('ON58', f'ON58{n - 29:02d}'),
            ('OD69', f'OD69{2 * n - 56:02d}'),
        ]
    else:
        return []

    return [
        ('OD69', f'OD69{trailers[0]:02d}'),
        ('ONL59', f'ONL59{n + 50:02d}'),
        ('ON59', f'ON59{n:02d}'),
        ('OD69', f'OD69{trailers[1]:02d}'),
    ]


def _bounded(index, low, high, prefix, working):
    if low <= index <= high:
        return index, working
    return None, f'that works out to set H{index}, and {prefix} cars only run on H{low}-H{high}'


def _int_or_none(text):
    try:
        return int(text)
    except (TypeError, ValueError):
        return None


def _rule_set_number(fleet_code, carriage):
    """(formatted set number, set key, working) for a rule-based fleet, or (None, None, reason)"""
    if fleet_code == 'H':
        index, working = _oscar_set_index(carriage)
        if index is None:
            return None, None, working
        if not 1 <= index <= 55:
            return None, None, f'that works out to set H{index}, which is outside the OSCAR fleet'
        return f'H{index}', index, working

    digits = carriage[-2:]
    if not digits.isdigit():
        return None, None, 'the carriage number does not end in two digits'

    index = int(digits)
    if fleet_code in ('A', 'B', 'D'):
        set_number = f'{fleet_code}{index}'
    else:
        # the 6 car Mariyung set number is D1 plus both digits, so the leading zero
        # in DD9804 -> D104 is part of a three digit number, not padding to strip
        set_number = f'D1{digits}'

    return set_number, index, (
        f'{RULE_FLEETS[fleet_code]["name"]} carriage numbers end in their set '
        f'number, so {carriage[:-2]}|{digits} is set {set_number}.'
    )


def _rule_match(carriage):
    """(prefix, fleet code, car) for a rule-based carriage number, or None.

    A prefix on its own isn't enough - every rule fleet writes its carriages as the
    prefix plus exactly two digits, and without checking that, the Tangara set
    number T130 reads as a Waratah Series 2 trailer.
    """
    for prefix, fleet_code, car in RULE_PREFIXES:
        if not carriage.startswith(prefix):
            continue
        rest = carriage[len(prefix):]
        if rest.isdigit() and len(rest) == 2:
            return prefix, fleet_code, car
    return None


def _set_number_for(carriage):
    """Just the set number, or None. The plain answer behind resolve_carriage().

    Kept separate so the formation builder can check its own candidates without
    recursing back through the full lookup, which builds a formation of its own.
    """
    for fleet_code, (lookup_table, _) in TABLE_LOOKUPS.items():
        if carriage in lookup_table:
            return lookup_table[carriage]
    match = _rule_match(carriage)
    if match:
        return _rule_set_number(match[1], carriage)[0]
    return None


# ---------------------------------------------------------------- formations

def _fleet_summary(fleet):
    """the fleet description without the numbering internals the page has no use for"""
    return {k: v for k, v in fleet.items() if k not in ('formation', 'carriagePrefixes')}


def _table_formation(fleet_code, set_number, match=None):
    _, table = TABLE_LOOKUPS[fleet_code]
    prefixes = TABLE_FLEETS[fleet_code]['carriagePrefixes']
    cars = [
        {
            'number': number,
            'type': prefixes.get(number[0], 'unknown type'),
            'position': i + 1,
            'isMatch': number == match,
        }
        for i, number in enumerate(table[set_number])
    ]
    return {
        'source': 'table',
        'ordered': True,
        'complete': True,
        'cars': cars,
        'note': None,
    }


def _rule_formation(fleet_code, set_number, set_key, match=None):
    """Rebuilds a formation from the numbering rule, keeping only cars that round-trip.

    Every candidate is fed back through the forward lookup and dropped unless it
    resolves to this same set. That keeps the diagram honest: the OSCAR rules in
    particular don't cover every car, and a number the checker itself would reject
    has no business being shown as fact.
    """
    fleet = RULE_FLEETS[fleet_code]
    candidates = []

    if fleet_code == 'H':
        candidates = _oscar_formation(set_key)
    else:
        # every rule fleet writes the set number as two digits on the carriage,
        # whether or not the set number itself is written with the leading zero
        candidates = [(car['prefix'], f'{car["prefix"]}{set_key:02d}') for car in fleet['formation']]

    types = {car['prefix']: car['type'] for car in fleet['formation']}
    cars = []
    dropped = []
    for prefix, number in candidates:
        resolved = _set_number_for(number)
        if resolved != set_number:
            dropped.append((number, resolved))
            continue
        cars.append({
            'number': number,
            'type': types.get(prefix, 'unknown type'),
            'position': len(cars) + 1,
            'isMatch': number == match,
        })

    complete = len(cars) == fleet['cars']
    return {
        'source': 'derived',
        # positions only mean something in a formation the rule fills end to end
        'ordered': complete,
        'complete': complete,
        'cars': cars,
        'note': _dropped_note(fleet, len(cars), dropped) if not complete else None,
    }


def _dropped_note(fleet, kept, dropped):
    """Says which cars the rule named and why they aren't shown.

    This is really about OSCAR sets H50-H55: the rule gives them OD69 numbers in
    the 6943-6954 range, which the H11-H48 rule has already handed to H21-H26.
    Naming the clash beats a vague "some cars are missing".
    """
    missing = fleet['cars'] - kept
    if not dropped:
        return (
            f'The numbering rule accounts for {kept} of this set’s {fleet["cars"]} cars. '
            f'The other {missing} are left out rather than guessed at.'
        )

    numbers = ', '.join(number for number, _ in dropped)
    clashes = sorted({resolved for _, resolved in dropped if resolved})
    plural = 'those numbers already belong' if len(dropped) > 1 else 'that number already belongs'
    if clashes:
        return (
            f'The rule also names {numbers} for this set, but {plural} to '
            f'{" and ".join(clashes)}. Shown as {kept} of {fleet["cars"]} cars rather '
            f'than listing the same carriage under two sets.'
        )
    return (
        f'The rule also names {numbers} for this set, but the checker can’t resolve '
        f'{"them" if len(dropped) > 1 else "it"} back, so {"they are" if len(dropped) > 1 else "it is"} left out.'
    )


# ---------------------------------------------------------------- lookups

def resolve_carriage(text):
    """carriage number -> everything the checker can say about it"""
    carriage = normalise(text)
    if not carriage:
        return {'found': False, 'reason': 'enter a carriage number'}

    # composition tables first: their carriage numbers reuse prefixes the rule
    # fleets also use, and a table hit is the stronger answer
    for fleet_code, (lookup, _) in TABLE_LOOKUPS.items():
        if carriage in lookup:
            set_number = lookup[carriage]
            fleet = TABLE_FLEETS[fleet_code]
            formation = _table_formation(fleet_code, set_number, match=carriage)
            position = next(car['position'] for car in formation['cars'] if car['isMatch'])
            return {
                'found': True,
                'matchedBy': 'carriage',
                'carriage': {
                    'number': carriage,
                    'type': fleet['carriagePrefixes'].get(carriage[0], 'unknown type'),
                    'position': position,
                },
                'set': {'number': set_number, 'cars': fleet['cars']},
                'fleet': _fleet_summary(fleet),
                'derivation': {
                    'method': 'table',
                    'steps': [
                        fleet['rule'],
                        f'{carriage} is listed as car {position} of {fleet["cars"]} in set {set_number}.',
                    ],
                },
                'formation': formation,
            }

    match = _rule_match(carriage)
    if match:
        prefix, fleet_code, car = match
        fleet = RULE_FLEETS[fleet_code]
        set_number, set_key, working = _rule_set_number(fleet_code, carriage)
        if set_number is None:
            return {
                'found': False,
                'carriage': carriage,
                'reason': f'{carriage} matches the {fleet["name"]} numbering, but {working}',
            }
        formation = _rule_formation(fleet_code, set_number, set_key, match=carriage)
        # only a formation in real running order can say which car this is - an
        # OSCAR's place in the list is just where it happened to land
        position = (
            next((c['position'] for c in formation['cars'] if c['isMatch']), None)
            if formation['ordered'] else None
        )
        return {
            'found': True,
            'matchedBy': 'carriage',
            'carriage': {'number': carriage, 'type': car['type'], 'position': position},
            'set': {'number': set_number, 'cars': fleet['cars']},
            'fleet': _fleet_summary(fleet),
            'derivation': {
                'method': 'rule',
                'steps': [f'{prefix} is the {fleet["name"]} {car["type"]} prefix.', working],
            },
            'formation': formation,
        }

    return {'found': False, 'carriage': carriage, 'reason': 'carriage number pattern not recognised'}


def resolve_set(text):
    """set number -> the same detail, reached from the other direction"""
    set_code = normalise(text)
    if not set_code:
        return {'found': False, 'reason': 'enter a set number'}

    for fleet_code, (_, table) in TABLE_LOOKUPS.items():
        # tables are keyed without padding (K7), so a padded K07 has to be tried too
        for candidate in _set_key_variants(set_code, fleet_code):
            if candidate in table:
                fleet = TABLE_FLEETS[fleet_code]
                return {
                    'found': True,
                    'matchedBy': 'set',
                    'carriage': None,
                    'set': {'number': candidate, 'cars': fleet['cars']},
                    'fleet': _fleet_summary(fleet),
                    'derivation': {
                        'method': 'table',
                        'steps': [f'Set {candidate} is listed in the {fleet["name"]} composition table.'],
                    },
                    'formation': _table_formation(fleet_code, candidate),
                }

    parsed = _parse_rule_set(set_code)
    if parsed:
        fleet_code, set_number, set_key = parsed
        fleet = RULE_FLEETS[fleet_code]
        formation = _rule_formation(fleet_code, set_number, set_key)
        if formation['cars']:
            return {
                'found': True,
                'matchedBy': 'set',
                'carriage': None,
                'set': {'number': set_number, 'cars': fleet['cars']},
                'fleet': _fleet_summary(fleet),
                'derivation': {
                    'method': 'rule',
                    'steps': [
                        fleet['rule'],
                        f'Set {set_number} therefore runs the carriages below.',
                    ],
                },
                'formation': formation,
            }

    fleet = TABLE_FLEETS.get(set_code[:1])
    if fleet and set_code[1:].isdigit():
        return {
            'found': False,
            'carriage': set_code,
            'reason': f'no set {set_code[0]}{int(set_code[1:])} in the {fleet["name"]} composition table',
        }
    return {'found': False, 'carriage': set_code, 'reason': 'set number not recognised'}


def _set_key_variants(set_code, fleet_code):
    """K07 and K7 are the same set - the tables only hold one of the two spellings"""
    if not set_code.startswith(fleet_code):
        return []
    digits = set_code[len(fleet_code):]
    if not digits.isdigit():
        return []
    return {set_code, f'{fleet_code}{int(digits)}'}


def _parse_rule_set(set_code):
    """(fleet code, formatted set number, set index) from something like A12 or D104

    A5 and A05 are the same set, so both are accepted even though the checker only
    ever writes the first form back out.
    """
    letter, digits = set_code[:1], set_code[1:]
    if not digits.isdigit():
        return None

    if letter in ('A', 'B'):
        return letter, f'{letter}{int(digits)}', int(digits)

    if letter == 'H':
        index = int(digits)
        return ('H', f'H{index}', index) if 1 <= index <= 55 else None

    # Mariyung 6 car sets are the three digit D1xx numbers, where that 1 is part of
    # the set number rather than a digit of it. Anything shorter is a 4 car set.
    if letter == 'D':
        if len(digits) == 3 and digits[0] == '1':
            return 'D1', f'D1{digits[1:]}', int(digits[1:])
        if len(digits) <= 2:
            return 'D', f'D{int(digits)}', int(digits)
    return None


def lookup(text):
    """One box, both directions: try it as a carriage number, then as a set number."""
    query = str(text or '').strip()
    result = resolve_carriage(query)
    if result.get('found'):
        result['query'] = query
        return result

    as_set = resolve_set(query)
    if as_set.get('found'):
        as_set['query'] = query
        return as_set

    # both readings failed, so answer about whichever one the input actually looked
    # like - told "carriage number not recognised", someone who typed K07 would go
    # looking for a typo in a set number that simply isn't in the table
    failure = as_set if _looks_like_set(normalise(query)) else result
    failure['query'] = query
    return failure


def _looks_like_set(set_code):
    """a fleet letter followed by nothing but digits, which no carriage number is"""
    prefix = set_code[:1]
    digits = set_code[1:]
    return bool(digits) and digits.isdigit() and (prefix in TABLE_FLEETS or prefix in RULE_FLEETS)


def catalogue():
    """Everything the checker covers, for the reference panel on the page."""
    classes = []
    for fleet_code, fleet in TABLE_FLEETS.items():
        _, table = TABLE_LOOKUPS[fleet_code]
        classes.append({
            **_fleet_summary(fleet),
            'lookup': 'table',
            'setsKnown': len(table),
            'carriagesKnown': sum(len(cars) for cars in table.values()),
            'sets': list(table.keys()),
        })
    for fleet_code, fleet in RULE_FLEETS.items():
        classes.append({
            **_fleet_summary(fleet),
            'lookup': 'rule',
            'setsKnown': None,
            'carriagesKnown': None,
            'prefixes': [car['prefix'] for car in fleet['formation']],
            'sets': [],
        })
    return {'classes': classes}
