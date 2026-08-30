# Changelog

All notable changes to this project are documented here.

The project uses Semantic Versioning for source, firmware, web, and cloud function releases.

## [0.5.0-desktop] - 2026-08-29

### Added

- New standalone desktop app (`gate-desktop/`): same single-screen design as the
  Android app - dark theme, live DVR camera feed, and a circular `GATE` button
  that sends one pulse directly to Firebase.
- Desktop stack: PySide6 (UI) + OpenCV (in-app RTSP/H.265 decode). No web shell,
  no relay server. The feed connects straight from the PC to the DVR over the
  house LAN.
- Desktop shortcut (`GateCam.lnk`) launches the app headless via `pythonw.exe`
  (no console window).
- Headless functional test (`gate-desktop/test_headless.py`) that verifies the
  decode -> render pipeline and the Firebase pulse contract without a display.

### Changed

- Gate button label renamed from `OPEN GATE` to `GATE` in both the desktop app
  and the Android `strings.xml` - the button both opens and closes the gate.
- Desktop app exit path hardened: `cap.release()` unblocks a stuck RTSP read on
  close, plus a guaranteed `os._exit(0)` so no `pythonw` process is ever left
  hanging.

### Fixed

- Corrected the DVR RTSP URL: the verified working path is
  `rtsp://192.168.0.245:554/h264/ch7/main/av_stream`. The earlier
  `/user=admin&password=&channel=7&stream=0.sdp` format is rejected by the
  Topsvision server (`451 Parameter Not Understood`).

## [0.4.0-cam] - 2026-08-29

### Changed

- Rebuilt the Android app as a standalone single-screen client (`GateCam`): dark
  theme, camera card, and a large circular OPEN GATE button.
- Replaced the WebView web-app shell with a native UI that talks directly to
  Firebase (sign-in via Identity Toolkit REST, command intent written to
  `/gate/commandRequests/{id}`).
- Embedded the DVR camera feed in-app via ExoPlayer's RTSP extension
  (`media3-exoplayer-rtsp`) instead of the external HLS relay.
- Dropped the experimental native-SDK camera path (`CameraStreamActivity`,
  `TsSdkProtocol`) and the 0.1.0 REST client (`GateCommandClient`, `GateConfig`).
- Moved Firebase credentials into a gitignored `GateSecrets.java`
  (template: `GateSecrets.example.txt`).
- Recovered and kept the DVR `umsp/*.bin` protocol templates as assets for
  future P2P remote-view work.

### Fixed

- Android build now uses AndroidX (`gradle.properties` -> `android.useAndroidX=true`)
  so media3 dependencies resolve and compile.

## [0.3.7+20260617] - 2026-06-17

### Fixed

- Removed browser-side command authority from the family gate page. This protects the dumb-GUI invariant: the browser writes intent only, while Firebase/ESP state drives the button display.
- Removed ESP cloud-command rejection based on local timestamp age. This prevents valid Firebase-published commands being thrown away as `expired_or_bad_timestamp`; Firebase owns command timing and the ESP owns physical actuation.
- Added prompt Firebase cleanup for unclaimed live commands. If the ESP does not claim a pending live command within the command TTL plus grace, Firebase records `firebase_expired_unclaimed` and retires the single live slot instead of leaving a stuck executable state.

### Added

- Added `SAFETY_INVARIANTS.md` to pin the no-queue, dumb-webapp, Firebase-timing-authority, ESP-actuator-authority rules and prevent regression drift.

## [0.3.6+20260617] - 2026-06-17

### Fixed

- Removed the ESP Firebase-stale self-reboot path so cloud trouble cannot take down local access.
- Kept the `GateController` backup AP running while the ESP is also connected to house Wi-Fi.
- Reduced Firebase HTTP request timeout from 5000 ms to 1200 ms so failed cloud calls block the ESP loop for less time.

### Removed

- Removed the local `SMART GATE` pulse mode and `/smart-pulse` endpoint after the detector-start hardware was removed.
- Removed unused Android widget resources and stale widget installer text. The Android project is now the simple one-tap app only.

## [0.3.5+20260616] - 2026-06-16

### Fixed

- Removed browser-side ESP stale authority from the main gate page; heartbeat age is now diagnostic display only and does not decide gate availability or main button state.

## [0.3.4+20260616] - 2026-06-16

### Fixed

- Kept Firebase as the command time authority while starting the executable ESP expiry window when Firebase publishes `gate/liveCommand`, so backend trigger delay cannot consume the ESP pickup window.
- Routed the camera preview through the Firebase HTTPS origin at `/camera/index.m3u8` to avoid browser mixed-content blocking.
- Removed the web/admin command-timeout tuning control so command freshness is not authored or tuned by the browser.
- Stopped the Firebase validation function from racing the ESP with an early `expired_unclaimed` write while the ESP may still be reporting `active` or `done`.

## [0.3.3+20260616] - 2026-06-16

### Changed

- Pointed the Firebase web camera preview at the live MediaMTX HLS relay.

## [0.3.2+20260616] - 2026-06-16

### Fixed

- Moved the camera preview below the gate button and capped it to a small thumbnail-sized box.
- Bumped the web version so browsers reload the corrected layout.

## [0.3.1+20260616] - 2026-06-16

### Fixed

- Removed browser-authored gate command timing, expiry, TTL, and executable `gate/liveCommand` writes.
- Added Firebase Function handling for `gate/commandRequests/{id}` so Firebase is the time authority.
- Blocked normal users from writing command logs, command records, or `gate/liveCommand` directly in database rules.

### Changed

- Shrunk the camera panel into a thumbnail-sized preview.

## [0.3.0+20260616] - 2026-06-16

### Added

- Added a Firebase web camera preview panel that loads an HLS relay with hls.js.
- Added `camera-config.js` so the browser only sees the MediaMTX HLS URL, not the raw DVR RTSP URL.
- Added no-Docker MediaMTX relay setup files for a Google Compute Engine VM.

### Changed

- Moved user-facing access stats and logs behind an `Activity and diagnostics` fold so the main gate page is cleaner.

## [0.2.1+20260615] - 2026-06-15

### Fixed

- Restored ESP32 millisecond epoch timestamps for cloud telemetry and stale-command checks.
- Prevented delayed Firebase `active` callbacks from downgrading already-final command records.
- Confirmed Firebase rules allow the ESP device account to acknowledge and complete existing live commands.

### Changed

- Added explicit project version tracking across ESP firmware, web app, and cloud functions.
- Moved PlatformIO build output to `D:/GateControllerBuild/platformio` to avoid generated build junk in OneDrive.

## [0.2.0+20260614] - 2026-06-14

### Fixed

- Stopped web and Android clients from rounding command timestamps down to whole seconds.
- Moved command freshness checks to Firebase/server-received timestamps.
- Cleaned stale pending audit records and confirmed the executable live command slot was empty.

### Added

- Initial GitHub handoff with ESP32 firmware, Firebase web/functions/rules, Android source, and project README.
