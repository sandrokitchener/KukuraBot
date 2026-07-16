# Questing Beast Dashboard UI Rework Implementation Plan

Status: Implemented on `ui-rework`; verification complete
Branch: `ui-rework`
Design source: `design/ui-rework-concept.html`
Scope: Replace the live dashboard presentation while preserving the current command, safety, robot, map, camera, speech, diagnostics, and Android flows.

## Outcome

The shared `public/` frontend becomes the approved premium operator console:

- a fixed, full-height black navigation rail;
- a light command and interaction column on the left;
- a light robot state and visualization column on the right;
- the live map as the dominant visual element;
- camera reuse of the same visualization slot;
- black, white, warm neutral, and orange visual tokens;
- operator-facing state in the workspace and developer detail in Diagnostics.

This is a frontend migration. It does not require a new API, backend workflow, ROS/Nav2 behavior, dependency, or Pi-side deployment.

## Non-negotiable behavior contracts

Implementation must preserve the existing DOM IDs and event-handler ownership wherever possible. Existing nodes should be moved and restyled, not copied.

The following behavior is locked:

- `handleChatSubmit()` remains the command submission and conversation owner.
- `#persistent-emergency-stop` stays continuously visible, state-aware, and fail-safe.
- Manual/gamepad controls stay continuously visible in the left workspace. Neutral, pointer-loss, visibility-change, and disconnect behavior must not change.
- `renderRobotStateSnapshot()` remains the source for battery, task, connection freshness, navigation state, pose trust, waypoints, and robot marker updates.
- `applyRobotView()` remains the only Map/Camera visualization switch. Camera must replace the map in the same slot and hide map workflow controls.
- `applyAutonomousMappingState()` and `updateAutonomousMappingButtons()` remain authoritative for mapping action availability.
- `setSpeechStatus()` and `updateSpeechPreview()` continue to drive voice readiness and the live transcript below conversation history.
- Existing camera refresh, recovery, YOLO, snapshot, and gallery actions remain unchanged.
- Existing Settings, Help, Diagnostics, snapshot gallery, and confirmation modal behavior remains intact.
- Android keeps the existing `robot`, `chat`, and `audio` mobile-view contracts in `public/mobile-navigation.js`.
- Do not display a planned route or historical pose path. Keep the current robot pose marker, scan, map layers, and waypoints; hide `#robot-map-track` in the redesigned operator view without adding replacement path logic.
- No duplicated save, relocalize, navigation, snapshot, or mapping actions are introduced.

## Information architecture and destination mapping

### Fixed navigation rail

| Rail destination | Existing behavior it exposes |
| --- | --- |
| Console | Focus the command input and left interaction workspace. |
| Map | Select the existing overview/map view and focus the primary viewport. |
| Camera | Select the existing Camera view through `applyRobotView()`. |
| Waypoints | Select the overview/map view and activate the Waypoints controls tab. |
| Saved shots | Open `#recon-gallery-drawer` with the existing snapshot data and handlers. |
| Log history | Focus the existing conversation/history log; no new persistence layer. |
| CPU status | Open Diagnostics at the existing Pi performance section, relabeled CPU status; do not run a probe automatically. |

Settings, Help, and general Diagnostics remain utility actions. The implementation may place them at the bottom of the rail or in the compact top utility bar, but must reuse their current buttons and drawers.

### Left command and interaction column

Order:

1. Robot identity header and live/connection state.
2. Natural-language command input.
3. Orange primary Send Command button.
4. Persistent Emergency Stop action.
5. Persistent manual/gamepad controls.
6. Execution timeline.
7. Conversation/history log.
8. Voice readiness and current live transcript.

The left column remains a light surface. Only the far-left navigation rail is black.

### Right robot and visualization column

Order:

1. Compact state header: battery, current task, trusted pose/readout, and connection freshness.
2. Large map viewport as the default and primary focus.
3. Existing camera viewport in the exact same slot when Camera is selected.
4. Mapping, Navigation, and Waypoints tabs below the viewport.

Raw parsed JSON and expanded Nav2-chain details move to Diagnostics. Operator-facing blockers and readiness summaries remain visible in the main workspace.

## Implementation phases

### Phase 1 - Lock structural and safety contracts

Files:

- `test/android-web-parity.test.mjs`
- `test/frontend-modules.test.mjs`

Work:

- Replace layout-specific assertions that describe the old shell with assertions for the new rail, two-column workspace, shared map/camera viewport, and tab panels.
- Retain assertions for all safety-critical IDs and handlers before moving markup.
- Add assertions that the emergency stop and manual controls are in the left command column.
- Add assertions that speech readiness and transcript follow conversation history.
- Add assertions that map controls are below the viewport and hidden in Camera view.
- Add assertions that the old and new layouts do not contain duplicate action IDs.
- Add a focused unit test for execution-timeline state derivation if a pure helper is required.

