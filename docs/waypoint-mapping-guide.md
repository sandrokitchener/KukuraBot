# Waypoint Mapping Guide

## Goal

Use one stable semantic waypoint name across both runtime targets:

- real robot file: `config/robot-waypoints.json`
- Isaac Sim file: `config/isaacsim-waypoints.json`

Keep names the same and let coordinates differ by target. That gives the app one command vocabulary while still letting sim and hardware use different frames and tolerances.

## Files That Matter

| File | Purpose | Coordinate style |
| --- | --- | --- |
| `config/robot-waypoints.json` | Named targets for ROS2 and real-robot plans | `x`, `y`, `yaw`, `arrivalToleranceMeters` |
| `config/isaacsim-waypoints.json` | Named targets for Isaac Sim | `position: [x, y, z]`, `yawDegrees` |
| `config/robot-runtime.json` | Chooses active waypoint set | `selectedWaypointSet` |
| `config/valid-waypoints.txt` | Prompt-facing list of allowed names | text list only |

## Keep Prompt Names In Sync

There is already one mismatch in this repo:

- `config/valid-waypoints.txt` includes names such as `front door`, `master bedroom`, `game room`, and `guest room`
- `config/robot-waypoints.json` currently defines `living_room`, `garage`, `bedroom`, `current_position`, and `source`

Practical rule: do not add a prompt-facing name until both waypoint JSON files know how to resolve it. Otherwise the model can generate a name the runtime cannot execute.

## Current Real-Robot Contract

Today the real-robot command compiler actually uses these keys from `config/robot-waypoints.json`:

| Key | Meaning | Recommendation |
| --- | --- | --- |
| `kind` | `map_pose` or `special` | Use `map_pose` for fixed home spots. Keep `special` for semantic targets like `source` and `current_position`. |
| `frame` | Coordinate frame name | Use `map` unless you have a very specific reason to do otherwise. |
| `x`, `y` | Target position in meters | Measure from one permanent home origin. |
| `yaw` | Heading | Store radians for real ROS targets. Do not mix radians and degrees in the same file. |
| `arrivalToleranceMeters` | How close is "good enough" | Wider at thresholds and tighter in open rooms. |
| `physicalSpot` | Human-readable meaning | Describe the parking bubble, not just the room name. |
| `anchorHint` | How you measured it | Reference a wall, dock, door frame, tile seam, or furniture corner that does not move. |
| `verified` | Bench-tested or still placeholder | Leave `false` until both sim and real runs agree. |
| `notes` | Extra context | Use for safety notes, rug warnings, dock offsets, or retry tips. |

Anything else you add is currently metadata only. Safe pattern: keep future tuning values in `notes` until the app or bridge starts reading them explicitly.

## Current Isaac Sim Contract

`config/isaacsim-waypoints.json` keeps the same names but uses simulator-friendly fields:

| Key | Meaning | Recommendation |
| --- | --- | --- |
| `frame` | Usually `world` | Keep one world frame per scene. |
| `position` | `[x, y, z]` meters | Mirror the semantic spot, not necessarily the exact real-house coordinate. |
| `yawDegrees` | Heading in degrees | Keep this file in degrees because that is the existing repo convention. |
| `verified` | Sim-tested | Mark true only after actual scene playback looks right. |
| `notes` | Scene caveats | Call out local-room-only or proxy-rig-only assumptions. |

## Pick Physical Spots, Not Room Centers

Good waypoints are parking bubbles, not symbolic labels.

- Put the target where the dog can stop, rotate, and recover without clipping furniture.
- Bias the spot toward open floor, not toward the geometric center of the room.
- Measure from anchors that never move. Good anchors: dock edge, wall corner, tile seam, door jamb, built-in cabinet corner.
- Never anchor to a chair, car, loose rug, or movable storage bin.
- Keep doorway waypoints just inside or just outside the threshold, not on the threshold itself.
- Face the robot toward the next likely travel direction or toward open space, not toward a wall.

## Suggested Home Spots For Current Names

Use the current repo names as practical zones:

