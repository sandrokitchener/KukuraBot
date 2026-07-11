# Navigation, Mapping, and UX Reliability Review

Review date: 2026-07-10
Scope: evidence-first review and implementation plan. No product runtime or source behavior changed by this review.

## Executive verdict

The primary goal is not safe to claim today. Nav2 can accept a goal, but current live evidence shows three incompatible coordinate authorities:

| Authority | Live evidence | Consequence |
| --- | --- | --- |
| Nav2 static map | <code>/map_server</code> loads <code>/home/pi/robodoge/maps/robodoge_home.yaml</code>; active map <code>robodoge_home_20260708T195940_scanner</code>, fingerprint <code>85e17c...8038</code>, 0.05 m resolution | Nav2 plans against the scanner YAML/PGM. |
| Cartographer localization | Running process loads <code>robodoge_home_20260704T014339Z.pbstream</code>. Pi mode file names that same old artifact. | The live <code>map -> base_link</code> transform is localized against a different map generation. |
| Waypoints | Six verified map-pose entries in <code>config/robot-waypoints.json</code> carry older fingerprint <code>c0a5a...cf3f</code>. | A saved physical location can be sent to a different map. |
| Saved origin | Pi origin file is absent. Local ignored cache contains exact test fixture <code>x=1, y=2, yaw=0.5</code>, with no map identity. | UI reports origin ready while deployed localization has no matching origin. |
| Readiness | Live bridge says <code>waypointReady=true</code>, <code>canSendGoal=true</code>, lifecycle active, and scan/odom ready. | Readiness proves transport, not map coherence or physical correctness. |

This is evidence for waypoint drift, not a generic SLAM theory. The next implementation slice must make one active map generation authoritative across the Nav2 YAML/PGM, localization artifact, origin, and waypoint registry. Until then, block live waypoint dispatch when those identities differ.

Manufacturer documentation supports this pairing: the Yahboom mapping guide saves a Cartographer <code>.pbstream</code> and converts it to <code>.yaml</code>/<code>.pgm</code> at 0.05 m; the navigation guide starts localization from that <code>.pbstream</code> and Nav2 from its YAML. See <code>docs/DOGZILLA-main/14.Lidar course/Robot dog mapping.pdf</code>, page 9, and <code>Robot Dog Navigation.pdf</code>, pages 6 and 9.

## 1. Current architecture

| Layer | Current implementation |
| --- | --- |
| Operator UI | Shared static <code>public/</code> application. <code>public/index.html</code> and <code>public/app.js</code> run in browser, Electron, and Tauri/Android shells. |
| Desktop/mobile shells | Electron launches the local backend and opens <code>http://127.0.0.1:3037</code> in <code>electron/main.cjs</code>. Tauri uses <code>public/</code> and the same dev URL in <code>src-tauri/tauri.conf.json</code>. |
| App server | <code>server.mjs</code> is a Node HTTP server on <code>0.0.0.0:3037</code>. It serves static UI, applies CORS, and routes to <code>lib/http-runtime-routes.mjs</code> and <code>lib/http-dogzilla-routes.mjs</code>. |
| Command layer | <code>lib/app-service.mjs</code> queries model output, parses JSON, calls <code>buildRobotRuntimePreview()</code>, then dispatches through <code>dispatchRobotCommand()</code>. |
| Robot transport | Direct bridge at Pi port 8893 owns DOGZILLALib control on <code>/dev/ttyAMA0</code>. Rosbridge uses port 9090 and LiDAR HAT UART <code>/dev/ttyAMA1</code>. |
| ROS/Nav2 | Pi systemd owns <code>robodoge-map-pose.service</code> and <code>robodoge-navigation.service</code>. Cartographer emits <code>map -> base_link</code>; Nav2 consumes <code>/scan_nav2</code>, <code>/odom</code>, and <code>navigate_to_pose</code>. |
| Persistent data | Map aliases and metadata live under Pi <code>/home/pi/robodoge/maps</code>; local waypoint registry is <code>config/robot-waypoints.json</code>; local origin cache is <code>output/app-cache/dogzilla-map-origin.json</code>. |

The app has no single map authority today. The active Nav2 occupancy map is the YAML/PGM named by <code>map_server</code>. Cartographer localization independently selects a pbstream, including a fallback to the newest <code>robodoge_home_*.pbstream</code> in <code>sidecars/dogzilla_map_pose/start-map-pose-in-container.sh:85-123</code>. That fallback created the live split.