Exit gate:

- Tests describe the new structure while still protecting all existing behavior contracts.
- No live layout has changed yet.

### Phase 2 - Rebuild the shared HTML shell by moving existing nodes

File:

- `public/index.html`

Work:

- Replace `.app-header`, `.control-rail`, `.command-zone`, and the current robot-column arrangement with semantic rail, utility header, command column, and robot column containers.
- Move the existing command form, stop button, manual controls, chat log, speech panel, robot state, map, camera, and map workflow nodes into the approved order.
- Keep every existing functional ID used by `public/app.js`.
- Add only the markup that does not already exist:
  - rail destination buttons that route to existing surfaces;
  - execution timeline presentation;
  - Mapping, Navigation, and Waypoints tablist and tab panels.
- Partition the existing map workflow actions without duplicating them:
  - Mapping: Map This Floor, Continue Current Map, Finish Mapping, Use Candidate Map.
  - Navigation: Relocalize on Map and the existing navigation repair action.
  - Waypoints: Save Spot, stale waypoint state, and existing waypoint actions/list where currently rendered.
- Move `#parsed-output` and `#robot-nav-chain-detail` into the Diagnostics drawer.
- Preserve drawers and `#confirm-modal-overlay` outside the main workspace so their overlay behavior does not change.
- Preserve accessible labels, focus order, `aria-live` regions, tab semantics, and minimum 44 px touch targets.

Exit gate:

- Every `document.querySelector()` used by `public/app.js` still resolves once.
- No action exists in more than one location.
- The static DOM order matches the approved information architecture.

### Phase 3 - Replace the visual system in the existing CSS bundle

Files:

- `public/styles/01-shell.css`
- `public/styles/03-panels.css`
- `public/styles/04-robot-map.css`
- `public/styles/05-responsive.css`
- `public/styles/06-operator-status.css`
- `public/styles.css` only if import ordering must change

Work:

- Define shared tokens for ink, paper, panel, borders, muted text, orange, green, red, spacing, radius, typography, and focus treatment.
- Use one macro CSS Grid beside the fixed 88 px rail. The workspace must consume all remaining viewport width.
- Use the approved desktop proportion as the starting point: command column `minmax(330px, 0.72fr)`, robot column `minmax(650px, 1.62fr)`, with 14 px rail/content and inter-column gaps.
- Remove old max-width or centering rules that create empty space between the rail and workspace at wide resolutions.
- Keep the command column dense but readable; do not use black cards for chat, intent, conversation, or transcript.
- Make the visualization viewport the dominant right-column block. Preserve the map renderer's coordinate and aspect-ratio assumptions.
- Style orange only for primary action, active destination, selected tab, and meaningful current state.
- Keep Emergency Stop visually distinct in red and preserve all current `data-state` variants.
- Add explicit hover, keyboard focus, selected, disabled, loading, warning, blocked, and stale states.
- Delete obsolete old-shell rules after the replacement works; do not add a permanent override stylesheet.

Responsive targets:

- Wide desktop, including 2560 px: rail remains attached to the workspace; both columns expand without a dead gutter.
- Standard desktop/laptop: two columns remain readable and the map remains dominant.
- Narrow browser/tablet: main columns stack without horizontal overflow; safety and command actions remain near the top.
- Android shell: existing `data-mobile-view` switching still determines which view is visible; touch controllers remain usable.

Exit gate:

- No horizontal overflow at supported widths.
- The full-screen layout has no unexplained whitespace beside the rail.
- Camera and map occupy the same visual slot.

### Phase 4 - Add the minimum presentation behavior

Files:

- `public/app.js`
- `public/operator-status.js` only if a pure timeline helper is useful
- `public/mobile-navigation.js` only if selectors must be adapted; do not change its view model

Work:

- Bind rail buttons to existing view, drawer, and focus handlers.
- Add one small workflow-tab controller using native button/`hidden` state; tab switching changes presentation only.
- Keep Camera switching routed through the current robot-tab/apply-view path instead of introducing a second camera state.
- Derive the execution timeline from state already available to the client:
  - Intent parsing: request pending, then parsed or failed.
  - Planning: `robotRuntime.canonicalPlan` available, not applicable, or failed.
  - Navigation/execution: active only for applicable commands; use dispatch and `navigationStatus` for accepted, moving, arrived, blocked, cancelled, or failed states.
  - Completion: command completion, non-navigation dispatch completion, or an honest blocked/error state.