| Waypoint | Best physical meaning | Notes |
| --- | --- | --- |
| `living_room` | Open standby bubble near rug edge or couch corner | Leave enough room for a turn-in-place. |
| `garage` | Clear staging spot just inside the garage threshold | Do not anchor to parked-car position. |
| `bedroom` | Standby bubble near door swing edge or beside bed corner | Bias away from soft rugs and tight bed clearances. |
| `current_position` | No-op semantic target | Keep as `special` / `stay_put`. |
| `source` | Operator-relative or speaker-relative behavior target | Keep semantic. Do not convert into a fake fixed coordinate. |

## Measurement Workflow

1. Pick one origin for the house. Best choice is the dock or a permanent wall corner.
2. Mark your `+x` and `+y` directions on paper before measuring anything.
3. Put painter's tape on the floor for each parking bubble center.
4. Measure `x` and `y` from the origin to the bubble center in meters.
5. Choose `yaw` so the dog faces open floor or the next hallway segment.
6. Add `arrivalToleranceMeters` based on local clutter, threshold bumps, and turning room.
7. Set `verified: false` until the spot works in sim first and on the real robot second.
8. After three repeatable arrivals, flip `verified` to `true`.

## Tolerance Rules

Use tolerance as a safety knob, not as a hidden fix for bad coordinates.

| Spot type | Suggested tolerance |
| --- | --- |
| Open room parking bubble | `0.20` to `0.30` m |
| Doorway or threshold staging | `0.30` to `0.40` m |
| Tight bedside or dock approach | `0.10` to `0.20` m after repeatable tests |

If you need more than `0.40` m to make a waypoint work, the location is probably wrong or too cluttered.

## Parameterization That Scales

Current code already consumes the core fields above. For future tuning, keep these ideas in mind:

- `clearanceRadiusMeters`: how much empty floor the dog needs around the target
- `approachHeadingDegrees`: preferred final heading if you later separate travel heading from final pose
- `surface`: hardwood, tile, rug, threshold, mat
- `dwellSeconds`: how long to hold the pose before the next step
- `tags`: `["dock", "threshold", "quiet_zone"]`
- `lastMeasuredAt`: when you last re-measured after moving furniture

If you add these now, treat them as documentation until code starts reading them.

## Keep Sim And Real In Sync

The safest rule is:

- same waypoint names across both files
- same human meaning across both files
- different numeric coordinates allowed

That means `living_room` should always mean the same destination concept, even if the sim room is simplified and the exact coordinates do not match your house.

Also keep special names special across both files:

- `current_position` should remain a no-op semantic target
- `source` should remain operator-relative or speaker-relative, not a fake fixed pose

## Example Real-Robot Entry

```json
{
  "living_room": {
    "kind": "map_pose",
    "frame": "map",
    "x": 1.42,
    "y": -0.38,
    "yaw": 1.57,
    "arrivalToleranceMeters": 0.25,
    "physicalSpot": "Living room parking bubble near couch corner",
    "anchorHint": "Measured from dock front edge and west wall",
    "verified": false,
    "notes": [
      "Faces hallway exit.",
      "Keep 0.35 m clearance from rug edge."
    ]
  }
}
```

## Example Isaac Sim Entry

```json
{
  "living_room": {
    "position": [-1.55, 1.4, 0.0],
    "yawDegrees": 25.0,
    "verified": false,
    "notes": [
      "Matches living room semantic target in proxy scene."
    ]
  }
}
```

## Verification Loop

Run the same name through both targets in this order:

1. Isaac Sim first: confirm the semantic spot is correct.
2. Real target in dry-run: confirm the preview envelope resolves the same waypoint name and pose fields.
3. Real target live: test the easiest open-floor spots first.
4. Mark `verified: true` only after repeatable arrivals with no furniture contact and no surprise heading flips.

## Practical Recommendation

For a home deployment, do not chase centimeter-perfect room-center coordinates first. Pick 3 to 5 safe parking bubbles that matter every day, verify them, and only then expand the waypoint set.
