# Map This Floor: Focused Friction Fixes

## Goal

Make the normal workflow:

1. Click **Map This Floor**.
2. Watch the robot map.
3. Review the completed map and click **Use New Map**.

Keep the existing supervisor, health polling, candidate storage, promotion backups, and safety gates. Do not add a job system or another mapping workflow.

## What already works

- The Pi prevents duplicate mapping jobs.
- Frontier exploration can finish automatically.
- Automatic completion saves a candidate only after verified movement.
- The active map is preserved until candidate promotion.
- Promotion verifies hashes and backs up the current map.
- Battery and emergency-stop gates block actual motion.

Build on those paths instead of replacing them.

## Focused fixes

### 1. Show “Starting” until the Pi is ready

Problem:

[lib/dogzilla-connection-center.mjs](../lib/dogzilla-connection-center.mjs) returns 202 started immediately after launching the background process, while [public/app.js](../public/app.js) immediately presents mapping as active. Health polling can then briefly make the controls look idle before the Pi creates its ready marker.

Fix:

- Treat 202 as **Starting mapping**, not success.
- Keep Map, Continue, and Use Map disabled while startup is pending.
- Change to **Mapping** only when the existing health response reports autonomous mapping active.
- If the Pi reports a terminal failure, show that existing error and restore the controls.
- Use the current health endpoint and status files. Do not add a database, job API, or general state-machine framework.

Files:

- [public/app.js](../public/app.js)
- [sidecars/dogzilla_lib_bridge/server.py](../sidecars/dogzilla_lib_bridge/server.py), only if the existing response does not expose enough terminal detail

### 2. Reuse the existing preflight for fresh maps

Problem:

[scripts/start-dogzilla-autonomous-mapping-ssh.ps1](../scripts/start-dogzilla-autonomous-mapping-ssh.ps1) runs its battery and gait preflight only for **Continue Current Map**. A fresh run can restart mapping services before learning that motion is blocked.

Fix:

- Run the same existing preflight for both start modes.
- Run it before reserving the job or changing Cartographer/Nav2.
- Return the existing battery, gait, or emergency-stop reason directly.
- Keep the runtime motion gate unchanged.

This should be a small control-flow change, not a new preflight service.

### 3. Make automatic completion the normal UI

Problem:

The supervisor already knows when frontier coverage is complete, but **Finish Mapping** looks like a required step.

Fix:

- Rename **Finish Mapping** to **Stop Early**.
- Present it as a secondary action.
- Update the active-mapping message to say the robot will stop and save automatically when coverage is complete.
- When health reports a candidate, show **Map ready to review** and enable **Use New Map**.
- Keep the final rendered SLAM map on screen for review; do not build a candidate browser.

Files:

- [public/index.html](../public/index.html)
- [public/app.js](../public/app.js)

### 4. Do not save an empty early-stop candidate

Problem:

[sidecars/dogzilla_navigation/autonomous_mapping_supervisor.sh](../sidecars/dogzilla_navigation/autonomous_mapping_supervisor.sh) uses motion proof for automatic saves but bypasses it for a manual Finish request.

Fix:

- Require the existing motion proof for both automatic completion and Stop Early.
- If stopped before verified movement, restore localization and report that no candidate was saved.
- Do not add map-quality scoring or another override.

## Minimal tests

Add or adjust focused tests for:

1. A 202 response leaves the UI in Starting until Pi health reports active.
2. Fresh and continued mapping both run preflight before reservation.
3. Stop Early without motion does not create a candidate.
4. Automatic completion still creates a candidate and enables Use New Map.

Run the related connection-center, frontend, navigation-script, and frontier-explorer tests. Do not broaden unrelated test cleanup into this task.

Baseline observed during review: 132 of 134 focused JavaScript tests passed. One relevant test still expects mapping start to return ok instead of started; another unrelated Nav2 launcher assertion failed in the existing dirty worktree.

## Live Pi check

After local tests and user approval:

1. Deploy only the changed launcher, supervisor, and bridge files.
2. Restart only affected services.
3. Verify blocked battery or emergency stop prevents service changes.
4. Verify one click reaches active mapping and automatic candidate completion.
5. Verify Stop Early before movement restores localization without a candidate.

## Out of scope

- New job service or database
- Candidate gallery, candidate deletion workflow, or new settings
- New dependencies
- Changes to waypoint coordinates or authority
- Changes to collision, battery, map hash, promotion backup, or localization-trust safeguards