## 2. Exact current Map This Floor flow

| Step | What code does | Evidence |
| --- | --- | --- |
| Enter | Operator opens Map Controls and clicks Map This Floor. | <code>public/index.html:265-279</code> |
| Confirm | Browser-only confirmation warns about people, pets, fragile objects, and stairs. | <code>public/operator-status.js:10-21</code>; <code>public/app.js:1853-1865</code> |
| Start request | UI POSTs <code>{ action: "start-autonomous-mapping" }</code> to <code>/api/dogzilla/connection/action</code>. | <code>public/app.js:1926-1932</code>; <code>lib/http-dogzilla-routes.mjs:105-152</code> |
| Pi startup | PowerShell starts Cartographer mapping mode, Nav2 mapping mode, then detached explorer. | <code>scripts/start-dogzilla-autonomous-mapping-ssh.ps1</code> |
| Mapping Nav2 | Mapping launch omits <code>map_server</code> and AMCL and uses the live Cartographer grid. | <code>sidecars/dogzilla_navigation/robodoge_nav2_navigation_launch.py:38-80</code> |
| Exploration | <code>FrontierExplorer</code> subscribes to <code>/map_cartographer</code> and <code>/scan_nav2</code>, reads <code>map -> base_link</code>, selects free cells adjacent to unknown cells, then sends <code>NavigateToPose</code>. | <code>sidecars/dogzilla_navigation/frontier_explorer.py</code> |
| Status | Explorer atomically writes <code>maps/autonomous-mapping-status.json</code> with state, goal count, failures, and error. | <code>frontier_explorer.py:159-178</code> |
| Finish | Finish creates a stop file, waits up to 20 seconds for explorer exit, saves candidate pbstream/YAML/PGM, restores previous localization and Nav2. | <code>scripts/finish-dogzilla-autonomous-mapping-ssh.ps1</code> |
| Promote | Candidate script copies pbstream, YAML, and PGM into <code>robodoge_home.*</code>; route clears origin and restarts localization/Nav2. | <code>sidecars/dogzilla_map_pose/promote-candidate-map-in-container.sh</code>; <code>lib/http-dogzilla-routes.mjs:137-149</code> |

Current control-state behavior:

| Operator action | Present behavior | Missing or unsafe behavior |
| --- | --- | --- |
| Start | Starts after confirmation. | No Pi-owned job lock, PID ownership, or idempotency check. A second start can launch another explorer. |
| Pause | Not implemented. | No pause state, current-goal cancellation acknowledgement, or resume. |
| Finish / cancel | Finish writes stop file and attempts candidate save. | UI marks success from request completion; it does not verify job state, candidate files, or restored runtime coherence. |
| Automatic completion | Explorer can stop after no frontiers, goal limit, stale sensors, TF loss, or failures. | UI never reads status file, so it cannot tell operator why or that it completed. |
| Retry | Not implemented. | No retained failure reason or safe retry rule. |
| Reload / leave screen | Browser booleans reset. | Robot-side explorer may still run while Finish/Promote controls return to initial state. |
| Promote | User must explicitly confirm. | Sequential copies and later restarts have no transaction rollback if restart or validation fails. |

The implementation is real, not a mock: it launches Cartographer, Nav2, and ROS action goals. It is partial because job state is disconnected from UI, unattended safety is unproven, and activation does not ensure one coherent map generation.

The UI phrase "stops at safe reachable edges" overstates protection. Explorer clearance is only 2D occupancy-grid clearance. Yahboom guide evidence only establishes the horizontal <code>/scan</code> LiDAR path; no downward drop-off sensor or stair boundary contract is present. Mapping must remain supervised in a bounded, stair-free area with physical barriers until a hazard sensor or validated keep-out boundary exists.

## 3. Current end-to-end map data flow

~~~text
LiDAR /scan
  -> Cartographer mapping
  -> /map_cartographer occupancy grid
  -> frontier_explorer.py and mapping-mode Nav2
  -> /write_state candidate.pbstream
  -> cartographer_pbstream_to_ros_map candidate.yaml + candidate.pgm
  -> candidate.json
  -> promote script copies robodoge_home.pbstream/yaml/pgm
  -> normal Cartographer localization + Nav2 map_server
~~~

Current map formats and transforms:

