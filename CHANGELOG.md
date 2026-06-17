# Changelog

All notable changes to this project are documented here.

The project uses Semantic Versioning for source, firmware, web, and cloud function releases.

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
