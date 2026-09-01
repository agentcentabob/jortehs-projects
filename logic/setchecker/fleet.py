"""Descriptions of each fleet the checker knows, and how its numbering works.

Two kinds of fleet live here. The rule-based ones (A, B, D, H) carry their set
number inside the carriage number, so the whole formation can be worked back out
from the numbering alone. The table-based ones (T, M, K) can't - see compositions.py.

`formation` is in car order, front to back, and is what both the "which car is
this" answer and the derived formation diagram are built from.
"""

# fleets whose set number falls out of the carriage number
RULE_FLEETS = {
    'A': {
        'code': 'A',
        'name': 'Waratah',
        'cars': 8,
        'deck': 'double-deck',
        'builder': 'Downer EDI Rail / CRRC Changchun',
        'introduced': '2011',
        'operator': 'Sydney Trains',
        'service': 'Suburban',
        'rule': 'The last two digits of any Waratah carriage number are the set number.',
        'examples': ['D6312', 'N5312', 'T6512'],
        'formation': [
            {'prefix': 'D63', 'type': 'driving trailer'},
            {'prefix': 'N53', 'type': 'non-driving motor'},
            {'prefix': 'N55', 'type': 'non-driving motor'},
            {'prefix': 'T65', 'type': 'non-driving trailer'},
            {'prefix': 'T66', 'type': 'non-driving trailer'},
            {'prefix': 'N56', 'type': 'non-driving motor'},
            {'prefix': 'N54', 'type': 'non-driving motor'},
            {'prefix': 'D64', 'type': 'driving trailer'},
        ],
    },
    'B': {
        'code': 'B',
        'name': 'Waratah Series 2',
        'cars': 8,
        'deck': 'double-deck',
        'builder': 'Downer / CRRC Changchun',
        'introduced': '2018',
        'operator': 'Sydney Trains',
        'service': 'Suburban',
        'rule': 'The last two digits of any Waratah Series 2 carriage number are the set number.',
        'examples': ['D1105', 'N1705', 'T1305'],
        'formation': [
            {'prefix': 'D11', 'type': 'driving trailer'},
            {'prefix': 'N17', 'type': 'non-driving motor'},
            {'prefix': 'N19', 'type': 'non-driving motor'},
            {'prefix': 'T13', 'type': 'non-driving trailer'},
            {'prefix': 'T14', 'type': 'non-driving trailer'},
            {'prefix': 'N18', 'type': 'non-driving motor'},
            {'prefix': 'N16', 'type': 'non-driving motor'},
            {'prefix': 'D12', 'type': 'driving trailer'},
        ],
    },
    'D': {
        'code': 'D',
        'name': 'Mariyung',
        'cars': 4,
        'deck': 'double-deck',
        'builder': 'Hyundai Rotem',
        'operator': 'NSW TrainLink',
        'service': 'Intercity (New Intercity Fleet)',
        'rule': 'The last two digits of any Mariyung carriage number are the set number.',
        'examples': ['DD9704', 'DN8504', 'DDA9304'],
        'formation': [
            {'prefix': 'DD97', 'type': 'driving trailer'},
            {'prefix': 'DN85', 'type': 'non-driving motor'},
            {'prefix': 'DND83', 'type': 'non-driving motor'},
            {'prefix': 'DDA93', 'type': 'driving trailer (atp)'},
        ],
    },
    'D1': {
        'code': 'D1',
        'name': 'Mariyung',
        'cars': 6,
        'deck': 'double-deck',
        'builder': 'Hyundai Rotem',
        'operator': 'NSW TrainLink',
        'service': 'Intercity (New Intercity Fleet)',
        'rule': 'The last two digits of any Mariyung carriage number are the set number.',
        'examples': ['DD9804', 'DNL8804', 'DDA9404'],
        'formation': [
            {'prefix': 'DD98', 'type': 'driving trailer'},
            {'prefix': 'DNL88', 'type': 'non-driving motor'},
            {'prefix': 'DT96', 'type': 'non-driving trailer'},
            {'prefix': 'DN86', 'type': 'non-driving motor'},
            {'prefix': 'DND84', 'type': 'non-driving motor'},
            {'prefix': 'DDA94', 'type': 'driving trailer (atp)'},
        ],
    },
    'H': {
        'code': 'H',
        'name': 'OSCAR',
        'cars': 4,
        'deck': 'double-deck',
        'builder': 'UGL Rail (Goninan)',
        'introduced': '2006',
        'operator': 'NSW TrainLink',
        'service': 'Outer suburban / intercity',
        'rule': 'Each OSCAR carriage prefix counts its own way - see the working below.',
        'examples': ['ON5912', 'ONL5962', 'OD6925'],
        # unlike the other rule fleets this isn't the car order - it's every prefix
        # OSCARs use, across both variants (H1-H49 run the 59 series motors, H50-H55
        # the 58 series). Car order comes from _oscar_formation() instead.
        'formation': [
            {'prefix': 'OD69', 'type': 'driving trailer'},
            {'prefix': 'ONL59', 'type': 'non-driving motor with lavatory'},
            {'prefix': 'ONL58', 'type': 'non-control motor with lavatory'},
            {'prefix': 'ON59', 'type': 'non-control motor'},
            {'prefix': 'ON58', 'type': 'non-control motor'},
        ],
    },
}

# fleets that need a composition table, keyed by the prefix their set numbers use
TABLE_FLEETS = {
    'T': {
        'code': 'T',
        'name': 'Tangara',
        'cars': 4,
        'deck': 'double-deck',
        'builder': 'A Goninan & Co',
        'introduced': '1988',
        'operator': 'Sydney Trains',
        'service': 'Suburban',
        'rule': 'Tangara carriage numbers say nothing about the set - it comes from a composition table.',
        'examples': ['D6105', 'N5105', 'D6840'],
        'carriagePrefixes': {'D': 'driving trailer', 'N': 'non-driving motor'},
    },
    'M': {
        'code': 'M',
        'name': 'Millennium',
        'cars': 4,
        'deck': 'double-deck',
        'builder': 'EDI Rail / Alstom',
        'introduced': '2002',
        'operator': 'Sydney Trains',
        'service': 'Suburban',
        'rule': 'Millennium carriage numbers say nothing about the set - it comes from a composition table.',
        'examples': ['D1001', 'N1501', 'D1072'],
        'carriagePrefixes': {'D': 'driving trailer', 'N': 'non-driving motor'},
    },
    'K': {
        'code': 'K',
        'name': 'K set',
        'cars': 4,
        'deck': 'double-deck',
        'builder': 'A Goninan & Co / Comeng',
        'introduced': '1981',
        'operator': 'Sydney Trains',
        'service': 'Suburban',
        'rule': 'K set carriage numbers say nothing about the set - it comes from a composition table.',
        'examples': ['C3510', 'T4176', 'C3577'],
        'carriagePrefixes': {'C': 'driving motor', 'T': 'non-driving trailer'},
    },
}
