# WiFi Zone Beckon — Integration Plan

Use phone-side WiFi fingerprinting to detect which room the user is in, then beckon DOGZILLA to that room's waypoint.

## Overview

```
Phone scans visible BSSIDs  ──>  fingerprint matcher  ──>  zone_id  ──>  waypoint name  ──>  Nav2 NavigateToPose
```

| Layer | Runs on | Job |
| --- | --- | --- |
| WiFi scanner | Android (Tauri plugin or WebView JS) | Collect visible BSSID list + RSSI |
| Fingerprint store | PC backend (`server.mjs` route) | Persist zone→BSSID fingerprints, match current scan |
| WPS geolocation | PC backend (optional) | Use Apple WPS API for GPS-level context during setup |
| Zone→waypoint map | PC config (`config/zone-waypoints.json` new file) | Map zone_id to waypoint name |
| Beckon dispatch | PC backend (`lib/app-service.mjs`) | Send `locomotion.goto` with resolved waypoint |

## Phase 1 — Android-side WiFi scan bridge

The Tauri Android WebView cannot access Android WiFi APIs directly. Three options:

| Option | Effort | Latency | Dependencies |
| --- | --- | --- | --- |
| **A. Tauri plugin (recommended)** | Medium | Low | Custom Tauri plugin (Rust) exposing `scan_wifi() → BSSID[]` to JS via `invoke` |
| **B. WebView JS + captive portal probe** | Low | High | No native code; uses `fetch()` timing or `navigator.connection` — coarse, unreliable |
| **C. Companion native helper** | High | Low | Separate Kotlin foreground service with HTTP endpoint; needs lifecycle management |

**Recommendation: Option A.** Write a minimal Tauri plugin (`src-tauri/plugins/wifi-scanner/`) that:

1. Uses Android `WifiManager.startScan()` + `getScanResults()` (API 23+)
2. Returns JSON array of `{bssid, ssid, rssi, frequency, channelWidth}`
3. Exposed as `invoke('plugin:wifi-scanner|scan')` callable from the shared `public/` JS

The plugin maps to existing Tauri Android plugin patterns at `src-tauri/gen/android/`.

### Backend relay endpoint

New route on `server.mjs`:

```
POST /api/zone/scan
  Body: { bssids: [{bssid, ssid, rssi, frequency}], timestamp }
  Returns: { zoneId: string | null, confidence: number, waypointName: string | null }
```

The backend runs matching; the phone is just a scan relay.

## Phase 2 — Zone fingerprint storage and matching

### New config file: `config/zone-waypoints.json`

```json
{
  "zones": {
    "kitchen_zone": {
      "waypointName": "kitchen",
      "fingerprints": [
        {
          "bssid": "aa:bb:cc:dd:ee:01",
          "ssid": "HomeWiFi-5G",
          "expectedRssi": -45,
          "rssiTolerance": 10,
          "frequency": 5180
        }
      ],
      "createdAt": "2026-06-30T12:00:00Z",
      "notes": ["Marked from phone while standing at kitchen counter"]
    }
  }
}
```

### Matching algorithm

Simple weighted-BSSID matcher in a new lib module (`lib/zone-matcher.mjs`):

1. For each zone, compute a match score from how many expected BSSIDs appear in the scan and how close the RSSI values are
2. Return the zone with the highest score above a threshold (`ZONE_MATCH_MIN_SCORE`, default 0.6)
3. If no zone scores above threshold, return `null` (unknown location)

This avoids requiring GPS or Apple WPS API calls for the common case. The WPS API (`bssid-geolocator.js` from wifi-position-tracker) is optional for initial setup hints.

## Phase 3 — Zone marking UI (setup)

New panel in the shared `public/` UI, accessible from the Android app (and optionally desktop):

### "Mark Current Zone" flow

1. Phone scans WiFi → shows BSSID summary
2. User selects a waypoint name from a dropdown populated by `GET /api/waypoints` (existing endpoint)
3. User taps **"Mark Zone"**
4. `POST /api/zone/define { waypointName, bssids }` saves to `config/zone-waypoints.json`
5. UI shows confirmation: "Kitchen zone saved with 6 access points"

### "Test Zone" button

Scan current WiFi, run the matcher, show the matched zone and confidence. Used for verification during and after setup.

## Phase 4 — Beckon button / "come to me"

### UI element

Add a **Beckon** button to the Android app's home/status screen. Conditions:

- Phone has a matched zone (current scan resolved to a known zone)
- Robot is online and waypoint-capable (check `/healthz-lite`)
- Tap sends `POST /api/zone/beckon` → backend resolves zone→waypoint→`locomotion.goto`

### Voice command

The existing chat/speech system (`speech-input.js`, `chat-history.js`) already parses "come to me" / "beckon" / "follow me" as semantic commands. The plan hooks into the existing `operator_source` / `user` special waypoint kinds by making them resolve to the current zone's waypoint at dispatch time instead of being static stay-put targets.

### Backend dispatch

In `lib/robot-command-compiler.mjs`, resolve a `source` or `user` target:

1. Call zone matcher with the latest phone scan (passed via dispatch context or cached in `output/app-cache/latest-phone-scan.json`)
2. If matched → resolve to the zone's waypoint pose → normal Nav2 dispatch
3. If unmatched → return "Phone zone unknown; beckon unavailable"

## Phase 5 — Periodic background scan

The phone should re-scan on a cadence to keep the zone current without the user pressing a button first.

- **Scan interval**: Every 30–60 seconds while the app is foregrounded
- **Trigger events**: On app resume, on connectivity change
- **Result**: The matched zone is cached and displayed in the app status bar ("Zone: Kitchen")

The Tauri plugin fires a JS event (`wifi:zone-changed`) when the zone changes so the UI can react.

## File changes summary

| File | Change |
| --- | --- |
| `src-tauri/` | New `plugins/wifi-scanner/` Rust plugin for Android WiFi scan |
| `server.mjs` | New routes: `POST /api/zone/scan`, `POST /api/zone/define`, `POST /api/zone/beckon` |
| `lib/zone-matcher.mjs` | New module: fingerprint matching algorithm |
| `lib/robot-command-compiler.mjs` | Resolve `source`/`user` targets via zone matcher |
| `public/...` | Beckon button, zone marking panel, zone status indicator (shared with all shells) |
| `config/zone-waypoints.json` | New config: zone→waypoint mapping |
| `output/app-cache/latest-phone-scan.json` | Relay cache for the most recent phone scan |

## Out of scope (v1)

- GPS-level Apple WPS integration from wifi-position-tracker (can be added as a setup hint later)
- Multi-user zone detection (assumes one phone = one user)
- Fused location (WiFi + BLE + cellular)
- Automated zone calibration (all zones are manually marked by the user)

## Risk notes

| Risk | Mitigation |
| --- | --- |
| Android WiFi scan rate limits (Android 9+ throttles passive scans) | Use `WifiManager.setScanThrottleEnabled(false)` on API 28+; keep interval ≥30 s |
| BSSID randomization at router level | Accept that fingerprints drift; allow user to refresh a zone's fingerprint |
| No WiFi = no zone | Beckon shows "No WiFi scan available" rather than sending robot to wrong room |
| Phone not on same LAN as backend | Zone matching runs server-side; scan data is sent over the existing backend connection (LAN/Tailnet) |
