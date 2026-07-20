# DOGZILLA Reverse and Crab-Walk Motion Research

Research date: 2026-07-19

## Recommendation

Keep reverse as a short Nav2 recovery and, after physical stability testing, enable low-speed lateral velocity in Nav2's existing DWB local controller. Do not add waypoint-specific reverse/crab rules or reuse Yahboom's simple LiDAR avoidance script. DWB already owns obstacle-aware local motion, the velocity smoother already has a Y axis, and the collision monitor already guards the final command stream.

In this document, **reverse** means negative `Twist.linear.x` / negative DOGZILLA X step. **Crab walk** means body-frame lateral motion through `Twist.linear.y` / DOGZILLA Y step without first turning the body.

## Findings

### Yahboom documents both motions as native DOGZILLA controls

- `docs/DOGZILLA-main/07.DOGZILLA control course/01.Basic control.pdf`, page 1, documents `forward`, `back`, `left`, `right`, `turnleft`, `turnright`, and `stop`. It calls left/right motion "translation," not a turn.
- `docs/DOGZILLA-main/07.DOGZILLA control course/02.Gait conditioning.pdf`, pages 1 and 3, documents signed `move('x', step)` and `move('y', step)`: positive X is forward, negative X is backward, positive Y is left, and negative Y is right. The documented ranges are X `[-25, 25]` and Y `[-18, 18]`.
- `docs/DOGZILLA-main/12.ROS robot dog basic control course/4. Keyboard control/keyboard control.pdf`, page 5, exposes forward, stop, back, and in-place turns. This keyboard example does not expose lateral motion.
- `docs/DOGZILLA-main/14.Lidar course/2. Obstacle avoidance.pdf` describes a forward-and-turn obstacle avoider. The matching source on the Pi confirms that it never commands reverse or `linear.y`.

The documentation proves that reverse and lateral translation are supported primitives. It does not provide a safe autonomous policy for deciding when to crab walk.

### The live Pi has the complete low-level path

The following was read from Questing Beast over the repo SSH configuration on 2026-07-19; no movement command was sent.

| Pi component | Evidence | Meaning |
| --- | --- | --- |
| DOGZILLALib 3.1.9 | `/usr/local/lib/python3.11/dist-packages/DOGZILLALib-3.1.9-py3.11.egg` | `back(step)` calls negative `move_x`; `left/right` call signed `move_y`. The installed library actually clamps X to `[-20, 20]`, Y to `[-18, 18]`, and turn to `[-70, 70]`, so its runtime limits are stricter than parts of the PDFs and Robo-Doge config. |
| Yahboom control notebooks | `/home/pi/DOGZILLA/Samples/2_Control/1.basic_control.ipynb` and `2.speed_adjustment.ipynb` | Yahboom supplies explicit backward/left/right controls and independent X/Y sliders. |
| Yahboom phone app | `/home/pi/DOGZILLA/app_dogzilla/app_dogzilla.py` | The joystick sends both `move_x` and `move_y`; direction buttons call `back`, `left`, and `right`. Its default step control produces about X/Y step 10. |
| Yahboom gamepad | `/home/pi/DOGZILLA/app_dogzilla/joystick_dogzilla.py` | Left-stick vertical maps to X and left-stick horizontal maps to Y. Its default scale can produce about step 14. |
| Yahboom ROS base | Container source `/root/yahboomcar_ws/src/yahboom_base/yahboom_base/base.py` | A `Twist` subscriber maps `linear.x` to `move('x', ...)` and `linear.y` to `move('y', ...)`. |
| Yahboom gait node | Container source `/root/yahboomcar_ws/src/yahboom_gait/yahboom_gait/yahboom_gait.py` | The gait subscriber also passes both `linear.x` and `linear.y` to DOGZILLALib. |
| Yahboom LiDAR avoidance | Container source `/root/yahboomcar_ws/src/yahboom_laser/yahboom_laser/laser_Avoidance_xgo_RS200.py` | Every avoidance branch uses positive `linear.x` plus optional `angular.z`; there is no reverse or lateral escape. This is a demo heuristic, not the integration point for Robo-Doge. |

### Robo-Doge already carries the commands, but autonomous lateral motion is intentionally blocked

