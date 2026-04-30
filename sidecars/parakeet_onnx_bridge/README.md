# Parakeet ONNX Sidecar

Windows-friendly HTTP bridge for the ONNX conversion of NVIDIA Parakeet TDT 0.6B v3.

Default URL:

```text
http://127.0.0.1:8893
```

Install runtime dependencies in the Python used by `config/speech-sidecar.json`:

```bash
pip install "onnx-asr[cpu,hub]"
```

The default `onnx-asr` model alias is:

```text
nemo-parakeet-tdt-0.6b-v3
```

That alias resolves to the ONNX model published at:

```text
https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx
```

Set `PARAKEET_ONNX_MODEL_ID` to point at a local model directory or another `onnx-asr` alias.

Routes:

- `GET /healthz`
- `POST /transcribe`