- Candidate save in <code>save-map-pose-in-container.sh</code> calls Cartographer <code>/write_state</code>, then converts to YAML/PGM. It refuses to update normal metadata if conversion fails.
- YAML specifies <code>image</code>, 0.05 m resolution, <code>origin</code>, <code>negate</code>, <code>occupied_thresh</code>, and <code>free_thresh</code>. Current active YAML has origin <code>[-1.5662, -8.3426, 0]</code>, occupied threshold 0.65, free threshold 0.196.
- Explorer treats occupancy <code>0..50</code> as free and <code>&lt;0</code> as unknown. It uses occupancy-grid origin and resolution to calculate map-frame goals.
- UI rendering flips grid rows for canvas display in <code>public/robot-map.js:314-324</code>. Waypoints are stored as numeric poses, not pixels; this render-only Y inversion is not a root cause of dispatched waypoint drift.
- Map-frame conversion rounds to five decimal places in <code>lib/dogzilla-map-frame.mjs:393-395</code>. That precision is not a plausible drift source.

There is a second, temporary scanner bridge:

~~~text
SLAM App scan export map.yaml + map.pgm
  -> scripts/promote-latest-slam-map.ps1
  -> robodoge_home.yaml + robodoge_home.pgm + metadata
  -> restart only robodoge-navigation.service
~~~

That script explicitly records "External occupancy map only; no Cartographer pbstream was generated." It can replace Nav2's map without replacing Cartographer localization. Live runtime proves that path produced the current split. It must not be allowed to activate an authoritative map until it supplies a matching localization backend/artifact and the activation transaction validates both.

## 4. Current waypoint data flow

~~~text
trusted current map pose
  -> POST /api/dogzilla/waypoints
  -> optional map -> app_map transform plus captured map pose
  -> config/robot-waypoints.json
  -> model JSON waypoint name
  -> robot-command-compiler resolves pose
  -> direct bridge validates and sends NavigateToPose
~~~

Capture details:

- <code>POST /api/dogzilla/waypoints</code> gets a <code>waypointSafe</code> pose, reads live map metadata and saved origin, then writes the registry. See <code>lib/http-dogzilla-routes.mjs:301-406</code>.
- With an origin, it stores <code>frame: "app_map"</code>, numeric x/y/yaw, map id/fingerprint, a map-origin snapshot, and a <code>capturedMapPose</code>. Without an origin, it stores raw <code>map</code> pose.
- Same normalized name silently overwrites existing entry at <code>lib/http-dogzilla-routes.mjs:401-405</code>. There is no rename or delete endpoint/UI.
- <code>config/robot-waypoints.json</code> is the source of real coordinates and trust fields. Current registry has 17 entries: 6 ready map waypoints, 8 disabled map placeholders, and 3 semantic entries. It must remain authoritative; diagnostics must not silently rewrite it.

Dispatch details:

- <code>resolveNavigationPose()</code> accepts map or app_map pose in <code>lib/robot-command-compiler.mjs:462-541</code>.
- For app_map, <code>resolveAppMapPoseToMapPose()</code> resolves in this order: stored waypoint origin, then captured map pose, then mutable current origin. See <code>lib/dogzilla-map-frame.mjs:189-230</code>.
- The compiler sends a map-frame canonical plan to <code>locomotion.goto</code>; direct bridge validates it and creates Nav2 <code>NavigateToPose</code>.

The required final representation is simpler: store only a stable <code>map</code>-frame x/y/yaw plus immutable active-map id/fingerprint. Do not convert a stale waypoint to a new map. If the active fingerprint changes, mark waypoint stale and require recapture.

## 5. Evidence-based waypoint drift causes

| Rank | Evidence | Why it causes drift | Proposed guard |
| --- | --- | --- | --- |
| P0 | Nav2 YAML/PGM is scanner map while Cartographer loads old pbstream. | Pose transform and planner use different coordinate worlds. | One active manifest and startup hard-fail on artifact mismatch. |
| P0 | Waypoints carry old fingerprint but <code>validateWaypointMapIdentity()</code> returns ready when any map is available. | Map version mismatch is advisory, so old poses dispatch. | Require exact id/fingerprint match before navigation. |
| P0 | Validator reports living_room and master_bedroom outside active bounds but leaves both ready. | Off-map target can reach bridge and fail late or route incorrectly. | Treat off-map as dispatch blocker, not advisory text. |
| P0 | Local ignored origin file is exact test fixture and lacks map identity; Pi origin absent. | App/UI can claim origin ready while deployed localization lacks it. | Isolate tests; require origin identity; never seed localization from unverified cache. |
| P1 | app_map uses historical origin/captured pose precedence. | It preserves old map coordinate values after map replacement. | Replace app_map persistence with final map pose and version binding. |
| P1 | Cartographer laser-only local tracking can lose physical alignment after robot is carried. | Fresh TF proves a transform exists, not that it represents the real room. | Require deliberate known-point relocalization and recapture workflow. |

