# DOGZILLA YOLO Vision Sidecar

Pi-local ONNX YOLO object detection for the DOGZILLA camera.

Default pipeline:

```text
/dev/video0 -> ONNX Runtime YOLO -> annotated MJPEG -> Questing Beast app proxy
```

Endpoints:

- `GET /healthz`
- `GET /detections`
- `GET /stream.mjpg`

The sidecar is intentionally Pi-local so object recognition latency stays off the app/browser path. The app should consume `/api/dogzilla/camera/stream`, which proxies the sidecar's annotated stream when `config/dogzilla-connection.json` has `vision.enabled: true`.

The sidecar can also read an MJPEG URL, but direct `/dev/video0` capture is preferred because the vendor Flask `/video_feed` can accept TCP and then stall before HTTP headers.

Start from Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dogzilla-yolo-vision-ssh.ps1 -Host 10.0.4.32 -ModelPath <path-to-best.onnx> -DataYamlPath <path-to-custom.yaml> -Background
```

By default the script installs missing Pi Python runtime package `onnxruntime` with `pip --user --break-system-packages`. Add `-NoInstallDeps` to fail before install.
