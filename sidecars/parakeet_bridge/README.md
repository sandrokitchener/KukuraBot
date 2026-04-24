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
- On Windows, run this through WSL2, Docker, or another Linux-capable Python runtime.
- Install NeMo ASR first, for example `pip install -U nemo_toolkit[asr]`.
