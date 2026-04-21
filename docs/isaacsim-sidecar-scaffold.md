# Isaac Sim Sidecar Scaffold

## Purpose

Keep three concerns separate:

1. LLM prompt + JSON output
2. command-to-sim translation
3. transport into Isaac Sim

This repo now treats those as separate layers.

## Current Shape

```text
user input
-> model reply JSON
-> Isaac command compiler
-> sidecar transport client
-> Python sidecar
-> Isaac Sim hook later
```

## Files

Editable configs:

- `config/isaacsim-command-map.json`
- `config/isaacsim-sidecar.json`
- `config/isaacsim-cad-split-plan.json`

Backend modules:

- `lib/isaacsim-config.mjs`
- `lib/isaacsim-command-compiler.mjs`
- `lib/isaacsim-sidecar-client.mjs`

Sidecar scaffold:

- `sidecars/isaac_bridge/server.py`

## Recommended Communication Shape

Best app-facing address:

- local HTTP base URL, for example `http://127.0.0.1:8891`

Why:

- clean boundary between Node app and Python / Isaac world
- easy to test with dry-run mode
- easy to swap implementation later
- avoids mixing Omniverse-specific imports into the Node app

### What path should you hand me later

Two useful values can exist later:

1. App-facing sidecar URL:
   - example: `http://127.0.0.1:8891`
   - this is what the Node app should talk to

2. Isaac-facing script / extension path:
   - example: path to your Isaac-side Python hook or extension entry file
   - this belongs inside the sidecar config, not in the app prompt/config layer

If you only hand me one thing later, best one is:

- the local sidecar base URL

## Current API

### `POST /api/chat`

Still returns model response and parsed JSON.

Now also returns:

```json
{
  "isaacSim": {
    "status": "ready",
    "action": "navigate.named_target",
    "payload": {},
    "dispatchPlan": {}
  }
}
```

### `GET /api/isaac/health`

Checks current sidecar config and probes the sidecar when transport is enabled.

### `POST /api/isaac/dispatch`

Accepts either:

```json
{
  "preview": { "...": "..." }
}
```

or:

```json
{
  "parsed": { "...": "..." },
  "input": "user text",
  "rawResponse": "{...}"
}
```

## STEP File Assessment

The local file `DOGZILLA S2.STEP` looks promising for CAD import, but not for direct articulated sim:

- format header: `STEP AP214`
- source tool: `SolidWorks 2021`
- one quick-scan `PRODUCT` entry named `DOGZILLA S2`
- around `9535` `ADVANCED_FACE` entities
- no quick-hit `NEXT_ASSEMBLY_USAGE_OCCURRENCE` entries found in a simple scan

What that suggests:

- likely fine for CAD import into Isaac Sim
- likely good for visuals and maybe collider setup
- likely not preserving a clean robot assembly tree for immediate joint rigging

Practical meaning:

- expect manual regrouping after import
- expect first pass to be visual shell or proxy rig
- avoid planning around a perfect STEP -> full quadruped articulation jump

## Best Next Step In Isaac

1. Import STEP into Isaac Sim CAD Converter.
2. Save resulting USD.
3. Inspect prim tree.
4. Fill `config/isaacsim-cad-split-plan.json` with actual imported prim-name patterns.
5. Start with proxy articulation if imported hierarchy is messy.
6. Only then decide whether full DOGZILLA rigging is worth it.
