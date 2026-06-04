# DOGZILLA YOLO Vision Sidecar

Pi-local ONNX YOLO object detection for the DOGZILLA camera.

Default pipeline:

```text
auto camera source -> ONNX Runtime YOLO -> annotated MJPEG -> Questing Beast app proxy
```

Endpoints:

- `GET /healthz`
- `GET /detections`
- `GET /stream.mjpg`

The sidecar is intentionally Pi-local so object recognition latency stays off the app/browser path. The app should consume `/api/dogzilla/camera/stream`, which proxies the sidecar's annotated stream when `config/dogzilla-connection.json` has `vision.enabled: true`.

The sidecar can also read an MJPEG URL, but direct device capture is preferred because the vendor Flask `/video_feed` can accept TCP and then stall before HTTP headers.

## Camera Regression Notes

Do not hardcode `/dev/video0`. The Sonix USB camera re-enumerates on the Pi and has appeared as `/dev/video0` and `/dev/video1`. Startup should pass `-CameraUrl auto`, which picks `/dev/v4l/by-id/*video-index0` first and lets that symlink resolve to the current video node.

Do not remove low-latency capture behavior. V4L can buffer old camera frames; if the capture loop sleeps or inference is slower than the sensor, the app shows stale video behind what DOGZILLA actually sees. The sidecar sets `CAP_PROP_BUFFERSIZE=1` and drains a few queued frames before encoding each MJPEG frame. If camera lag returns, check `DOGZILLA_YOLO_CAMERA_DRAIN_FRAMES` before changing camera source.

Known bad states:

- `sourceStreamUrl: "/dev/video0"` in `config/dogzilla-connection.json`.
- YOLO health says `cameraResolvedPath` points at a missing or old `/dev/video*`.
- Health has fresh `ok: true` but operator view is seconds behind the physical dog; this means buffered capture, not device selection.

Start from Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dogzilla-yolo-vision-ssh.ps1 -Host 10.0.4.32 -ModelPath <path-to-best.onnx> -DataYamlPath <path-to-custom.yaml> -Background
```

By default the script installs missing Pi Python runtime package `onnxruntime` with `pip --user --break-system-packages`. Add `-NoInstallDeps` to fail before install.
