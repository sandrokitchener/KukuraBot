# DeepSeek Plan: Android Scan Mode UI

## Mission

Add the Android-only scan entrypoint and mobile app flow. Do not implement map processing, robot deployment, or server-side storage.

Target flow:

```text
Android app opens -> Settings -> Scan -> scanning mode takes over app -> Complete scan -> Confirm and Send to Robot
```

## Scope

Work only on the Android/mobile user experience in the shared `public/` app.

Likely files:

- `public/index.html`
- `public/app.js`
- `public/styles/*.css`
- `test/android-web-parity.test.mjs`
- `docs/ANDROID_APP.md`

Do not change desktop/web behavior except where shared markup needs an Android-only hidden section.

## Existing Facts

- Android app is a Tauri WebView around the shared `public/` UI.
- Android talks to the Robo-Doge backend through the existing Backend URL.
- Android does not run Node, SSH, ROS2, Cartographer, or DOGZILLA sidecars locally.
- Existing Android shell detection is `isAndroidAppShell()` in `public/app.js`.

## UI Behavior

1. In Android shell only, Settings shows a `Scan` option.
2. Tapping `Scan` closes or visually replaces Settings and opens a full-screen scanning mode.
3. Scanning mode owns the screen until `Cancel` or successful send.
4. Required buttons:
   - `Complete Scan`
   - `Confirm and Send to Robot`
   - `Cancel`
5. Required visible states:
   - `scanning`
   - `ready_to_confirm`
   - `uploading`
   - `processing`
   - `sending_to_robot`
   - `loaded`
   - `failed`

## Backend Contract To Call

Call one endpoint from the Android UI:

```http
POST /api/android/scans/send-to-robot
Content-Type: multipart/form-data
```

Fields:

- `rawMap`: required file/blob from scanner output
- `metadata`: required JSON string
- `preview`: optional image file/blob

Metadata JSON shape:

```json
{
  "createdAt": "2026-07-09T00:00:00.000Z",
  "source": "android-scan-mode",
  "resolution": 0.05,
  "width": 0,
  "height": 0,
  "origin": [0, 0, 0],
  "frame": "map"
}
```

Expected success response:

```json
{
  "ok": true,
  "sessionId": "scan_...",
  "state": "loaded",
  "map": {
    "fingerprint": "...",
    "widthCells": 0,
    "heightCells": 0,
    "resolution": 0.05
  }
}
```

Expected failure response:

```json
{
  "ok": false,
  "state": "failed",
  "error": "human-readable reason"
}
```

## Implementation Tasks

1. Add Android-only Settings row/button:
   - Label: `Scan`
   - Visible only when `isAndroidAppShell()` is true.
   - Hidden on desktop/web.

2. Add full-screen scan mode markup:
   - Status label.
   - Optional preview/map area.
   - `Complete Scan`, `Confirm and Send to Robot`, `Cancel` buttons.
   - Keep layout touch-friendly and readable on phone.

3. Wire scan mode state:
   - `Scan` enters `scanning`.
   - `Complete Scan` moves to `ready_to_confirm`.
   - `Confirm and Send to Robot` uploads payload, then shows backend result.
   - `Cancel` exits scan mode and clears local pending payload.

4. Upload using existing `apiFetch()` behavior so Android Backend URL still works.

5. Disable double submit while upload is active.

6. Render backend errors clearly in scan mode.

7. Keep normal app controls untouched outside scan mode.

8. Add or update Android parity test:
   - Scan control exists in shared markup.
   - Scan control is marked Android-only.
   - Existing Connection Center and Settings controls remain present.

9. Update `docs/ANDROID_APP.md` briefly:
   - Settings -> Scan exists on Android only.
   - Requires backend reachable through Backend URL.
   - Backend owns processing and robot map deployment.

## Acceptance Criteria

- Android Settings has a Scan entry.
- Desktop/web does not show or depend on Scan entry.
- Scan mode takes over the app screen on Android.
- User can complete, confirm/send, cancel, and see failure states.
- UI calls `POST /api/android/scans/send-to-robot` with multipart form data.
- No server-side processing logic is implemented in this task.

## Do Not Do

- Do not add a database.
- Do not implement map processing.
- Do not SSH to the robot.
- Do not promote robot maps.
- Do not alter existing desktop/web Map Controls.
- Do not rewrite the Settings drawer.
