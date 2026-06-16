<!-- Archive detail doc. Do not read by default. Current summary lives in docs/ANDROID_APP.md. -->

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

Nemotron note: the local Ollama `nemotron-3-nano:latest` on this dev box reports a 31.6B MoE model, Q4_K_M quantization, and a 24 GB local size. That is not a realistic first phone target unless the device has unusually high RAM and thermal headroom. Start phone-local work with a 1B-3B GGUF Q4 model, then try larger models only after device testing.

## Experimental Phone-Local LLM

The app now has an `Android llama.cpp` model profile:

```json
{
  "provider": "llama-cpp-http",
  "baseUrl": "http://127.0.0.1:8080/v1",
  "modelPath": "/storage/emulated/0/Android/data/com.robodoge.console/files/models/NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf"
}
```

On desktop, `llama-cpp-http` behaves like an OpenAI-compatible profile and the Node backend calls `baseUrl`.
Inside the Android Tauri shell, the web UI calls `http://127.0.0.1:8080/v1/chat/completions` directly, so `127.0.0.1` means the phone, not the PC. The resulting model text is then posted back to `/api/chat/result` on the Robo-Doge backend so existing JSON parsing, Isaac preview, and ROS2 dispatch behavior stays shared.

### GGUF Storage Path

Do not rely on `/sdcard/Download/*.gguf` as the final Android path. Android scoped storage can make arbitrary shared-storage paths unreliable for app-native reads unless the app uses Storage Access Framework permissions. The safer debug path is app-specific external storage:

```text
/sdcard/Android/data/com.robodoge.console/files/models/
```

The app can read this directory without broad storage permission, and `adb push` can place large GGUF files there for side-loaded/debug builds.

Pull the current target model on the PC:

```powershell
.\scripts\pull-nemotron3-nano-4b-gguf.ps1
```

Install the GGUF onto an attached Android device:

```powershell
.\scripts\install-android-gguf.ps1
```

To try a different GGUF, push it to the same app-specific `models/` directory and set `modelPath` in `config/model-profiles.json` to the device path. Keep `baseUrl` fixed only for the current local llama-server bridge shape.

### llama.cpp Smoke Path

Practical first test with Termux:

```bash
pkg update
pkg install git cmake clang
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build -DGGML_OPENMP=OFF -DGGML_LLAMAFILE=OFF
cmake --build build --config Release -j4
mkdir -p ~/models
cp /sdcard/Android/data/com.robodoge.console/files/models/NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf ~/models/
./build/bin/llama-server -m ~/models/NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf -c 2048 --host 127.0.0.1 --port 8080
```

Then:

1. Run the PC Robo-Doge backend with `bun run dev:lan`.
2. In the Android app, set Backend URL to `http://<pc-lan-ip>:3037`.
3. Select `Android llama.cpp` from Settings.
4. Send a small prompt and watch the phone-local `llama-server` terminal.

If Android WebView blocks the direct local request, the next implementation step is a Tauri/native Android bridge to call llama.cpp or its local HTTP endpoint without browser CORS.

The final desired shape is native app-owned llama.cpp, not Termux:

```text
Android UI -> Tauri/native Android command -> llama.cpp -> app-specific GGUF path -> model text -> /api/chat/result
```

The `modelPath` metadata is already in the model profile so the same setting can drive the native llama.cpp binding once it is linked into the Android app.

Phone-local LLM ladder:

1. Use local `llama-server` over `127.0.0.1` from the Android WebView.
2. Add a native Tauri command/plugin wrapping llama.cpp or a JNI/Kotlin binding.
3. Keep PC Ollama as default high-quality private route.

Sources: [Ollama API](https://docs.ollama.com/api/introduction), [llama.cpp Android notes](https://github.com/ggml-org/llama.cpp/blob/master/docs/android.md), [Android NDK CMake guide](https://developer.android.com/ndk/guides/cmake), [Tauri JavaScript API global notes](https://v2.tauri.app/reference/javascript/api/).
