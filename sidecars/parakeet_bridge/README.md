# Parakeet Sidecar

Tiny HTTP bridge for `nvidia/parakeet-tdt-0.6b-v3`.

Purpose:

- keep Node app free from NeMo/PyTorch imports
- let browser recorder stay same while backend speech engine swaps
- isolate heavy model runtime behind local HTTP

Routes:

- `GET /healthz`
- `POST /transcribe`

Request body for `/transcribe`:

```json
{
  "audioBase64": "<wav-bytes-base64>",
  "modelId": "nvidia/parakeet-tdt-0.6b-v3",
  "timestamps": true,
  "device": "auto"
}
```

Notes:

- NVIDIA model card says official support targets Linux environments.
- On Windows, the app-managed path in `config/speech-sidecar.json` launches this through WSL by default when the active speech profile is `parakeet_tdt_0_6b_v3`.
- Leave `linuxWorkdir` and `linuxScriptPath` empty to let the Node launcher map the repo path to `/mnt/<drive>/...`; set them only if your WSL checkout lives somewhere else.
- Install NeMo ASR first, for example `pip install -U nemo_toolkit[asr]`.
