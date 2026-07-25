# Click Waypoints and Global Relocalization

## Handoff objective

Add one-click waypoint creation to the existing top-down minimap. Preserve and
verify the existing global LiDAR relocalization flow so the robot can be placed
at an arbitrary recognizable location inside the active saved map.

This is a small UI feature plus verification. Do not replace the navigation
stack, introduce a new localization system, or weaken localization trust gates.

## Current implementation facts

- `public/robot-map.js` renders the occupancy grid and already owns zoom, pan,
  and pointer handling.
- `poseToMapPosition()` converts map coordinates to screen percentages.
  Click conversion is its inverse:

  ```text
  x = centerX + ((pixelX / width) - 0.5) * 2 * rangeMeters
  y = centerY + (0.5 - (pixelY / height)) * 2 * rangeYMeters
  ```

- The active view returned by `getCurrentMapView()` already includes map
  aspect ratio, zoom, and pan offsets. Use that view; do not calculate from raw
  grid dimensions separately.
- The decoded occupancy grid is already held inside the renderer as `mapGrid`.
  ROS grid lookup is:

  ```text
  col = floor((x - originX) / resolution)
  row = floor((y - originY) / resolution)
  index = row * width + col
  ```

- Occupancy values use the existing rendering contract:
  `-1` is unknown, `0..50` is free, `51..64` is uncertain, and `65..100` is
  occupied.
- `POST /api/dogzilla/waypoints` already supports an explicit pose and
  atomically writes `config/robot-waypoints.json`. It already rejects
  non-finite coordinates, non-`map` frames, out-of-bounds coordinates, and
  missing/stale map identity.
- An explicit waypoint request must contain the active map ID and fingerprint.
  The normal map poll already fetches `/api/dogzilla/lidar/health`; its current
  identity is under `healthPayload.body.runtime.map`.
- `Relocalize on Map` already invokes
  `sidecars/dogzilla_map_pose/relocalize_on_frozen_map.py`. It performs bounded
  global matching against the active frozen PBSTREAM and supports a carried
  robot far from the saved pose hint.
- Relocalization trust requires at least three distinct frozen-map constraints
  scoring at least 55%, followed by a stable handoff within 0.25 m / 0.25 rad.
  These limits are intentional safety gates.

## Product behavior

1. In the normal top-down active-map view, a short click or tap on a free map
   cell opens a native name prompt.
2. Submitting a non-empty name saves a `map`-frame waypoint at the clicked
   coordinates through the existing API.
3. Use `yaw: 0` for this one-click version. Do not add a heading editor or
   click-drag orientation gesture. That can be added later if operators need
   arrival orientation.
4. After a successful save, refresh waypoint readiness so the new marker
   appears immediately and show the existing success status.
5. Dragging continues to pan and never opens the prompt. Wheel zoom and zoom
   reset continue to work.
6. Reject clicks on unknown, uncertain, or occupied cells with a concise
   status message. Also reject clicks outside the grid/letterbox.
7. Do not allow waypoint creation while displaying a SLAM session or candidate
   map. Those views are not the active navigation map.
8. If the normalized name already exists, use the existing confirmation modal
   before overwriting it.
9. A stale map identity race must fail through the existing server validation;
   surface the returned error and do not retry with guessed metadata.
10. Waypoint creation does not require the robot to be standing at the target,
    but later navigation remains subject to normal localization and Nav2
    readiness.

## Implementation steps

### 1. Add pure coordinate/grid helpers

File: `public/robot-map.js`

- Export a small inverse helper such as `mapPointerToPose(view, pixelX,
  pixelY, width, height)`.
- Return `null` for invalid/non-finite values or non-positive dimensions.
- Add a small helper that returns the grid cell value for a map pose, or
  `null` when outside the grid.
- Keep these functions dependency-free and testable with `node:test`.

### 2. Distinguish click from pan

File: `public/robot-map.js`

- Extend `createRobotMapRenderer()` with one optional callback, for example
  `onMapClick`.
- Store the pointer-down coordinates in `panStart`.
- Mark the gesture as a drag after approximately 5 CSS pixels of movement.
- On pointer-up, preserve current pan behavior. If the gesture did not cross
  the drag threshold, compute the map pose using the current view and invoke
  `onMapClick({ x, y, frame: "map", cell })`.
- Only invoke it in top-down map mode with a valid normal map grid.
- Ignore clicks originating from buttons, links, inputs, or selects as the
  existing handler already does.
- Do not add another pointer listener in `app.js`; keep gesture ownership in
  the renderer.

### 3. Track the displayed map context

File: `public/app.js`

- During `refreshDogzillaMap()`, retain the latest active map identity from
  `healthPayload.body.runtime.map`.
- Also retain whether the displayed stream is the normal active map,
  candidate, or SLAM map.
- Clear retained identity when the map becomes unavailable.
- Pass a single `onMapClick` handler into `createRobotMapRenderer()`.
- The handler must reject candidate/SLAM views and missing active identity
  before prompting.

