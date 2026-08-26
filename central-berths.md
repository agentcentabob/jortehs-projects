# Central Station signal berths (Locs)

Reference for the Digital Tactile Bumps board. None of this is published by
Transport for NSW - it was all read off the live GTFS-realtime feed
(`sydneytrains`), so it reflects observed behaviour rather than documented fact
and should be re-checked if track working or the timetable changes.

## How berths are named

The `sydneytrains` feed reports `stop_id` as a train-describer berth string, not a
GTFS stop id:

```
Sydney.Central 17 Loc      <- platform berth
Sydney.SY354 Loc           <- plain berth in the station throat
Sydenham.Central 24 Loc    <- also Central; the prefix is an area, not the station
Sydney.CO271/SY366 Loc     <- a berth can name two codes
Sydney.SY522 Entry Loc     <- between stations, deliberately unmatched
```

Two things that bite:

- The prefix before the dot is an **area, not the station**. `Sydenham.Central 24
  Loc` is Central platform 24.
- Central's terminal platforms (1-15) are officially **Sydney Terminal**, so they
  report as `Sydney 12 Loc`, not `Central 12 Loc`. Through platforms (16-27) use
  `Central`. Every `Sydney N` berth observed had N <= 15; every `Central N` berth
  had N >= 16.

Matching must anchor the station name to the dot. Without that,
`NorthSydney.North Sydney 2 Loc` ends in `Sydney 2 Loc` and reads as Central
platform 2.

## Platform stop IDs

These are `departure_mon` stop IDs, separate from the berths above.

| Platforms | Stop ID |
|---|---|
| 1-25 | `2000320 + platform number` (platform 1 = `2000321`) |
| 26, 27 (metro) | `2000466`, `2000467` |
| Grand Concourse (L1) | `2000257` |
| Chalmers St LR1 / LR2 | `2000447`, `2000448` |

Platform 15 does not physically exist. Chalmers Street platform 3 exists but TfNSW
publishes no stop ID for it.

## Run-in berths, by platform

The berth a train passes through immediately before entering the platform. This is
what lets the board show "arriving" before the train is physically at the platform.

Confirmed by observation:

| Platform | Run-in berth | Times seen |
|---|---|---|
| 19 | `SY374` | 5 |
| 22 | `SY373` | 1 (low confidence) |
| 23 | `SY379` | 3 |
| 24 | `SY712` | 4 |
| 25 | `ES0.06` | 5 |

Still unconfirmed: **16, 17, 18, 20, 21**. Only entries with solid repeat
observations are wired into `PLATFORM_APPROACH_BERTHS` in `centralPlatforms.js`;
anything missing falls back to starting "arriving" when the train reaches the
platform berth, rather than guessing.

**Why these are slow to collect:** run numbers change at Central, so a train
arriving at a through platform carries a *different* vehicle ID there than it had
in the run-in berth. Tracking berth transitions by vehicle ID therefore never sees
the handover on exactly the platforms that need it. Correlating berth occupancy
over time sidesteps that.

## Berths within 700 m of Central

Distances are the closest observed GPS fix reporting that berth, so they are
approximate.

| Distance | Berth |
|---|---|
| 75 m | `SY354` |
| 88-120 m | platform berths `Central 16` - `Central 23` |
| 115 m | `SY357`, `SY362`, `SY363`, `SY367`, `SY370`, `SY373`, `SY374`, `SY379`, `CO271/SY366` |
| 137 m | `SY365` |
| 154 m | `SY372` |
| 186 m | `SY389`, `SY395` |
| 198 m | `SY371` |
| 263 m | `SY380` |
| 318 m | `SY361` |
| 323 m | `CI24/SY359` |
| 330 m | `SY368` |
| 342 m | `SY397` |
| 377 m | `SR1.3BER` |
| 395-396 m | `SY403`, `SY384` |
| 403 m | `ES0.14`, `ES0.24`, `ES0.46`, `ES0.58` (Eastern Suburbs) |
| 468-482 m | `SY394`, `SY409` |
| 505 m | `CI34`, `CI258`, `CO259`, `CO263`, `SY356`, `SY358` (City Circle) |
| 511 m | `SH0.31/SY364` |
| 540-546 m | `SY360`, `SY386`, `SY393`, `SY407` |
| 601-660 m | `SH0.39`, `SH0.42`, `SH0.43`, `SY392`, `SY402` |
| 677 m | `SY439` |

Nearby station platform berths, for reference: Museum ~811 m, Town Hall ~1072 m,
Redfern ~1203 m.

The set treated as "still at Central" for ending the departing indicator
(`CENTRAL_APPROACH_BERTHS` in `centralPlatforms.js`) is the cluster within roughly
200 m: `SY354`, `SY357`, `SY362`, `SY363`, `SY365`, `SY366`, `SY367`, `SY370`,
`SY371`, `SY372`, `SY373`, `SY374`, `SY379`, `SY389`, `SY395`.