| Robo-Doge layer | Reverse today | Crab walk today |
| --- | --- | --- |
| Manual touch/gamepad | Negative X is supported. | UI and compiler support `strafe`, but the direct bridge caps explicit manual Y step to `1`. |
| Direct bridge | `_execute_locomotion()` sends signed X/Y to `robot.move()`. | Non-manual Y step is clamped to `0` by default. |
| Nav2 gait adapter | Signed X is scaled symmetrically, so a negative `linear.x` reaches DOGZILLALib. | It reads `linear.y` but hard-codes `y_step = 0.0`. Live `/nav2/speed_config` reports `maxYStep: 0.0`. |
| Normal Nav2 path following | Live DWB config has `min_vel_x: 0.0`, so normal trajectories are forward-only. | Startup hard-codes Y velocity and acceleration to zero and `vy_samples` to `1`. The live generated params confirm `min_vel_y/max_vel_y: 0`, and the velocity smoother also has zero Y limits. |
| Nav2 recovery | `robodoge_navigate_to_pose_corner_recovery.xml` already tries `BackUp` for `0.20 m` at `0.13 m/s` after path following fails, before clearing/replanning and spinning. | No lateral recovery behavior exists. |
| Final safety gate | The lifecycle-managed collision monitor guards negative and positive commands alike. Its current stop polygon reaches X `+0.35/-0.25 m` and Y `+/-0.20 m`. | Same gate, but lateral leg sweep and the side clearance have not been physically validated. |

This block was deliberate. Repository history records that an earlier autonomous configuration used `maxYStep: 3`; the first physical holonomic test made DOGZILLA fall. The current motion config also records repeated falls during sustained crab walking. The manual step-1 exception is the only retained lateral path.

Two additional details would break a partial implementation:

- The live Nav2 params inherit `controller_server.min_y_velocity_threshold: 0.5`. That must be reduced with the lateral velocity limits or small Y commands will be discarded.
- `sidecars/dogzilla_navigation/README.md` still describes a default Nav2 Y step of `3` and optional autonomous trot. Current code hard-disables both; update that file when implementation begins.

### Current live test blocker

At research time the Pi services were active, but `/healthz-lite` reported `localizationTrusted: false`, `waypointReady: false`, and a frozen-map global-localization timeout. Battery was 25%. Autonomous reverse/crab testing must wait for trusted localization and ordinary forward waypoint navigation to work again.

## Where each motion belongs

### Reverse

Reverse belongs in the existing Nav2 behavior tree as a bounded recovery after `FollowPath` fails. The current `BackUp` node is the correct owner because it uses Nav2's behavior server, local costmap, velocity smoother, collision monitor, stale-command stop, and gait adapter. Keep DWB normal path following forward-only initially; do not make every route freely sample reverse until the existing 0.20 m recovery is physically proven.

Useful cases are backing out of a corner, creating turning room after a blocked approach, and escaping a failed forward trajectory. It should not be dispatched from the waypoint compiler or a raw LiDAR callback.

### Crab walk

After stability is proven, crab motion belongs in DWB's local trajectory sampling (`min_vel_y`, `max_vel_y`, `acc_lim_y`, and `vy_samples`). DWB can then choose a small lateral correction when it scores better against the local costmap, such as:

- shifting around a close obstacle without spending space on an in-place turn;
- correcting lateral path error in a doorway or narrow corridor;
- moving off a wall or corner after the reverse recovery creates room; or
- aligning position while preserving body heading when a future task requires a meaningful final yaw.

Do not add application-level rules such as "if obstacle, move left." They would duplicate the local planner and lack trajectory scoring. Do not add charger-specific strafing until a charger/dock perception and alignment contract exists.

## Implementation plan

### Gate 0 - restore the known-good baseline

1. Restore trusted Cartographer localization and prove one normal forward waypoint route.
2. Confirm the exact command chain remains `/cmd_vel_nav` -> velocity smoother -> `/cmd_vel_raw` -> collision monitor -> `/cmd_vel` -> gait adapter -> direct bridge.
3. Test only on a level, high-traction floor with a charged battery, clear emergency-stop access, and a person ready to catch the robot.

Exit gate: trusted localization, `waypointReady: true`, no unexplained gait stop, and a repeatable forward route.