Do not weaken the API by making map identity optional. Do not copy identity
from a waypoint or from `config/robot-waypoints.json`.

### 4. Save the clicked waypoint

File: `public/app.js`

- Validate the renderer result is a free cell (`0..50`).
- Ask for the waypoint name with `window.prompt`, consistent with the existing
  rename control. Cancellation is a no-op.
- Normalize only for duplicate detection using the same server convention:
  trim, lowercase, and replace runs of spaces/hyphens with `_`. The server
  remains authoritative.
- If that ID already exists, call `showConfirmModal()` before continuing.
- POST:

  ```json
  {
    "name": "operator input",
    "pose": {
      "frame": "map",
      "x": 1.23,
      "y": -0.45,
      "yaw": 0
    },
    "mapId": "active map id",
    "mapFingerprint": "active map fingerprint"
  }
  ```

- Reuse the status handling and readiness refresh already present in
  `handleWaypointCapture()` rather than creating a second notification system.
  A tiny shared save function is acceptable only if it makes both call sites
  shorter; do not add a class or new module.

### 5. Keep relocalization unchanged

Files to inspect, not redesign:

- `sidecars/dogzilla_map_pose/relocalize_on_frozen_map.py`
- `sidecars/dogzilla_map_pose/start-map-pose-in-container.sh`
- `public/app.js` (`start-map-pose` / `Relocalize on Map`)

Confirm the UI action still starts the global frozen-map matcher and that the
operator-confirmed carried-robot path allows a large jump from the old pose
hint. Do not:

- lower the 55% minimum score;
- reduce the three-distinct-constraint requirement;
- publish a user click as the robot's current pose;
- treat a waypoint or saved origin as localization proof;
- expose the robot dot or enable navigation before trust is proven.

“Arbitrary spot” means any location inside the active mapped area that has
enough distinctive, unchanged LiDAR-visible geometry. It does not mean
unmapped space or a guarantee in repetitive/featureless rooms.

### 6. Tests

File: `test/frontend-modules.test.mjs`

Add focused tests for:

- center and corner pointer-to-map conversion;
- non-square views;
- zoomed/panned view values;
- invalid dimensions/input;
- grid-cell lookup for free, unknown, uncertain, occupied, and outside-grid
  coordinates;
- a short pointer gesture invokes the callback once;
- a drag pans but does not invoke it.

The explicit waypoint API is already covered by
`test/http-dogzilla-routes-map-origin.test.mjs`. Do not duplicate those route
tests unless implementation reveals an uncovered server bug.

Run:

```powershell
node --test test/frontend-modules.test.mjs test/http-dogzilla-routes-map-origin.test.mjs test/dogzilla-navigation-startup-script.test.mjs
py -3 -m unittest test.test_dogzilla_relocalize
npm run verify
```

There are no configured lint or typecheck scripts in `package.json`; report
that fact instead of inventing commands.

### 7. Manual acceptance

At `http://127.0.0.1:3037` with the real target selected:

- Top-down active map: click a free cell, name it, and see the marker without a
  page reload.
- Pan after zooming: the same visible cell resolves to the same map location.
- Dragging, clicking a wall/unknown area, and clicking letterboxed space do
  not create a waypoint.
- Candidate and active-SLAM views refuse waypoint creation.
- Duplicate names require confirmation.
- Test both desktop mouse and Android tap.
- Confirm the saved JSON entry has `frame: "map"`, finite `x/y/yaw`,
  `verified: true`, and the current active map ID/fingerprint.

For physical relocalization, with an operator supervising in a safe open area:

1. Carry the robot to a recognizable spot inside the saved map.
2. Run `Relocalize on Map`.
3. Confirm the dot and waypoint navigation remain blocked during matching.
4. Confirm a proven match restores the dot and navigation readiness.
5. Repeat from a second substantially different mapped spot.
6. Confirm a deliberately poor/featureless placement fails closed.

Pi-side code does not need deployment if this task only changes the browser UI
and documentation. If any Pi-side file is changed, follow the repository rule:
deploy only after user approval, restart only the affected service/container,
and verify live Pi state.

## Documentation

Update `docs/NAVIGATION.md` with two compact durable facts:

- active-map free cells can be clicked to create map-frame waypoints;
- global relocalization works from arbitrary recognizable positions inside the
  active map but intentionally fails closed when geometry is ambiguous.

Do not duplicate command recipes from `docs/COMMANDS.md`.

## Definition of done

- One click/tap on a free cell can save a named waypoint.
- Zoom, pan, desktop, and Android coordinate conversion are correct.
- Invalid cells and non-active map views cannot create waypoints.
- Server-side map identity and bounds validation remain intact.
- Existing global relocalization safety thresholds and trust behavior are
  unchanged and tests pass.
- Focused tests and `npm run verify` pass.
- Only `public/robot-map.js`, `public/app.js`,
  `test/frontend-modules.test.mjs`, and `docs/NAVIGATION.md` are changed unless
  a verified defect requires otherwise.