Not supported as primary causes:

- UI pixel scaling or canvas Y inversion: dispatch uses stored numeric coordinates, and canvas inversion is render-only.
- JSON precision loss: five decimal places is much smaller than practical navigation tolerance.
- A repeated image-to-ROS transform: current compiler resolves one app_map transform to map frame before dispatch.

## 6. Typed command flow

1. <code>public/app.js:614-710</code> sends text to <code>POST /api/chat</code>.
2. <code>lib/http-runtime-routes.mjs:46-50</code> calls <code>processUserInput()</code>.
3. <code>lib/app-service.mjs:335-427</code> sends the text and prompt to configured model, parses JSON, builds the robot plan, and dispatches it when real robot target is active.
4. <code>lib/robot-command-compiler.mjs:717-742</code> resolves only exact name or lowercase/space/hyphen normalized name from <code>robot-waypoints.json</code>.
5. <code>lib/robot-sidecar-client.mjs</code> POSTs the envelope to direct bridge <code>/commands</code>.
6. Bridge uses Docker rclpy client and <code>NavigateToPose</code>.

The model prompt does not use the authoritative registry alone. <code>lib/app-service.mjs:449-550</code> loads <code>config/valid-waypoints.txt</code>; that duplicate list omits verified kitchen, charger, and kit while including unverified placeholders. This can prevent "go to kitchen" before compiler resolution.

No coordinate is intentionally generated from language in the compiler. Keep that invariant. Add aliases and deterministic ambiguity handling: exact normalized id/alias is accepted; one unique partial match is offered for confirmation; multiple or no matches asks clarification; no match never produces x/y.

## 7. Voice command flow

1. Speech provider transcribes locally or through configured sidecar.
2. <code>public/speech-input.js:55-82</code> accepts configured activation phrase only at transcript start.
3. Bare activation arms an eight-second command window; otherwise untriggered speech is ignored. See <code>speech-input.js:379-421</code>.
4. <code>public/app.js:3968-3986</code> places accepted text into chat input and submits the same typed-command flow.

Voice and typed routes therefore share waypoint resolution and dispatch behavior. At review time, app health was degraded because local Parakeet sidecar was unreachable. The UI can still display "Ready: Parakeet" from configuration in <code>public/app.js:2639-2643</code>, so voice end-to-end completion is currently unproven.

## 8. What works, what is partial, and what is disconnected

| Works in code/live probes | Partial, disconnected, or broken |
| --- | --- |
| Shared web/Electron/Tauri UI, Node route wiring, Pi direct bridge, live scan, live map-frame pose, Nav2 lifecycle/odom/scan readiness. | No coherent active-map contract; current Nav2, Cartographer, waypoints, and origin disagree. |
| Map This Floor starts true Cartographer mapping, true Nav2 frontier goals, candidate pbstream/YAML/PGM save. | Explorer status file is never exposed to UI; browser state is not recoverable after reload. |
| Candidate save refuses normal activation when Cartographer conversion fails. | Promotion copies files sequentially and does not roll back if restart/readiness validation fails. |
| Capture persists map provenance and compiler builds map-frame goal. | Identity mismatch and off-map checks are advisory; duplicate name overwrites silently. |
| Direct bridge returns goal acceptance and observes initial movement/no-motion. | It exits goal helper after acceptance; no Nav2 result, arrival, abort, or persistent cancellation state reaches app. |
| Typed and activated voice commands share command path. | Prompt vocabulary is a duplicate stale file; speech sidecar was unavailable at review time. |
| Confirmation modal and visible emergency stop exist. | Confirmation is client-only. Mutating routes have no operator authentication, server binds 0.0.0.0, and CORS defaults to wildcard/private-network access. |
| Existing unit coverage covers many isolated mapping/waypoint functions. | Full Node baseline had 9 failures and a map-origin route test writes a fixture into real ignored runtime cache. |