### Gate 1 - calibrate hardware without changing autonomous planning

Use the existing manual-control/direct-bridge path with an explicit `walk/slow` command; do not enable DWB Y sampling yet.

1. Verify signs with short `walk/slow` pulses: negative X backs up, positive Y moves left, negative Y moves right.
2. Start at Y step `1`, test both directions, and increase only one step at a time. Record lateral displacement, unintended yaw, foot slip, body roll, fall/near-fall, and Cartographer pose response.
3. Run both a short pulse test and the existing five-foot sustained stability test. Stop at the first unstable value; that result becomes the hard autonomous Y-step ceiling.
4. Repeat the existing reverse recovery at conservative X steps through the final chain. Confirm the rear collision stop before trusting the 0.20 m `BackUp` action.
5. Place obstacles on each side and verify the collision monitor stops motion before the body or leg sweep can contact them. Measure the real moving footprint rather than assuming the current `+/-0.20 m` side polygon is sufficient.

Exit gate: stable left/right travel, stable short reverse, correct odom/TF direction, and collision stops for the commanded direction. If step `1` is not stable for five feet, keep autonomous crab disabled.

### Gate 2 - enable the minimum end-to-end lateral path

1. Add calibrated lateral velocity, acceleration, sample-count, Y-threshold, and gait max-Y-step values to `config/robot-obstacle-avoidance.json`; keep zero as the rollback value.
2. In `sidecars/dogzilla_navigation/start-navigation-in-container.sh`, feed those values into DWB and the velocity smoother, including a low `min_y_velocity_threshold`. Keep `min_vel_x: 0` so normal path following remains forward-only.
3. In `sidecars/dogzilla_lib_bridge/server.py`, load that same canonical gait max-Y-step at process startup into the existing speed config. Keep `POST /nav2/speed_config` immutable so a LAN caller cannot raise the hardware limit at runtime.
4. In `sidecars/dogzilla_lib_bridge/nav2_gait_adapter.py`, scale `linear.y` exactly as X is scaled, but clamp it to the physically verified hard ceiling. Keep `walk/slow` and the existing deadband.
5. In `sidecars/dogzilla_lib_bridge/server.py`, allow source `nav2_cmd_vel` to use that already-calibrated Nav2 Y ceiling while leaving other non-manual relative commands at zero. Reuse the existing speed config instead of adding another independent limit.
6. Keep the collision monitor, stale-command stop, battery gate, emergency stop, command preemption, and exact topic ownership unchanged.
7. Update focused tests for adapter Y scaling, direct-bridge source-specific clamping, immutable runtime config, canonical config propagation, and generated DWB/smoother Y limits. Correct the stale navigation README in the same change.

Rollback: set the canonical lateral velocity/acceleration and max Y step back to zero, regenerate the Nav2 params, and restart only `robodoge-navigation.service` plus the direct bridge if its adapter config changed.

### Gate 3 - validate planner behavior before general use

1. In open space, send a route with lateral path error and confirm the sequence at `/cmd_vel_nav`, `/cmd_vel_raw`, `/cmd_vel`, and the bridge command log.
2. Test left and right doorway offsets, a blocked forward corner, and an obstacle beside the robot. Require no oscillation between turn and strafe.
3. Verify that the reverse recovery still runs only after `FollowPath` failure and that DWB never samples normal reverse.
4. Repeat routes with the robot facing both directions so sign errors cannot hide behind one map orientation.
5. Run the full Node and Python verification suites, deploy only the changed Pi files, restart only affected services, and re-check live health/readiness.

Exit gate: repeatable completion in both lateral directions, no falls or near-falls, no side/rear contact, correct localization, and a clean zero-value rollback test.

## Expected first implementation scope

The smallest credible implementation is four code/config files plus their existing tests:

- `config/robot-obstacle-avoidance.json`
- `sidecars/dogzilla_navigation/start-navigation-in-container.sh`
- `sidecars/dogzilla_lib_bridge/nav2_gait_adapter.py`
- `sidecars/dogzilla_lib_bridge/server.py`

No new ROS node, planner, dependency, or application command type is needed. A custom lateral recovery behavior should be considered only if low-speed DWB strafing is stable but global holonomic sampling causes unacceptable route oscillation.
