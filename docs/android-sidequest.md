# Android Side Quest

Robo-Doge now has a Tauri Android shell around the existing `public/` console.
The first viable mobile shape is a private LAN client:

1. Run the Robo-Doge backend on the PC with `bun run dev:lan`.
2. Install/run the Android APK.
3. Open Settings and set Backend URL to `http://<pc-lan-ip>:3037`.

This keeps model, robot bridge, Parakeet sidecar, and Isaac Sim on the PC. The phone becomes a mobile control surface.
The script is launched with Bun, but it runs the LAN HTTP/WebSocket backend under Node because Bun 1.3.11's `node:http` upgrade path does not complete the raw WebSocket handshake used by the fake robot state stream.

## Web / Android Parity

The Android app bundles the same `public/` UI as the web app. The router button, Connection Center, DOGZILLA IP settings, bridge checks, bridge sync, bridge start/stop, and backend URL control are shared code.

On Android, set Backend URL from either Settings or the Connection Center:

```text
http://<pc-lan-ip>:3037
```

Connection actions then execute on the PC backend over LAN. Android does not run Node, PowerShell, SSH, ROS2, or bridge sidecars locally.

## Build Commands

```bash
bun install
bun run tauri:android:init
bun run tauri:android:build
```

## PC Runtime For Phone

```powershell
$env:ROBOT_RUNTIME_TARGET="ros2_real"
bun run dev:lan
```

In another terminal, start fake map telemetry:

```powershell
$env:ROBOT_STATE_WS_URL="ws://127.0.0.1:3037/api/robot/state/stream"
npm run fake:robot-state
```

On Windows without Developer Mode, Tauri can fail while creating Android JNI symlinks. The `tauri:android:build` script falls back to copying the built arm64 Rust library and asks Gradle for a signed debug APK.

Current APK path:

```text
src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
```

## Current Mobile Architecture

- Tauri bundles `public/` as static assets; no Node server runs inside Android.
- `public/api-client.js` stores an optional backend base URL in `localStorage`.
- Server CORS is open by default for local mobile control. Set `APP_CORS_ORIGIN` if this needs narrowing.
- Android manifest allows `INTERNET`, `RECORD_AUDIO`, and LAN cleartext HTTP for side-loaded builds.

## Speech Recognition Choice

Best first path: keep Parakeet ONNX on the PC backend and use the Android app as a microphone/control client.

Why:

- Current Parakeet ONNX path already exists as `sidecars/parakeet_onnx_bridge/`.
- Parakeet TDT 0.6B V3 ONNX is strong but large; on-device Android integration means model packaging, ONNX Runtime mobile wiring, audio chunking, and thermal/perf testing.
- Browser Moonshine remains the best pure on-phone fallback because it runs locally in web tech and already fits this UI model, but WebView performance and model caching need device testing.

Recommended ladder:

1. LAN backend Parakeet sidecar: most viable now.
2. Browser Moonshine on Android WebView: private, simpler, device-test next.
3. Native on-device ASR via sherpa-onnx or ONNX Runtime Mobile: best long-term offline path.
4. On-device Parakeet ONNX: possible side quest inside side quest, not first APK target.

Sources: [Parakeet ONNX model card](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx), [MoonshineJS](https://github.com/moonshine-ai/moonshine-js).

## LLM Choice

Best first path: phone sends requests to the PC Robo-Doge backend, which uses local Ollama or any OpenAI-compatible local server.

Why:

- No third-party server required.
- Current app already has Ollama/openai-compatible profiles.
- PC can run bigger/better models and keep Isaac/ROS sidecars nearby.
- Android local LLM is possible, but it should be a second pass with llama.cpp/GGUF and a tiny model.

Nemotron note: NVIDIA's Nemotron Nano 4B is efficient for its class, but the model card positions it as fitting on a single RTX GPU, not as an easy phone-local ONNX target. For this app, local PC Ollama is more viable than phone ONNX Nemotron.

Future phone-local LLM ladder:

1. Add a native Tauri command/plugin wrapping llama.cpp.
2. Start with a 1B-3B GGUF Q4 model.
3. Keep PC Ollama as default high-quality private route.

Sources: [Ollama API](https://docs.ollama.com/api/introduction), [Nemotron Nano 4B model card](https://huggingface.co/nvidia/Llama-3.1-Nemotron-Nano-4B-v1.1), [llama.cpp Android notes](https://github.com/ggml-org/llama.cpp/blob/master/docs/android.md).