## 9. UX findings

| Severity | Finding and evidence | Specific change |
| --- | --- | --- |
| Critical | Green "Nav2 ready" can coexist with incompatible map/localizer/waypoint generations. <code>deriveNavigationStatus()</code> returns readiness before active dispatch state at <code>lib/dogzilla-navigation-status.mjs:30-42</code>. | Show one blocking Map integrity card with active id, artifact hashes, localization backend/artifact, origin identity, and waypoint compatibility. |
| Critical | Map This Floor says it stops at safe reachable edges, but current system has only 2D LiDAR frontier clearance. | Say "supervised bounded-area mapping"; require stair-free setup and physical barriers. Do not imply drop-off protection. |
| High | Start/Finish/Promote state lives in <code>autonomousMappingActive</code> browser booleans. | Render Pi-owned job status with running, paused, saving, candidate-ready, failed, and restored states; survive reload. |
| High | User sees accepted/navigating without arrival, abort, or cancellation result. | Bind commandId feedback to UI and show localizing, planning, moving, arrived, cancelled, failed. |
| High | UI readiness counts confuse 14 navigable entries with 6 ready verified waypoints; off-map entries remain green. | Show "6 usable now, 2 out of bounds, 8 unverified" and disable unsafe actions. |
| Medium | Static/latched map looks failed after five seconds because <code>formatMapStatusPayload()</code> treats every old update stale. | Label saved static map as "loaded [timestamp]"; reserve freshness only for mapping stream. |
| Medium | Rendered app showed grid visible while workflow said "No occupancy grid loaded." | Derive workflow status from same normalized map payload as canvas, never a separate mode guess. |
| Medium | Speech panel may show sidecar error plus configured ready preview. | One source-of-truth status: unavailable, connecting, listening, transcribing, or ready. |
| Medium | Desktop has nested scrolling, unused chat space, crowded lower right map controls, and overlapping labels; mobile buries mapping below chat/speech. | Put active robot task/status first, make mapping a primary mobile action, collapse advanced diagnostics, and declutter labels at low zoom. |
| Medium | Save Spot silently overwrites normalized duplicate name; no edit/delete lifecycle. | Add explicit overwrite confirmation plus rename/delete controls with current map compatibility shown. |

## 10. Reliability and synchronization findings

| Severity | Current behavior | Failure mode | Required correction |
| --- | --- | --- | --- |
| Critical | Active aliases, metadata, Cartographer fallback, map_server parameter, waypoints, and origin are independent. | Silent map-version split and physical drift. | Single atomic active-map manifest and coherence gate. |
| Critical | Test route omits temporary origin file and writes x=1/y=2/yaw=.5 to ignored application cache. | Tests contaminate later runtime/localization behavior. | Inject temp origin path in every route test; assert production cache untouched. |
| Critical | Mutable control routes are unauthenticated and CORS wildcarded. | Any reachable page/client can trigger mapping, motion, restart, or waypoint write. | Require operator token on mutations; restrict allowed origins/private-network header. |
| High | Promotion copies files then restarts services. | Partial activation or failed restart can leave inconsistent aliases. | Stage, validate, atomically switch manifest, restart, verify, rollback on failure. |
| High | Explorer cancellation calls <code>cancel_goal_async()</code> without awaiting completion. | Finish may save while a Nav2 frontier goal remains active. | Wait for cancel acknowledgement and zero active goal before save/restore. |
| High | Bridge goal helper returns after acceptance; monitor only proves initial movement. | UI cannot distinguish arrived, aborted, stuck after moving, or cancelled. | Keep worker client alive until action result; publish command lifecycle. |
| High | Current status returns "Nav2 ready" before checking navigating dispatch. | Operator receives contradictory ready/active states. | Resolve active command state before generic readiness. |
| Medium | Mapping explorer has no job lock or persisted owner. | Duplicate processes and ambiguous stop semantics. | One lock/PID/job id owned by Pi. |
| Medium | Duplicate prompt waypoint file drifts from registry. | LLM and compiler disagree about valid destinations. | Derive prompt vocabulary from verified active registry. |
| Medium | App origin identity is optional at capture and restore. | An origin can look valid while bound to no map. | Require map id/fingerprint for map-derived origin; otherwise report unconfigured. |

## 11. Phased implementation plan

No new service or dependency is required. Reuse current Pi scripts, direct bridge, Node routes, and static UI.

