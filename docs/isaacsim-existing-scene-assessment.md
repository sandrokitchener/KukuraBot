# Existing Isaac Scene Assessment

## Scene Files

Existing scene:

- `isaacsim/dogzilla_sim_env.usd`

New non-destructive companion scene:

- `isaacsim/dogzilla_sim_env_proxy.usda`

Proxy rig config:

- `config/isaacsim-proxy-rig.json`

## What Was Found

### `dogzilla_sim_env.usd`

This scene is small and mostly acts as a wrapper:

- default prim is `/World`
- room payload comes from Isaac content
- DOGZILLA comes from payload `../../../../Downloads/DOGZILLA S2.usd`
- the scene already applies a `rotateX = 90` plus a units scale conversion to the DOGZILLA prim

That means the scene itself is not the messy part. The messy part is the payload asset.

### `DOGZILLA S2.usd`

This payload appears to be a CAD-converted asset:

- creator string references `omni.kit.converter.hoops_core`
- default prim is `tn__DOGZILLAS2_oA`
- `metersPerUnit = 0.001`
- `upAxis = "Y"`
- root kind is `assembly`
- geometry sits under a `Prototypes` scope
- many child components are named `NONE`, `NONE_1`, `NONE_2`, and so on

So the imported payload has geometry, but not meaningful robot semantics.

## What Can Be Done Reliably

Yes, I can do scene-level work around this asset.

Good scene-level edits:

- add a clean wrapper prim around the payload
- hide the original scene payload prim in a companion scene
- create stable prim paths for a proxy rig
- add manual rotation-tweak channels on the visual shell wrapper
- define clean command target prims

## What Cannot Be Recovered Automatically

Not from this payload alone:

- meaningful part names
- true link/joint structure
- servo pivots
- articulation hierarchy
- robot-control semantics

## What The New Proxy Scene Does

`isaacsim/dogzilla_sim_env_proxy.usda`:

- sublayers the original scene
- deactivates `/World/DOGZILLA_S2` in the companion scene
- adds `/World/DOGZILLA_SIM`
- re-payloads the DOGZILLA asset under `/World/DOGZILLA_SIM/VisualShell`
- adds manual rotation tweak ops on that visual shell
- adds empty clean proxy prims under `/World/DOGZILLA_SIM/ProxyRig`

## Recommended Use

Open the new companion scene when you want to work on control scaffolding:

- `isaacsim/dogzilla_sim_env_proxy.usda`

Keep the original scene intact for comparison:

- `isaacsim/dogzilla_sim_env.usd`

## Why This Is Better

This avoids editing the large CAD-converted payload directly.

It gives you:

- stable prim paths for future controller code
- a place to add proxy links or guide meshes
- a way to adjust visual rotation at the wrapper level
- a clean separation between visual shell and control rig

## Next Safe Step

In Isaac Sim, inspect:

- `/World/DOGZILLA_SIM/VisualShell`
- `/World/DOGZILLA_SIM/ProxyRig`

Then decide whether to:

1. use only a root/body proxy first, or
2. build a six-link placeholder rig, or
3. attach simple primitives to the proxy link prims as guide geometry
