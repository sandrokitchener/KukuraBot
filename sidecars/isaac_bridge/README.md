# Isaac Sidecar

Tiny Python sidecar scaffold between this app and Isaac Sim.

Purpose:

- keep Node app free from Isaac-specific Python imports
- give the app one clean local transport, ideally HTTP on `127.0.0.1`
- leave Isaac-specific hookup on the Python side later

Current state:

- HTTP relay for app-facing commands
- no Isaac Sim import inside sidecar itself
- Isaac runtime consumes shared command log
- accepts commands and logs them for Isaac runtime pickup

Default routes:

- `GET /healthz`
- `POST /commands`

Suggested app-facing address:

- `http://127.0.0.1:8891`

Suggested future Isaac-facing path:

- a Python script or extension path on the Isaac side that this sidecar can import or call

Current repo wiring:

- app talks only to sidecar over HTTP
- sidecar writes `command_log.ndjson`
- Isaac extension/runtime follows that log and applies commands in sim