| Phase | Current behavior and problem | Proposed change | Files/systems | Test and acceptance criteria |
| --- | --- | --- | --- | --- |
| P0 - map integrity and safety | YAML/PGM, pbstream, origin, and waypoint fingerprints can differ while readiness is green. Scanner promotion writes occupancy files only. Tests alter production cache. Mutating endpoints are open. | Add one internal active-map manifest: id, backend, YAML/PGM/localization artifact paths and SHA-256, resolution, origin, dimensions, thresholds, creation source. Stage generations internally; atomically switch one manifest pointer only after validation. Remove newest-pbstream fallback. Reject scanner YAML/PGM-only activation unless a validated matching localization backend is in its manifest. Block waypoint dispatch on any mismatch. Require auth on mutating routes and allowlisted CORS. | <code>sidecars/dogzilla_map_pose/start-map-pose-in-container.sh</code>, save/promote scripts, <code>scripts/promote-latest-slam-map.ps1</code>, <code>sidecars/dogzilla_lib_bridge/map_metadata.py</code>, <code>server.py</code>, <code>lib/dogzilla-map-metadata.mjs</code>, <code>lib/robot-sidecar-client.mjs</code>, <code>server.mjs</code>, map-origin route tests. | Unit: missing/hash-mismatched artifact blocks startup and dispatch. Integration: rollback preserves prior active generation after forced restart failure. Security: unauthenticated mutation is rejected. Live: health reports one coherent generation before a goal can be accepted. |
| P1 - stable waypoint registry | Waypoints use app_map plus historical origins; identity/off-map are advisory; name writes overwrite. Prompt names are duplicate. | Store final <code>map</code> pose, yaw, map id/fingerprint, capture timestamp, label, aliases, and verified flag. Existing old-generation entries become stale, never converted silently. Capture Kitchen from current robot pose. Add overwrite confirmation, rename, delete, aliases, exact/unique partial matching, and derived prompt vocabulary. | <code>config/robot-waypoints.json</code>, <code>lib/http-dogzilla-routes.mjs</code>, <code>lib/dogzilla-map-frame.mjs</code>, <code>lib/robot-command-compiler.mjs</code>, <code>lib/app-service.mjs</code>, <code>public/index.html</code>, <code>public/app.js</code>, <code>config/valid-waypoints.txt</code> removal/replacement. | Unit: stale/missing fingerprint and off-map pose cannot dispatch; alias/ambiguous/unknown names do not produce coordinates. UI: duplicate requires confirmation, delete/rename persist. Live: create Kitchen, reboot app/Pi, confirm identical map-frame pose remains. |
| P2 - recoverable Map This Floor job | Explorer has a status file but no UI route; browser booleans lose state; no lock/pause/retry/rollback. | Make Pi status file a server-owned job record with job id, PID, state, goal count, candidate id, failure, timestamps. Add start/status/pause/resume/finish/discard routes. Enforce one job, await goal cancellation, recover status after reload, and expose candidate preview. Promotion validates/restarts/rolls back. Keep only "Active Map" user-facing; candidates are temporary recovery artifacts. | <code>frontier_explorer.py</code>, start/finish/promote scripts, <code>lib/dogzilla-connection-center.mjs</code>, <code>lib/http-dogzilla-routes.mjs</code>, <code>public/app.js</code>, <code>public/index.html</code>, map CSS, mapping tests. | Unit: lock, transitions, cancellation acknowledgement, status parsing. Integration: reload during mapping restores Finish; duplicate start rejected; forced restart failure rolls back. Manual: supervised stair-free mapping creates one reviewable candidate and restores normal navigation. |
| P3 - end-to-end Nav2 feedback | Docker rclpy worker returns after acceptance. UI real-target feedback polling is effectively Isaac-only; navigation status precedence is wrong. | Keep same bridge worker alive through <code>NavigateToPose</code> result and update same commandId. Expose accepted, planning, moving, succeeded, cancelled, aborted, and timeout through <code>/feedback</code> and <code>/api/robot/feedback</code>. Poll it for DOGZILLA, then make command state override generic readiness. | <code>sidecars/dogzilla_lib_bridge/nav2_client.py</code>, <code>server.py</code>, <code>lib/robot-sidecar-client.mjs</code>, <code>lib/http-runtime-routes.mjs</code>, <code>server.mjs</code>, <code>lib/dogzilla-navigation-status.mjs</code>, <code>public/app.js</code>. | Unit: result lifecycle maps correctly; cancellation/abort remain terminal. Integration: feedback commandId survives refresh and UI shows final state. Live: goal acceptance, physical gait, Nav2 success, and final tolerance evidence are distinct records. |
| P4 - physical acceptance and UX polish | No physical completion/repeatability proof; labels imply more than telemetry proves. | Validate in bounded level test area, then simplify status language and layout around actual job/goal states. | Operator UI files, QA checklist, Pi deployment scripts. | Two fresh map cycles; reboot persistence; Kitchen capture; five typed and five activated-voice runs from varied starts; each reports same active map id and true final outcome. Measure final physical position against fixed floor mark within configured tolerance before claiming repeatability. |

