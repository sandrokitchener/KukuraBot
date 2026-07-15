# DOGZILLA Audio Cue Sidecar

Pi-local sound cue bridge for the speaker attached to DOGZILLA.

Endpoints:

- `GET /healthz`
- `POST /cue`

Cue body:

```json
{ "cue": "thinking-start" }
```

Supported cue names:

- `thinking-start`
- `thinking-stop`
- `confirm`
- `mapping-start` (plays `public/sounds/mapping-start.wav` after autonomous mapping starts)

The sidecar plays WAV files with `aplay` by default so the browser does not need to own robot feedback audio.