- Show Navigation as not applicable for non-navigation commands instead of implying robot motion.
- Re-render the timeline from existing robot feedback updates so an accepted Nav2 goal can progress to arrived/blocked without another command submission.
- Keep mapping-only actions hidden or disabled according to the existing autonomous mapping state. Do not infer applicability from CSS.
- Rename visible `Pi status`/Pi performance wording to `CPU status` where it is a navigation label; retain precise Pi/CPU/thermal terminology inside diagnostic results.

Exit gate:

- No new endpoint or polling loop exists.
- Timeline states never claim navigation or completion without supporting payload/feedback state.
- Existing handler code remains the authority for every robot action.

### Phase 5 - Remove developer clutter from the operator path

Files:

- `public/index.html`
- `public/app.js`
- `public/styles/03-panels.css`
- `public/styles/06-operator-status.css`

Work:

- Keep raw `#parsed-output` available in Diagnostics for development and support.
- Keep expanded Nav-chain component details and repair context in Diagnostics.
- Keep compact operator summaries visible: current task, connection freshness, battery, trusted pose, navigation blocker, and mapping status.
- Remove duplicated labels, metadata, and ornamental status chips that repeat the same state.
- Preserve ROS/Nav2 terminology where it helps an operator act: Nav2, localization, relocalize, occupancy grid, waypoint, and mapping candidate.

Exit gate:

- The main workspace answers: What robot is this? Is it connected? What is it doing? Where is it? What command is running? Is intervention required?
- Raw JSON and component-level repair detail no longer compete with the map.

### Phase 6 - Verification and visual acceptance

Automated checks, run in this order:

```text
node --test test/frontend-modules.test.mjs
node --test test/android-web-parity.test.mjs
npm test
```

Browser verification at narrow, standard desktop, and 2560 px widths:

- rail is fixed, black, and full height;
- the workspace begins 14 px from the rail and fills remaining width;
- two desktop columns have a 14 px gap and do not bunch together;
- no horizontal overflow or large dead gutter exists;
- map is the right-column focal point and continues to render pose, scan, layers, and waypoints;
- no route/path visualization was added;
- Camera replaces the map in the same viewport and hides Mapping/Navigation/Waypoints controls;
- Mapping actions appear or enable only when the existing state says they apply;
- command submit, response history, parsed diagnostics, and error states still update;
- timeline progresses truthfully for navigation and non-navigation commands;
- speech readiness and live transcript continue updating below chat;
- Emergency Stop is always reachable and its unknown/stopped/running states remain distinct;
- gamepad enable, movement readouts, speed, Neutral, and loss-of-input safety still work;
- all rail destinations, drawers, tabs, settings, help, and confirmation modal work by keyboard and pointer;
- browser console has no errors.

Packaged-shell checks:

- Electron loads the same shared frontend without missing assets or overflow.
- Android retains `robot`, `chat`, and `audio` navigation and usable touch controls.
- A desktop browser pass proves the shared frontend only. Android launch, touch, and neutral-stop behavior require separate device proof before claiming device parity.

## Recommended implementation sequence

Use small checkpoints so the live app is never left in a half-wired state:

1. Tests and structural contract.
2. HTML shell and node movement.
3. Desktop layout and map/camera slot.
4. Rail and workflow tab behavior.
5. Execution timeline.
6. Diagnostics cleanup.
7. Responsive and Android CSS.
8. Full automated and visual verification.

Each checkpoint should remain reviewable on `ui-rework`. Do not mix unrelated robot, Nav2, backend, or Pi changes into this UI work.

## Expected changed files

Primary:

- `public/index.html`
- `public/app.js`
- `public/styles/01-shell.css`
- `public/styles/03-panels.css`
- `public/styles/04-robot-map.css`
- `public/styles/05-responsive.css`
- `public/styles/06-operator-status.css`
- `test/android-web-parity.test.mjs`
- `test/frontend-modules.test.mjs`

Conditional:

- `public/operator-status.js` for a pure, tested timeline state helper.
- `public/mobile-navigation.js` only for selector compatibility.
- `docs/ARCHITECTURE.md` after implementation, with a short durable description of the new operator layout.

## Explicit non-goals

- No backend or API redesign.
- No new voice capture or tap-to-speak control.
- No path planning visualization or historical route display.
- No new log persistence, camera feature, waypoint feature, mapping feature, or robot command.
- No duplicate action controls.
- No new frontend framework, icon library, CSS framework, or dependency.
- No Pi deployment for the frontend-only change.

## Completion definition

The rework is complete when the approved visual hierarchy is present in the live shared frontend, all existing operator flows still work, automated tests pass, desktop visual checks pass at all target widths, no developer clutter competes with the map, and any unverified packaged-device behavior is reported separately instead of assumed.