## 12. Required interface and data contracts

### Active map manifest

~~~json
{
  "schemaVersion": 1,
  "id": "generation-id",
  "backend": "cartographer",
  "artifacts": {
    "yaml": { "path": "maps/generation/map.yaml", "sha256": "..." },
    "pgm": { "path": "maps/generation/map.pgm", "sha256": "..." },
    "localization": { "kind": "pbstream", "path": "maps/generation/map.pbstream", "sha256": "..." }
  },
  "resolution": 0.05,
  "origin": [-1.5662, -8.3426, 0],
  "widthCells": 304,
  "heightCells": 364,
  "thresholds": { "negate": 0, "occupied": 0.65, "free": 0.196 }
}
~~~

This is an internal activation record, not a user-visible map library. UI exposes only current active map and, during an unfinished mapping job, one candidate preview/discard decision.

### Waypoint

~~~json
{
  "kind": "map_pose",
  "frame": "map",
  "x": 1.93918,
  "y": 3.90034,
  "yaw": -0.65166,
  "mapId": "generation-id",
  "mapFingerprint": "active-manifest-fingerprint",
  "label": "Kitchen",
  "aliases": ["kitchen"],
  "verified": true,
  "capturedAt": "..."
}
~~~

No app_map origin transform belongs in the final navigation contract. A map replacement invalidates old map-frame waypoints unless an explicit, separately validated migration is performed.

### Mapping job and navigation result

Job state must be persisted on Pi and include <code>jobId</code>, <code>state</code>, <code>startedAt</code>, <code>updatedAt</code>, <code>goalCount</code>, <code>activeGoalId</code>, <code>candidateId</code>, and <code>error</code>. Navigation feedback must include <code>commandId</code>, map id/fingerprint, waypoint id, action status, final result code, and timestamps.

## 13. Specific change index

| Concern | Current source of truth / interface | Change target |
| --- | --- | --- |
| UI map workflow | <code>public/index.html</code>, <code>public/app.js</code>, <code>public/operator-status.js</code>, <code>public/robot-map.js</code> | Persisted mapping job, coherent map card, accurate static-map freshness, waypoint lifecycle, real navigation result. |
| App routes | <code>/api/dogzilla/connection/action</code>, <code>/api/dogzilla/waypoints</code>, <code>/api/chat</code>, <code>/api/chat/result</code>, <code>/api/robot/feedback</code> | Add authenticated map-job/status/candidate endpoints; make waypoint operation version-safe; return command lifecycle. |
| Map creation/promotion | <code>scripts/start-dogzilla-autonomous-mapping-ssh.ps1</code>, <code>finish-dogzilla-autonomous-mapping-ssh.ps1</code>, <code>promote-dogzilla-map-candidate-ssh.ps1</code>, <code>save-map-pose-in-container.sh</code>, <code>promote-candidate-map-in-container.sh</code> | Manifest staging, lock, atomic switch, restart validation, rollback. |
| Localization / Nav2 | <code>start-map-pose-in-container.sh</code>, <code>robodoge_nav2_navigation_launch.py</code>, <code>start-navigation-in-container.sh</code> | Read same manifest; remove arbitrary pbstream fallback; report active artifact to health. |
| ROS nodes/interfaces | <code>frontier_explorer.py</code>, <code>nav2_client.py</code>, direct bridge <code>server.py</code>; topics <code>/map_cartographer</code>, <code>/scan_nav2</code>, <code>/odom</code>, TF <code>map -> base_link</code>; action <code>navigate_to_pose</code>; service <code>/write_state</code> | Job ownership/cancel acknowledgement and long-lived action result worker. |
| Commands | <code>app-service.mjs</code>, <code>robot-command-compiler.mjs</code>, <code>robot-sidecar-client.mjs</code>, <code>config/robot-waypoints.json</code> | One version-bound registry and deterministic names/aliases. |
| Security | <code>server.mjs:77,812-822</code> | Token-check mutations, CORS/origin policy, explicit remote operator configuration. |
| Tests | <code>test/http-dogzilla-routes-map-origin.test.mjs</code>, mapping/waypoint/navigation tests, <code>sidecars/dogzilla_navigation/test_frontier_explorer.py</code> | Isolate cache and add coherency/job/result/auth coverage. |

