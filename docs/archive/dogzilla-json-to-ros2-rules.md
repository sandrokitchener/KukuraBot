<!-- Archive detail doc. Do not read by default. Current summary lives in docs/ARCHITECTURE.md. -->

# DOGZILLA JSON to ROS2 Rules

## Purpose

This document defines a safe, explicit translation layer between our app's LLM JSON and ROS2 control for the Yahboom DOGZILLA robot.

Goal:

- keep prompt/model logic simple
- keep robot-control logic deterministic
- base the hardware adapter on DOGZILLA surfaces that are actually documented
- avoid depending on undocumented Yahboom ROS2 internals when we can own the contract ourselves

This is a rules document, not a final implementation spec. It is meant to guide the ROS2 bridge we add next.

## Source Summary

The upstream DOGZILLA repo is mostly tutorial PDFs rather than source code:

- Repo root: [YahboomTechnology/DOGZILLA](https://github.com/YahboomTechnology/DOGZILLA)
- README: <https://github.com/YahboomTechnology/DOGZILLA/blob/main/README.md>
- Basic control docs: <https://github.com/YahboomTechnology/DOGZILLA/tree/main/07.DOGZILLA%20control%20course>
- ROS2 basic control docs: <https://github.com/YahboomTechnology/DOGZILLA/tree/main/12.ROS%20robot%20dog%20basic%20control%20course>
- IK / body control docs: <https://github.com/YahboomTechnology/DOGZILLA/tree/main/13.ROS%20robot%20dog%20Inverse%20Kinematics%20Control%20Course>
- Developer mode / ROS2 docs: <https://github.com/YahboomTechnology/DOGZILLA/tree/main/09.Developer%20mode>
- Lidar course docs: <https://github.com/YahboomTechnology/DOGZILLA/tree/main/14.Lidar%20course>
- AI LLM course docs: <https://github.com/YahboomTechnology/DOGZILLA/tree/main/16.AI%20LLM%20course>

Important note:

- The repo README says DOGZILLA S1/S2 for Raspberry Pi 5 with ROS2 Humble.
- Some PDFs still mention older ROS2/Foxy or Ubuntu 20.04-era material.
- The Pi 5 tutorials also show `./run_humble.sh`, so the docs are mixed-era.

Because of that, this document distinguishes between:

- `Verified from docs`
- `Recommended bridge contract`
- `Inference`

## Verified From DOGZILLA Docs

### 1. DOGZILLA already has a documented Python control library

The upstream control docs describe these Python-level functions:

- `forward(step)` with step range `[0, 25]`
- `back(step)` with step range `[0, 25]`
- `left(step)` with step range `[0, 18]`
- `right(step)` with step range `[0, 18]`
- `turnleft(step)` with step range `[0, 100]`
- `turnright(step)` with step range `[0, 100]`
- `stop()`
- `move(direction, step)` where:
  - `direction` is one of forward/back or left/right axes
  - X range is `[-25, 25]`
  - Y range is `[-18, 18]`
- `turn(step)` with range `[-100, 100]`
- `pace(mode)` where mode is `normal`, `slow`, or `high`
- `translation(direction, data)` where:
  - X range is `[-35, 35]`
  - Y range is `[-18, 18]`
  - Z / height range is `[75, 115]`
- `attitude(direction, data)` where:
  - roll `r` range is `[-20, 20]`
  - pitch `p` range is `[-15, 15]`
  - yaw `y` range is `[-11, 11]`
- `action(action_id)` where:
  - `1..19` are preset actions
  - `255` resets / restores initial posture
- `perform(mode)` where:
  - `1` starts action loop
  - `0` stops action loop
- `imu(mode)` where:
  - `1` enables stabilization mode
  - `0` disables stabilization mode
- `read_Motor()`
- `read_Battery()`
- `read_roll()`
- `read_pitch()`
- `read_yaw()`

Source docs:

- `07.DOGZILLA control course/01.Basic control.pdf`
- `07.DOGZILLA control course/02.Gait conditioning.pdf`
- `07.DOGZILLA control course/03.Body control.pdf`
- `07.DOGZILLA control course/04.Performing actions.pdf`
- `07.DOGZILLA control course/05.Stabilization mode.pdf`
- `07.DOGZILLA control course/08.Reading data.pdf`

### 2. ROS2 environment exists and movement is driven through standard ROS2 tools

The ROS2 control tutorials consistently show:

- start chassis / bringup
- run `ros2 launch bringup Navigation_bringup.launch.py`
- control movement with `ros2 run teleop_twist_keyboard teleop_twist_keyboard`

This strongly suggests a velocity-command interface inside the DOGZILLA ROS2 stack.

Verified docs:

- `12.ROS robot dog basic control course/4. Keyboard control/keyboard control.pdf`
- `12.ROS robot dog basic control course/1. Trot gait/Trot gait.pdf`
- `12.ROS robot dog basic control course/2. Trot make no headway/Trot stands still.pdf`
- `12.ROS robot dog basic control course/3. Walk gait/Walk gait.pdf`

### 3. Gait control is exposed in ROS2 launch arguments

The docs show:

```bash
ros2 launch yahboom_gait yahboomGaitLaunch.launch.py gait:=trot mark:=0
ros2 launch yahboom_gait yahboomGaitLaunch.launch.py gait:=trot mark:=2
ros2 launch yahboom_gait yahboomGaitLaunch.launch.py gait:=walk mark:=0
```

Verified meaning from docs:

- `gait` selects gait type
- `mark` is stepping amplitude

Source docs:

- `12.ROS robot dog basic control course/1. Trot gait/Trot gait.pdf`
- `12.ROS robot dog basic control course/2. Trot make no headway/Trot stands still.pdf`
- `12.ROS robot dog basic control course/3. Walk gait/Walk gait.pdf`

### 4. Body pose / height / walking speed are also exposed in ROS2 launch arguments

The docs show this launch family:

```bash
ros2 launch yahboom_set_height yahboomSetHeghtLaunch.launch.py xGoHeight:=95 attitude_p:=10 move_x:=0 move_y:=0
```

Verified meaning from docs:

- `xGoHeight` controls body height and ranges `75..115`
- `attitude_p` controls pitch and ranges `-15..15`
- `move_x` controls walking speed and ranges `0..25`
- `move_y` is also accepted by the launch command

Source docs:

- `13.ROS robot dog Inverse Kinematics Control Course/1. Trot gait leaning forward/Trot gait stooped forward.pdf`
- `13.ROS robot dog Inverse Kinematics Control Course/2. Walking height adjustment/walking height adjustment.pdf`
- `13.ROS robot dog Inverse Kinematics Control Course/3. Walking speed adjustment/walking speed adjustment.pdf`
- `13.ROS robot dog Inverse Kinematics Control Course/4. Standing angle adjustment/Standing angle adjustment.pdf`

### 5. Joint / state visibility exists in ROS2

The docs show:

- `rviz2`
- start chassis / joint status nodes
- a tutorial specifically for obtaining robot-dog joint data in ROS2

Source docs:

- `14.Lidar course/Get robot dog joint data.pdf`
- `09.Developer mode/2.Rviz simulation in ros2 environment/Rviz simulation in ros2 environment.pdf`

### 6. Lidar examples use `Twist()` in ROS2 behavior code

The lidar course PDFs show Python snippets that create and publish `Twist()` messages for obstacle avoidance, tracking, guard, and patrol behaviors.

This is evidence that DOGZILLA behavior code in ROS2 is already built around velocity messages, even if the exact topic name is not clearly shown in extracted text.

Source docs:

- `14.Lidar course/2. Obstacle avoidance.pdf`
- `14.Lidar course/3.Lidar Tracking.pdf`
- `14.Lidar course/4.Lidar guard.pdf`
- `14.Lidar course/5. Patrol.pdf`

## Main Design Decision

We should not make our app depend directly on undocumented Yahboom ROS2 topic names or process-launch side effects.

Instead:

1. Our Node app produces deterministic command JSON.
2. A dedicated ROS2 bridge node we own translates that JSON into DOGZILLA operations.
3. That bridge calls documented DOGZILLA Python library functions where possible.
4. Only secondarily should the bridge interact with Yahboom ROS2 launch flows or existing ROS2 topics.

Reason:

- the Python library API is more explicit in the docs than the ROS2 internals
- we control the bridge contract
- we can test the bridge off-robot with fakes
- we avoid shelling out to `ros2 launch ...` per command

## Recommended Architecture

### Layer 1: LLM JSON

Keep the model-facing JSON semantic and small.

Example current schema in this repo:

```json
{
  "command": "move",
  "waypoint": "living_room"
}
```

### Layer 2: Command Compiler

Add a deterministic compiler stage that turns LLM JSON into a canonical robot plan.

Suggested internal shape:

```json
{
  "kind": "locomotion.relative",
  "params": {
    "x_step": 12,
    "y_step": 0,
    "turn_rate": 0,
    "gait": "walk",
    "pace": "normal"
  }
}
```

or:

```json
{
  "kind": "action.once",
  "params": {
    "action_id": 7
  }
}
```

or:

```json
{
  "kind": "pose.body",
  "params": {
    "height": 95,
    "pitch": 10
  }
}
```

### Layer 3: ROS2 Bridge

Implement a `dogzilla_bridge` ROS2 node in Python with `rclpy`.

That bridge should:

- accept our canonical plan
- validate/clamp values to DOGZILLA-safe ranges
- call DOGZILLA Python library functions
- optionally publish standard ROS2 state messages

### Layer 4: Hardware / Existing Yahboom Stack

Under the bridge, use:

- DOGZILLA Python library for chassis/body/action control
- Yahboom bringup stack for the rest of the robot environment
- existing nav / lidar / rviz / joint-state stack where needed

## Rule: Separate Semantic Navigation From Chassis Motion

This repo's current JSON uses semantic `waypoint` names like:

- `living_room`
- `garage`
- `source`
- `current_position`

Those are not direct ROS2 motion commands.

Rule:

- `waypoint` must first resolve to a navigation target or behavior target
- only after that do we choose a ROS2 action

Examples:

- `waypoint = living_room` -> resolve to a known map pose
- `waypoint = current_position` -> no-op location target
- `waypoint = source` -> follow speaker / return-to-source behavior, not raw locomotion

So we need a waypoint registry, for example:

```json
{
  "living_room": { "kind": "map_pose", "frame": "map", "x": 1.2, "y": -0.4, "yaw": 1.57 },
  "garage": { "kind": "map_pose", "frame": "map", "x": -2.3, "y": 0.8, "yaw": 0.0 },
  "source": { "kind": "behavior_target", "behavior": "follow_operator" },
  "current_position": { "kind": "special", "mode": "stay_put" }
}
```

## Recommended Canonical Command Kinds

These are the command kinds our compiler should emit after validating LLM JSON.

### `locomotion.relative`

For direct robot motion.

Fields:

- `x_step` in `[-25, 25]`
- `y_step` in `[-18, 18]`
- `turn_rate` in `[-100, 100]`
- `gait` in `walk | trot`
- `pace` in `slow | normal | high`

Bridge action:

- call `move('x', ...)`, `move('y', ...)`, `turn(...)`, `pace(...)`
- or publish equivalent `Twist` from the bridge if we choose a Twist-facing implementation

### `locomotion.goto`

For semantic navigation to a named waypoint or map pose.

Fields:

- `target_kind` in `waypoint | pose`
- `waypoint` or `pose`
- `arrival_tolerance`

Bridge action:

- if nav stack is present, send a nav goal
- if nav stack is not present, reject instead of improvising with raw chassis motion

Rule:

- never silently convert named room navigation into blind forward walking

### `pose.body`

For body translation / stance / attitude.

Fields:

- `body_x` in `[-35, 35]`
- `body_y` in `[-18, 18]`
- `height` in `[75, 115]`
- `roll` in `[-20, 20]`
- `pitch` in `[-15, 15]`
- `yaw` in `[-11, 11]`

Bridge action:

- call `translation(...)`
- call `attitude(...)`

### `gait.set`

For gait family and stepping amplitude.

Fields:

- `gait` in `walk | trot`
- `mark` numeric stepping amplitude

Bridge action:

- preferred: set gait in long-running bridge state
- compatibility mode: launch or reconfigure `yahboom_gait`

### `action.once`

For one-shot preset tricks / action groups.

Fields:

- `action_id` in `[1, 19]` when verified
- `reset` optional

Bridge action:

- call `action(action_id)`
- if reset requested, call `action(255)`

### `action.loop`

For performance carousel mode.

Fields:

- `enabled` boolean

Bridge action:

- `perform(1)` when enabled
- `perform(0)` when disabled

### `stabilize.set`

For IMU self-stabilization mode.

Fields:

- `enabled` boolean

Bridge action:

- call `imu(1)` or `imu(0)`

### `state.read`

For robot state query / telemetry.

Fields:

- `want_joints`
- `want_battery`
- `want_attitude`

Bridge action:

- call `read_Motor()`
- call `read_Battery()`
- call `read_roll()`, `read_pitch()`, `read_yaw()`

## Rules For Our Existing LLM JSON

Our current prompt/schema is still too small for full DOGZILLA control.

Current commands in this repo:

- `move`
- `detect`
- `trick`
- `follow`
- `talk`

We can still define deterministic compile rules now.

### `move`

Rule:

- if a real waypoint resolves to a known map pose -> emit `locomotion.goto`
- if waypoint is `current_position` -> emit no-op or clarification-required result
- if waypoint is `source` -> emit follow/operator behavior, not direct motion

Gap:

- current `move` JSON does not express direct relative motion like forward / left / rotate
- current `move` JSON also does not express gait, pace, or speed

Recommendation:

- extend `move` with conditional fields in a v2 schema:

```json
{
  "command": "move",
  "mode": "waypoint",
  "waypoint": "living_room"
}
```

or:

```json
{
  "command": "move",
  "mode": "relative",
  "direction": "forward",
  "speed": "medium",
  "gait": "walk"
}
```

### `detect`

Rule:

- compile to a perception behavior request, not a chassis primitive
- if `waypoint` present and known, optionally emit a two-stage plan:
  - `locomotion.goto`
  - `behavior.detect`

Recommended internal fields:

- `target`
- `sensor`
- `waypoint`
- `sweep`

### `trick`

Rule:

- compile to `action.once` or `action.loop`
- map known trick names to action IDs in config
- if trick name is unknown but present, reject instead of guessing

Recommendation:

- add config:

```json
{
  "backflip": { "action_id": 4, "verified": false },
  "wave": { "action_id": 7, "verified": false }
}
```

Important:

- the upstream docs confirm action IDs exist, but the extracted text did not expose a machine-readable name-to-ID table
- do not hardcode names until verified on your robot

### `follow`

Rule:

- compile to a higher-level behavior request, not raw locomotion
- candidate backends:
  - face tracking
  - visual tracking
  - lidar tracking
  - follow-operator behavior

Docs evidence:

- the repo includes tracking and navigation courses, including face tracking, visual tracking, lidar tracking, and navigation flows

### `talk`

Rule:

- does not require chassis motion
- compile to a speech / UI response only

## Recommended ROS2 Bridge API We Own

Because the Yahboom docs do not cleanly document a stable ROS2 application API, we should define our own.

Suggested bridge surface:

- topic `/dogzilla/cmd_vel` using `geometry_msgs/msg/Twist`
- topic `/dogzilla/stabilize` using `std_msgs/msg/Bool`
- topic `/dogzilla/action` using a small custom message or `std_msgs/msg/UInt16`
- service `/dogzilla/set_pose`
- service `/dogzilla/set_gait`
- service `/dogzilla/get_state`
- action `/dogzilla/navigate_named_target`

Why this split:

- `Twist` is standard and consistent with teleop and lidar-course behavior code
- gait / pose / action are not naturally modeled as raw `Twist`
- named navigation is better handled as a service or action than by overloading `move`

## Inference: `Twist` Should Be Our Motion Interop Surface

This is an inference, but a strong one.

Reason:

- DOGZILLA tutorials use `teleop_twist_keyboard`
- lidar behavior PDFs publish `Twist()`
- standard ROS2 locomotion tooling interoperates well with `geometry_msgs/msg/Twist`

Rule:

- if we need a ROS2-native movement topic, use `Twist` as our bridge input format
- inside the bridge, convert `Twist` to DOGZILLA Python library calls

Example conversion policy:

- positive `linear.x` -> forward
- negative `linear.x` -> back
- positive `linear.y` -> left
- negative `linear.y` -> right
- positive `angular.z` -> turnleft
- negative `angular.z` -> turnright
- near-zero on all axes -> stop

Important:

- do not assume physical units from docs
- the docs describe step width / rotation speed ranges, not meters per second
- use tunable calibration in config to map `Twist` to DOGZILLA step values

Example calibration config:

```json
{
  "twist_to_step": {
    "linear_x_max_step": 25,
    "linear_y_max_step": 18,
    "angular_z_max_step": 100,
    "deadband": 0.05
  }
}
```

## Safety Rules

These rules should be enforced before any ROS2 command is emitted.

### Clamp numeric values

- `x_step` to `[-25, 25]`
- `y_step` to `[-18, 18]`
- `turn_rate` to `[-100, 100]`
- `height` to `[75, 115]`
- `roll` to `[-20, 20]`
- `pitch` to `[-15, 15]`
- `yaw` to `[-11, 11]`

### Reject unknown trick names

- do not map natural-language trick names directly unless they exist in verified config

### Reject unknown waypoint names

- do not improvise motion for semantic waypoints

### Stop before mode changes when needed

- before switching gait / pose / action-loop state, the bridge may need to issue `stop()`

### Separate high-level behaviors from low-level locomotion

- `detect`, `follow`, navigation, and line patrol are behaviors
- forward / strafe / rotate are chassis primitives
- do not mix them in the same emitted command object

## Proposed v2 LLM Command Schema

This is the schema we should eventually move toward.

```json
{
  "command": "move | detect | trick | follow | talk | pose | stabilize | state",
  "mode": "relative | waypoint | action_once | action_loop | query",
  "waypoint": "string",
  "direction": "forward | back | left | right | turn_left | turn_right",
  "speed": "slow | medium | fast",
  "gait": "walk | trot",
  "mark": 0,
  "height": 95,
  "roll": 0,
  "pitch": 0,
  "yaw": 0,
  "trick": "string",
  "action_id": 0,
  "enabled": true,
  "target": "string",
  "text": "string"
}
```

Compilation rule:

- LLM schema stays semantic
- compiler turns it into canonical internal plan
- ROS2 bridge executes the plan

## Open Items To Verify On Real Robot

These remain unverified from the upstream docs we inspected:

1. Exact Yahboom ROS2 topic names used by chassis motion.
2. Exact message type and topic name if joint state is published from the real robot.
3. Whether `yahboom_gait` and `yahboom_set_height` are intended as long-running nodes, one-shot launch wrappers, or parameterized startup helpers.
4. Exact mapping of preset action names to action IDs.
5. Best way to integrate semantic waypoint navigation on S1 versus S2.
6. Whether the bridge should call DOGZILLA Python library directly or wrap existing Yahboom nodes that already do so under the hood.

Until those are bench-verified, our implementation should prefer:

- documented Python library calls
- our own ROS2 bridge contract
- config-driven mapping tables

## Recommended Next Implementation Step

Build a small Python ROS2 package named `dogzilla_bridge` with:

- one adapter module for DOGZILLA Python library calls
- one validator module for clamping / rejecting invalid commands
- one compiler module for mapping app JSON to canonical plans
- one `rclpy` node exposing our ROS2 bridge API

For this repo specifically, the Node app should not talk to Yahboom ROS2 directly. It should send requests to the bridge using a narrow, validated command contract.