## 14. Automated test plan

| ID | Test | Expected result |
| --- | --- | --- |
| MAP-1 | Valid manifest with matching YAML/PGM/pbstream hashes. | Localization and map_server start against same generation. |
| MAP-2 | Missing pbstream, hash mismatch, or scanner YAML/PGM-only generation selected. | Activation and waypoint dispatch block with explicit integrity reason. |
| MAP-3 | Force Nav2 restart validation failure during promote. | Prior manifest remains active or is restored; user sees rollback failure detail. |
| MAP-4 | Run map-origin route test. | Only temporary origin file changes; real ignored cache remains untouched. |
| WP-1 | Capture Kitchen under active map. | Stores map-frame pose with active id/fingerprint. |
| WP-2 | Dispatch stale, missing-identity, and off-map waypoint. | Compiler/route rejects before bridge goal request. |
| WP-3 | Exact alias, unique partial, ambiguous, unknown command. | Correct identifier, clarification, clarification, no dispatch respectively. |
| JOB-1 | Start twice, reload UI, pause/resume, finish, stale scan, and timeout. | One job only; state remains recoverable; goal cancellation acknowledged. |
| NAV-1 | Simulated Nav2 accepted/succeeded/cancelled/aborted feedback. | Same commandId reaches API/UI as correct terminal state. |
| NAV-2 | Active dispatch plus healthy Nav2. | UI reports navigation state, not generic "Nav2 ready". |
| SEC-1 | Cross-origin/unauthenticated mutation request. | Rejected; authenticated supported client remains functional. |
| UI-1 | Static saved map older than five seconds. | Shows loaded timestamp, not failed/stale live-grid warning. |

## 15. Manual and physical test plan

1. Put robot in a bounded, level, stair-free area with physical barriers and an operator holding emergency stop.
2. Verify active-map manifest, map_server YAML, Cartographer artifact, origin identity, and waypoint registry fingerprint all match before moving.
3. Run Map This Floor. Reload browser during exploration, confirm persisted state, pause/resume once, then finish. Confirm candidate preview and restore of prior active map.
4. Promote candidate. Verify rollback path in a controlled forced-failure test before relying on it. Confirm Nav2 and Cartographer report same generation after normal promote.
5. Drive to Kitchen reference mark, capture Kitchen, restart app and Pi, then verify saved map-frame pose and fingerprint remain unchanged.
6. From at least three starting positions, issue five typed and five activated-voice "go to the kitchen" commands. For each, record commandId, active map id, Nav2 result, observed gait, final pose, and tape-measured location.
7. Accept repeatability only when every run reaches configured tolerance of the same physical mark and operator confirms no unsafe behavior. A 202 Accepted response or initial movement alone is not arrival proof.

## Current verification baseline

- Live probe at approximately 2026-07-10 20:32 UTC: direct bridge/Nav2/scan/odom/lifecycle reported ready, while map coherence evidence above was incompatible.
- Live SSH confirmed <code>/map_server</code> YAML and old Cartographer pbstream split.
- Yahboom mapping/navigation PDFs were text-extracted and visually inspected at relevant pages.
- Focused mapping, connection-plan, waypoint compiler/validator, and navigation-status tests passed earlier in this review session. Frontier Python tests reported 2 passed; Python syntax and autonomous-mapping PowerShell parse checks passed.
- Broader Node baseline: 345 passed, 9 failed. Four old LiDAR-client tests still expect removed HTTP scan/pose URLs; four map-pose-capture tests expect map identity fields no longer emitted; one ANSI banner expectation is environment-sensitive. Without forced process exit, a LiDAR test leaves reconnect handles open.
- Physical mapping, candidate promotion, voice completion, and repeatable arrival were not executed. Treat them as Unknown / not confirmed.
